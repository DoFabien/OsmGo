import { DOCUMENT, KeyValuePipe } from '@angular/common'
import {
    type AfterViewInit,
    Component,
    computed,
    InjectionToken,
    inject,
    type OnDestroy,
    signal,
} from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatDialog } from '@angular/material/dialog'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MAX_CHANGESET_COMMENT_LENGTH } from '@app/utils/osm-tags'
import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { IconComponent } from '@components/icon/icon.component'
import {
    ConfirmDialogComponent,
    type ConfirmDialogData,
} from '@components/shared/confirm-dialog/confirm-dialog'
import { ScreenHeaderComponent } from '@components/shared/screen-header/screen-header'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import type { OsmGoFeature } from '@osmgo/type'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmAuthService } from '@services/osm-auth.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { TagsService } from '@services/tags.service'
import {
    UploadBusyElsewhereError,
    UploadCoordinatorService,
    type UploadFailure,
    type UploadFailureCode,
    type UploadFeature,
    type UploadRecoveryAction,
    type UploadSummary,
} from '@services/upload-coordinator.service'
import type { Geometry, Position } from 'geojson'
import { firstValueFrom, interval, timer } from 'rxjs'
import { map, take } from 'rxjs/operators'

export const UPLOAD_SUCCESS_DELAY_MS = new InjectionToken<number>(
    'Upload success feedback delay',
    { factory: () => 1000 }
)

/** Files for the Android WebView, which can neither share nor download. */
export interface NativeFileExport {
    isNativePlatform(): boolean
    filesystem: Pick<typeof Filesystem, 'writeFile'>
    share: Pick<typeof Share, 'share'>
}

export const NATIVE_FILE_EXPORT = new InjectionToken<NativeFileExport>(
    'Native file export',
    {
        factory: () => ({
            isNativePlatform: () => Capacitor.isNativePlatform(),
            filesystem: Filesystem,
            share: Share,
        }),
    }
)

@Component({
    selector: 'page-push-data-to-osm',
    templateUrl: './pushDataToOsm.html',
    styleUrls: ['./pushDataToOsm.scss'],
    host: { '(window:beforeunload)': 'warnBeforeLeaving($event)' },
    imports: [
        FormsModule,
        IconComponent,
        KeyValuePipe,
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatProgressSpinnerModule,
        ScreenHeaderComponent,
        TranslateModule,
    ],
})
export class PushDataToOsmPage implements AfterViewInit, OnDestroy {
    readonly dataService = inject(DataService)
    readonly tagsService = inject(TagsService)
    readonly mapService = inject(MapService)
    readonly configService = inject(ConfigService)
    readonly uploadCoordinator = inject(UploadCoordinatorService)
    private readonly translate = inject(TranslateService)
    private readonly dialog = inject(MatDialog)
    private readonly overlayNavigation = inject(OverlayNavigationService)
    private readonly snackBar = inject(MatSnackBar)
    private readonly successDelayMs = inject(UPLOAD_SUCCESS_DELAY_MS)
    private readonly document = inject(DOCUMENT)
    private readonly osmAuth = inject(OsmAuthService)
    private readonly nativeFileExport = inject(NATIVE_FILE_EXPORT)
    private readonly clock = toSignal(
        interval(1000).pipe(map(() => Date.now())),
        { initialValue: Date.now() }
    )

    readonly commentChangeset = signal(this.configService.getChangeSetComment())
    readonly maxCommentLength = MAX_CHANGESET_COMMENT_LENGTH
    readonly uploadInFlight = this.uploadCoordinator.inFlight
    readonly isPushing = this.uploadInFlight
    readonly uploadStatusVisible = signal(false)
    readonly uploadedOk = computed(
        () => this.uploadCoordinator.state().kind === 'succeeded'
    )
    readonly verifying = computed(
        () => this.uploadCoordinator.state().kind === 'verifying'
    )
    /** Failure explanations attached to queue entries, by feature id. */
    private readonly featureErrors = signal<Record<string, string>>({})
    private readonly failedFeatureId = signal<string | undefined>(undefined)
    readonly featuresChanges = computed<UploadFeature[]>(() => {
        const errors = this.featureErrors()
        const failedId = this.failedFeatureId()
        const features = this.dataService
            .changedFeatures()
            .map((feature): UploadFeature => {
                const error = errors[String(feature.id)]
                return error ? { ...feature, error } : feature
            })
        const failed = features.find((feature) => feature.id === failedId)
        return failed
            ? [failed, ...features.filter((feature) => feature !== failed)]
            : features
    })
    readonly summary = computed<UploadSummary>(() => {
        const summary: UploadSummary = {
            Total: 0,
            Create: 0,
            Update: 0,
            Delete: 0,
        }
        for (const feature of this.dataService.changedFeatures()) {
            const changeType = feature.properties.changeType
            if (
                changeType === 'Create' ||
                changeType === 'Update' ||
                changeType === 'Delete'
            ) {
                summary[changeType]++
            }
            summary.Total++
        }
        return summary
    })
    private readonly localError = signal<UploadFailure | undefined>(undefined)
    readonly connectionError = computed(() => {
        const state = this.uploadCoordinator.state()
        return state.kind === 'failed' && state.stage === 'connection'
            ? this.failureMessageKey(state.error.code)
            : undefined
    })
    readonly error = computed(() => {
        const localError = this.localError()
        if (localError) return localError
        const state = this.uploadCoordinator.state()
        return state.kind === 'failed' ? state.error : undefined
    })
    readonly activeJournal = computed(() => {
        this.uploadCoordinator.state()
        this.dataService.changedFeatures()
        return this.dataService.getUploadJournal()
    })
    readonly changesetInspectionUrl = computed(() => {
        const changesetId =
            this.error()?.changesetId ?? this.activeJournal()?.changesetId
        if (!changesetId) return undefined
        const host = this.configService.config().isDevServer
            ? 'https://master.apis.dev.openstreetmap.org'
            : 'https://www.openstreetmap.org'
        return `${host}/changeset/${encodeURIComponent(changesetId)}`
    })
    readonly recoveryQueueCount = computed(
        () =>
            this.activeJournal()?.submittedIds.length ??
            this.featuresChanges().length
    )
    /** The recovery data was handed to the user: removing the attempt is safe. */
    readonly recoveryExported = signal(false)
    readonly rebasing = signal(false)
    readonly rebaseConflict = signal<
        { keys: string[]; position: boolean; structure: boolean } | undefined
    >(undefined)
    readonly canRebase = computed(() => {
        const error = this.error()
        const feature = error?.feature
        return (
            error?.code === 'versionConflict' &&
            feature?.properties.changeType === 'Update'
        )
    })
    /**
     * Only a check made long enough after the failure, that found nothing,
     * lets the user call a lost answer "not applied".
     */
    readonly canMarkNotApplied = computed(() => {
        const error = this.error()
        return (
            this.activeJournal()?.phase === 'prepared' &&
            error?.code !== 'receiptNotSaved' &&
            error?.verification === 'notFound' &&
            error.notAppliedConfirmed === true
        )
    })
    /** Seconds before a new check can confirm that nothing was applied. */
    readonly confirmationCountdown = computed(() => {
        const error = this.error()
        if (
            error?.verification !== 'notFound' ||
            error.notAppliedConfirmed ||
            !error.confirmationCheckAfter
        ) {
            return undefined
        }
        const remaining =
            Date.parse(error.confirmationCheckAfter) - this.clock()
        return Number.isFinite(remaining)
            ? Math.max(0, Math.ceil(remaining / 1000))
            : 0
    })
    readonly canVerifyAgain = computed(() => {
        const error = this.error()
        return (
            this.activeJournal()?.phase === 'prepared' &&
            error?.code !== 'receiptNotSaved' &&
            !this.uploadInFlight()
        )
    })
    /**
     * An acknowledged attempt that cannot be reconciled, or a prepared one the
     * changeset holds only in part (an upload is applied as a whole).
     */
    readonly canMarkApplied = computed(() => {
        const phase = this.activeJournal()?.phase
        const error = this.error()
        return (
            ((phase === 'acknowledged' || phase === 'applied') && !!error) ||
            (phase === 'prepared' &&
                error?.verification === 'partial' &&
                error.code !== 'receiptNotSaved')
        )
    })
    readonly quarantinedCount = this.dataService.quarantinedCount
    /** Copies of local data set aside by a reset or a change of server. */
    readonly stateBackupCount = signal(0)
    readonly staleWindow = this.dataService.externalStateChange
    private destroyed = false
    private closeStarted = false
    private verificationRequested = false

    ngOnDestroy(): void {
        this.destroyed = true
        this.persistComment()
    }

    ngAfterViewInit(): void {
        void this.verifyAfterRestart()
        void this.loadStateBackupCount()
    }

    private async loadStateBackupCount(): Promise<void> {
        try {
            const backups = await this.dataService.getStateBackups()
            this.stateBackupCount.set(backups.length)
        } catch (error) {
            console.warn('Could not read the local data backups.', error)
        }
    }

    async exportStateBackups(): Promise<void> {
        let backups: unknown[]
        try {
            backups = await this.dataService.getStateBackups()
        } catch (error) {
            console.error('Could not read the local data backups.', error)
            this.displayError(this.translate.instant('SEND_DATA.EXPORT_FAILED'))
            return
        }
        await this.exportJsonFile('osmgo-local-data-backups.json', {
            exportedAt: new Date().toISOString(),
            note: 'Local OpenStreetMap data set aside by a reset or a change of server. Each entry keeps the stored values as they were.',
            backups,
        })
    }

    back(): void {
        if (this.canCloseOverlay()) void this.closeOverlayOnce()
    }

    canCloseOverlay(): boolean {
        return !this.uploadInFlight()
    }

    /** Warns before a reload or tab close would cut a running upload. */
    warnBeforeLeaving(event: BeforeUnloadEvent): void {
        if (!this.uploadInFlight()) return
        event.preventDefault()
        event.returnValue = ''
    }

    presentConfirm(): void {
        const count = this.featuresChanges().length
        void this.confirm({
            title: 'SEND_DATA.DELETE_CONFIRM_HEADER',
            message:
                count === 1
                    ? 'SEND_DATA.DELETE_CONFIRM_MESSAGE_ONE'
                    : 'SEND_DATA.DELETE_CONFIRM_MESSAGE',
            messageParams: { count },
            confirmLabel: 'SHARED.CONFIRM',
        }).then((confirmed) => {
            if (confirmed) void this.cancelAllFeatures()
        })
    }

    displayError(error: string): void {
        this.snackBar.open(error, this.translate.instant('SHARED.CLOSE'), {
            duration: 8000,
            panelClass: 'osmgo-error-snackbar',
        })
    }

    login(): void {
        this.persistComment()
        this.osmAuth.login().subscribe({
            error: (error) => {
                console.error('Unable to start login.', error)
                this.displayError(
                    this.translate.instant('SEND_DATA.ERRORS.LOGIN_FAILED')
                )
            },
        })
    }

    reloadApplication(): void {
        this.document.defaultView?.location.reload()
    }

    failureMessageKey(code: UploadFailureCode): string {
        const keys: Record<UploadFailureCode, string> = {
            emptyQueue: 'SEND_DATA.ERRORS.EMPTY_QUEUE',
            invalidQueue: 'SEND_DATA.ERRORS.INVALID_QUEUE',
            commentTooLong: 'SEND_DATA.ERRORS.COMMENT_TOO_LONG',
            connection: 'SEND_DATA.ERRORS.CONNECTION',
            authentication: 'SEND_DATA.ERRORS.AUTHENTICATION',
            forbidden: 'SEND_DATA.ERRORS.FORBIDDEN',
            changesetClosed: 'SEND_DATA.ERRORS.CHANGESET_CLOSED',
            changeset: 'SEND_DATA.ERRORS.CHANGESET',
            journal: 'SEND_DATA.ERRORS.JOURNAL',
            uploadRejected: 'SEND_DATA.ERRORS.UPLOAD_REJECTED',
            versionConflict: 'SEND_DATA.ERRORS.VERSION_CONFLICT',
            nodeStillReferenced: 'SEND_DATA.ERRORS.NODE_STILL_REFERENCED',
            uploadUncertain: 'SEND_DATA.ERRORS.UPLOAD_UNCERTAIN',
            uploadElsewhere: 'SEND_DATA.ERRORS.UPLOAD_ELSEWHERE',
            staleState: 'SEND_DATA.ERRORS.STALE_STATE',
            receiptNotSaved: 'SEND_DATA.ERRORS.RECEIPT_NOT_SAVED',
            reconciliation: 'SEND_DATA.ERRORS.RECONCILIATION',
            recoveryRequired: 'SEND_DATA.ERRORS.RECOVERY_REQUIRED',
            legacyJournal: 'SEND_DATA.ERRORS.LEGACY_JOURNAL',
            integrity: 'SEND_DATA.ERRORS.INTEGRITY',
            localChange: 'SEND_DATA.ERRORS.LOCAL_CHANGE',
            unknown: 'SEND_DATA.ERRORS.UNKNOWN',
        }
        return keys[code]
    }

    recoveryActionKey(action: UploadRecoveryAction): string {
        const keys: Record<UploadRecoveryAction, string> = {
            editQueue: 'SEND_DATA.RECOVERY.ACTIONS.EDIT_QUEUE',
            reconnect: 'SEND_DATA.RECOVERY.ACTIONS.RECONNECT',
            reauthenticate: 'SEND_DATA.RECOVERY.ACTIONS.REAUTHENTICATE',
            checkAccount: 'SEND_DATA.RECOVERY.ACTIONS.CHECK_ACCOUNT',
            createChangeset: 'SEND_DATA.RECOVERY.ACTIONS.CREATE_CHANGESET',
            inspectServer: 'SEND_DATA.RECOVERY.ACTIONS.INSPECT_SERVER',
            resumeReconciliation:
                'SEND_DATA.RECOVERY.ACTIONS.RESUME_RECONCILIATION',
            reload: 'SEND_DATA.RECOVERY.ACTIONS.RELOAD',
            retry: 'SEND_DATA.RECOVERY.ACTIONS.RETRY',
        }
        return keys[action]
    }

    verificationMessageKey(
        verification: UploadFailure['verification']
    ): string | undefined {
        switch (verification) {
            case 'notFound':
                return 'SEND_DATA.VERIFICATION_NOT_FOUND'
            case 'unavailable':
                return 'SEND_DATA.VERIFICATION_UNAVAILABLE'
            case 'partial':
                return 'SEND_DATA.VERIFICATION_PARTIAL'
            default:
                return undefined
        }
    }

    getSummary(): UploadSummary {
        return this.summary()
    }

    async pushDataToOsm(commentChangeset: string): Promise<void> {
        if (this.uploadInFlight()) return

        this.localError.set(undefined)
        this.rebaseConflict.set(undefined)
        this.featureErrors.set({})
        this.failedFeatureId.set(undefined)
        this.uploadStatusVisible.set(true)
        const state = await this.uploadCoordinator.start(commentChangeset)

        if (state.kind === 'failed') {
            this.uploadStatusVisible.set(false)
            const failedFeature = state.error.feature
            if (failedFeature) {
                this.markFeatureError(
                    String(failedFeature.id),
                    this.translate.instant(
                        this.failureMessageKey(state.error.code)
                    )
                )
            }
            return
        }
        if (state.kind !== 'succeeded') return

        await firstValueFrom(timer(this.successDelayMs).pipe(take(1)))
        this.uploadStatusVisible.set(false)
        if (!this.destroyed) await this.closeOverlayOnce()
    }

    confirmCancelErrorFeature(feature: OsmGoFeature): void {
        const message =
            feature.properties.changeType === 'Create'
                ? 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_CREATED'
                : feature.properties.changeType === 'Delete'
                  ? 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_DELETED'
                  : 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE'
        void this.confirm({
            title: 'MAIN.SELECTION.REVERT_LOCAL_TITLE',
            message,
            confirmLabel: 'MAIN.SELECTION.REVERT_LOCAL',
        }).then((confirmed) => {
            if (confirmed) void this.cancelErrorFeature(feature)
        })
    }

    async cancelErrorFeature(feature: OsmGoFeature): Promise<void> {
        try {
            await this.dataService.cancelPendingChange(String(feature.id))
        } catch (error) {
            this.setLocalError(error, feature)
            return
        }
        this.refreshMapAndQueue()
        this.localError.set(undefined)
        this.rebaseConflict.set(undefined)
        this.uploadCoordinator.resetTerminalState()
    }

    /**
     * Re-applies a change that lost a version conflict on top of the current
     * OpenStreetMap version. Overlapping edits are reported, never merged.
     */
    async rebaseErrorFeature(feature: OsmGoFeature): Promise<void> {
        if (this.rebasing()) return
        this.rebasing.set(true)
        this.rebaseConflict.set(undefined)
        try {
            const outcome = await this.uploadCoordinator.rebasePendingFeature(
                String(feature.id)
            )
            switch (outcome.kind) {
                case 'rebased':
                case 'upToDate':
                    this.refreshMapAndQueue()
                    this.localError.set(undefined)
                    this.uploadCoordinator.resetTerminalState()
                    this.notify(
                        outcome.kind === 'rebased'
                            ? 'SEND_DATA.REBASE_DONE'
                            : 'SEND_DATA.REBASE_UP_TO_DATE'
                    )
                    break
                case 'gone':
                    this.notify('SEND_DATA.REBASE_GONE')
                    break
                case 'conflict':
                    this.rebaseConflict.set({
                        keys: outcome.conflicts.map(({ key }) => key),
                        position: outcome.position,
                        structure: outcome.structure,
                    })
                    break
                default:
                    this.notify('SEND_DATA.REBASE_FAILED')
            }
        } catch (error) {
            console.error('Unable to rebase the pending change.', error)
            this.notify('SEND_DATA.REBASE_FAILED')
        } finally {
            this.rebasing.set(false)
        }
    }

    isFeatureLocked(feature: OsmGoFeature): boolean {
        return (
            this.activeJournal()?.submittedIds.includes(String(feature.id)) ??
            false
        )
    }

    async resumeReconciliation(): Promise<void> {
        this.localError.set(undefined)
        this.uploadStatusVisible.set(true)
        const state = await this.uploadCoordinator.resumeReconciliation()
        this.uploadStatusVisible.set(false)
        this.refreshMapAndQueue()
        if (state.kind === 'succeeded') {
            this.notify('SEND_DATA.RECONCILIATION_COMPLETE')
        }
    }

    /** Asks OpenStreetMap whether the lost attempt was applied after all. */
    async verifyAttempt(): Promise<void> {
        if (this.uploadInFlight()) return
        this.localError.set(undefined)
        this.uploadStatusVisible.set(true)
        try {
            const state = await this.uploadCoordinator.verifyPreparedAttempt()
            this.refreshMapAndQueue()
            if (state.kind === 'succeeded') {
                this.notify('SEND_DATA.RECONCILIATION_COMPLETE')
            }
        } finally {
            this.uploadStatusVisible.set(false)
        }
    }

    /**
     * After a restart, a prepared journal means an answer was lost: look it up
     * on the changeset before offering any way out.
     */
    private async verifyAfterRestart(): Promise<void> {
        if (
            this.verificationRequested ||
            this.activeJournal()?.phase !== 'prepared' ||
            this.error()?.verification ||
            this.uploadInFlight()
        ) {
            return
        }
        this.verificationRequested = true
        await this.verifyAttempt()
    }

    discardPreparedAttempt(): void {
        void this.confirm({
            title: 'SEND_DATA.DISCARD_ATTEMPT_CONFIRM_HEADER',
            message: 'SEND_DATA.DISCARD_ATTEMPT_CONFIRM_MESSAGE',
            confirmLabel: 'SHARED.CONFIRM',
        }).then((confirmed) => {
            if (confirmed) void this.confirmDiscardPreparedAttempt()
        })
    }

    /** Removes an unreconcilable attempt from the queue, once exported. */
    markAttemptAsApplied(): void {
        if (!this.recoveryExported() || !this.canMarkApplied()) return
        const prepared = this.activeJournal()?.phase === 'prepared'
        void this.confirm({
            title: 'SEND_DATA.MARK_APPLIED_CONFIRM_HEADER',
            message: 'SEND_DATA.MARK_APPLIED_CONFIRM_MESSAGE',
            confirmLabel: 'SHARED.CONFIRM',
        }).then(async (confirmed) => {
            if (!confirmed) return
            try {
                await (prepared
                    ? this.uploadCoordinator.markPartialAttemptAsApplied()
                    : this.uploadCoordinator.markAcknowledgedAttemptAsApplied())
            } catch (error) {
                this.setLocalError(error)
                return
            }
            this.localError.set(undefined)
            this.refreshMapAndQueue()
            this.notify('SEND_DATA.ATTEMPT_ABANDONED')
        })
    }

    async exportRecoveryBundle(): Promise<void> {
        const journal = this.activeJournal()
        if (!journal) return
        const unsaved = this.uploadCoordinator.getUnsavedReceipt()
        const exported = await this.exportJsonFile(
            `osmgo-upload-recovery-${journal.attemptId}.json`,
            {
                exportedAt: new Date().toISOString(),
                journal,
                ...(unsaved ? { unsavedServerAnswer: unsaved } : {}),
                currentPendingFeatures:
                    this.dataService.getGeojsonChanged().features,
            }
        )
        if (exported) this.recoveryExported.set(true)
    }

    async exportQuarantine(): Promise<void> {
        const features = await this.dataService.getQuarantinedFeatures()
        await this.exportJsonFile('osmgo-unreadable-objects.json', {
            exportedAt: new Date().toISOString(),
            note: 'Objects that could not be read and were set aside. Each entry keeps its raw value.',
            features,
        })
    }

    dismissQuarantine(): void {
        void this.confirm({
            title: 'SEND_DATA.QUARANTINE_DISMISS_CONFIRM_HEADER',
            message: 'SEND_DATA.QUARANTINE_DISMISS_CONFIRM_MESSAGE',
            confirmLabel: 'SHARED.CONFIRM',
        }).then(async (confirmed) => {
            if (confirmed) await this.dataService.clearQuarantine()
        })
    }

    /**
     * Hands a JSON file to the user: the system share sheet in the Android
     * application, the browser share sheet where it can share files, a
     * download link elsewhere. Resolves to false when nothing was exported,
     * including a share sheet the user closed.
     */
    private async exportJsonFile(
        fileName: string,
        data: unknown
    ): Promise<boolean> {
        const json = JSON.stringify(data, null, 2)
        if (this.nativeFileExport.isNativePlatform()) {
            return this.shareNativeFile(fileName, json)
        }
        const view = this.document.defaultView
        try {
            const file = new File([json], fileName, {
                type: 'application/json',
            })
            const navigator = view?.navigator
            if (navigator?.share && navigator.canShare?.({ files: [file] })) {
                await navigator.share({ files: [file], title: fileName })
                return true
            }
        } catch (error) {
            if ((error as { name?: unknown })?.name === 'AbortError') {
                return false
            }
            console.warn('Sharing failed, downloading instead.', error)
        }
        try {
            const url = URL.createObjectURL(
                new Blob([json], { type: 'application/json' })
            )
            const link = this.document.createElement('a')
            link.href = url
            link.download = fileName
            link.click()
            // Some WebViews read the blob after the click: revoke it later.
            view?.setTimeout(() => URL.revokeObjectURL(url), 60_000)
            return true
        } catch (error) {
            console.error('The file could not be exported.', error)
            this.displayError(this.translate.instant('SEND_DATA.EXPORT_FAILED'))
            return false
        }
    }

    private async shareNativeFile(
        fileName: string,
        json: string
    ): Promise<boolean> {
        let uri: string
        try {
            ;({ uri } = await this.nativeFileExport.filesystem.writeFile({
                path: fileName,
                data: json,
                directory: Directory.Cache,
                encoding: Encoding.UTF8,
            }))
        } catch (error) {
            console.error('The file could not be written.', error)
            this.displayError(this.translate.instant('SEND_DATA.EXPORT_FAILED'))
            return false
        }
        try {
            await this.nativeFileExport.share.share({
                title: fileName,
                files: [uri],
            })
            return true
        } catch (error) {
            // Android rejects a share sheet closed without choosing a target.
            console.warn('The file was not shared.', error)
            return false
        }
    }

    async cancelAllFeatures(): Promise<void> {
        try {
            await this.dataService.cancelAllPendingChanges()
        } catch (error) {
            this.setLocalError(error)
            return
        }
        this.refreshMapAndQueue()
        this.localError.set(undefined)
        this.uploadCoordinator.resetTerminalState()
        this.back()
    }

    centerToElement(geometry: OsmGoFeature['geometry']): void {
        this.persistComment()
        if (geometry.type === 'Point') {
            const [longitude, latitude] = geometry.coordinates
            if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
                return
            }
            this.mapService.focusOn({
                center: [longitude, latitude],
                zoom: Math.max(this.mapService.map.getZoom(), 18.5),
            })
        } else {
            const bounds = this.geometryBounds(geometry)
            if (!bounds) return
            this.mapService.focusOn({ bounds, padding: 48 })
        }
        this.back()
    }

    private geometryBounds(
        geometry: Exclude<Geometry, { type: 'Point' }>
    ): [[number, number], [number, number]] | null {
        const positions: Position[] = []
        const collectPositions = (value: unknown): void => {
            if (
                Array.isArray(value) &&
                value.length >= 2 &&
                typeof value[0] === 'number' &&
                typeof value[1] === 'number' &&
                Number.isFinite(value[0]) &&
                Number.isFinite(value[1])
            ) {
                positions.push(value as Position)
                return
            }
            if (Array.isArray(value)) {
                for (const child of value) collectPositions(child)
            }
        }

        if (geometry.type === 'GeometryCollection') {
            for (const child of geometry.geometries) {
                if (child.type === 'Point') {
                    collectPositions(child.coordinates)
                } else {
                    const childBounds = this.geometryBounds(child)
                    if (childBounds) collectPositions(childBounds)
                }
            }
        } else {
            collectPositions(geometry.coordinates)
        }
        if (positions.length === 0) return null

        let west = positions[0][0]
        let east = positions[0][0]
        let south = positions[0][1]
        let north = positions[0][1]
        for (const [longitude, latitude] of positions.slice(1)) {
            west = Math.min(west, longitude)
            east = Math.max(east, longitude)
            south = Math.min(south, latitude)
            north = Math.max(north, latitude)
        }
        return [
            [west, south],
            [east, north],
        ]
    }

    private persistComment(): void {
        const comment = this.commentChangeset()
        if (comment !== this.configService.getChangeSetComment()) {
            this.configService.setChangeSetComment(comment)
        }
    }

    private markFeatureError(featureId: string, error: string): void {
        this.featureErrors.update((errors) => ({
            ...errors,
            [featureId]: error,
        }))
        this.failedFeatureId.set(featureId)
    }

    private notify(messageKey: string): void {
        this.snackBar.open(
            this.translate.instant(messageKey),
            this.translate.instant('SHARED.CLOSE'),
            { duration: 6000 }
        )
    }

    private async confirm(options: {
        title: string
        message: string
        messageParams?: Record<string, unknown>
        confirmLabel: string
    }): Promise<boolean> {
        const data: ConfirmDialogData = {
            title: this.translate.instant(options.title),
            message: this.translate.instant(
                options.message,
                options.messageParams
            ),
            cancelLabel: this.translate.instant('SHARED.CANCEL'),
            confirmLabel: this.translate.instant(options.confirmLabel),
            destructive: true,
        }
        const confirmed = await firstValueFrom(
            this.dialog
                .open(ConfirmDialogComponent, {
                    data,
                    maxWidth: 'calc(100vw - 32px)',
                    panelClass: 'osmgo-dialog',
                })
                .afterClosed()
        )
        return !!confirmed
    }

    private setLocalError(
        error: unknown,
        feature: OsmGoFeature | null = null
    ): void {
        const details =
            typeof error === 'object' && error !== null
                ? (error as {
                      status?: unknown
                      error?: unknown
                      message?: unknown
                  })
                : {}
        const message =
            typeof details.error === 'string' && details.error.trim()
                ? details.error
                : typeof details.message === 'string' && details.message.trim()
                  ? details.message
                  : error instanceof Error && error.message.trim()
                    ? error.message
                    : 'The local changes could not be updated.'
        this.localError.set({
            status: typeof details.status === 'number' ? details.status : 0,
            code:
                error instanceof UploadBusyElsewhereError
                    ? 'uploadElsewhere'
                    : 'localChange',
            technicalMessage: message,
            feature,
            queuePreserved: true,
            canClose: true,
            canRetry: true,
            recoveryAction: 'retry',
        })
        this.uploadStatusVisible.set(false)
    }

    private refreshMapAndQueue(): void {
        this.mapService.redrawMarkers(this.dataService.getGeojson())
        this.mapService.redrawChangedMarkers(
            this.dataService.getGeojsonChanged()
        )
    }

    private async confirmDiscardPreparedAttempt(): Promise<void> {
        try {
            await this.uploadCoordinator.discardPreparedAttemptAsNotApplied()
        } catch (error) {
            this.setLocalError(error)
            return
        }
        this.localError.set(undefined)
        this.refreshMapAndQueue()
    }

    private async closeOverlayOnce(): Promise<void> {
        if (this.closeStarted) return
        this.closeStarted = true
        await this.overlayNavigation.close()
    }
}
