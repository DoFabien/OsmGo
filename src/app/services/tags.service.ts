import { HttpClient } from '@angular/common/http'
import { computed, inject, isDevMode, Service, signal } from '@angular/core'
import { requireValidOsmTag } from '@app/utils/osm-tags'
import type {
    JsonSprites,
    OsmGoFeature,
    Preset,
    PrimaryTag,
    Tag,
    TagConfig,
    TagsJson,
} from '@osmgo/type'
import { AppStorage } from '@services/app-storage.service'
import {
    CATALOG_CACHE_SCHEMA_VERSION,
    type CatalogCache,
    requireCatalogCache,
    requirePresetCatalog,
    requireSpriteCatalog,
    requireTagsCatalog,
} from '@services/catalog-validation'
import { defer, forkJoin, from, type Observable, of, throwError } from 'rxjs'
import {
    catchError,
    finalize,
    map,
    shareReplay,
    switchMap,
    tap,
} from 'rxjs/operators'

export interface SavedField {
    tags: Tag[]
}

export interface CatalogLoadMetric {
    characters: number
    downloadMs: number
    parseMs: number
    indexMs?: number
}

type CatalogResource = 'tags' | 'presets' | 'brands' | 'sprites'
type CatalogTimedPhase = 'parseMs' | 'indexMs'

// These development-only budgets surface meaningful regressions without
// turning device-dependent timings into production startup failures.
const catalogPerformanceBudgets: Record<
    CatalogResource,
    Partial<Record<CatalogTimedPhase, number>>
> = {
    tags: { parseMs: 250, indexMs: 50 },
    presets: { parseMs: 150 },
    brands: { parseMs: 250 },
    sprites: { parseMs: 50 },
}

export class CustomTagError extends Error {
    constructor(
        readonly code: 'invalid' | 'collision',
        options?: ErrorOptions
    ) {
        super(`Could not create custom tag: ${code}.`, options)
    }
}

@Service()
export class TagsService {
    private readonly http = inject(HttpClient)
    readonly localStorage = inject(AppStorage)

    private readonly lastTagsUsedIdsState = signal<string[]>([])
    readonly lastTagsUsedIds = this.lastTagsUsedIdsState.asReadonly()
    private readonly bookmarksIdsState = signal<string[]>([])
    readonly bookmarksIds = this.bookmarksIdsState.asReadonly()
    private readonly hiddenTagsIdsState = signal<string[]>([])
    readonly hiddenTagsIds = this.hiddenTagsIdsState.asReadonly()

    savedFields: Record<string, SavedField> = {}
    private readonly tagsState = signal<TagConfig[]>([])
    readonly tags = this.tagsState.asReadonly()
    private readonly tagsByIdState = signal<Record<string, TagConfig>>({})
    readonly tagsById = this.tagsByIdState.asReadonly()
    /**
     * What the converter reads to match and style an object: no labels, terms,
     * descriptions or fields. Copying it to the worker costs a fraction of the
     * full catalog.
     */
    readonly converterTags = computed<TagConfig[]>(() =>
        this.tags().map(
            ({
                id,
                tags,
                addTags,
                icon,
                markerColor,
                deprecated,
                replace,
                searchable,
                matchScore,
            }: TagConfig) => ({
                id,
                tags,
                ...(addTags ? { addTags } : {}),
                icon,
                markerColor,
                ...(deprecated ? { deprecated } : {}),
                ...(deprecated && replace ? { replace } : {}),
                ...(searchable === false ? { searchable } : {}),
                ...(matchScore !== undefined ? { matchScore } : {}),
                presets: [],
                geometry: [],
            })
        )
    )
    private readonly catalogMetricsState = signal<
        Partial<
            Record<'tags' | 'presets' | 'brands' | 'sprites', CatalogLoadMetric>
        >
    >({})
    readonly catalogMetrics = this.catalogMetricsState.asReadonly()
    userTags: TagConfig[] = []
    private readonly userTagsRecoveryWarningState = signal(false)
    readonly userTagsRecoveryWarning =
        this.userTagsRecoveryWarningState.asReadonly()
    private readonly primaryKeysState = signal<string[]>([])
    readonly primaryKeys = this.primaryKeysState.asReadonly()
    private readonly presetsState = signal<Record<string, Preset>>({})
    readonly presets = this.presetsState.asReadonly()
    private readonly brandPresetsLoadedState = signal(false)
    readonly brandPresetsLoaded = this.brandPresetsLoadedState.asReadonly()
    private brandPresetsRequest$?: Observable<Record<string, Preset>>
    private readonly jsonSpritesState = signal<JsonSprites>({})
    readonly jsonSprites = this.jsonSpritesState.asReadonly()

    defaultHiddenTagsIds: string[] = [
        'highway/footway',
        'highway/motorway',
        'highway/trunk',
        'highway/trunk_link',
        'highway/primary',
        'highway/primary_link',
        'highway/secondary',
        'highway/secondary_link',
        'highway/tertiary',
        'highway/tertiary_link',
        'highway/unclassified',
        'highway/residential',
        'highway/service',
        'highway/service/alley',
        'highway/motorway_link',
        'highway/living_street',
        'highway/track',
        'highway/bus_guideway',
        'highway/road',
        'highway/bridleway',
        'highway/path',
        'highway/cycleway',
        'highway/construction',
        'highway/steps',
        'highway/motorway_junction',
        'highway/corridor',
        'highway/pedestrian_line',
        'highway/cycleway/bicycle_foot',
        'highway/footway/crossing',
        'highway/service/parking_aisle',
        'highway/service/driveway',
        'highway/path/informal',
        'highway/stop',
        'highway/turning_circle',

        'railway/platform',
        'railway/abandoned',
        'railway/construction',
        'railway/disused',
        'railway/funicular',
        'railway/light_rail',
        'railway/miniature',
        'railway/monorail',
        'railway/narrow_gauge',
        'railway/rail',
        'railway/rail/highspeed',
        'railway/subway',
        'railway/tram',
        'railway/tram_level_crossing',
        'railway/tram_crossing',
        'railway/railway_crossing',

        'barrier/kerb',
        'barrier/kerb/flush',
        'barrier/kerb/lowered',
        'barrier/kerb/raised',
        'barrier/kerb/rolled',

        'natural/grassland',
        'natural/wood',
        'natural/bare_rock',
        'natural/cliff',
        'natural/shingle',
        'natural/coastline',

        'waterway/riverbank',
        'waterway/canal',
        'waterway/canal/lock',
        'waterway/ditch',
        'waterway/drain',
        'waterway/fish_pass',
        'waterway/river',
        'waterway/stream_intermittent',
        'waterway/stream',
        'waterway/tidal_channel',

        'man_made/bridge',

        'building/yes',
        'building/train_station',
        'building/apartments',
        'building/barn',
        'building/boathouse',
        'building/bungalow',
        'building/cabin',
        'building/carport',
        'building/cathedral',
        'building/chapel',
        'building/church',
        'building/civic',
        'building/college',
        'building/commercial',
        'building/construction',
        'building/detached',
        'building/dormitory',
        'building/farm_auxiliary',
        'building/farm',
        'building/garage',
        'building/garages',
        'building/grandstand',
        'building/greenhouse',
        'building/hangar',
        'building/hospital',
        'building/hotel',
        'building/house',
        'building/houseboat',
        'building/hut',
        'building/industrial',
        'building/kindergarten',
        'building/mosque',
        'building/pavilion',
        'building/public',
        'building/residential',
        'building/retail',
        'building/roof',
        'building/ruins',
        'building/school',
        'building/semidetached_house',
        'building/service',
        'building/shed',
        'building/stable',
        'building/stadium',
        'building/static_caravan',
        'building/temple',
        'building/terrace',
        'building/transportation',
        'building/university',
        'building/warehouse',
        'building/office',
    ]

    getTagConfigFromTagsID(tagIds: string[]): TagConfig[] {
        const tagsById = this.tagsById()
        return tagIds.flatMap((tagId) =>
            tagsById[tagId] ? [tagsById[tagId]] : []
        )
    }

    setBookMarksIds(bookmarksIds: string[]): void {
        const normalizedIds = [...new Set(bookmarksIds.filter(Boolean))]
        const hiddenIds = this.hiddenTagsIds().filter(
            (hiddenId) => !normalizedIds.includes(hiddenId)
        )
        if (hiddenIds.length !== this.hiddenTagsIds().length) {
            this.setHiddenTagsIds(hiddenIds)
        }
        this.localStorage.set('bookmarksIds', normalizedIds)
        this.bookmarksIdsState.set(normalizedIds)
    }

    setLastTagsUsedIds(lastTagsUsedIds: string[]): void {
        this.localStorage.set('lastTagsUsedIds', lastTagsUsedIds)
        this.lastTagsUsedIdsState.set(lastTagsUsedIds)
    }

    removeBookMark(tag: TagConfig): void {
        this.setBookMarksIds(
            this.bookmarksIds().filter((bookmarkId) => bookmarkId !== tag.id)
        )
    }

    addBookMark(tag: TagConfig): void {
        if (this.bookmarksIds().includes(tag.id)) {
            return
        }
        this.removeHiddenTag(tag)
        const currentTag = this.tagsById()[tag.id]
        if (!currentTag) {
            this.addUserTags(tag)
        }
        this.setBookMarksIds([tag.id, ...this.bookmarksIds()])
    }

    loadBookMarksIds$(): Observable<string[]> {
        return from(this.localStorage.get('bookmarksIds')).pipe(
            map((bookmarksIds: string[]) => {
                const normalizedIds = [
                    ...new Set((bookmarksIds ?? []).filter(Boolean)),
                ]
                const hiddenIds = this.hiddenTagsIds().filter(
                    (hiddenId) => !normalizedIds.includes(hiddenId)
                )
                if (hiddenIds.length !== this.hiddenTagsIds().length) {
                    this.setHiddenTagsIds(hiddenIds)
                }
                this.bookmarksIdsState.set(normalizedIds)
                return normalizedIds
            })
        )
    }

    // hidden tags
    loadHiddenTagsIds$(): Observable<string[]> {
        return from(this.localStorage.get('hiddenTagsIds')).pipe(
            map((hiddenTagsIds: string[]) => {
                const normalizedIds = [
                    ...new Set(
                        (hiddenTagsIds ?? this.defaultHiddenTagsIds).filter(
                            (hiddenId) =>
                                hiddenId &&
                                !this.bookmarksIds().includes(hiddenId)
                        )
                    ),
                ]
                this.hiddenTagsIdsState.set(normalizedIds)
                return normalizedIds
            })
        )
    }

    setHiddenTagsIds(hiddenTagsIds: string[]): void {
        const normalizedIds = [
            ...new Set(
                hiddenTagsIds.filter(
                    (hiddenId) =>
                        hiddenId && !this.bookmarksIds().includes(hiddenId)
                )
            ),
        ]
        this.localStorage.set('hiddenTagsIds', normalizedIds)
        this.hiddenTagsIdsState.set(normalizedIds)
    }

    removeHiddenTag(tag: TagConfig): void {
        if (!tag.id) {
            return
        }
        const newHiddenTags = this.hiddenTagsIds().filter((t) => t !== tag.id)
        this.setHiddenTagsIds(newHiddenTags)
    }

    addHiddenTag(tag: TagConfig): void {
        if (!tag.id) {
            return
        }
        if (!this.hiddenTagsIds().includes(tag.id)) {
            const newHiddenTags = [tag.id, ...this.hiddenTagsIds()]
            this.setHiddenTagsIds(newHiddenTags)
            this.removeBookMark(tag)
        }
    }

    resetHiddenTags(): void {
        const defaultHiddenTagsIds = [...this.defaultHiddenTagsIds]
        this.setHiddenTagsIds(defaultHiddenTagsIds)
    }

    removeAllHiddenTags(): void {
        this.setHiddenTagsIds([])
    }

    loadLastTagsUsedIds$(): Observable<string[]> {
        return from(this.localStorage.get('lastTagsUsedIds')).pipe(
            map((lastTagsUsedIds: string[]) => {
                lastTagsUsedIds = lastTagsUsedIds ? lastTagsUsedIds : []
                this.lastTagsUsedIdsState.set(lastTagsUsedIds)
                return lastTagsUsedIds
            })
        )
    }

    addTagTolastTagsUsed(tagId: string): TagConfig | undefined {
        if (!tagId) {
            return
        }
        const previousTagIds = this.lastTagsUsedIds().filter(
            (previousTagId) => previousTagId !== tagId
        )
        const currentTag = this.tagsById()[tagId]
        if (!currentTag) {
            return
        }

        this.setLastTagsUsedIds([tagId, ...previousTagIds].slice(0, 20))
        return currentTag
    }

    loadUserTags$(): Observable<TagConfig[]> {
        return from(this.loadValidatedUserTags())
    }

    private async loadValidatedUserTags(): Promise<TagConfig[]> {
        const persisted = await this.localStorage.get<unknown>('userTags')
        const source = Array.isArray(persisted) ? persisted : []
        const userTags = source.filter(
            (tag): tag is TagConfig =>
                !!tag &&
                typeof tag === 'object' &&
                typeof (tag as { id?: unknown }).id === 'string' &&
                (tag as { id: string }).id.trim() !== '' &&
                !!(tag as { tags?: unknown }).tags &&
                typeof (tag as { tags: unknown }).tags === 'object' &&
                !Array.isArray((tag as { tags: unknown }).tags)
        )
        const corrupted =
            (persisted !== null &&
                persisted !== undefined &&
                !Array.isArray(persisted)) ||
            userTags.length !== source.length
        this.userTagsRecoveryWarningState.set(corrupted)
        if (corrupted) {
            await Promise.allSettled([
                this.localStorage.set('userTagsCorrupted', persisted),
                this.localStorage.set('userTags', userTags),
            ])
        }
        this.userTags = userTags
        return userTags
    }

    setUserTags(userTags: TagConfig[]): void {
        this.localStorage.set('userTags', userTags)
        this.userTags = userTags
    }

    addUserTags(newTag: TagConfig): void {
        const newTagId = newTag.id
        if (this.userTags.find((t) => t.id === newTagId)) {
            return
        }
        const normalizedTag: TagConfig = {
            ...newTag,
            tags: { ...newTag.tags },
            geometry: ['point', 'vertex', 'line', 'area'],
            icon: 'maki-circle-custom',
            markerColor: '#000000',
        }
        this.userTags = [...this.userTags, normalizedTag]
        if (!this.tagsById()[newTagId]) {
            this.setTags([...this.tags(), normalizedTag])
        }
        this.setUserTags(this.userTags)
    }

    addCustomTag(keyInput: unknown, valueInput: unknown): TagConfig {
        let key: string
        let value: string
        try {
            ;({ key, value } = requireValidOsmTag(keyInput, valueInput))
        } catch (cause) {
            throw new CustomTagError('invalid', { cause })
        }

        const semanticMatches = this.tags().filter((tag) => {
            const entries = Object.entries(tag.tags)
            return (
                entries.length === 1 &&
                entries[0][0] === key &&
                String(entries[0][1]).normalize('NFC') === value
            )
        })
        if (semanticMatches.length === 1) return semanticMatches[0]
        if (semanticMatches.length > 1) {
            throw new CustomTagError('collision')
        }

        const id = `${encodeURIComponent(key)}/${encodeURIComponent(value)}`
        if (this.tagsById()[id]) throw new CustomTagError('collision')
        const customTag: TagConfig = {
            icon: 'maki-circle-custom',
            markerColor: '#000000',
            geometry: ['point', 'vertex', 'line', 'area'],
            lbl: { en: `${key} = ${value}` },
            presets: [],
            id,
            tags: { [key]: value },
            isUserTag: true,
        }
        this.addUserTags(customTag)
        return this.tagsById()[id] ?? customTag
    }

    loadSavedFields$(): Observable<Record<string, SavedField>> {
        return from(this.localStorage.get('savedFields')).pipe(
            map((d: Record<string, SavedField> | null | undefined) => {
                const res = d ? d : {}
                this.savedFields = res
                return res
            })
        )
    }

    addSavedField(tagId: string, tags: Tag[]): void {
        this.savedFields[tagId] = { tags }
        this.localStorage.set('savedFields', this.savedFields)
    }

    // Same rule as the converter: the highest priority primary key wins, not
    // the first one met in the tags.
    findPkey(featureOrTags: OsmGoFeature | Tag[]): PrimaryTag | undefined {
        const tags = Array.isArray(featureOrTags)
            ? featureOrTags
            : Object.entries(featureOrTags.properties?.tags ?? {}).map(
                  ([key, value]) => ({ key, value })
              )
        let fallback: PrimaryTag | undefined
        for (const key of this.primaryKeys()) {
            const tag = tags.find((candidate) => candidate.key === key)
            if (!tag) continue
            if (tag.value !== '') return { key, value: tag.value }
            fallback ??= { key, value: tag.value }
        }
        return fallback
    }

    getTagsConfig$(): Observable<TagsJson> {
        return this.loadJsonAsset$<TagsJson>(
            `assets/tagsAndPresets/tags.json`,
            'tags',
            requireTagsCatalog
        ).pipe(
            map((tagsConfig) => {
                this.primaryKeysState.set(tagsConfig.primaryKeys)
                return tagsConfig
            })
        )
    }

    loadPresets$(): Observable<Record<string, Preset>> {
        return this.loadJsonAsset$<Record<string, Preset>>(
            `assets/tagsAndPresets/presets.json`,
            'presets',
            (value) => requirePresetCatalog(value, 'presets')
        ).pipe(
            map((p) => {
                const json = p
                for (const k in json) {
                    json[k]._id = k
                }
                this.presetsState.set(json)
                return json
            })
        )
    }

    loadBrandPresets$(): Observable<Record<string, Preset>> {
        if (this.brandPresetsLoaded()) return of(this.presets())
        if (this.brandPresetsRequest$) return this.brandPresetsRequest$

        this.brandPresetsRequest$ = this.loadJsonAsset$<Record<string, Preset>>(
            `assets/tagsAndPresets/brandPresets.json`,
            'brands',
            (value) => requirePresetCatalog(value, 'brands')
        ).pipe(
            tap((brandPresets) => {
                for (const [id, preset] of Object.entries(brandPresets)) {
                    preset._id = id
                }
                this.presetsState.update((presets) => ({
                    ...presets,
                    ...brandPresets,
                }))
                this.brandPresetsLoadedState.set(true)
            }),
            map(() => this.presets()),
            finalize(() => {
                this.brandPresetsRequest$ = undefined
            }),
            shareReplay({ bufferSize: 1, refCount: false })
        )
        return this.brandPresetsRequest$
    }

    loadJsonSprites$(): Observable<JsonSprites> {
        const devicePixelRatio = window.devicePixelRatio > 1 ? 2 : 1
        const url =
            devicePixelRatio === 1
                ? `assets/mapStyle/sprites/sprites.json`
                : `assets/mapStyle/sprites/sprites@2x.json`
        return this.loadJsonAsset$(url, 'sprites', requireSpriteCatalog).pipe(
            map((jsonSprites) => {
                this.jsonSpritesState.set(jsonSprites)
                return jsonSprites
            })
        )
    }

    loadTags$(): Observable<TagConfig[]> {
        return forkJoin(this.getTagsConfig$(), this.loadUserTags$()).pipe(
            map(([tagsConfig, userTags]: [TagsJson, TagConfig[]]) => {
                // Built-in definitions are authoritative; user tags only fill
                // IDs that are absent from the generated catalog.
                const builtInIds = new Set(tagsConfig.tags.map((tag) => tag.id))
                const tags: TagConfig[] = [
                    ...tagsConfig.tags,
                    ...userTags.filter((tag) => !builtInIds.has(tag.id)),
                ]
                this.setTags(tags)
                return tags
            })
        )
    }

    private setTags(tags: TagConfig[]): void {
        const startedAt = performance.now()
        const tagsById = Object.fromEntries(tags.map((tag) => [tag.id, tag]))
        const indexMs = performance.now() - startedAt
        this.tagsState.set(tags)
        this.tagsByIdState.set(tagsById)
        const currentMetric = this.catalogMetricsState().tags
        this.recordCatalogMetric('tags', {
            characters: currentMetric?.characters ?? 0,
            downloadMs: currentMetric?.downloadMs ?? 0,
            parseMs: currentMetric?.parseMs ?? 0,
            indexMs,
        })
    }

    private loadJsonAsset$<T>(
        url: string,
        resource: 'tags' | 'presets' | 'brands' | 'sprites',
        validate: (value: unknown) => T
    ): Observable<T> {
        return defer(() => {
            const requestedAt = performance.now()
            return this.http.get(url, { responseType: 'text' }).pipe(
                map((response) => {
                    const receivedAt = performance.now()
                    const parseStartedAt = performance.now()
                    // Production receives text so JSON parsing can be timed.
                    // Object responses keep lightweight test doubles possible.
                    const parsed: unknown =
                        typeof response === 'string'
                            ? JSON.parse(response)
                            : response
                    const validated = validate(parsed)
                    const parsedAt = performance.now()
                    const currentMetric = this.catalogMetricsState()[resource]
                    this.recordCatalogMetric(resource, {
                        characters:
                            typeof response === 'string'
                                ? response.length
                                : JSON.stringify(response).length,
                        downloadMs: receivedAt - requestedAt,
                        parseMs: parsedAt - parseStartedAt,
                        ...(currentMetric?.indexMs === undefined
                            ? {}
                            : { indexMs: currentMetric.indexMs }),
                    })
                    return validated
                }),
                switchMap((value) =>
                    this.storeCatalogFallback$(resource, value)
                ),
                catchError((sourceError: unknown) =>
                    this.loadCatalogFallback$(resource, validate, sourceError)
                )
            )
        })
    }

    private recordCatalogMetric(
        resource: CatalogResource,
        metric: CatalogLoadMetric
    ): void {
        this.catalogMetricsState.update((metrics) => ({
            ...metrics,
            [resource]: metric,
        }))
        if (!isDevMode()) return

        const budgets = catalogPerformanceBudgets[resource]
        for (const phase of ['parseMs', 'indexMs'] as const) {
            const durationMs = metric[phase]
            const budgetMs = budgets[phase]
            if (
                durationMs !== undefined &&
                budgetMs !== undefined &&
                durationMs > budgetMs
            ) {
                console.warn(
                    `Catalog ${resource} ${phase} exceeded its development budget.`,
                    { durationMs, budgetMs, characters: metric.characters }
                )
            }
        }
    }

    private storeCatalogFallback$<T>(
        resource: CatalogResource,
        value: T
    ): Observable<T> {
        const cache: CatalogCache<T> = {
            schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
            value,
        }
        return defer(() =>
            from(this.localStorage.set(this.catalogCacheKey(resource), cache))
        ).pipe(
            map(() => value),
            catchError((error: unknown) => {
                console.warn(`Could not cache the ${resource} catalog.`, error)
                return of(value)
            })
        )
    }

    private loadCatalogFallback$<T>(
        resource: CatalogResource,
        validate: (value: unknown) => T,
        sourceError: unknown
    ): Observable<T> {
        return defer(() =>
            from(this.localStorage.get<unknown>(this.catalogCacheKey(resource)))
        ).pipe(
            map((cached) => requireCatalogCache(cached, validate).value),
            tap(() =>
                console.warn(
                    `Using the last valid ${resource} catalog.`,
                    sourceError
                )
            ),
            catchError((cacheError: unknown) =>
                throwError(
                    () =>
                        new Error(
                            `Could not load a valid ${resource} catalog.`,
                            { cause: sourceError ?? cacheError }
                        )
                )
            )
        )
    }

    private catalogCacheKey(resource: CatalogResource): string {
        return `catalogCache:v${CATALOG_CACHE_SCHEMA_VERSION}:${resource}`
    }
}
