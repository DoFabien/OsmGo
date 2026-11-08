import {
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatDialog } from '@angular/material/dialog'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatToolbarModule } from '@angular/material/toolbar'
import { MatTooltipModule } from '@angular/material/tooltip'
import { cloneDeep } from '@app/utils/clone'
import { resolveReplacementTags } from '@app/utils/deprecated-tags'
import { isNodeUsedByWay } from '@app/utils/osm-feature'
import {
    MAX_OSM_TAG_LENGTH,
    normalizedOsmTagMap,
    normalizeEditorTags,
    normalizeOsmTagKey,
    normalizeOsmTags,
    osmTagMapsEqual,
} from '@app/utils/osm-tags'
import { AlertComponent } from '@components/modal/components/alert/alert.component'
import { EditOtherTag } from '@components/modal/components/edit/OtherTag.component'
import { EditPresets } from '@components/modal/components/edit/Presets.component'
import type { TagsPatch } from '@components/modal/components/multi-select/multi-select.component'
import { PrimaryKey } from '@components/modal/components/primary-key/PrimaryKey'
import type { TagSelectionChange } from '@components/modal/components/select/select.component'
import {
    ConfirmDialogComponent,
    type ConfirmDialogData,
} from '@components/shared/confirm-dialog/confirm-dialog'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import type {
    FeatureIdSource,
    MapMode,
    OsmGoFeature,
    Preset,
    PrimaryTag,
    Tag,
    TagConfig,
} from '@osmgo/type'
import { osmTagKeyToPresetId } from '@osmgo/utils'
import { FilterExcludeKeysPipe } from '@pipes/filterExcludeKeys.pipe'
import { IsBookmarkedPipe } from '@pipes/is-bookmarked.pipe'
import { OrderByPresetPipe } from '@pipes/orderByPreset.pipe'
import { getConfigTag } from '@scripts/osmToOsmgo/index.js'
import { ConfigService } from '@services/config.service'
import { DataService, UploadQueueLockedError } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmApiService } from '@services/osmApi.service'
import { type SavedField, TagsService } from '@services/tags.service'
import type { Geometry } from 'geojson'
import { finalize, take } from 'rxjs/operators'
import {
    isCoveredByPreset,
    isEditablePreset,
    isEditableTagKey,
    isMultiValuePreset,
    isPrefixPreset,
    type TagValueIssue,
    tagValueIssue,
} from './editor-tag'
import { type AddTagSelection, ModalAddTag } from './modal.addTag/modal.addTag'
import { ModalSelectList } from './modalSelectList/modalSelectList'
import { PendingFieldEntries } from './pending-field-entries'

export interface ModalDismissData {
    redraw?: boolean
    type?: string
    geojson?: OsmGoFeature
    mode?: MapMode
    deleted?: boolean
    origineData?: FeatureIdSource
}

interface SelectedTagConfig extends TagConfig {
    addTags?: Record<string, string | number>
}

interface ModalSelectListResult {
    key: string
    value: string | number
    tags?: Record<string, string | number>
}

interface DeprecatedTags {
    old: Record<string, unknown>
    replace: Record<string, string | number>
}

type EditorMode = Extract<MapMode, 'Create' | 'Update'>

const SURVEY_DATE_KEYS = ['survey:date', 'check_date']
@Component({
    selector: 'app-object-editor-content',
    templateUrl: './modal.html',
    styleUrls: ['./modal.scss'],
    imports: [
        AlertComponent,
        EditOtherTag,
        EditPresets,
        FilterExcludeKeysPipe,
        FormsModule,
        IsBookmarkedPipe,
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatProgressSpinnerModule,
        MatToolbarModule,
        MatTooltipModule,
        OrderByPresetPipe,
        PrimaryKey,
        TranslateModule,
    ],
    providers: [PendingFieldEntries],
})
export class ObjectEditorContentComponent {
    readonly isNodeUsedByWay = isNodeUsedByWay
    readonly osmApi = inject(OsmApiService)
    readonly tagsService = inject(TagsService)
    readonly mapService = inject(MapService)
    readonly dataService = inject(DataService)
    readonly configService = inject(ConfigService)
    private readonly translate = inject(TranslateService)
    private readonly dialog = inject(MatDialog)
    private readonly snackBar = inject(MatSnackBar)
    private readonly destroyRef = inject(DestroyRef)
    private readonly pendingEntries = inject(PendingFieldEntries)

    private readonly tagsState = signal<Tag[]>([])
    get tags(): Tag[] {
        return this.tagsState()
    }

    private readonly emptyNameTag: Tag = { key: '', value: '' }
    readonly nameTag = computed(
        () =>
            this.tagsState().find((tag) => tag.key === 'name') ??
            this.emptyNameTag
    )
    readonly maxTagLength = MAX_OSM_TAG_LENGTH
    /** Fields that write several tags (`payment:cash=yes`, `male=yes`…). */
    private readonly multiValueFields = computed(() =>
        this.tagsState().flatMap((tag) =>
            tag.preset && isMultiValuePreset(tag.preset) ? [tag.preset] : []
        )
    )

    originalTags: Tag[] = []
    private readonly featureState = signal<OsmGoFeature | undefined>(undefined)
    get feature(): OsmGoFeature {
        const feature = this.featureState()
        if (!feature) {
            throw new Error('The feature input has not been initialized.')
        }
        return feature
    }

    origineData: FeatureIdSource = 'data'
    private readonly typeFicheState = signal<'Loading' | 'Edit'>('Loading')
    get typeFiche(): 'Loading' | 'Edit' {
        return this.typeFicheState()
    }

    private readonly displayCodeState = signal(false)
    get displayCode(): boolean {
        return this.displayCodeState()
    }

    private readonly modeState = signal<EditorMode>('Update')
    get mode(): EditorMode {
        return this.modeState()
    }

    private readonly tagConfigState = signal<TagConfig | undefined>(undefined)
    get tagConfig(): TagConfig {
        const tagConfig = this.tagConfigState()
        if (!tagConfig) {
            throw new Error('The tag configuration has not been initialized.')
        }
        return tagConfig
    }

    currentTagConfig(): TagConfig | undefined {
        return this.tagConfigState()
    }

    primaryKey: PrimaryTag = { key: '', value: '' }
    private readonly savedFieldsState = signal<SavedField | undefined>(
        undefined
    )
    get savedFields(): SavedField | undefined {
        return this.savedFieldsState()
    }

    get hasSavedFields(): boolean {
        return Boolean(this.savedFields?.tags.length)
    }

    get fieldMemoryCategory(): string {
        const language = this.configService.config().languageTags
        return (
            this.tagConfig.lbl?.[language] ||
            this.tagConfig.lbl?.['en'] ||
            String(this.primaryKey.value)
        )
    }

    private readonly tagIdState = signal('')
    get tagId(): string {
        return this.tagIdState()
    }

    geometryType: 'point' | 'vertex' | 'line' | 'area' = 'point'
    openPrimaryTagModalOnStart = false
    customValue = ''

    newPosition = false
    presetsIds: string[] = []

    readonly dataInput = input.required<OsmGoFeature>({ alias: 'data' })
    readonly modeInput = input.required<EditorMode>({ alias: 'type' })
    readonly newPositionInput = input(false, {
        alias: 'newPosition',
    })
    readonly origineDataInput = input<FeatureIdSource>('data', {
        alias: 'origineData',
    })
    readonly openPrimaryTagModalOnStartInput = input(false, {
        alias: 'openPrimaryTagModalOnStart',
    })
    readonly dismissed = output<ModalDismissData | undefined>()
    readonly categoryRequested = output<void>()
    private initializedData?: OsmGoFeature
    private initializedMode?: EditorMode
    private initializedNewPosition?: boolean
    private initializedOrigin?: FeatureIdSource
    private initializedOpenCategory?: boolean

    constructor() {
        effect(() => {
            const data = this.dataInput()
            const mode = this.modeInput()
            const newPosition = this.newPositionInput()
            const origin = this.origineDataInput()
            const openCategory = this.openPrimaryTagModalOnStartInput()

            untracked(() => {
                this.synchronizeInputs({
                    data,
                    mode,
                    newPosition,
                    origin,
                    openCategory,
                })
            })
        })
    }

    private synchronizeInputs(inputs: {
        data: OsmGoFeature
        mode: EditorMode
        newPosition: boolean
        origin: FeatureIdSource
        openCategory: boolean
    }): void {
        const unchanged =
            this.initializedData === inputs.data &&
            this.initializedMode === inputs.mode &&
            this.initializedNewPosition === inputs.newPosition &&
            this.initializedOrigin === inputs.origin &&
            this.initializedOpenCategory === inputs.openCategory
        if (unchanged) return

        const currentFeature = this.featureState()
        const wouldOverwriteDraft =
            currentFeature !== undefined &&
            (this.mode === 'Update' || this.mode === 'Create') &&
            this.dataIsChanged() &&
            (this.initializedData !== inputs.data ||
                this.initializedMode !== inputs.mode ||
                this.initializedNewPosition !== inputs.newPosition ||
                this.initializedOrigin !== inputs.origin)

        // The parent normally blocks selection changes while editing. Keep that
        // invariant locally as well so an unexpected input cannot erase a draft.
        if (wouldOverwriteDraft) return

        this.initializedData = inputs.data
        this.initializedMode = inputs.mode
        this.initializedNewPosition = inputs.newPosition
        this.initializedOrigin = inputs.origin
        this.initializedOpenCategory = inputs.openCategory
        this.initializeFromInputs(inputs)
        this.initComponent()
        if (this.mode === 'Create' && this.openPrimaryTagModalOnStart) {
            this.openPrimaryTagModal()
        }
    }

    private initializeFromInputs(inputs: {
        data: OsmGoFeature
        mode: EditorMode
        newPosition: boolean
        origin: FeatureIdSource
        openCategory: boolean
    }): void {
        this.displayCodeState.set(false)
        this.newPosition = inputs.newPosition
        this.featureState.set(cloneDeep(inputs.data))

        const originalFeatureGeometry: Geometry = this.feature.properties
            .way_geometry
            ? this.feature.properties.way_geometry
            : this.feature.geometry

        const typeGeomFeature = originalFeatureGeometry.type
        const usedByWay = isNodeUsedByWay(this.feature)
        if (typeGeomFeature === 'Point' && !usedByWay) {
            this.geometryType = 'point'
        } else if (typeGeomFeature === 'Point' && usedByWay) {
            this.geometryType = 'vertex'
        } else if (
            typeGeomFeature === 'LineString' ||
            typeGeomFeature === 'MultiLineString'
        ) {
            this.geometryType = 'line'
        } else {
            // Polygons, multipolygons and relations without a surface of their
            // own (a stop_area is a GeometryCollection) share the area category.
            this.geometryType = 'area'
        }

        this.modeState.set(inputs.mode)
        this.openPrimaryTagModalOnStart = inputs.openCategory
        this.origineData = inputs.origin
        this.typeFicheState.set('Loading')
        this.feature.properties.tags = normalizeOsmTags(
            this.feature.properties.tags
        )

        const tags: Tag[] = []

        for (const tag in this.feature.properties.tags) {
            const preset = this.tagsService.presets()[osmTagKeyToPresetId(tag)]
            const data: Tag = {
                key: tag,
                value: this.feature.properties.tags[tag],
            }
            if (isEditablePreset(preset) && !isMultiValuePreset(preset)) {
                data.preset = preset
            }
            tags.push(data)
        }

        this.tagsState.set(tags)
        this.originalTags = cloneDeep(tags)
    }

    presentConfirm(): void {
        const data: ConfirmDialogData = {
            title: this.translate.instant(
                'MODAL_SELECTED_ITEM.DELETE_CONFIRM_HEADER'
            ),
            message: this.translate.instant(
                'MODAL_SELECTED_ITEM.DELETE_CONFIRM_MESSAGE'
            ),
            cancelLabel: this.translate.instant('SHARED.CANCEL'),
            confirmLabel: this.translate.instant('SHARED.CONFIRM'),
            destructive: true,
        }
        this.dialog
            .open(ConfirmDialogComponent, {
                data,
                maxWidth: 'calc(100vw - 32px)',
                panelClass: 'osmgo-dialog',
            })
            .afterClosed()
            .subscribe((confirmed) => {
                if (confirmed) {
                    this.deleteOsmElement()
                }
            })
    }

    initComponent(tagConfig?: TagConfig): {
        tagConfig: TagConfig
        tags: Tag[]
        feature: OsmGoFeature
    } {
        let _tags = normalizeEditorTags(this.tags)
        const feature = cloneDeep(this.feature)
        let _tagConfig: TagConfig
        let _tagId: string
        let _presetsIds: string[]

        const _primaryKey = this.tagsService.findPkey(_tags)
        if (!_primaryKey) {
            throw new Error(
                'The feature does not have a supported primary tag.'
            )
        }

        feature.properties.primaryTag = _primaryKey
        this.typeFicheState.set('Edit')

        // a field the user has just added stays until they fill or remove it
        _tags = _tags.filter(
            (tag) =>
                !tag.isDefaultValue &&
                (tag.value !== '' ||
                    (tag.isJustAdded === true &&
                        (tag.key !== '' || tag.preset !== undefined)))
        )
        if (!_tags.find((tag) => tag.key === 'name')) {
            _tags.push({ key: 'name', value: '' })
        }

        if (!tagConfig) {
            _tagConfig = getConfigTag(feature, this.tagsService.tags())
        } else {
            _tagConfig = this.withInheritedFields(tagConfig, feature)
        }

        _tagId =
            _tagConfig && _tagConfig.id
                ? _tagConfig.id
                : `${_primaryKey.key}/${_primaryKey.value}`
        this.savedFieldsState.set(this.tagsService.savedFields[_tagId])

        _presetsIds = _tagConfig.presets ?? []

        const multiValueFields = this.multiValueFieldsOf(_tagConfig, _tags)
        _tags = _tags.filter((tag) => {
            const preset = tag.preset
            if (!tag.isJustAdded || tag.value !== '' || !preset) return true
            // the category shows this field already
            return !(
                _presetsIds.includes(preset._id) ||
                multiValueFields.some((field) =>
                    this.sameMultiValueField(field, preset)
                )
            )
        })
        for (const tag of _tags) {
            if (
                multiValueFields.some((preset) =>
                    isCoveredByPreset(preset, tag.key)
                )
            ) {
                delete tag.preset
            }
        }

        for (const presetId of _presetsIds) {
            const preset = this.tagsService.presets()[presetId]
            if (!isEditablePreset(preset) || isMultiValuePreset(preset)) {
                continue
            }
            // the multi-value field already edits this key (male, diet:vegan…)
            if (
                preset.key &&
                multiValueFields.some((field) =>
                    isCoveredByPreset(field, preset.key ?? '')
                )
            ) {
                continue
            }
            const presetKeys = preset.keys?.length
                ? preset.keys
                : preset.key
                  ? [preset.key]
                  : []

            const tagOfPreset = _tags.find((tag) =>
                presetKeys.includes(tag.key)
            )

            if (tagOfPreset) {
                tagOfPreset.preset = preset
            } else {
                _tags.push({
                    key: preset.key || '',
                    value: '',
                    preset: preset,
                })
            }
        }
        for (const preset of multiValueFields) {
            _tags.push({ key: '', value: '', preset })
        }

        this.tagIdState.set(_tagId)
        this.featureState.set(feature)
        this.presetsIds = _presetsIds
        this.tagConfigState.set(_tagConfig)
        this.primaryKey = _primaryKey
        this.tagsState.set(_tags)
        if (
            _presetsIds.some((presetId) => presetId.endsWith('#brand')) &&
            !this.tagsService.brandPresetsLoaded()
        ) {
            this.tagsService
                .loadBrandPresets$()
                .pipe(take(1), takeUntilDestroyed(this.destroyRef))
                .subscribe({
                    next: () => {
                        if (this.tagConfigState()?.id === _tagConfig.id) {
                            this.initComponent(_tagConfig)
                        }
                    },
                    error: (error) =>
                        console.warn('Unable to load brand presets.', error),
                })
        }
        return { tagConfig: _tagConfig, tags: _tags, feature: feature }
    }

    /**
     * The fields of the category, then its optional fields already in use,
     * that write several tags. One field per key prefix or set of keys.
     */
    private multiValueFieldsOf(tagConfig: TagConfig, tags: Tag[]): Preset[] {
        const presets = this.tagsService.presets()
        const listed = (tagConfig.presets ?? [])
            .map((presetId) => presets[presetId])
            .filter(isMultiValuePreset)
        const used = (tagConfig.moreFields ?? [])
            .map((presetId) => presets[presetId])
            .filter(
                (preset) =>
                    isMultiValuePreset(preset) &&
                    tags.some(
                        (tag) =>
                            tag.value !== '' &&
                            isCoveredByPreset(preset, tag.key)
                    )
            )
        const fields: Preset[] = []
        for (const preset of [...listed, ...used]) {
            if (
                !fields.some((field) => this.sameMultiValueField(field, preset))
            ) {
                fields.push(preset)
            }
        }
        return fields
    }

    private sameMultiValueField(field: Preset, preset: Preset): boolean {
        if (field._id === preset._id) return true
        if (isPrefixPreset(preset)) {
            return isPrefixPreset(field) && field.key === preset.key
        }
        return (preset.keys ?? []).every((key) => isCoveredByPreset(field, key))
    }

    /** A category picked in the list comes without the fields of its parents. */
    private withInheritedFields(
        tagConfig: TagConfig,
        feature: OsmGoFeature
    ): TagConfig {
        const catalogConfig = this.tagsService
            .tags()
            .find((candidate) => candidate.id === tagConfig.id)
        if (!catalogConfig) return tagConfig
        const inherited = getConfigTag(
            {
                ...feature,
                properties: {
                    ...feature.properties,
                    configId: catalogConfig.id,
                    tags: catalogConfig.tags,
                },
            },
            this.tagsService.tags()
        )
        return inherited.id === tagConfig.id ? inherited : tagConfig
    }

    /** Tags that a multi-value field shows are not listed a second time. */
    isShownInOwnRow(tag: Tag): boolean {
        if (tag.preset && isMultiValuePreset(tag.preset)) return true
        if (tag.isJustAdded) return true
        return !this.multiValueFields().some((preset) =>
            isCoveredByPreset(preset, tag.key)
        )
    }

    dataIsChanged(): boolean {
        return (
            this.pendingEntries.count() > 0 ||
            !osmTagMapsEqual(
                this.editedTagMap(),
                normalizedOsmTagMap(this.originalTags)
            )
        )
    }

    /**
     * The tags the editor writes: a key that is empty or ends with `:` is never
     * produced, unless the object already carried it.
     */
    private editedTagMap(): Map<string, string> {
        const originalKeys = new Set(this.originalTags.map((tag) => tag.key))
        return normalizedOsmTagMap(
            this.tags.filter(
                (tag) => isEditableTagKey(tag.key) || originalKeys.has(tag.key)
            )
        )
    }

    presetOf(tag: Tag): Preset | undefined {
        if (tag.preset) {
            return isEditablePreset(tag.preset) ? tag.preset : undefined
        }
        // a `gender=*` tag is not the gender field, which writes male=yes…
        const preset = this.tagsService.presets()[osmTagKeyToPresetId(tag.key)]
        return isEditablePreset(preset) && !isMultiValuePreset(preset)
            ? preset
            : undefined
    }

    trackTag(tag: Tag): string {
        return tag.preset && (!tag.preset.key || isMultiValuePreset(tag.preset))
            ? `preset:${tag.preset._id}`
            : tag.key
    }

    saveLabelKey(changes: number): string {
        if (changes === 0) return 'SHARED.CLOSE'
        return changes === 1
            ? 'MODAL_SELECTED_ITEM.SAVE_CHANGE'
            : 'MODAL_SELECTED_ITEM.SAVE_CHANGES'
    }

    changedFieldCount(): number {
        const original = normalizedOsmTagMap(this.originalTags)
        const current = this.editedTagMap()
        const keys = new Set([...original.keys(), ...current.keys()])
        let changes = 0
        for (const key of keys) {
            if (original.get(key) !== current.get(key)) {
                changes++
            }
        }
        return (
            changes + this.pendingEntries.count() + (this.newPosition ? 1 : 0)
        )
    }

    toogleCode(): void {
        this.displayCodeState.set(!this.displayCode)
    }

    addNewKey(key: string, presetId?: string): void {
        const preset = presetId
            ? this.tagsService.presets()[presetId]
            : undefined
        if (preset) {
            if (!isEditablePreset(preset)) return
            if (isMultiValuePreset(preset)) {
                const alreadyAdded = this.multiValueFields().some((field) =>
                    this.sameMultiValueField(field, preset)
                )
                if (alreadyAdded) return
                this.tagsState.set([
                    ...this.tags,
                    { key: '', value: '', preset, isJustAdded: true },
                ])
                return
            }
            const tagKey = preset.key ?? ''
            const alreadyAdded = tagKey
                ? this.tags.some((tag) => tag.key === tagKey)
                : this.tags.some((tag) => tag.preset?._id === preset._id)
            if (alreadyAdded) return
            this.tagsState.set([
                ...this.tags,
                { key: tagKey, value: '', preset, isJustAdded: true },
            ])
            return
        }

        if (
            !isEditableTagKey(key) ||
            this.tags.some((tag) => tag.key === key)
        ) {
            return
        }
        this.tagsState.set([
            ...this.tags,
            { key, value: '', isJustAdded: true },
        ])
    }

    deleteTag(tag: Tag): void {
        const idx = this.tags.findIndex(
            (candidate) => candidate.key === tag.key
        )
        if (idx !== -1) {
            this.tagsState.set([
                ...this.tags.slice(0, idx),
                ...this.tags.slice(idx + 1),
            ])
        }
    }

    findElement(array: Tag[], kv: Partial<Tag>): Tag {
        const entries = Object.entries(kv) as Array<[keyof Tag, Tag[keyof Tag]]>
        const idx = array.findIndex((candidate) =>
            entries.every(([key, value]) => candidate[key] === value)
        )
        if (idx !== -1) {
            return array[idx]
        }
        return { key: '', value: '' }
    }

    dismiss(data?: ModalDismissData): void {
        this.dismissed.emit(data)
    }

    createOsmElement(tagConfig: TagConfig): void {
        this.pendingEntries.commitAll()
        if (!this.tagsAreSavable()) return
        this.mapService.setIsProcessing(true)

        this.typeFicheState.set('Loading')
        this.tagsService.addTagTolastTagsUsed(tagConfig.id)

        if (this.configService.getAddSurveyDate()) {
            this.addSurveyDate()
        }

        this.pushTagsToFeature()
        this.osmApi
            .createOsmNode(this.feature)
            .pipe(
                finalize(() => {
                    this.mapService.setIsProcessing(false)
                })
            )
            .subscribe({
                next: (feature) => {
                    this.rememberFields(tagConfig, this.tags)
                    this.dismiss({
                        redraw: true,
                        geojson: feature,
                        origineData: 'data_changed',
                    })
                },
                error: (error: unknown) => this.handleSaveError(error),
            })
    }

    updateOsmElement(tagConfig?: TagConfig): void {
        if (tagConfig) {
            this.tagsService.addTagTolastTagsUsed(tagConfig.id)
        }
        this.pendingEntries.commitAll()
        if (!this.dataIsChanged() && !this.newPosition) {
            this.dismiss()
            return
        }
        if (!this.tagsAreSavable()) return

        this.mapService.setIsProcessing(true)
        this.typeFicheState.set('Loading')

        if (this.configService.getAddSurveyDate()) {
            this.addSurveyDate()
        }

        this.pushTagsToFeature()

        this.osmApi
            .updateOsmElement(this.feature, this.origineData)
            .pipe(
                finalize(() => {
                    this.mapService.setIsProcessing(false)
                })
            )
            .subscribe({
                next: (feature) => {
                    this.dismiss({
                        redraw: true,
                        geojson: feature,
                        origineData: 'data_changed',
                    })
                },
                error: (error: unknown) => this.handleSaveError(error),
            })
    }

    deleteOsmElement(): void {
        this.mapService.setIsProcessing(true)
        this.typeFicheState.set('Loading')
        this.osmApi
            .deleteOsmElement(this.feature)
            .pipe(
                finalize(() => {
                    this.mapService.setIsProcessing(false)
                })
            )
            .subscribe({
                next: () => {
                    this.dismiss({ redraw: true, deleted: true })
                },
                error: (error: unknown) => this.handleSaveError(error),
            })
    }

    private handleSaveError(error: unknown): void {
        console.error(error)
        this.typeFicheState.set('Edit')
        this.presentToast(
            this.translate.instant(
                error instanceof UploadQueueLockedError
                    ? 'MODAL_SELECTED_ITEM.UPLOAD_LOCKED'
                    : 'SHARED.ERROR'
            )
        )
    }

    private tagsAreSavable(): boolean {
        for (const tag of this.tags) {
            if (!isEditableTagKey(tag.key)) continue
            const issue: TagValueIssue | null = tagValueIssue(tag.value)
            if (!issue) continue
            this.presentToast(
                this.translate.instant(
                    issue === 'tooLong'
                        ? 'MODAL_SELECTED_ITEM.VALUE_TOO_LONG'
                        : 'MODAL_SELECTED_ITEM.VALUE_INVALID',
                    { key: tag.key, max: MAX_OSM_TAG_LENGTH }
                )
            )
            return false
        }
        return true
    }

    pushTagsToFeature(): void {
        this.feature.properties.tags = Object.fromEntries(this.editedTagMap())
    }

    moveOsmElement(): void {
        this.pushTagsToFeature()
        this.dismiss({ type: 'Move', geojson: this.feature, mode: this.mode })
    }

    openPrimaryTagModal(): void {
        this.categoryRequested.emit()
    }

    applyPrimaryTagSelection(newTagConfig: SelectedTagConfig): void {
        const oldKeyTagsToDelete = Object.keys(this.tagConfig.tags)
        // like iD, the tags the old category added go too (healthcare=pharmacy)
        const oldAddedTags = Object.entries(this.tagConfig.addTags ?? {})
        let copyTags = cloneDeep(this.tags).filter(
            (tag) =>
                !oldKeyTagsToDelete.includes(tag.key) &&
                !oldAddedTags.some(
                    ([key, value]) =>
                        key === tag.key && String(value) === String(tag.value)
                )
        )

        for (const tag of copyTags) {
            if (tag.preset) delete tag.preset
        }

        const newTagsKeys = Object.keys(newTagConfig.tags)
        const newTagsToAdd = Object.entries(newTagConfig.tags).map(
            ([key, value]) => ({ key, value })
        )
        copyTags = copyTags.filter((tag) => !newTagsKeys.includes(tag.key))
        copyTags = [...newTagsToAdd, ...copyTags]

        if (newTagConfig.addTags) {
            copyTags = this.addTags(newTagConfig.addTags, copyTags)
        }

        this.tagsState.set(copyTags)
        this.initComponent(newTagConfig)
    }

    openModalList(data: Tag, preset: Preset): void {
        const dialogRef = this.dialog.open(ModalSelectList, {
            width: 'min(560px, calc(100vw - 24px))',
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: 'calc(100dvh - 24px)',
            panelClass: 'osmgo-dialog',
            autoFocus: 'dialog',
        })
        dialogRef.componentRef?.setInput('data', { ...data, preset })
        dialogRef.afterClosed().subscribe((_data?: ModalSelectListResult) => {
            if (_data) {
                this.tagsState.set(
                    this.tags.map((tag) =>
                        tag.key === _data.key
                            ? { ...tag, value: _data.value }
                            : tag
                    )
                )
                if (_data.tags) {
                    this.tagsState.set(this.addTags(_data.tags, this.tags))
                    this.initComponent(this.tagConfig)
                }
            }
        })
    }

    openModalAddTag(): void {
        const dialogRef = this.dialog.open(ModalAddTag, {
            width: 'min(620px, calc(100vw - 24px))',
            height: 'min(760px, calc(100dvh - 24px))',
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: 'calc(100dvh - 24px)',
            panelClass: 'osmgo-dialog',
            autoFocus: 'dialog',
        })
        dialogRef.componentRef?.setInput(
            'moreFields',
            this.tagConfig.moreFields || []
        )
        // keys (`contact:phone`) and field ids (`contact/phone`) both count
        dialogRef.componentRef?.setInput('usedList', [
            ...this.tagConfig.presets,
            ...this.tags.flatMap((tag) => [
                tag.key,
                osmTagKeyToPresetId(tag.key),
                ...(tag.preset?._id ? [tag.preset._id] : []),
            ]),
            ...this.multiValueFields().map((preset) => preset._id),
        ])
        dialogRef.afterClosed().subscribe((selection?: AddTagSelection) => {
            if (selection) this.addNewKey(selection.key, selection.presetId)
        })
    }

    addTags(
        newTags: Record<string, string | number>,
        existingTags: Tag[]
    ): Tag[] {
        let nextTags = existingTags.map((tag) => ({ ...tag }))
        for (const [rawKey, rawValue] of Object.entries(newTags)) {
            const key = normalizeOsmTagKey(rawKey)
            let value = String(rawValue).trim()
            if (!key || !isEditableTagKey(key) || value === '') continue
            const tagIndex = nextTags.findIndex((tag) => tag.key === key)
            // `building=*`: any value, so keep the one in place or write yes
            if (value === '*') {
                const current = String(nextTags[tagIndex]?.value ?? '').trim()
                value = current || 'yes'
            }
            if (tagIndex !== -1) {
                nextTags[tagIndex] = {
                    ...nextTags[tagIndex],
                    key,
                    value,
                }
            } else {
                nextTags = [...nextTags, { key, value }]
            }
        }
        return nextTags
    }

    applyTagSelection(change: TagSelectionChange): void {
        const sourceIndex = this.tags.indexOf(change.source)
        if (sourceIndex < 0) return
        const selected = normalizeEditorTags([change.tag])[0]
        // other fields keep their tag, which a pending entry may still change
        const nextTags = [...this.tags]
        const collisionIndex = selected.key
            ? nextTags.findIndex(
                  (tag, index) =>
                      index !== sourceIndex && tag.key === selected.key
              )
            : -1
        if (collisionIndex < 0) {
            nextTags[sourceIndex] = selected
        } else {
            const merged = {
                ...nextTags[collisionIndex],
                ...selected,
            }
            const insertAt = Math.min(sourceIndex, collisionIndex)
            const withoutDuplicates = nextTags.filter(
                (_tag, index) =>
                    index !== sourceIndex && index !== collisionIndex
            )
            withoutDuplicates.splice(insertAt, 0, merged)
            this.tagsState.set(withoutDuplicates)
            return
        }
        this.tagsState.set(nextTags)
    }

    /** Writes (`yes`, a raw value) or removes (`null`) tags of the object. */
    applyTagsPatch(patch: TagsPatch): void {
        let nextTags = this.tags.map((tag) => ({ ...tag }))
        for (const [rawKey, value] of Object.entries(patch)) {
            const key = normalizeOsmTagKey(rawKey)
            if (!key || !isEditableTagKey(key)) continue
            if (value === null) {
                nextTags = nextTags.filter((tag) => tag.key !== key)
                continue
            }
            const index = nextTags.findIndex((tag) => tag.key === key)
            if (index !== -1) {
                nextTags[index] = { ...nextTags[index], value }
            } else {
                nextTags = [...nextTags, { key, value }]
            }
        }
        this.tagsState.set(nextTags)
    }

    addPresetsTags(newTags: Record<string, string | number>): void {
        if (newTags) {
            this.tagsState.set(this.addTags(newTags, this.tags))
            this.initComponent(this.tagConfig)
        }
    }

    confirmCancelChange(): void {
        const changeType = this.feature.properties.changeType
        const messageKey =
            changeType === 'Create'
                ? 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_CREATED'
                : changeType === 'Delete'
                  ? 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_DELETED'
                  : 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE'
        const data: ConfirmDialogData = {
            title: this.translate.instant('MAIN.SELECTION.REVERT_LOCAL_TITLE'),
            message: this.translate.instant(messageKey),
            cancelLabel: this.translate.instant('SHARED.CANCEL'),
            confirmLabel: this.translate.instant('MAIN.SELECTION.DISCARD'),
            destructive: true,
        }
        this.dialog
            .open(ConfirmDialogComponent, {
                data,
                maxWidth: 'calc(100vw - 32px)',
                panelClass: 'osmgo-dialog',
            })
            .afterClosed()
            .subscribe((confirmed) => {
                if (confirmed) void this.cancelChange()
            })
    }

    async cancelChange(): Promise<void> {
        const originalFeature = cloneDeep(
            this.feature.properties.originalData ?? undefined
        )
        try {
            await this.dataService.cancelPendingChange(String(this.feature.id))
        } catch (error) {
            this.presentToast(
                error instanceof Error ? error.message : String(error)
            )
            return
        }
        if (originalFeature) {
            this.dismiss({
                redraw: true,
                geojson: this.mapService.getIconStyle(originalFeature),
                origineData: 'data',
            })
        } else {
            this.dismiss({ redraw: true, deleted: true })
        }
    }
    presentToast(message: string): void {
        this.snackBar.open(message, this.translate.instant('SHARED.CLOSE'), {
            duration: 4000,
        })
    }

    generateISODate(date: Date): string {
        const YYYY = date.getFullYear()
        const MM =
            date.getMonth() + 1 < 10
                ? '0' + (date.getMonth() + 1)
                : '' + (date.getMonth() + 1)
        const DD =
            date.getDate() < 10 ? '0' + date.getDate() : '' + date.getDate()
        return YYYY + '-' + MM + '-' + DD
    }

    /** Sets the chosen date key, and refreshes the other one if present. */
    addSurveyDate(): void {
        const isoDate = this.generateISODate(new Date())
        const checkedKey = this.configService.config().checkedKey
        const tags = this.tags.map((tag) =>
            SURVEY_DATE_KEYS.includes(tag.key)
                ? { ...tag, value: isoDate }
                : tag
        )
        if (!tags.some((tag) => tag.key === checkedKey)) {
            tags.push({ key: checkedKey, value: isoDate })
        }
        this.tagsState.set(tags)
    }

    copyFields(): void {
        this.rememberFields(this.tagConfig, this.tags)
        this.presentToast(
            this.translate.instant('MODAL_SELECTED_ITEM.FIELDS_REMEMBERED', {
                category: this.fieldMemoryCategory,
            })
        )
    }

    rememberFields(tagConfig: TagConfig, tags: Tag[]): void {
        const savedTags = this.reusableFields(tagConfig, tags)
        this.tagsService.addSavedField(tagConfig.id, savedTags)
        this.savedFieldsState.set({
            tags: [...savedTags],
        })
    }

    restoreFields(tagId: string, tags: Tag[]): void {
        const fields = this.tagsService.savedFields[tagId]
        const newTags = tags.map((tag) => ({ ...tag }))
        if (fields) {
            for (const stags of this.reusableFields(
                this.tagConfig,
                fields.tags
            )) {
                const t = newTags.find((o) => o.key === stags.key)
                if (t) {
                    t.value = stags.value
                } else {
                    newTags.push(cloneDeep(stags))
                }
            }
        }
        this.tagsState.set([...newTags])
        this.initComponent(this.tagConfig)
    }

    private reusableFields(tagConfig: TagConfig, tags: Tag[]): Tag[] {
        const excludedKeys = new Set([
            ...Object.keys(tagConfig.tags),
            'name',
            'survey:date',
            'check_date',
        ])
        return tags
            .filter(
                (tag) =>
                    isEditableTagKey(tag.key) &&
                    !excludedKeys.has(tag.key) &&
                    String(tag.value).trim() !== '' &&
                    !tag.isDefaultValue
            )
            .map((tag) => ({ key: tag.key, value: tag.value }))
    }

    fixDeprecated(deprecated: DeprecatedTags): void {
        const deprecatedKeys = Object.keys(deprecated.old)
        const featureTags = { ...this.feature.properties.tags }
        const replace = resolveReplacementTags(
            deprecated.replace,
            this.feature.properties.tags
        )
        for (const deprecatedKey of deprecatedKeys) {
            delete featureTags[deprecatedKey]
        }
        this.feature.properties.tags = {
            ...featureTags,
            ...replace,
        }
        const replacementTags = Object.entries(replace).map(([key, value]) => ({
            key,
            value,
        }))
        const remainingTags = this.tags.filter(
            (tag) => !deprecatedKeys.includes(tag.key)
        )
        this.tagsState.set([...replacementTags, ...remainingTags])

        this.initComponent()
    }

    addOrRemoveBookmark(tag: TagConfig): void {
        if (!this.tagsService.bookmarksIds().includes(tag.id)) {
            this.tagsService.addBookMark(tag)
        } else {
            this.tagsService.removeBookMark(tag)
        }
    }
}
