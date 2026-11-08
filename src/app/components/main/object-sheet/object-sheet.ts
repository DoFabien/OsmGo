import { CdkScrollable } from '@angular/cdk/scrolling'
import {
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatDialog } from '@angular/material/dialog'
import { MatIconModule } from '@angular/material/icon'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatTooltipModule } from '@angular/material/tooltip'
import { cloneDeep } from '@app/utils/clone'
import { resolveReplacementTags } from '@app/utils/deprecated-tags'
import { isNodeUsedByWay } from '@app/utils/osm-feature'
import { isSafeExternalUrl } from '@app/utils/safe-external-url'
import { IconComponent } from '@components/icon/icon.component'
import { AlertComponent } from '@components/modal/components/alert/alert.component'
import { OpeningHoursComponent } from '@components/modal/components/opening-hours/opening-hours.component'
import { splitSemiComboValue } from '@components/modal/components/semi-combo/semi-combo.component'
import { SurveyCard } from '@components/modal/components/survey-card/SurveyCard'
import {
    isCoveredByPreset,
    isMultiValuePreset,
    isPrefixPreset,
    multiValueKey,
} from '@components/modal/editor-tag'
import {
    type ModalDismissData,
    ObjectEditorContentComponent,
} from '@components/modal/modal'
import { ModalPrimaryTag } from '@components/modal/modal.primaryTag/modal.primaryTag'
import {
    ConfirmDialogComponent,
    type ConfirmDialogData,
} from '@components/shared/confirm-dialog/confirm-dialog'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import type {
    EventShowModal,
    OsmGoFeature,
    Preset,
    TagConfig,
} from '@osmgo/type'
import { osmTagKeyToPresetId } from '@osmgo/utils'
import {
    formatLocalizedDate,
    parseLocalizedDate,
} from '@pipes/localized-date.pipe'
import { RelativeTimePipe } from '@pipes/relative-time.pipe'
import { getConfigTag } from '@scripts/osmToOsmgo/index.js'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmApiService } from '@services/osmApi.service'
import { TagsService } from '@services/tags.service'
import { finalize } from 'rxjs/operators'

export type ObjectSheetLevel = 'collapsed' | 'medium' | 'expanded'
export type ObjectSheetMode = 'read' | 'edit' | 'create' | 'category' | 'saving'

interface ObjectSummaryRow {
    href?: string
    icon: string
    isOpeningHours: boolean
    key: string
    label: string
    value: string
}

interface DeprecatedTags {
    old: Record<string, string | number>
    replace: Record<string, string | number>
}

const SUMMARY_ICONS: Record<string, string> = {
    artist_name: 'person',
    check_date: 'event_available',
    description: 'sell',
    material: 'layers',
    opening_hours: 'schedule',
    start_date: 'calendar_month',
    'survey:date': 'event_available',
    website: 'language',
    wheelchair: 'accessible',
}

const SUMMARY_LABELS: Record<string, string> = {
    artist_name: 'MAIN.SELECTION.FIELDS.ARTIST',
    material: 'MAIN.SELECTION.FIELDS.MATERIAL',
    start_date: 'MAIN.SELECTION.FIELDS.START_DATE',
}

const SUMMARY_ORDER = ['material', 'start_date', 'artist_name', 'description']

const SURVEY_DATE_KEYS = ['survey:date', 'check_date']

@Component({
    selector: 'app-object-sheet',
    templateUrl: './object-sheet.html',
    styleUrls: ['./object-sheet.scss'],
    imports: [
        CdkScrollable,
        AlertComponent,
        IconComponent,
        MatButtonModule,
        ModalPrimaryTag,
        ObjectEditorContentComponent,
        MatIconModule,
        MatTooltipModule,
        OpeningHoursComponent,
        RelativeTimePipe,
        SurveyCard,
        TranslateModule,
    ],
    host: {
        '[class.sheet-collapsed]': "level() === 'collapsed'",
        '[class.sheet-medium]': "level() === 'medium'",
        '[class.sheet-expanded]': "level() === 'expanded'",
        '[class.sheet-protected]': 'isEditing()',
    },
})
export class ObjectSheetComponent {
    readonly configService = inject(ConfigService)
    readonly tagsService = inject(TagsService)
    readonly translate = inject(TranslateService)
    readonly mapService = inject(MapService)
    private readonly dataService = inject(DataService)
    private readonly osmApi = inject(OsmApiService)
    private readonly dialog = inject(MatDialog)
    private readonly snackBar = inject(MatSnackBar)

    readonly selection = input.required<EventShowModal>()
    readonly level = input<ObjectSheetLevel>('medium')
    readonly stackPosition = input<{ index: number; count: number } | null>(
        null
    )
    readonly closeRequested = output<void>()
    readonly editRequested = output<OsmGoFeature | undefined>()
    readonly levelChange = output<ObjectSheetLevel>()
    readonly stackStepRequested = output<-1 | 1>()
    readonly stackListRequested = output<void>()
    readonly sessionCompleted = output<ModalDismissData>()

    readonly dragOffset = signal(0)
    readonly categoryOpen = signal(false)
    readonly displayCode = signal(false)
    readonly userLocale = this.resolveUserLocale()
    private pointerStartY: number | null = null
    private activePointerId: number | null = null
    private sheetTouchStartY: number | null = null
    private sheetTouchStartedInHeader = false
    private initializedObjectKey = ''

    readonly editor = viewChild<ObjectEditorContentComponent>('editor')
    readonly isEditing = computed(
        () =>
            this.selection().type === 'Update' ||
            this.selection().type === 'Create'
    )
    readonly mode = computed<ObjectSheetMode>(() => {
        if (this.categoryOpen()) return 'category'
        if (this.isEditing() && this.mapService.isProcessing()) return 'saving'
        if (this.selection().type === 'Create') return 'create'
        if (this.selection().type === 'Update') return 'edit'
        return 'read'
    })
    readonly categoryTagConfig = computed(() => {
        const currentTagConfig = this.editor()?.currentTagConfig()
        return (
            currentTagConfig ??
            getConfigTag(this.feature(), this.tagsService.tags())
        )
    })
    readonly categoryGeometry = computed(() => {
        const editorGeometry = this.editor()?.geometryType
        if (editorGeometry) return editorGeometry
        const feature = this.feature()
        const geometry = feature.properties.way_geometry ?? feature.geometry
        if (geometry.type === 'Point') {
            return isNodeUsedByWay(feature) ? 'vertex' : 'point'
        }
        if (
            geometry.type === 'LineString' ||
            geometry.type === 'MultiLineString'
        ) {
            return 'line'
        }
        return 'area'
    })

    readonly feature = computed<OsmGoFeature>(() => this.selection().geojson)
    readonly selectedTagConfig = computed(() =>
        getConfigTag(this.feature(), this.tagsService.tags())
    )
    readonly bookmarked = computed(() =>
        this.tagsService.bookmarksIds().includes(this.selectedTagConfig().id)
    )
    readonly title = computed(() => {
        const feature = this.feature()
        const name = feature.properties.tags['name'] || feature.properties._name
        return name
            ? String(name)
            : this.translate.instant('MODAL_SELECTED_ITEM.NO_NAME')
    })
    readonly titleSize = computed(() => {
        const length = Array.from(this.title().trim()).length
        if (length <= 22) return 'large'
        if (length <= 38) return 'medium'
        if (length <= 62) return 'compact'
        return 'minimum'
    })
    readonly category = computed(() => {
        const { configId, primaryTag } = this.feature().properties
        const language = this.configService.config().languageTags
        const tagsById = this.tagsService.tagsById()
        // The category found for the object comes before the one of its main tag.
        const config =
            (configId ? tagsById[configId] : undefined) ??
            tagsById[`${primaryTag.key}/${primaryTag.value}`]
        return (
            config?.lbl?.[language] ||
            config?.lbl?.['en'] ||
            String(primaryTag.value)
        )
    })
    private readonly prefixPresets = computed(() =>
        Object.values(this.tagsService.presets()).filter(isPrefixPreset)
    )
    /**
     * The fields that gather several tags of the object in one row: those of
     * the category first, then any key prefix field (`payment:`, `diet:`…).
     */
    readonly multiValueFields = computed<Preset[]>(() => {
        const tagConfig = this.selectedTagConfig()
        const presets = this.tagsService.presets()
        const keys = Object.entries(this.feature().properties.tags)
            .filter(([, value]) => value !== '' && value !== undefined)
            .map(([key]) => key)
        const candidates = [
            ...[...(tagConfig.presets ?? []), ...(tagConfig.moreFields ?? [])]
                .map((presetId) => presets[presetId])
                .filter((preset): preset is Preset =>
                    isMultiValuePreset(preset)
                ),
            ...this.prefixPresets(),
        ]
        const fields: Preset[] = []
        for (const preset of candidates) {
            const coversNewKey = keys.some(
                (key) =>
                    isCoveredByPreset(preset, key) &&
                    !fields.some((field) => isCoveredByPreset(field, key))
            )
            if (coversNewKey) fields.push(preset)
        }
        return fields
    })
    readonly rows = computed<ObjectSummaryRow[]>(() => {
        const feature = this.feature()
        const tags = feature.properties.tags
        const primaryKey = feature.properties.primaryTag.key
        const displayCode = this.displayCode()
        const multiValueFields = displayCode ? [] : this.multiValueFields()
        const shownFields = new Set<Preset>()

        return Object.entries(tags)
            .filter(
                ([key, value]) =>
                    (displayCode || (key !== 'name' && key !== primaryKey)) &&
                    value !== '' &&
                    value !== undefined
            )
            .sort(([leftKey], [rightKey]) => {
                const leftIndex = SUMMARY_ORDER.indexOf(leftKey)
                const rightIndex = SUMMARY_ORDER.indexOf(rightKey)
                return (
                    (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
                    (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
                )
            })
            .flatMap(([key, value]): ObjectSummaryRow[] => {
                const field = multiValueFields.find((candidate) =>
                    isCoveredByPreset(candidate, key)
                )
                if (field) {
                    if (shownFields.has(field)) return []
                    shownFields.add(field)
                    return [this.getMultiValueRow(field, tags)]
                }
                const preset =
                    this.tagsService.presets()[osmTagKeyToPresetId(key)]
                const rawValue = String(value)
                return [
                    {
                        key,
                        href:
                            !displayCode &&
                            preset?.type === 'url' &&
                            isSafeExternalUrl(rawValue)
                                ? rawValue
                                : undefined,
                        icon: displayCode
                            ? 'code'
                            : (SUMMARY_ICONS[key] ?? 'sell'),
                        isOpeningHours: key === 'opening_hours' && !displayCode,
                        label: displayCode
                            ? key
                            : this.getPresetLabel(key, preset),
                        value: displayCode
                            ? rawValue
                            : this.getPresetValue(rawValue, preset),
                    },
                ]
            })
    })
    readonly lastSurvey = computed<Date | undefined>(() => {
        const surveyDates = SURVEY_DATE_KEYS.map(
            (key) => this.feature().properties.tags[key]
        )
            .filter((value): value is string | number => value !== undefined)
            .map((value) => parseLocalizedDate(value))
            .filter((value): value is Date => value !== null)
        return surveyDates.length > 0
            ? surveyDates.reduce((latest, current) =>
                  current > latest ? current : latest
              )
            : undefined
    })
    readonly shouldShowSurveyCard = computed(() => {
        const display = this.configService.getDisplaySurveyCard()
        if (
            display === 'never' ||
            String(this.feature().properties.meta.timestamp) === '0'
        ) {
            return false
        }
        const lastSurvey = this.lastSurvey()
        if (!lastSurvey) return true
        const today = new Date()
        if (this.generateISODate(lastSurvey) === this.generateISODate(today)) {
            return false
        }
        if (display === 'always') return true
        const oneYear = 31_536_000_000
        return (
            lastSurvey.getTime() <
            today.getTime() - oneYear * this.configService.getSurveyCardYear()
        )
    })
    readonly usedByWaysCount = computed(() => {
        const usedByWays = this.feature().properties.usedByWays
        return Array.isArray(usedByWays)
            ? usedByWays.length
            : usedByWays
              ? 1
              : 0
    })
    readonly metadataTimestamp = computed(() =>
        String(this.feature().properties.meta.timestamp) === '0'
            ? 0
            : this.feature().properties.meta.timestamp
    )
    readonly metadataActionKey = computed(() =>
        this.feature().properties.meta.version > 1
            ? 'MAIN.SELECTION.METADATA.UPDATED'
            : 'MAIN.SELECTION.METADATA.CREATED'
    )
    readonly metadataAuthor = computed(
        () =>
            this.feature().properties.meta.user ||
            this.translate.instant('MODAL_SELECTED_ITEM.META_MYSELF')
    )

    constructor() {
        effect(() => {
            const selection = this.selection()
            const objectId =
                selection.geojson.id ??
                `${selection.geojson.properties.type}/${selection.geojson.properties.id}`
            const key = `${objectId}:${selection.type}`
            if (key === this.initializedObjectKey) return
            this.initializedObjectKey = key
            this.displayCode.set(false)
            this.categoryOpen.set(
                selection.type === 'Create' &&
                    Boolean(selection.openPrimaryTagModalOnStart)
            )
        })
    }

    toggleBookmark(): void {
        const tagConfig = this.selectedTagConfig()
        if (this.bookmarked()) {
            this.tagsService.removeBookMark(tagConfig)
        } else {
            this.tagsService.addBookMark(tagConfig)
        }
    }

    toggleCode(): void {
        this.displayCode.update((displayCode) => !displayCode)
        this.levelChange.emit('expanded')
    }

    fixDeprecated(deprecated: DeprecatedTags): void {
        const feature = cloneDeep(this.feature())
        const replace = resolveReplacementTags(
            deprecated.replace,
            feature.properties.tags
        )
        for (const deprecatedKey of Object.keys(deprecated.old)) {
            delete feature.properties.tags[deprecatedKey]
        }
        feature.properties.tags = {
            ...feature.properties.tags,
            ...replace,
        }
        this.editRequested.emit(feature)
    }

    handleSurveyYes(): void {
        const feature = cloneDeep(this.feature())
        const checkedKey = this.configService.config().checkedKey
        const today = this.generateISODate(new Date())
        const tags = feature.properties.tags
        for (const key of SURVEY_DATE_KEYS) {
            if (key === checkedKey || key in tags) tags[key] = today
        }
        this.persistFeature(feature)
    }

    handleSurveyNo(): void {
        if (this.feature().properties.type !== 'node') return
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
                if (confirmed) this.deleteSelectedObject()
            })
    }

    confirmCancelChange(): void {
        const changeType = this.feature().properties.changeType
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
            this.feature().properties.originalData ?? undefined
        )
        try {
            await this.dataService.cancelPendingChange(
                String(this.feature().id)
            )
        } catch (error) {
            this.presentToast(
                error instanceof Error ? error.message : String(error)
            )
            return
        }
        if (originalFeature) {
            this.sessionCompleted.emit({
                redraw: true,
                geojson: this.mapService.getIconStyle(originalFeature),
                origineData: 'data',
            })
        } else {
            this.sessionCompleted.emit({ redraw: true, deleted: true })
        }
    }

    cycleLevel(): void {
        if (this.isEditing()) return
        const nextLevel: Record<ObjectSheetLevel, ObjectSheetLevel> = {
            collapsed: 'medium',
            medium: 'expanded',
            expanded: 'collapsed',
        }
        this.levelChange.emit(nextLevel[this.level()])
    }

    onHandleClick(event: MouseEvent): void {
        if (event.detail === 0) this.cycleLevel()
    }

    toggleExpandedLevel(): void {
        if (this.isEditing() || this.level() === 'collapsed') return
        this.levelChange.emit(
            this.level() === 'expanded' ? 'medium' : 'expanded'
        )
    }

    onPointerDown(event: PointerEvent): void {
        if (this.isEditing()) return
        this.pointerStartY = event.clientY
        this.activePointerId = event.pointerId
        ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    }

    onPointerMove(event: PointerEvent): void {
        if (
            this.pointerStartY === null ||
            event.pointerId !== this.activePointerId
        ) {
            return
        }
        const delta = event.clientY - this.pointerStartY
        this.dragOffset.set(Math.max(-28, delta))
    }

    onPointerUp(event: PointerEvent): void {
        if (
            this.pointerStartY === null ||
            event.pointerId !== this.activePointerId
        ) {
            return
        }

        const delta = event.clientY - this.pointerStartY
        ;(event.currentTarget as HTMLElement).releasePointerCapture(
            event.pointerId
        )
        this.pointerStartY = null
        this.activePointerId = null
        this.dragOffset.set(0)

        if (delta > 42) {
            this.handleDownwardGesture()
        } else if (delta < -42) {
            this.levelChange.emit(
                this.level() === 'collapsed' ? 'medium' : 'expanded'
            )
        } else {
            this.cycleLevel()
        }
    }

    onPointerCancel(): void {
        this.pointerStartY = null
        this.activePointerId = null
        this.dragOffset.set(0)
    }

    onSheetTouchStart(event: TouchEvent): void {
        if (this.isEditing()) return
        const target = event.target
        if (
            event.touches.length !== 1 ||
            (target instanceof Element && target.closest('.sheet-handle'))
        ) {
            this.sheetTouchStartY = null
            this.sheetTouchStartedInHeader = false
            return
        }

        this.sheetTouchStartY = event.touches[0].clientY
        this.sheetTouchStartedInHeader =
            target instanceof Element &&
            target.closest('.object-header') !== null
    }

    onSheetTouchEnd(event: TouchEvent): void {
        if (
            this.sheetTouchStartY === null ||
            event.changedTouches.length === 0
        ) {
            return
        }

        const delta = event.changedTouches[0].clientY - this.sheetTouchStartY
        const startedInHeader = this.sheetTouchStartedInHeader
        this.sheetTouchStartY = null
        this.sheetTouchStartedInHeader = false
        if (delta > 56) {
            this.handleDownwardGesture()
        } else if (
            delta < -56 &&
            startedInHeader &&
            this.level() !== 'expanded'
        ) {
            this.levelChange.emit('expanded')
        }
    }

    onSheetTouchCancel(): void {
        this.sheetTouchStartY = null
        this.sheetTouchStartedInHeader = false
    }

    private handleDownwardGesture(): void {
        if (this.isEditing()) return
        if (this.level() === 'expanded') {
            this.levelChange.emit('medium')
        } else {
            this.closeRequested.emit()
        }
    }

    requestExit(): void {
        if (!this.isEditing()) {
            this.closeRequested.emit()
            return
        }

        const editor = this.editor()
        const hasDraft =
            this.selection().type === 'Create' ||
            Boolean(this.selection().newPosition) ||
            Boolean(editor?.dataIsChanged())
        if (!hasDraft) {
            this.completeCancellation()
            return
        }

        const data: ConfirmDialogData = {
            title: this.translate.instant('MAIN.SELECTION.DISCARD_TITLE'),
            message: this.translate.instant('MAIN.SELECTION.DISCARD_MESSAGE'),
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
                if (confirmed) this.completeCancellation()
            })
    }

    handleEditorDismissed(result?: ModalDismissData): void {
        if (!result) {
            this.requestExit()
            return
        }
        if (result.type === 'Edit') {
            this.editRequested.emit(undefined)
            return
        }
        this.sessionCompleted.emit(result)
    }

    openCategory(): void {
        this.categoryOpen.set(true)
    }

    closeCategory(): boolean {
        if (!this.categoryOpen()) return false
        this.handleCategoryCompleted(null)
        return true
    }

    handleCategoryCompleted(tagConfig: TagConfig | null): void {
        if (tagConfig) this.editor()?.applyPrimaryTagSelection(tagConfig)
        this.categoryOpen.set(false)
    }

    private persistFeature(feature: OsmGoFeature): void {
        this.mapService.setIsProcessing(true)
        this.osmApi
            .updateOsmElement(feature, this.selection().origineData)
            .pipe(
                finalize(() => {
                    this.mapService.setIsProcessing(false)
                })
            )
            .subscribe({
                next: (updatedFeature) => {
                    this.sessionCompleted.emit({
                        redraw: true,
                        geojson: updatedFeature,
                        origineData: 'data_changed',
                    })
                },
                error: (error: unknown) => {
                    console.error(error)
                    this.presentToast(this.translate.instant('SHARED.ERROR'))
                },
            })
    }

    private deleteSelectedObject(): void {
        this.mapService.setIsProcessing(true)
        this.osmApi
            .deleteOsmElement(this.feature())
            .pipe(
                finalize(() => {
                    this.mapService.setIsProcessing(false)
                })
            )
            .subscribe({
                next: () => {
                    this.sessionCompleted.emit({
                        redraw: true,
                        deleted: true,
                    })
                },
                error: (error: unknown) => {
                    console.error(error)
                    this.presentToast(this.translate.instant('SHARED.ERROR'))
                },
            })
    }

    private generateISODate(date: Date): string {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `${year}-${month}-${day}`
    }

    private presentToast(message: string): void {
        this.snackBar.open(message, this.translate.instant('SHARED.CLOSE'), {
            duration: 4000,
        })
    }

    private completeCancellation(): void {
        this.categoryOpen.set(false)
        if (this.selection().type === 'Create') {
            this.closeRequested.emit()
        } else {
            this.sessionCompleted.emit({ type: 'Cancel' })
        }
    }

    private getPresetLabel(key: string, preset?: Preset): string {
        const translatedLabel = SUMMARY_LABELS[key]
        if (translatedLabel) {
            return this.translate.instant(translatedLabel)
        }
        const language = this.configService.config().languageTags
        return (
            preset?.lbl[language] ||
            preset?.lbl['en'] ||
            key.replaceAll(':', ' · ').replaceAll('_', ' ')
        )
    }

    private getPresetValue(value: string, preset?: Preset): string {
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return formatLocalizedDate(value, this.userLocale)
        }
        if (preset?.type === 'semiCombo') {
            return splitSemiComboValue(value)
                .map((part) => this.getOptionLabel(part, preset))
                .join(', ')
        }
        return this.getOptionLabel(value, preset)
    }

    private getOptionLabel(value: string, preset?: Preset): string {
        const option = preset?.options?.find(
            (candidate) => candidate.v === value
        )
        const language = this.configService.config().languageTags
        return option?.lbl?.[language] || option?.lbl?.['en'] || value
    }

    /** `Cash, Card, Visa: no` for `payment:cash=yes`, `payment:cards=yes`, `payment:visa=no`. */
    private getMultiValueRow(
        preset: Preset,
        tags: Record<string, string | number>
    ): ObjectSummaryRow {
        const language = this.configService.config().languageTags
        const optionKeys = (preset.options ?? []).map((option) =>
            multiValueKey(preset, option.v)
        )
        const prefixLength = isPrefixPreset(preset)
            ? (preset.key ?? '').length
            : 0
        const rank = (key: string): number => {
            const index = optionKeys.indexOf(key)
            return index === -1 ? Number.MAX_SAFE_INTEGER : index
        }
        const coveredTags = Object.entries(tags)
            .filter(
                ([key, value]) =>
                    value !== '' &&
                    value !== undefined &&
                    isCoveredByPreset(preset, key)
            )
            .sort(([leftKey], [rightKey]) => rank(leftKey) - rank(rightKey))
        const chosen: string[] = []
        const others: string[] = []
        for (const [key, value] of coveredTags) {
            const option = preset.options?.[optionKeys.indexOf(key)]
            const label =
                option?.lbl?.[language] ||
                option?.lbl?.['en'] ||
                key.slice(prefixLength)
            const text = String(value).trim()
            if (text === 'yes') {
                chosen.push(label)
            } else {
                others.push(
                    this.translate.instant(
                        'MAIN.SELECTION.FIELDS.OPTION_VALUE',
                        {
                            label,
                            value: this.getMultiValueText(text),
                        }
                    )
                )
            }
        }
        const codeLabel = isPrefixPreset(preset)
            ? `${preset.key}*`
            : (preset.keys ?? []).join(' · ')
        return {
            key: codeLabel,
            icon: 'sell',
            isOpeningHours: false,
            label: preset.lbl?.[language] || preset.lbl?.['en'] || codeLabel,
            value: [...chosen, ...others].join(', '),
        }
    }

    private getMultiValueText(value: string): string {
        if (value === 'no') {
            return this.translate.instant('MAIN.SELECTION.FIELDS.VALUE_NO')
        }
        if (value === 'only') {
            return this.translate.instant('MAIN.SELECTION.FIELDS.VALUE_ONLY')
        }
        return value
    }

    private resolveUserLocale(): string {
        return (
            globalThis.navigator?.languages?.[0] ||
            globalThis.navigator?.language ||
            this.configService.config().languageUi ||
            'en'
        )
    }
}
