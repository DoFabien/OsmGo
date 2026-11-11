import { computed, inject, Service, signal } from '@angular/core'
import { cloneDeep } from '@app/utils/clone'
import { isDeepEqual } from '@app/utils/deep-equal'
import { withWebLock } from '@app/utils/web-lock'
import type {
    FeatureIdSource,
    OsmGoFeature,
    OsmGoFeatureCollection,
} from '@osmgo/type'
import { AppStorage } from '@services/app-storage.service'
import {
    requireGeometryFeatureCollection,
    requireOsmGoFeature,
    requireOsmGoFeatureCollection,
} from '@services/osm-data-validation'
import {
    composePersistedOsmState,
    isPersistedOsmStateHead,
    migrateLegacyOsmStateWithQuarantine,
    OSM_OFFICIAL_SLOT_KEYS,
    OSM_STATE_HEAD_SCHEMA_VERSION,
    OSM_STATE_SCHEMA_VERSION,
    OSM_STATE_STORAGE_KEY,
    OSM_STATE_STORAGE_KEYS,
    type OsmOfficialSlot,
    OsmStateConflictError,
    OsmStatePersistenceError,
    type PersistedOfficialData,
    type PersistedOfficialDelta,
    type PersistedOfficialReference,
    type PersistedOsmStateHead,
    type PersistedOsmStateV2,
    type PersistedUploadJournal,
    type QuarantinedOsmFeature,
    readOfficialReference,
    recoverPersistedOsmState,
} from '@services/osm-state'
import { featureCollection } from '@turf/helpers'
import { from, type Observable } from 'rxjs'
import { map } from 'rxjs/operators'

export interface OsmDownload {
    geojson: OsmGoFeatureCollection
    geojsonBbox: OsmGoFeatureCollection
}

export interface UploadReceiptEntry {
    oldId: string
    feature?: OsmGoFeature
}

const OSM_STATE_LOCK_NAME = 'osmgo-osm-state'
/** Tiny cross-window marker: the revision of the last persisted OSM state. */
const OSM_STATE_REVISION_MARKER_KEY = 'osmgo:osmStateRevision'
export const OSM_STATE_QUARANTINE_KEY = 'osmStateQuarantinedFeatures'
const OSM_STATE_BACKUP_PREFIX = 'osmStateBackup:'
const MAX_OSM_STATE_BACKUPS = 3
const LEGACY_V1_KEYS = ['geojson', 'geojsonChanged', 'geojsonBbox']
/**
 * Above this many official objects changed since the last download, the
 * official slot is rewritten instead of carrying the changes in the head.
 */
const MAX_OFFICIAL_DELTA_SIZE = 250

/** A pending object is locked by an unresolved upload attempt. */
export class UploadQueueLockedError extends Error {
    readonly name = 'UploadQueueLockedError'

    constructor(readonly lockedIds: string[]) {
        super(
            `The upload attempt must be resolved before changing: ${lockedIds.join(', ')}.`
        )
    }
}

export const isUploadQueueLockedError = (
    error: unknown
): error is UploadQueueLockedError => error instanceof UploadQueueLockedError

/** The queue no longer matches what an upload attempt was prepared from. */
export class UploadQueueChangedError extends Error {
    readonly name = 'UploadQueueChangedError'

    constructor(readonly changedIds: string[]) {
        super(
            `The local changes were modified while the upload was prepared: ${changedIds.join(', ')}.`
        )
    }
}

/** The local data cannot be wiped while a request is in progress. */
export class UploadInFlightError extends Error {
    readonly name = 'UploadInFlightError'

    constructor() {
        super('Local data cannot be cleared while changes are being uploaded.')
    }
}

interface NodeReferences {
    ways: string[]
    relations: string[]
}

type QuarantineSource = NonNullable<QuarantinedOsmFeature['source']>

/** Sets objects aside; they are saved before the commit that removes them. */
type SetAside = (
    entries: QuarantinedOsmFeature[],
    source: QuarantineSource
) => void

interface LoadedOsmState {
    state: PersistedOsmStateV2
    official: PersistedOfficialReference
}

@Service()
export class DataService {
    readonly localStorage = inject(AppStorage)

    /**
     * Primary data storage for official OSM POIs.
     * Don't read from this value directly. Instead use the `geojson` member
     * variable.
     *
     * A hashmap is used to have a constant time complexity when looking up
     * entries with a known ID.
     */
    private _geojson: Record<string, OsmGoFeature> = {}

    /**
     * Primary data storage for self-created or modified POIs.
     * Don't read from this value directly. Instead use the `geojsonChanged`
     * member variable.
     *
     * A hashmap is used to have a constant time complexity when looking up
     * entries with a known ID.
     */
    private _geojsonChanged: Record<string, OsmGoFeature> = {}
    private readonly changedDataRevisionState = signal(0)
    readonly changedFeatureCount = computed(() => {
        this.changedDataRevisionState()
        return Object.keys(this._geojsonChanged).length
    })

    private _geojsonBbox: OsmGoFeatureCollection = featureCollection(
        []
    ) as OsmGoFeatureCollection

    /** Next unused ID that can be used for a new feature. */
    private _nextTemporaryId = -1
    private _osmStateRevision = 0
    private _uploadJournal?: PersistedUploadJournal
    private _officialSlot: OsmOfficialSlot | null = null
    private _officialRevision = 0
    private _officialDelta: PersistedOfficialDelta = {}
    private osmStateMutationQueue: Promise<void> = Promise.resolve()
    private knownRevisionMarker: string | null = this.readRevisionMarker()
    private storageCleared = false
    /** Official objects an upload or a cancellation restored meanwhile. */
    private readonly keptOnNextDownloadIds = new Set<string>()

    /** Every pending object, as a signal that follows each persisted commit. */
    readonly changedFeatures = computed(() => {
        this.changedDataRevisionState()
        return this.geojsonChanged.features
    })
    readonly hasActiveUploadJournal = computed(() => {
        this.changedDataRevisionState()
        return this._uploadJournal !== undefined
    })
    private readonly uploadInFlightState = signal(false)
    /** True while a request to OpenStreetMap is being prepared or running. */
    readonly uploadInFlight = this.uploadInFlightState.asReadonly()
    private readonly quarantinedCountState = signal(0)
    private readonly quarantinedPendingCountState = signal(0)
    private readonly newlyQuarantinedCountState = signal(0)
    /** Objects set aside by the load that just ran (migration or recovery). */
    readonly newlyQuarantinedCount =
        this.newlyQuarantinedCountState.asReadonly()
    /** Objects set aside as unreadable; they stay exportable until cleared. */
    readonly quarantinedCount = this.quarantinedCountState.asReadonly()
    readonly quarantinedPendingCount =
        this.quarantinedPendingCountState.asReadonly()
    private readonly externalStateChangeState = signal(false)
    /**
     * True once another window of the application changed the persisted OSM
     * state: this window must be reloaded before it can save anything.
     */
    readonly externalStateChange = this.externalStateChangeState.asReadonly()

    constructor() {
        try {
            window.addEventListener('storage', (event) => {
                if (
                    event.key === OSM_STATE_REVISION_MARKER_KEY ||
                    event.key === null
                ) {
                    if (event.newValue !== this.knownRevisionMarker) {
                        this.externalStateChangeState.set(true)
                    }
                }
            })
        } catch {
            // Storage events are an optimisation: saves are still checked.
        }
    }

    setUploadInFlight(inFlight: boolean): void {
        this.uploadInFlightState.set(inFlight)
    }

    /**
     * True when wiping local data would lose work: pending changes or an
     * unresolved upload attempt.
     */
    hasPendingWork(): boolean {
        return this.changedFeatureCount() > 0 || this.hasActiveUploadJournal()
    }

    /**
     * The official objects as a new collection that shares the stored
     * objects: callers must treat them as read-only (copy before editing, as
     * `getFeatureById` does). Commands never edit a stored object in place, so
     * a collection stays a consistent snapshot. Cloning 10 000 objects on
     * every redraw was the main cost of a map update.
     */
    get geojson(): OsmGoFeatureCollection {
        return featureCollection(
            Object.values(this._geojson)
        ) as OsmGoFeatureCollection
    }

    /** The pending objects, read-only like `geojson`. */
    get geojsonChanged(): OsmGoFeatureCollection {
        return featureCollection(
            Object.values(this._geojsonChanged)
        ) as OsmGoFeatureCollection
    }

    async addIconCache(idIcon: string, uri: string): Promise<void> {
        await this.localStorage.set(idIcon, uri)
    }

    getIconCache(idIcon: string): Promise<unknown> {
        return this.localStorage.get(idIcon)
    }

    loadOsmState$(): Observable<PersistedOsmStateV2> {
        return from(
            withWebLock(OSM_STATE_LOCK_NAME, async () => {
                const loaded = await this.loadPersistedOsmState()
                this.setRevisionMarker(String(loaded.state.revision))
                return loaded
            })
        ).pipe(
            // The loaded state was just built by validation and is owned
            // here: it is kept and returned without copies, read-only like
            // `geojson`.
            map(({ state, official }) => {
                this._geojson = state.officialById
                this._geojsonChanged = state.pendingById
                this._geojsonBbox = state.bbox
                this._nextTemporaryId = state.nextTemporaryId
                this._osmStateRevision = state.revision
                this._uploadJournal = state.uploadJournal
                this.setOfficialReference(official)
                this.externalStateChangeState.set(false)
                this.notifyChangedData()
                return state
            })
        )
    }

    private async loadPersistedOsmState(): Promise<LoadedOsmState> {
        const persisted = await this.localStorage.get(OSM_STATE_STORAGE_KEY)
        if (persisted !== null && persisted !== undefined) {
            let source: unknown = persisted
            let reference: PersistedOfficialReference | undefined
            let officialDropped = false
            if (isPersistedOsmStateHead(persisted)) {
                reference = readOfficialReference(persisted)
                const officialData =
                    reference.slot === null
                        ? null
                        : await this.localStorage.get(
                              OSM_OFFICIAL_SLOT_KEYS[reference.slot]
                          )
                ;({ value: source, officialDropped } = composePersistedOsmState(
                    persisted,
                    officialData
                ))
                if (officialDropped) {
                    console.warn(
                        'The saved official OSM data did not match the local changes: it was dropped.'
                    )
                }
            }
            const { state, quarantined } = recoverPersistedOsmState(source)
            this.newlyQuarantinedCountState.set(quarantined.length)
            if (quarantined.length === 0) await this.refreshQuarantineCount()
            if (quarantined.length > 0) {
                await this.appendQuarantine(
                    quarantined,
                    'persisted-state',
                    typeof persisted === 'object' && persisted !== null
                        ? ((persisted as { revision?: unknown }).revision ??
                              null)
                        : null
                )
            }
            if (reference && !officialDropped && quarantined.length === 0) {
                return {
                    state,
                    official: {
                        ...reference,
                        delta: this.officialDeltaFromState(
                            reference.delta,
                            state
                        ),
                    },
                }
            }
            return {
                state,
                official: await this.writeFullOsmState(
                    state,
                    reference?.slot ?? null
                ),
            }
        }

        const [geojson, geojsonChanged, geojsonBbox] = await Promise.all([
            this.localStorage.get<OsmGoFeatureCollection>('geojson'),
            this.localStorage.get<OsmGoFeatureCollection>('geojsonChanged'),
            this.localStorage.get<OsmGoFeatureCollection>('geojsonBbox'),
        ])
        const { state, quarantined } = migrateLegacyOsmStateWithQuarantine({
            geojson,
            geojsonChanged,
            geojsonBbox,
        })
        this.newlyQuarantinedCountState.set(quarantined.length)
        if (quarantined.length > 0) {
            await this.appendQuarantine(quarantined, 'v1-migration', null)
        } else {
            await this.refreshQuarantineCount()
        }
        const official = await this.writeFullOsmState(state, null)
        await Promise.all(
            LEGACY_V1_KEYS.map((key) => this.localStorage.remove(key))
        )
        return { state, official }
    }

    /** The loaded delta, pointing at the validated objects now in memory. */
    private officialDeltaFromState(
        delta: PersistedOfficialDelta,
        state: PersistedOsmStateV2
    ): PersistedOfficialDelta {
        const next: PersistedOfficialDelta = {}
        for (const id of Object.keys(delta)) {
            next[id] = state.officialById[id] ?? null
        }
        return next
    }

    /**
     * Writes the official data to the slot the head does not use, then the
     * head that switches to it: until that second write, the previous slot
     * and head stay untouched and consistent.
     */
    private async writeFullOsmState(
        state: PersistedOsmStateV2,
        currentSlot: OsmOfficialSlot | null
    ): Promise<PersistedOfficialReference> {
        const slot: OsmOfficialSlot = currentSlot === 'a' ? 'b' : 'a'
        const official: PersistedOfficialReference = {
            slot,
            revision: state.revision,
            delta: {},
        }
        const officialData: PersistedOfficialData = {
            schemaVersion: OSM_STATE_HEAD_SCHEMA_VERSION,
            revision: state.revision,
            officialById: state.officialById,
            bbox: state.bbox,
        }
        await this.localStorage.set(OSM_OFFICIAL_SLOT_KEYS[slot], officialData)
        await this.localStorage.set(
            OSM_STATE_STORAGE_KEY,
            this.toPersistedHead(state, official)
        )
        if (currentSlot) {
            try {
                await this.localStorage.remove(
                    OSM_OFFICIAL_SLOT_KEYS[currentSlot]
                )
            } catch (error) {
                // The next download overwrites the unused slot anyway.
                console.warn('Could not remove the previous OSM data.', error)
            }
        }
        return official
    }

    private toPersistedHead(
        state: PersistedOsmStateV2,
        official: PersistedOfficialReference
    ): PersistedOsmStateHead {
        return {
            schemaVersion: OSM_STATE_HEAD_SCHEMA_VERSION,
            revision: state.revision,
            pendingById: state.pendingById,
            nextTemporaryId: state.nextTemporaryId,
            ...(state.uploadJournal
                ? { uploadJournal: state.uploadJournal }
                : {}),
            official,
        }
    }

    private setOfficialReference(official: PersistedOfficialReference): void {
        this._officialSlot = official.slot
        this._officialRevision = official.revision
        this._officialDelta = official.delta
    }

    /**
     * Sets the stored OSM state aside so the next start begins from a clean
     * slate: the head (pending queue and upload journal) and the V1
     * collections a migration would read again are copied under another name
     * first; the downloaded official data is not, the next download restores
     * it. Nothing is removed when no copy could be written. Like `clearCache`,
     * it waits for the running commits and blocks new ones until the
     * application reloads. `includeQuarantine` also sets the objects put in
     * quarantine aside (they belong to the OSM server being left).
     * Returns the backup key, or `undefined` when there was nothing to save.
     */
    async resetStoredOsmState(
        options: { includeQuarantine?: boolean } = {}
    ): Promise<string | undefined> {
        if (this.uploadInFlightState()) throw new UploadInFlightError()
        this.storageCleared = true
        try {
            await this.osmStateMutationQueue
            return await withWebLock(OSM_STATE_LOCK_NAME, () =>
                this.resetStoredOsmStateUnderLock(options)
            )
        } catch (error) {
            this.storageCleared = false
            throw error
        }
    }

    private async resetStoredOsmStateUnderLock(options: {
        includeQuarantine?: boolean
    }): Promise<string | undefined> {
        const savedKeys = [
            OSM_STATE_STORAGE_KEY,
            ...LEGACY_V1_KEYS,
            ...(options.includeQuarantine ? [OSM_STATE_QUARANTINE_KEY] : []),
        ]
        const entries: Record<string, unknown> = {}
        for (const key of savedKeys) {
            try {
                const value = await this.localStorage.get(key)
                if (value !== null && value !== undefined) entries[key] = value
            } catch (error) {
                console.warn(`Could not read ${key} before the reset.`, error)
            }
        }

        let backupKey: string | undefined
        if (Object.keys(entries).length > 0) {
            backupKey = await this.writeStateBackup(entries)
            if (!backupKey) {
                // The official data can be downloaded again: free its space.
                await this.removeOfficialSlots()
                backupKey = await this.writeStateBackup(entries)
            }
            if (!backupKey) {
                throw new Error(
                    'The local OSM data could not be backed up: it was kept.'
                )
            }
        }

        await Promise.all(
            [...new Set([...OSM_STATE_STORAGE_KEYS, ...savedKeys])].map((key) =>
                this.localStorage.remove(key)
            )
        )
        if (options.includeQuarantine) {
            this.publishQuarantineCounts([])
        }
        this.clearRevisionMarker()
        return backupKey
    }

    private async writeStateBackup(
        entries: Record<string, unknown>
    ): Promise<string | undefined> {
        const backedUpAt = new Date().toISOString()
        const key = `${OSM_STATE_BACKUP_PREFIX}${backedUpAt}`
        try {
            await this.localStorage.set(key, { backedUpAt, entries })
        } catch (error) {
            console.error('Could not back up the OSM state.', error)
            return undefined
        }
        try {
            await this.pruneStateBackups()
        } catch (error) {
            console.warn('Could not remove the oldest backups.', error)
        }
        return key
    }

    private async removeOfficialSlots(): Promise<void> {
        for (const key of Object.values(OSM_OFFICIAL_SLOT_KEYS)) {
            try {
                await this.localStorage.remove(key)
            } catch (error) {
                console.warn(`Could not remove ${key}.`, error)
            }
        }
    }

    /** The copies kept by `resetStoredOsmState`, oldest first, to export them. */
    async getStateBackups(): Promise<
        Array<{ key: string; backedUpAt: unknown; entries: unknown }>
    > {
        const keys = (await this.localStorage.keys())
            .filter((key) => key.startsWith(OSM_STATE_BACKUP_PREFIX))
            .sort()
        const backups: Array<{
            key: string
            backedUpAt: unknown
            entries: unknown
        }> = []
        for (const key of keys) {
            const value = await this.localStorage.get<{
                backedUpAt?: unknown
                entries?: unknown
            }>(key)
            if (value) {
                backups.push({
                    key,
                    backedUpAt: value.backedUpAt ?? null,
                    entries: value.entries ?? null,
                })
            }
        }
        return backups
    }

    private async pruneStateBackups(): Promise<void> {
        const backups = (await this.localStorage.keys())
            .filter((key) => key.startsWith(OSM_STATE_BACKUP_PREFIX))
            .sort()
        for (const key of backups.slice(0, -MAX_OSM_STATE_BACKUPS)) {
            await this.localStorage.remove(key)
        }
    }

    /** Objects set aside while loading, oldest first. */
    async getQuarantinedFeatures(): Promise<QuarantinedOsmFeature[]> {
        return this.toQuarantineFeatures(
            await this.localStorage.get(OSM_STATE_QUARANTINE_KEY)
        )
    }

    async clearQuarantine(): Promise<void> {
        await this.localStorage.remove(OSM_STATE_QUARANTINE_KEY)
        this.quarantinedCountState.set(0)
        this.quarantinedPendingCountState.set(0)
    }

    private async appendQuarantine(
        entries: QuarantinedOsmFeature[],
        source: QuarantineSource,
        sourceRevision: unknown
    ): Promise<void> {
        const previous = await this.localStorage.get(OSM_STATE_QUARANTINE_KEY)
        const existing = this.toQuarantineFeatures(previous)
        const quarantinedAt = new Date().toISOString()
        const added = entries
            .map((entry) => ({ ...entry, quarantinedAt, source }))
            .filter(
                (entry) =>
                    !existing.some(
                        (known) =>
                            known.store === entry.store &&
                            known.id === entry.id &&
                            known.source === entry.source &&
                            isDeepEqual(known.value, entry.value)
                    )
            )
        const features = [...existing, ...added]
        if (added.length > 0) {
            await this.localStorage.set(OSM_STATE_QUARANTINE_KEY, {
                quarantinedAt,
                sourceRevision: sourceRevision ?? null,
                features,
            })
        }
        this.publishQuarantineCounts(features)
    }

    private publishQuarantineCounts(features: QuarantinedOsmFeature[]): void {
        this.quarantinedCountState.set(features.length)
        this.quarantinedPendingCountState.set(
            features.filter((feature) => feature.store === 'pending').length
        )
    }

    private toQuarantineFeatures(value: unknown): QuarantinedOsmFeature[] {
        const features =
            typeof value === 'object' && value !== null
                ? (value as { features?: unknown }).features
                : undefined
        return Array.isArray(features)
            ? (features as QuarantinedOsmFeature[])
            : []
    }

    private async refreshQuarantineCount(): Promise<void> {
        try {
            const features = this.toQuarantineFeatures(
                await this.localStorage.get(OSM_STATE_QUARANTINE_KEY)
            )
            this.quarantinedCountState.set(features.length)
            this.quarantinedPendingCountState.set(
                features.filter((feature) => feature.store === 'pending').length
            )
        } catch (error) {
            console.warn('Could not read the quarantined objects.', error)
        }
    }

    async getKeysCacheIcon(): Promise<string[]> {
        const allKeys: string[] = await this.localStorage.keys()
        return allKeys.filter(
            (k) => /^circle/.test(k) || /^square/.test(k) || /^penta/.test(k)
        )
    }

    async clearIconCache(): Promise<number> {
        const keys: string[] = await this.getKeysCacheIcon()
        let n: number = 0
        for (const key of keys) {
            await this.localStorage.remove(key)
            n++
        }
        return n
    }

    /**
     * Wipes every stored value, including pending changes and the token. The
     * wipe waits for the running state commits and then blocks new ones, so
     * nothing is written back before the application reloads. It is refused
     * while a request to OpenStreetMap is in progress; callers should check
     * `hasPendingWork()` and ask for confirmation first.
     */
    async clearCache(): Promise<void> {
        if (this.uploadInFlightState()) throw new UploadInFlightError()
        this.storageCleared = true
        try {
            await this.osmStateMutationQueue
            await this.localStorage.clear()
            localStorage.clear()
            this.knownRevisionMarker = null
        } catch (error) {
            this.storageCleared = false
            throw error
        }
    }

    getGeojsonBbox(): OsmGoFeatureCollection {
        return cloneDeep(this._geojsonBbox)
    }

    getGeojson(): OsmGoFeatureCollection {
        return this.geojson
    }

    applyDownload(download: OsmDownload): Promise<void> {
        const validatedGeojson = requireOsmGoFeatureCollection(
            download.geojson,
            'downloaded OSM data',
            'official'
        )
        const officialById = this.collectionToRecord(
            validatedGeojson,
            'downloaded feature',
            true
        )
        const bbox = requireGeometryFeatureCollection(
            download.geojsonBbox,
            'downloaded bbox data'
        )
        return this.enqueueOsmStateMutation('apply download', (state) => {
            // A download can be older than an upload that was reconciled while
            // it was converted: never replace a newer version with an older
            // one, and keep what that upload just created. The conversion also
            // left out the objects pending when it started: keep those whose
            // change was cancelled since.
            const merged: Record<string, OsmGoFeature> = {}
            for (const [id, downloaded] of Object.entries(officialById)) {
                if (state.pendingById[id]) continue
                const current = state.officialById[id]
                merged[id] =
                    current &&
                    this.versionOf(current) > this.versionOf(downloaded)
                        ? current
                        : downloaded
            }
            for (const id of this.keptOnNextDownloadIds) {
                const current = state.officialById[id]
                if (current && !merged[id] && !state.pendingById[id]) {
                    merged[id] = current
                }
            }
            this.keptOnNextDownloadIds.clear()
            state.officialById = merged
            state.bbox = bbox
        })
    }

    private versionOf(feature: OsmGoFeature): number {
        const version = feature.properties?.meta?.version
        return typeof version === 'number' ? version : 0
    }

    /** True when an OSM id (`node/111`) is in the local official or pending data. */
    isKnownFeatureId(id: string): boolean {
        return id in this._geojson || id in this._geojsonChanged
    }

    /**
     * Looks up a feature with a given ID.
     *
     * If the source is `data`, the original OSM geojson features are searched
     * through, otherwise the local modified features are used for the lookup.
     *
     * @returns A deep copy of the feature if found, otherwise `undefined`.
     */
    getFeatureById(
        id: string,
        source: FeatureIdSource
    ): OsmGoFeature | undefined {
        const feature =
            source === 'data_changed'
                ? this._geojsonChanged[id]
                : this._geojson[id]
        return feature ? cloneDeep(feature) : undefined
    }

    /**
     * Retrieve a geojson feature collection of all changed
     * (created/modified/deleted) elements.
     *
     * @returns A deep copy of the geojson feature collection of all changed
     * elements.
     */
    getGeojsonChanged(): OsmGoFeatureCollection {
        return this.geojsonChanged
    }

    private notifyChangedData(): void {
        this.changedDataRevisionState.update((revision) => revision + 1)
    }

    async replacePendingFeatures(data: OsmGoFeatureCollection): Promise<void> {
        const validatedData = requireOsmGoFeatureCollection(
            data,
            'replacement pending data',
            'pending'
        )
        const nextGeojsonChanged = this.collectionToRecord(
            validatedData,
            'pending feature'
        )
        await this.enqueueOsmStateMutation('replace pending data', (state) => {
            this.assertUploadQueueUnlocked(
                state,
                Object.keys(state.pendingById)
            )
            state.pendingById = nextGeojsonChanged
            for (const id of Object.keys(nextGeojsonChanged)) {
                delete state.officialById[id]
            }
            state.nextTemporaryId = this.getNextTemporaryId(nextGeojsonChanged)
        })
    }

    createPendingFeature(input: OsmGoFeature): Promise<OsmGoFeature> {
        const feature = cloneDeep(input)
        return this.enqueueOsmStateMutation(
            'create pending feature',
            (state) => {
                const temporaryId = state.nextTemporaryId
                if (!Number.isInteger(temporaryId) || temporaryId >= 0) {
                    throw new Error('The temporary ID allocator is invalid.')
                }
                const type = feature.properties.type
                if (type !== 'node' || feature.geometry.type !== 'Point') {
                    throw new Error('Only OSM nodes can be created locally.')
                }

                feature.id = `${type}/${temporaryId}`
                feature.properties.id = temporaryId
                feature.properties.changeType = 'Create'
                feature.properties.originalData = null
                feature.properties.meta.version = 0
                const validated = requireOsmGoFeature(
                    feature,
                    'created pending feature',
                    'pending'
                )
                state.pendingById[this.requireFeatureId(validated)] = validated
                state.nextTemporaryId = temporaryId - 1
                return cloneDeep(validated)
            }
        )
    }

    moveOfficialToPending(
        id: string,
        patch: OsmGoFeature
    ): Promise<OsmGoFeature> {
        const changedFeature = cloneDeep(patch)
        return this.enqueueOsmStateMutation(
            'move official feature to pending',
            (state) => {
                this.assertUploadQueueUnlocked(state, [id])
                const original = state.officialById[id]
                if (!original) {
                    throw new Error('The original feature data is missing.')
                }
                this.copyCanonicalIdentity(changedFeature, original)
                changedFeature.properties.changeType = 'Update'
                changedFeature.properties.originalData = cloneDeep(original)
                delete state.officialById[id]
                const validated = requireOsmGoFeature(
                    changedFeature,
                    'updated pending feature',
                    'pending'
                )
                state.pendingById[id] = validated
                return cloneDeep(validated)
            }
        )
    }

    updatePendingFeature(
        id: string,
        patch: OsmGoFeature
    ): Promise<OsmGoFeature> {
        const changedFeature = cloneDeep(patch)
        return this.enqueueOsmStateMutation(
            'update pending feature',
            (state) => {
                this.assertUploadQueueUnlocked(state, [id])
                const current = state.pendingById[id]
                if (!current) {
                    throw new Error('The pending feature data is missing.')
                }
                this.copyCanonicalIdentity(changedFeature, current)
                changedFeature.properties.changeType =
                    current.properties.changeType
                changedFeature.properties.originalData = cloneDeep(
                    current.properties.originalData
                )
                const validated = requireOsmGoFeature(
                    changedFeature,
                    'updated pending feature',
                    'pending'
                )
                state.pendingById[id] = validated
                return cloneDeep(validated)
            }
        )
    }

    markPendingDeleted(id: string): Promise<OsmGoFeature | undefined> {
        return this.enqueueOsmStateMutation(
            'mark pending feature deleted',
            (state) => {
                this.assertUploadQueueUnlocked(state, [id])
                const pending = state.pendingById[id]
                if (pending?.properties.changeType === 'Create') {
                    delete state.pendingById[id]
                    return undefined
                }

                const official = state.officialById[id]
                const source = pending ?? official
                if (!source) {
                    throw new Error('The feature data is missing.')
                }
                const original = pending
                    ? this.requireOriginalFeature(pending)
                    : cloneDeep(official)
                if (!original) {
                    throw new Error('The original feature data is missing.')
                }

                const deletedFeature = cloneDeep(source)
                this.copyCanonicalIdentity(deletedFeature, original)
                deletedFeature.properties.changeType = 'Delete'
                deletedFeature.properties.originalData = cloneDeep(original)
                delete state.officialById[id]
                const validated = requireOsmGoFeature(
                    deletedFeature,
                    'deleted pending feature',
                    'pending'
                )
                state.pendingById[id] = validated
                return cloneDeep(validated)
            }
        )
    }

    /**
     * Drops a local change. `current`, the version now on OpenStreetMap,
     * replaces the one the change started from when it is known (after a
     * version conflict).
     */
    cancelPendingChange(id: string, current?: OsmGoFeature): Promise<void> {
        const replacement = current
            ? requireOsmGoFeature(
                  cloneDeep(current),
                  'current OSM version',
                  'official'
              )
            : undefined
        return this.enqueueOsmStateMutation(
            'cancel pending change',
            (state) => {
                this.assertUploadQueueUnlocked(state, [id])
                const pending = state.pendingById[id]
                if (!pending) {
                    throw new Error('The pending feature data is missing.')
                }
                if (pending.properties.changeType !== 'Create') {
                    const official =
                        replacement ?? this.requireOriginalFeature(pending)
                    if (replacement)
                        this.copyCanonicalIdentity(official, pending)
                    state.officialById[id] = official
                    this.keptOnNextDownloadIds.add(id)
                }
                delete state.pendingById[id]
            }
        )
    }

    /**
     * Drops a pending change on an object OpenStreetMap reports as deleted
     * (HTTP 410): restoring the outdated version would show an object that no
     * longer exists, and keep it through the next download.
     */
    discardGoneFeature(id: string): Promise<void> {
        return this.enqueueOsmStateMutation('discard gone feature', (state) => {
            this.assertUploadQueueUnlocked(state, [id])
            if (!state.pendingById[id]) {
                throw new Error('The pending feature data is missing.')
            }
            delete state.pendingById[id]
            delete state.officialById[id]
            this.keptOnNextDownloadIds.delete(id)
        })
    }

    cancelAllPendingChanges(): Promise<void> {
        return this.enqueueOsmStateMutation(
            'cancel all pending changes',
            (state) => {
                this.assertUploadQueueUnlocked(
                    state,
                    Object.keys(state.pendingById)
                )
                for (const [id, pending] of Object.entries(state.pendingById)) {
                    if (pending.properties.changeType !== 'Create') {
                        state.officialById[id] =
                            this.requireOriginalFeature(pending)
                        this.keptOnNextDownloadIds.add(id)
                    }
                }
                state.pendingById = {}
                state.nextTemporaryId = -1
            }
        )
    }

    async applyUploadReceipt(results: UploadReceiptEntry[]): Promise<void> {
        const receipt = cloneDeep(results)
        for (const result of receipt) {
            if (result.feature) {
                result.feature = requireOsmGoFeature(
                    result.feature,
                    'uploaded official feature',
                    'official'
                )
            }
        }
        await this.enqueueOsmStateMutation('apply upload receipt', (state) => {
            this.applyReceiptToState(
                state,
                receipt,
                Object.keys(state.pendingById)
            )
        })
    }

    getUploadJournal(): PersistedUploadJournal | undefined {
        return this._uploadJournal ? cloneDeep(this._uploadJournal) : undefined
    }

    beginUploadAttempt(
        journal: Extract<PersistedUploadJournal, { phase: 'prepared' }>
    ): Promise<void> {
        const prepared = cloneDeep(journal)
        return this.enqueueOsmStateMutation('begin upload attempt', (state) => {
            if (state.uploadJournal) {
                throw new Error('An upload journal is already active.')
            }
            if (prepared.journalVersion === 2) {
                const changedIds = prepared.submissions
                    .filter(
                        ({ oldId, feature }) =>
                            !isDeepEqual(state.pendingById[oldId], feature)
                    )
                    .map(({ oldId }) => oldId)
                if (changedIds.length > 0) {
                    throw new UploadQueueChangedError(changedIds)
                }
            }
            state.uploadJournal = prepared
        })
    }

    acknowledgeUploadAttempt(
        attemptId: string,
        rawReceipt: unknown,
        acknowledgedAt: string
    ): Promise<void> {
        const receipt = cloneDeep(rawReceipt)
        return this.enqueueOsmStateMutation(
            'acknowledge upload attempt',
            (state) => {
                const journal = state.uploadJournal
                if (
                    journal?.attemptId !== attemptId ||
                    journal.phase !== 'prepared'
                ) {
                    throw new Error('The active upload journal is invalid.')
                }
                state.uploadJournal = {
                    ...journal,
                    phase: 'acknowledged',
                    rawReceipt: receipt,
                    acknowledgedAt,
                }
            }
        )
    }

    applyAcknowledgedUploadReceipt(
        attemptId: string,
        results: UploadReceiptEntry[],
        appliedAt: string
    ): Promise<void> {
        const receipt = cloneDeep(results)
        for (const result of receipt) {
            if (result.feature) {
                result.feature = requireOsmGoFeature(
                    result.feature,
                    'uploaded official feature',
                    'official'
                )
            }
        }
        return this.enqueueOsmStateMutation(
            'apply acknowledged upload receipt',
            (state, setAside) => {
                const journal = state.uploadJournal
                if (
                    journal?.attemptId !== attemptId ||
                    journal.phase !== 'acknowledged'
                ) {
                    throw new Error(
                        'The acknowledged upload journal is invalid.'
                    )
                }
                const modifiedMeanwhile: OsmGoFeature[] = []
                if (journal.journalVersion === 2) {
                    for (const submission of journal.submissions) {
                        const current = state.pendingById[submission.oldId]
                        if (
                            current &&
                            !isDeepEqual(current, submission.feature)
                        ) {
                            modifiedMeanwhile.push(cloneDeep(current))
                        }
                    }
                }
                this.applyReceiptToState(state, receipt, journal.submittedIds)
                state.uploadJournal = {
                    ...journal,
                    phase: 'applied',
                    appliedAt,
                }
                if (modifiedMeanwhile.length > 0) {
                    // The receipt replaces these objects with the uploaded
                    // version: keep the local edit instead of dropping it.
                    console.warn(
                        'Pending changes made during an upload were set aside.',
                        modifiedMeanwhile.map((feature) => feature.id)
                    )
                    setAside(
                        modifiedMeanwhile.map((feature) => ({
                            store: 'pending',
                            id: String(feature.id),
                            value: feature,
                            reason: 'The object was edited while its upload was being applied.',
                        })),
                        'upload'
                    )
                }
            }
        )
    }

    /**
     * Last resort for an upload attempt that can no longer be reconciled
     * (corrupted or legacy journal): its objects leave the pending queue, are
     * kept in the quarantine for export, and the journal is dropped. The next
     * download restores the server version of what was really applied. A
     * prepared attempt is only abandoned on request (`prepared`), once the
     * changeset showed that it reached OpenStreetMap.
     */
    abandonUploadAttempt(
        attemptId: string,
        options: { prepared?: boolean } = {}
    ): Promise<void> {
        return this.enqueueOsmStateMutation(
            'abandon upload attempt',
            (state, setAside) => {
                const journal = state.uploadJournal
                if (
                    journal?.attemptId !== attemptId ||
                    (journal.phase === 'prepared') !== !!options.prepared
                ) {
                    throw new Error('The upload journal cannot be abandoned.')
                }
                const removed: OsmGoFeature[] = []
                for (const id of journal.submittedIds) {
                    const pending = state.pendingById[id]
                    if (pending) removed.push(cloneDeep(pending))
                    delete state.pendingById[id]
                    delete state.officialById[id]
                }
                delete state.uploadJournal
                setAside(
                    removed.map((feature) => ({
                        store: 'pending',
                        id: String(feature.id),
                        value: feature,
                        reason: 'The upload was marked as applied by the user.',
                    })),
                    'upload'
                )
            }
        )
    }

    /**
     * OpenStreetMap answered that a node is still used by other objects: the
     * pending deletion is now sent as a removal of the node's tags.
     */
    markPendingNodeReferenced(
        id: string,
        references: NodeReferences
    ): Promise<OsmGoFeature> {
        return this.enqueueOsmStateMutation(
            'mark pending node referenced',
            (state) => {
                this.assertUploadQueueUnlocked(state, [id])
                const pending = state.pendingById[id]
                if (
                    pending?.properties.changeType !== 'Delete' ||
                    pending.properties.type !== 'node'
                ) {
                    throw new Error('The pending deletion is missing.')
                }
                const next = cloneDeep(pending)
                next.properties.usedByWays =
                    references.ways.length > 0 ? references.ways : true
                if (references.relations.length > 0) {
                    next.properties.relations = references.relations.map(
                        (rel) => ({ rel, reltags: {}, role: '' })
                    )
                }
                const validated = requireOsmGoFeature(
                    next,
                    'referenced pending deletion',
                    'pending'
                )
                state.pendingById[id] = validated
                return cloneDeep(validated)
            }
        )
    }

    /**
     * Replaces a pending edit by the same edit applied on top of a newer
     * server version (new base in `originalData`, new OSM version).
     */
    rebasePendingFeature(
        id: string,
        rebased: OsmGoFeature
    ): Promise<OsmGoFeature> {
        const next = cloneDeep(rebased)
        return this.enqueueOsmStateMutation(
            'rebase pending feature',
            (state) => {
                this.assertUploadQueueUnlocked(state, [id])
                const current = state.pendingById[id]
                if (current?.properties.changeType !== 'Update') {
                    throw new Error('The pending edit is missing.')
                }
                if (!next.properties.originalData) {
                    throw new Error('The new base version is missing.')
                }
                this.copyCanonicalIdentity(next, current)
                next.properties.changeType = 'Update'
                const validated = requireOsmGoFeature(
                    next,
                    'rebased pending feature',
                    'pending'
                )
                state.pendingById[id] = validated
                return cloneDeep(validated)
            }
        )
    }

    clearAppliedUploadAttempt(attemptId: string): Promise<void> {
        return this.enqueueOsmStateMutation(
            'clear applied upload attempt',
            (state) => {
                const journal = state.uploadJournal
                if (
                    journal?.attemptId !== attemptId ||
                    journal.phase !== 'applied'
                ) {
                    throw new Error('The applied upload journal is invalid.')
                }
                delete state.uploadJournal
            }
        )
    }

    discardPreparedUploadAttempt(attemptId: string): Promise<void> {
        return this.enqueueOsmStateMutation(
            'discard rejected upload attempt',
            (state) => {
                const journal = state.uploadJournal
                if (
                    journal?.attemptId !== attemptId ||
                    journal.phase !== 'prepared'
                ) {
                    throw new Error('The prepared upload journal is invalid.')
                }
                delete state.uploadJournal
            }
        )
    }

    resetDownloadedData(): Promise<OsmDownload> {
        return this.enqueueOsmStateMutation(
            'reset downloaded data',
            (state) => {
                const emptyGeojson = featureCollection(
                    []
                ) as OsmGoFeatureCollection
                const emptyBbox = featureCollection(
                    []
                ) as OsmGoFeatureCollection
                state.officialById = {}
                state.bbox = emptyBbox
                return { geojson: emptyGeojson, geojsonBbox: emptyBbox }
            }
        )
    }

    resetAllData(): Promise<void> {
        return this.enqueueOsmStateMutation('reset all OSM data', (state) => {
            state.officialById = {}
            state.pendingById = {}
            state.bbox = featureCollection([]) as OsmGoFeatureCollection
            state.nextTemporaryId = -1
            delete state.uploadJournal
        })
    }

    private requireFeatureId(feature: OsmGoFeature): string {
        if (feature.id === undefined || feature.id === null) {
            throw new Error('A feature ID is required.')
        }
        return String(feature.id)
    }

    private applyReceiptToState(
        state: PersistedOsmStateV2,
        receipt: UploadReceiptEntry[],
        expectedIds: string[]
    ): void {
        const oldIds = receipt.map((result) => result.oldId)
        const expectedIdSet = new Set(expectedIds)
        if (
            new Set(oldIds).size !== oldIds.length ||
            expectedIdSet.size !== expectedIds.length ||
            oldIds.length !== expectedIds.length ||
            oldIds.some(
                (id) => !state.pendingById[id] || !expectedIdSet.has(id)
            )
        ) {
            throw new Error('The OSM upload result does not match local data.')
        }

        for (const result of receipt) {
            delete state.pendingById[result.oldId]
            delete state.officialById[result.oldId]
            if (result.feature) {
                const officialId = this.requireFeatureId(result.feature)
                state.officialById[officialId] = cloneDeep(result.feature)
                this.keptOnNextDownloadIds.add(officialId)
            }
        }
    }

    private assertUploadQueueUnlocked(
        state: PersistedOsmStateV2,
        candidateIds: string[]
    ): void {
        const submittedIds = new Set(state.uploadJournal?.submittedIds ?? [])
        const lockedIds = candidateIds.filter((id) => submittedIds.has(id))
        if (lockedIds.length > 0) {
            throw new UploadQueueLockedError(lockedIds)
        }
    }

    private collectionToRecord(
        collection: OsmGoFeatureCollection,
        label: string,
        requireCanonicalIdentity = false
    ): Record<string, OsmGoFeature> {
        const featuresById: Record<string, OsmGoFeature> = {}
        for (const sourceFeature of collection.features) {
            const feature = cloneDeep(sourceFeature)
            const id = requireCanonicalIdentity
                ? this.requireCanonicalFeatureId(feature)
                : this.requireFeatureId(feature)
            if (featuresById[id]) {
                throw new Error(`The ${label} collection has duplicate IDs.`)
            }
            featuresById[id] = feature
        }
        return featuresById
    }

    /** A persisted feature key is always the canonical `type/id` pair. */
    private requireCanonicalFeatureId(feature: OsmGoFeature): string {
        const id = this.requireFeatureId(feature)
        const objectId = feature.properties.id
        const type = feature.properties.type
        if (
            !['node', 'way', 'relation'].includes(type) ||
            !Number.isInteger(objectId) ||
            id !== `${type}/${objectId}`
        ) {
            throw new Error('The feature has an inconsistent canonical ID.')
        }
        return id
    }

    private copyCanonicalIdentity(
        target: OsmGoFeature,
        source: OsmGoFeature
    ): void {
        target.id = this.requireFeatureId(source)
        target.properties.id = source.properties.id
        target.properties.type = source.properties.type
    }

    private requireOriginalFeature(feature: OsmGoFeature): OsmGoFeature {
        const original = feature.properties.originalData
        if (!original) {
            throw new Error('The original feature data is missing.')
        }
        return cloneDeep(original)
    }

    /**
     * Collections are copied shallowly: commands replace or remove whole
     * features and never edit a stored feature in place, so the previous state
     * stays intact if a command fails and no deep clone is paid per commit.
     */
    private createOsmStateSnapshot(): PersistedOsmStateV2 {
        return {
            schemaVersion: OSM_STATE_SCHEMA_VERSION,
            revision: this._osmStateRevision + 1,
            officialById: { ...this._geojson },
            pendingById: { ...this._geojsonChanged },
            bbox: this._geojsonBbox,
            nextTemporaryId: this._nextTemporaryId,
            ...(this._uploadJournal
                ? { uploadJournal: this._uploadJournal }
                : {}),
        }
    }

    private enqueueOsmStateMutation<Result>(
        operation: string,
        mutate: (state: PersistedOsmStateV2, setAside: SetAside) => Result
    ): Promise<Result> {
        const mutation = this.osmStateMutationQueue.then(() =>
            withWebLock(OSM_STATE_LOCK_NAME, () =>
                this.commitOsmStateMutation(operation, mutate)
            )
        )
        this.osmStateMutationQueue = mutation.then(
            () => undefined,
            () => undefined
        )
        return mutation
    }

    /**
     * A local edit only writes the head: the pending queue, the journal and
     * the official objects changed since the last download. Objects set aside
     * by the command are saved first, so a failure in between can at worst
     * keep a copy of an object that is still pending.
     */
    private async commitOsmStateMutation<Result>(
        operation: string,
        mutate: (state: PersistedOsmStateV2, setAside: SetAside) => Result
    ): Promise<Result> {
        if (this.storageCleared) {
            throw new Error(
                'The local data was cleared: reload the application.'
            )
        }
        this.assertRevisionUnchanged()
        const state = this.createOsmStateSnapshot()
        const setAsideEntries: Array<{
            entries: QuarantinedOsmFeature[]
            source: QuarantineSource
        }> = []
        const result = mutate(state, (entries, source) => {
            if (entries.length > 0) setAsideEntries.push({ entries, source })
        })
        const delta =
            state.bbox === this._geojsonBbox
                ? this.nextOfficialDelta(state.officialById)
                : undefined
        const previousMarker = this.knownRevisionMarker
        this.setRevisionMarker(String(state.revision))
        let official: PersistedOfficialReference
        try {
            for (const { entries, source } of setAsideEntries) {
                await this.appendQuarantine(entries, source, state.revision)
            }
            if (delta) {
                official = {
                    slot: this._officialSlot,
                    revision: this._officialRevision,
                    delta,
                }
                await this.localStorage.set(
                    OSM_STATE_STORAGE_KEY,
                    this.toPersistedHead(state, official)
                )
            } else {
                official = await this.writeFullOsmState(
                    state,
                    this._officialSlot
                )
            }
        } catch (cause) {
            this.restoreRevisionMarker(previousMarker)
            throw new OsmStatePersistenceError(operation, state.revision, {
                cause,
            })
        }
        this.publishOsmState(state, official)
        return result
    }

    /**
     * The official objects that differ from the stored slot after this
     * command, or `undefined` when there are too many and the slot should be
     * rewritten. Unchanged objects keep their reference across commits.
     */
    private nextOfficialDelta(
        next: Record<string, OsmGoFeature>
    ): PersistedOfficialDelta | undefined {
        const previous = this._geojson
        const delta: PersistedOfficialDelta = { ...this._officialDelta }
        for (const id of Object.keys(previous)) {
            if (!Object.hasOwn(next, id)) delta[id] = null
        }
        for (const [id, feature] of Object.entries(next)) {
            if (previous[id] !== feature) delta[id] = feature
        }
        return Object.keys(delta).length > MAX_OFFICIAL_DELTA_SIZE
            ? undefined
            : delta
    }

    private publishOsmState(
        state: PersistedOsmStateV2,
        official: PersistedOfficialReference
    ): void {
        this._geojson = state.officialById
        this._geojsonChanged = state.pendingById
        this._geojsonBbox = state.bbox
        this._nextTemporaryId = state.nextTemporaryId
        this._osmStateRevision = state.revision
        this._uploadJournal = state.uploadJournal
        this.setOfficialReference(official)
        this.notifyChangedData()
    }

    /** Refuses to overwrite a state that another window saved meanwhile. */
    private assertRevisionUnchanged(): void {
        const stored = this.readRevisionMarker()
        if (stored === this.knownRevisionMarker) return
        this.externalStateChangeState.set(true)
        const storedRevision = Number(stored)
        throw new OsmStateConflictError(
            this._osmStateRevision,
            stored !== null && Number.isInteger(storedRevision)
                ? storedRevision
                : undefined
        )
    }

    private readRevisionMarker(): string | null {
        try {
            return window.localStorage.getItem(OSM_STATE_REVISION_MARKER_KEY)
        } catch {
            return null
        }
    }

    /**
     * The marker only detects concurrent windows: when it cannot be written
     * (quota, storage blocked), keep comparing with what is really stored so
     * the next save is not mistaken for a conflict.
     */
    private setRevisionMarker(value: string): void {
        try {
            window.localStorage.setItem(OSM_STATE_REVISION_MARKER_KEY, value)
            this.knownRevisionMarker = value
        } catch {
            this.knownRevisionMarker = this.readRevisionMarker()
        }
    }

    private restoreRevisionMarker(value: string | null): void {
        if (value === null) {
            this.clearRevisionMarker()
        } else {
            this.setRevisionMarker(value)
        }
    }

    private clearRevisionMarker(): void {
        try {
            window.localStorage.removeItem(OSM_STATE_REVISION_MARKER_KEY)
            this.knownRevisionMarker = null
        } catch {
            this.knownRevisionMarker = this.readRevisionMarker()
        }
    }

    private getNextTemporaryId(
        featuresById: Record<string, OsmGoFeature>
    ): number {
        const ids = Object.values(featuresById)
            .map((feature) => feature.properties.id)
            .filter((id) => Number.isInteger(id) && id < 0)
        return ids.length > 0 ? Math.min(...ids) - 1 : -1
    }
}
