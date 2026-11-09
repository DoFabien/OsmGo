import { CdkTrapFocus } from '@angular/cdk/a11y'
import {
    type AfterViewInit,
    Component,
    computed,
    DestroyRef,
    type ElementRef,
    effect,
    HostListener,
    inject,
    type OnDestroy,
    type OnInit,
    signal,
    untracked,
    viewChild,
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router'
import { SwUpdate } from '@angular/service-worker'
import { OsmAuthService } from '@app/services/osm-auth.service'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { DialogMultiFeaturesComponent } from '@components/dialog-multi-features/dialog-multi-features.component'
import { MenuPage } from '@components/menu/menu'
import type { ModalDismissData } from '@components/modal/modal'
import {
    ConfirmDialogComponent,
    type ConfirmDialogData,
} from '@components/shared/confirm-dialog/confirm-dialog'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import type {
    EventShowModal,
    FeatureIdSource,
    OsmGoFeature,
    OsmGoFeatureCollection,
} from '@osmgo/type'
import { AlertService } from '@services/alert.service'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { InitService } from '@services/init.service'
import { LocationService } from '@services/location.service'
import { MapService, MIN_DOWNLOAD_ZOOM } from '@services/map.service'
import { requireMapDataResult } from '@services/osm-data-validation'
import { OsmApiService } from '@services/osmApi.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { TagsService } from '@services/tags.service'
import type { BBox } from 'geojson'
import { LngLat, type MapGeoJSONFeature } from 'maplibre-gl'
import {
    EMPTY,
    from,
    fromEvent,
    type Observable,
    type Subscription,
    take,
    timer,
} from 'rxjs'
import {
    catchError,
    filter,
    finalize,
    map,
    startWith,
    switchMap,
    throttleTime,
} from 'rxjs/operators'
import { MapControlsComponent } from './map-controls/map-controls'
import {
    ObjectSheetComponent,
    type ObjectSheetLevel,
} from './object-sheet/object-sheet'

type OverlaySize = 'compact' | 'standard' | 'wide'

const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000
const LINKED_OBJECT_ZOOM = 20

interface RouteOverlayContent {
    canCloseOverlay?: () => boolean
}

@Component({
    templateUrl: './main.html',
    selector: 'main',
    styleUrls: ['./main.scss'],
    imports: [
        CdkTrapFocus,
        MapControlsComponent,
        MenuPage,
        ObjectSheetComponent,
        RouterOutlet,
        TranslateModule,
    ],
})
export class MainPage implements AfterViewInit, OnDestroy, OnInit {
    readonly osmApi = inject(OsmApiService)
    readonly tagsService = inject(TagsService)
    readonly mapService = inject(MapService)
    readonly dataService = inject(DataService)
    readonly locationService = inject(LocationService)
    readonly alertService = inject(AlertService)
    readonly configService = inject(ConfigService)
    private readonly router = inject(Router)
    readonly translate = inject(TranslateService)
    private readonly swUpdate = inject(SwUpdate)
    readonly initService = inject(InitService)
    private readonly osmAuthService = inject(OsmAuthService)
    private readonly route = inject(ActivatedRoute)
    private readonly destroyRef = inject(DestroyRef)
    private destroyed = false
    private readonly dialog = inject(MatDialog)
    private readonly snackBar = inject(MatSnackBar)
    private readonly overlayNavigation = inject(OverlayNavigationService)
    private pendingAuthCallbackUrl: string | null = null
    private authCallbackInProgress = false
    private initialDataLoaded = false

    readonly menuIsOpen = signal(false)
    readonly newVersion = signal(false)
    readonly overlayOpen = signal(false)
    readonly overlaySize = signal<OverlaySize>('standard')
    readonly selectedFeature = signal<EventShowModal | null>(null)
    private readonly readBeforeEdit = signal<EventShowModal | null>(null)
    readonly displayedSelection = computed(() =>
        this.mapService.markerMoveMoving() ? null : this.selectedFeature()
    )
    readonly sheetLevel = signal<ObjectSheetLevel>('medium')
    private readonly stackedFeatures = signal<{
        features: MapGeoJSONFeature[]
        index: number
    } | null>(null)
    private browsingStack = false
    readonly stackNavigation = computed(() => {
        const stack = this.stackedFeatures()
        if (!stack || this.selectedFeature()?.type !== 'Read') return null
        return { index: stack.index, count: stack.features.length }
    })
    readonly mapControlsBottom = computed(() => {
        if (
            this.mapService.markerMoving() ||
            this.mapService.markerMoveMoving()
        ) {
            return 'max(46px, calc(env(safe-area-inset-bottom) + 42px))'
        }
        if (!this.selectedFeature()) {
            return 'max(46px, calc(env(safe-area-inset-bottom) + 42px))'
        }
        if (this.sheetLevel() === 'collapsed') {
            return '164px'
        }
        if (this.sheetLevel() === 'expanded') {
            return 'calc(100dvh + 24px)'
        }
        return 'calc(min(49dvh, 430px) + 12px)'
    })
    centerOnStart?: number[]
    zoomOnStart?: number
    loadOsmDataOnStart = false
    idOsmObjectOnStart?: string
    addOsmObjectOnStart?: {
        coords: LngLat
        tags: Record<string, string | number>
    }
    private resizeObserver?: ResizeObserver
    private backButtonListener?: PluginListenerHandle
    private resumeListener?: PluginListenerHandle
    private reloadPromptOpen = false
    private mapReady = false
    /** The linked object (`?id=`) whose position is still being looked up. */
    private linkedObjectPending = false
    private lateLinkedObject?: { lon: number; lat: number }
    private linkedObjectDownload?: Subscription
    private activeOverlayContent?: RouteOverlayContent
    private readonly dialogOpen = signal(false)
    /** Whether something on the map page closes with the back gesture. */
    private readonly backClosableOpen = computed(
        () =>
            this.menuIsOpen() ||
            this.selectedFeature() !== null ||
            this.mapService.markerMoving() ||
            this.mapService.markerMoveMoving() ||
            this.dialogOpen()
    )
    private backEntryPushed = false
    private returningToBackEntry = false
    private readonly handlePopState = (): void => {
        if (this.returningToBackEntry) {
            this.returningToBackEntry = false
            return
        }
        if (this.overlayOpen()) {
            this.dialog.closeAll()
            return
        }
        this.backEntryPushed = false
        this.closeInternalState()
        // What is still open (the sheet under a dialog, an exit
        // confirmation) needs the entry back for the next back gesture.
        setTimeout(() => {
            if (this.backClosableOpen()) this.returnToBackEntry()
            // The entry below may still name the closed object.
            if (
                !this.selectedFeature() &&
                this.route.snapshot.queryParamMap.has('id')
            ) {
                void this.router.navigate([], {
                    replaceUrl: true,
                    relativeTo: this.route,
                    queryParams: { id: null },
                    queryParamsHandling: 'merge',
                })
            }
        })
    }

    /**
     * In a browser the map page is a single history entry, so the back
     * gesture would leave the application. An extra entry is pushed while a
     * sheet, the menu or a dialog is open, and the back gesture closes it.
     * The native application handles its back button instead.
     */
    private pushBackEntry(): void {
        if (
            this.backEntryPushed ||
            Capacitor.isNativePlatform() ||
            this.overlayOpen()
        ) {
            return
        }
        history.pushState(history.state, '', location.href)
        this.backEntryPushed = true
    }

    /**
     * Moves forward again to the entry that the back gesture left. Pushing a
     * new one would not work: the browser's back button skips the entries
     * pushed without a user interaction.
     */
    private returnToBackEntry(): void {
        if (Capacitor.isNativePlatform() || this.overlayOpen()) return
        this.returningToBackEntry = true
        this.backEntryPushed = true
        history.forward()
        // Without an entry ahead, no popstate event follows.
        setTimeout(() => {
            this.returningToBackEntry = false
        }, 1000)
    }

    private closeInternalState(): boolean {
        // An open select or menu panel closes before what is under it.
        const panelBackdrop = document.querySelector<HTMLElement>(
            '.cdk-overlay-transparent-backdrop'
        )
        if (panelBackdrop) {
            panelBackdrop.click()
            return true
        }
        const openDialogs = this.dialog.openDialogs
        if (openDialogs.length > 0) {
            const dialog = openDialogs[openDialogs.length - 1]
            const instance = dialog.componentInstance as {
                cancel?: () => void
            } | null
            if (typeof instance?.cancel === 'function') instance.cancel()
            else dialog.close()
            return true
        }
        if (this.overlayOpen()) {
            this.closeOverlay()
            return true
        }
        if (this.menuIsOpen()) {
            this.closeMenu()
            return true
        }
        if (this.objectSheet()?.closeCategory()) return true
        if (this.mapService.markerMoveMoving()) {
            this.mapService.cancelNewPosition()
            return true
        }
        if (this.mapService.markerMoving()) {
            this.mapService.cancelNewMarker()
            return true
        }
        if (this.selectedFeature()) {
            this.objectSheet()?.requestExit()
            return true
        }
        return false
    }

    readonly mapElement = viewChild.required<ElementRef<HTMLElement>>('map')
    readonly objectSheet = viewChild<ObjectSheetComponent>('objectSheet')

    // authType = this.platform.platforms().includes('hybrid') ? 'basic' : 'oauth'

    constructor() {
        this.overlayNavigation.installCloseGuard()
        this.dialog.afterOpened
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => this.dialogOpen.set(true))
        this.dialog.afterAllClosed
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => this.dialogOpen.set(false))
        effect(() => {
            if (this.backClosableOpen()) untracked(() => this.pushBackEntry())
        })
        effect(() => {
            if (this.dataService.externalStateChange()) {
                this.presentReloadPrompt('MAIN.SW.EXTERNAL_STATE', 0)
            }
        })
        effect(() => {
            const coordinates = this.initService.lateLinkedObjectCoords()
            if (coordinates) {
                untracked(() => this.showLateLinkedObject(coordinates))
            }
        })
        this.mapService.featureChoiceRequested$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((features) => {
                if (
                    this.selectedFeature()?.type === 'Update' ||
                    this.selectedFeature()?.type === 'Create'
                ) {
                    return
                }
                this.openFeatureChoice(features)
            })

        this.mapService.mapBackgroundClick$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
                if (this.selectedFeature()?.type === 'Read') {
                    this.closeSelection()
                }
            })

        this.mapService.showModal$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((_data) => {
                const current = this.selectedFeature()
                if (
                    (current?.type === 'Update' ||
                        current?.type === 'Create') &&
                    _data.type === 'Read'
                ) {
                    return
                }
                if (_data.type === 'Update' && current?.type === 'Read') {
                    this.readBeforeEdit.set(current)
                } else if (_data.type === 'Create' || _data.type === 'Read') {
                    this.readBeforeEdit.set(null)
                }
                const browsingStack = this.browsingStack
                this.browsingStack = false
                if (!this.isCurrentStackedFeature(_data)) {
                    this.stackedFeatures.set(null)
                }
                this.selectedFeature.set(_data)
                if (!browsingStack) {
                    this.sheetLevel.set(
                        _data.type === 'Read' && !_data.newPosition
                            ? this.readSheetLevel()
                            : 'expanded'
                    )
                }
            })

        this.alertService.newAlert$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((alert) => {
                void this.presentToast(alert)
            })
    }

    ngOnInit(): void {
        this.route.queryParams
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((params) => {
                if (params['code'] || params['state'] || params['error']) {
                    if (!this.authCallbackInProgress) {
                        this.pendingAuthCallbackUrl =
                            typeof params['nativeOAuthCallbackUrl'] === 'string'
                                ? params['nativeOAuthCallbackUrl']
                                : window.location.href
                    }
                    this.tryHandleAuthCallback()
                }
            })

        const urlId = this.route.snapshot.queryParamMap.get('id') // ex : id=node/5432 or id=way/123456 or relation/123
        if (urlId && /^(node|way|relation)\/-?[1-9]\d*$/.test(urlId)) {
            const numericId = Number(urlId.split('/')[1])
            if (Number.isSafeInteger(numericId)) {
                this.idOsmObjectOnStart = urlId
                this.loadOsmDataOnStart = true
            }
        }

        const queryZoom = this.route.snapshot.queryParamMap.get('zoom')
        const queryLoadData = this.route.snapshot.queryParamMap.get('loadData')
        if (queryZoom && parseFloat(queryZoom) > 10) {
            let zoom = parseFloat(queryZoom) || 18
            if (zoom <= 14 || zoom > 22) zoom = 18
            this.zoomOnStart = zoom
        }

        const urlCenter = this.route.snapshot.queryParamMap.get('center')
        if (urlCenter && urlCenter.split(',').length === 2) {
            const center = urlCenter.split(',')
            const long = parseFloat(center[0])
            const lat = parseFloat(center[1])

            if (
                Number.isFinite(long) &&
                Number.isFinite(lat) &&
                long >= -180 &&
                long <= 180 &&
                lat >= -90 &&
                lat <= 90
            ) {
                this.centerOnStart = [long, lat]
                this.loadOsmDataOnStart = queryLoadData === 'true'
            }
        }

        const urlAddFeature = this.route.snapshot.queryParamMap.get('add')
        if (urlAddFeature && !this.idOsmObjectOnStart && !this.centerOnStart) {
            console.error('The add query parameter requires a map center.')
        }
        if (urlAddFeature && !this.idOsmObjectOnStart && this.centerOnStart) {
            if (!this.zoomOnStart) {
                this.zoomOnStart = 18
            }
            try {
                const addFeatureTag = JSON.parse(urlAddFeature)
                if (
                    typeof addFeatureTag !== 'object' ||
                    addFeatureTag === null ||
                    Array.isArray(addFeatureTag)
                )
                    throw new Error(
                        'The add query parameter must be an object.'
                    )
                if (
                    !Object.values(addFeatureTag).every(
                        (value) =>
                            typeof value === 'string' ||
                            typeof value === 'number'
                    )
                ) {
                    throw new Error(
                        'The add query parameter values must be strings or numbers.'
                    )
                }

                const _coords: LngLat = new LngLat(
                    this.centerOnStart[0],
                    this.centerOnStart[1]
                )
                this.addOsmObjectOnStart = {
                    coords: _coords,
                    tags: addFeatureTag as Record<string, string | number>,
                }
                this.loadOsmDataOnStart = true
            } catch (error) {
                console.error(error)
            }
        }

        if (!Capacitor.isNativePlatform() && this.swUpdate.isEnabled) {
            this.swUpdate.versionUpdates
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe((event) => {
                    if (event.type === 'VERSION_READY') {
                        this.newVersion.set(true)
                    } else if (event.type === 'VERSION_INSTALLATION_FAILED') {
                        this.presentReloadPrompt(
                            'MAIN.SW.INSTALLATION_FAILED',
                            10_000
                        )
                    }
                })
            this.swUpdate.unrecoverable
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe(() => {
                    this.presentReloadPrompt('MAIN.SW.UNRECOVERABLE', 0)
                })
            // A service worker that is still running when the app opens
            // does not look for a new version by itself.
            fromEvent(document, 'visibilitychange')
                .pipe(
                    filter(() => document.visibilityState === 'visible'),
                    startWith(null),
                    throttleTime(UPDATE_CHECK_INTERVAL_MS),
                    takeUntilDestroyed(this.destroyRef)
                )
                .subscribe(() => {
                    this.swUpdate.checkForUpdate().catch((error: unknown) => {
                        console.warn('Update check failed.', error)
                    })
                })
        }
    }

    /** A prompt without duration stays until the app reloads, even when another message covers it. */
    private presentReloadPrompt(messageKey: string, duration: number): void {
        if (this.reloadPromptOpen) return
        this.reloadPromptOpen = true
        const snackBarRef = this.snackBar.open(
            this.translate.instant(messageKey),
            this.translate.instant('MAIN.SW.RELOAD'),
            {
                duration,
                verticalPosition: 'top',
                panelClass: 'osmgo-snackbar-top',
            }
        )
        snackBarRef
            .onAction()
            .pipe(take(1), takeUntilDestroyed(this.destroyRef))
            .subscribe(() => this.reloadApplication())
        snackBarRef
            .afterDismissed()
            .pipe(take(1), takeUntilDestroyed(this.destroyRef))
            .subscribe(({ dismissedByAction }) => {
                this.reloadPromptOpen = false
                if (duration === 0 && !dismissedByAction && !this.destroyed) {
                    this.whenSnackBarFree(() =>
                        this.presentReloadPrompt(messageKey, duration)
                    )
                }
            })
    }

    /** Runs `show` once no other message is on screen. */
    private whenSnackBarFree(show: () => void): void {
        const current = this.snackBar._openedSnackBarRef
        if (!current) {
            show()
            return
        }
        current
            .afterDismissed()
            .pipe(take(1), takeUntilDestroyed(this.destroyRef))
            .subscribe(() => this.whenSnackBarFree(show))
    }

    private tryHandleAuthCallback(): void {
        if (
            !this.initialDataLoaded ||
            this.authCallbackInProgress ||
            !this.pendingAuthCallbackUrl
        ) {
            return
        }

        const url = this.pendingAuthCallbackUrl
        this.pendingAuthCallbackUrl = null
        this.authCallbackInProgress = true

        this.osmAuthService
            .handleCallback(url)
            .pipe(
                switchMap(() => this.osmApi.getUserDetail$()),
                finalize(() => {
                    this.authCallbackInProgress = false
                    void this.router.navigate([], {
                        queryParams: {
                            code: null,
                            state: null,
                            error: null,
                            error_description: null,
                            nativeOAuthCallbackUrl: null,
                        },
                        queryParamsHandling: 'merge',
                        replaceUrl: true,
                    })
                    this.tryHandleAuthCallback()
                }),
                takeUntilDestroyed(this.destroyRef)
            )
            .subscribe({
                error: (error) => {
                    console.error('Authentication failed.', error)
                    void this.presentToast(this.getErrorMessage(error))
                },
            })
    }

    private refreshStoredAuthentication(): void {
        if (
            !this.osmAuthService.getToken() ||
            this.pendingAuthCallbackUrl ||
            this.authCallbackInProgress
        ) {
            return
        }

        this.osmApi
            .getUserDetail$()
            .pipe(take(1), takeUntilDestroyed(this.destroyRef))
            .subscribe({
                error: (error) => {
                    console.error(
                        'Unable to refresh the OpenStreetMap account.',
                        error
                    )
                },
            })
    }

    openMenu(): void {
        if (
            this.selectedFeature()?.type === 'Update' ||
            this.selectedFeature()?.type === 'Create'
        ) {
            this.objectSheet()?.requestExit()
            return
        }
        this.configService.freezeMapRenderer = true
        this.menuIsOpen.set(true)
    }

    closeMenu(): void {
        this.configService.freezeMapRenderer = false
        this.menuIsOpen.set(false)
    }

    onOverlayActivate(component: unknown): void {
        this.activeOverlayContent = component as RouteOverlayContent
        const configuredSize = this.route.firstChild?.snapshot.data[
            'overlaySize'
        ] as OverlaySize | undefined
        this.overlaySize.set(configuredSize ?? 'standard')
        this.overlayOpen.set(true)
        this.menuIsOpen.set(false)
        this.configService.freezeMapRenderer = true
    }

    onOverlayDeactivate(): void {
        this.activeOverlayContent = undefined
        this.overlayOpen.set(false)
        this.configService.freezeMapRenderer = false
        if (this.mapService.map) {
            requestAnimationFrame(() => {
                this.mapService.map.resize()
                const menuButton = document.querySelector<HTMLElement>(
                    '[data-testid="open-menu"]'
                )
                menuButton?.focus()
            })
        }
    }

    closeOverlay(): void {
        if (this.activeOverlayContent?.canCloseOverlay?.() === false) return
        void this.overlayNavigation.close()
    }

    @HostListener('document:keydown.escape')
    handleEscapeKey(): void {
        if (this.overlayOpen()) {
            this.closeOverlay()
        } else if (this.menuIsOpen()) {
            this.closeMenu()
        }
    }

    closeSelection(): void {
        this.selectedFeature.set(null)
        this.readBeforeEdit.set(null)
        this.stackedFeatures.set(null)
        this.sheetLevel.set('medium')
        void this.router.navigate([], {
            replaceUrl: true,
            relativeTo: this.route,
            queryParams: { id: null },
            queryParamsHandling: 'merge',
        })
    }

    editSelectedFeature(replacementFeature?: OsmGoFeature): void {
        const selection = this.selectedFeature()
        if (selection) {
            this.readBeforeEdit.set(selection)
            this.selectedFeature.set({
                ...selection,
                type: 'Update',
                geojson: replacementFeature ?? selection.geojson,
            })
            this.sheetLevel.set('expanded')
        }
    }

    openFeatureChoice(features: MapGeoJSONFeature[]): void {
        const dialogRef = this.dialog.open(DialogMultiFeaturesComponent, {
            autoFocus: 'dialog',
            maxWidth: 'calc(100vw - 24px)',
            panelClass: ['osmgo-dialog', 'osmgo-feature-choice-dialog'],
        })
        dialogRef.componentRef?.setInput('features', features)
        dialogRef.componentRef?.setInput(
            'jsonSprites',
            this.tagsService.jsonSprites()
        )

        dialogRef.afterClosed().subscribe((feature) => {
            if (feature) {
                const previousStack = this.stackedFeatures()
                this.stackedFeatures.set({
                    features,
                    index: features.indexOf(feature),
                })
                if (!this.mapService.selectFeature(feature)) {
                    this.stackedFeatures.set(previousStack)
                }
            }
        })
    }

    openStackedFeatureChoice(): void {
        const stack = this.stackedFeatures()
        if (stack) this.openFeatureChoice(stack.features)
    }

    showStackedFeature(step: -1 | 1): void {
        const stack = this.stackedFeatures()
        if (!stack) return
        const count = stack.features.length
        this.browsingStack = true
        try {
            for (let offset = 1; offset <= count; offset++) {
                const index =
                    (((stack.index + step * offset) % count) + count) % count
                this.stackedFeatures.set({ ...stack, index })
                if (this.mapService.selectFeature(stack.features[index])) {
                    return
                }
            }
            this.stackedFeatures.set(stack)
        } finally {
            this.browsingStack = false
        }
    }

    private isCurrentStackedFeature(data: EventShowModal): boolean {
        const stack = this.stackedFeatures()
        if (!stack) return false
        const feature = stack.features[stack.index]
        return (
            feature !== undefined &&
            data.geojson.id ===
                `${feature.properties['type']}/${feature.properties['id']}`
        )
    }

    private readSheetLevel(): ObjectSheetLevel {
        return this.configService.config().openObjectSheetAsPreview
            ? 'medium'
            : 'expanded'
    }

    startAddingObject(): void {
        this.closeSelection()
        this.mapService.positionateMarker()
    }

    handleSheetSession(data: ModalDismissData): void {
        const selection = this.selectedFeature()
        if (!selection) return

        if (data.type === 'Move' && data.geojson) {
            this.selectedFeature.set({
                ...selection,
                type: data.mode ?? selection.type,
                geojson: data.geojson,
                newPosition: false,
            })
            this.mapService.moveElement(data)
            return
        }

        if (data.deleted) {
            this.closeSelection()
        } else if (data.geojson) {
            if (selection.type === 'Create' || selection.type === 'Update') {
                this.closeSelection()
            } else {
                this.readBeforeEdit.set(null)
                this.selectedFeature.set({
                    type: 'Read',
                    geojson: data.geojson,
                    origineData: data.origineData ?? 'data_changed',
                })
                this.sheetLevel.set(this.readSheetLevel())
            }
        } else if (data.type === 'Cancel') {
            const previousRead = this.readBeforeEdit()
            this.selectedFeature.set(
                previousRead ?? { ...selection, type: 'Read' }
            )
            this.readBeforeEdit.set(null)
            this.sheetLevel.set(this.readSheetLevel())
            return
        }

        if (data.redraw) {
            if (
                selection.origineData === 'data' ||
                data.origineData === 'data'
            ) {
                this.mapService.redrawMarkers(this.dataService.getGeojson())
            }
            this.mapService.redrawChangedMarkers(
                this.dataService.getGeojsonChanged()
            )
        }
        this.mapService.setCenterInUrl()
    }

    presentConfirm(): void {
        if (this.dialog.openDialogs.length > 0) return
        const data: ConfirmDialogData = {
            title: this.translate.instant('MAIN.EXIT_CONFIRM_HEADER'),
            message: this.translate.instant('MAIN.EXIT_CONFIRM_MESSAGE'),
            cancelLabel: this.translate.instant('SHARED.NO'),
            confirmLabel: this.translate.instant('SHARED.YES'),
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
                    void CapacitorApp.exitApp()
                }
            })
    }

    loadData(): void {
        this.loadData$()
            .pipe(take(1), takeUntilDestroyed(this.destroyRef))
            .subscribe()
    }

    loadData$(): Observable<void> {
        this.mapService.setIsDownloading(true)
        this.alertService.displayToolTipRefreshData = false

        const bbox: BBox = this.mapService.getBbox()
        return this.osmApi
            .getDataFromBbox(bbox, this.configService.getLimitFeatures())
            .pipe(
                switchMap((newDataJson) => {
                    const validatedData = requireMapDataResult(
                        newDataJson,
                        'map worker result'
                    )
                    return from(
                        this.dataService.applyDownload({
                            geojson: validatedData.geojson,
                            geojsonBbox: validatedData.geojsonBbox,
                        })
                    ).pipe(
                        map(() => {
                            // The stored state keeps pending objects and newer versions.
                            this.mapService.redrawBbox(
                                this.dataService.getGeojsonBbox()
                            )
                            this.mapService.redrawMarkers(
                                this.dataService.getGeojson(),
                                { replace: true }
                            )
                        })
                    )
                }),

                catchError((error: unknown) => {
                    console.error(error)
                    void this.presentToast(this.getErrorMessage(error))
                    return EMPTY
                }),
                finalize(() => this.mapService.setIsDownloading(false))
            )
    }

    presentToast(message: string): void {
        this.snackBar.open(message, this.translate.instant('SHARED.CLOSE'), {
            duration: 4000,
            verticalPosition: 'top',
            panelClass: 'osmgo-snackbar-top',
        })
    }

    ngAfterViewInit(): void {
        const mapElement = this.mapElement()
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target === mapElement.nativeElement) {
                    if (this.mapService.map) this.mapService.map.resize()
                }
            }
        })

        this.resizeObserver.observe(mapElement.nativeElement)

        this.initService
            .initLoadData$(
                this.centerOnStart,
                this.zoomOnStart,
                this.idOsmObjectOnStart
            )
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: ({ config, objectOnStartCoords }) => {
                    this.linkedObjectPending =
                        this.idOsmObjectOnStart !== undefined &&
                        !objectOnStartCoords
                    this.initialDataLoaded = true
                    this.tryHandleAuthCallback()
                    this.refreshStoredAuthentication()
                    this.locationService.enableGeolocation()
                    this.mapService.initMap(config)
                },
                error: (error) => {
                    console.error('Application initialization failed.', error)
                },
            })

        this.mapService.mapLoaded$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
                this.mapReady = true
                if (this.addOsmObjectOnStart) {
                    this.mapService.openModalOsm(
                        this.addOsmObjectOnStart.coords,
                        this.addOsmObjectOnStart.tags
                    )
                }

                const lateLinkedObject = this.lateLinkedObject
                if (lateLinkedObject) {
                    this.showLateLinkedObject(lateLinkedObject)
                } else if (this.loadOsmDataOnStart) {
                    this.linkedObjectDownload = this.loadData$()
                        .pipe(take(1), takeUntilDestroyed(this.destroyRef))
                        .subscribe({
                            next: () =>
                                this.openRequestedObject(
                                    !this.linkedObjectPending
                                ),
                        })
                }
                timer(2000)
                    .pipe(take(1), takeUntilDestroyed(this.destroyRef))
                    .subscribe(() =>
                        this.whenSnackBarFree(() => this.presentStartupHint())
                    )
            })

        this.alertService.displayRefreshTooltip$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
                const snackBarRef = this.snackBar.open(
                    this.translate.instant('MAIN.LOAD_BBOX'),
                    'OK',
                    { duration: 4000 }
                )
                snackBarRef
                    .onAction()
                    .pipe(take(1), takeUntilDestroyed(this.destroyRef))
                    .subscribe(() => {
                        if (!this.mapReady || this.mapService.isBusy()) return
                        if (this.mapService.map.getZoom() < MIN_DOWNLOAD_ZOOM) {
                            this.alertService.showAlert(
                                this.translate.instant(
                                    'MAIN.BUTTONS.REFRESH_ZOOM_HINT'
                                )
                            )
                            return
                        }
                        this.loadData()
                    })
            })

        this.locationService.permissionDenied$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
                void this.presentToast(
                    this.translate.instant('MAIN.LOCATION.DENIED')
                )
            })
        fromEvent(document, 'visibilitychange')
            .pipe(
                filter(() => document.visibilityState === 'visible'),
                takeUntilDestroyed(this.destroyRef)
            )
            .subscribe(() =>
                this.locationService.resumeGeolocationInForeground()
            )

        window.addEventListener('popstate', this.handlePopState)
        void CapacitorApp.addListener('backButton', () => {
            if (!this.closeInternalState()) {
                this.presentConfirm()
            }
        }).then((listener) => {
            if (this.destroyed) void listener.remove()
            else this.backButtonListener = listener
        })
        void CapacitorApp.addListener('resume', () => {
            this.locationService.resumeGeolocationInForeground()
        }).then((listener) => {
            if (this.destroyed) void listener.remove()
            else this.resumeListener = listener
        })
    }

    reloadApplication(): void {
        window.location.reload()
    }

    retryMapInitialization(): void {
        this.mapService.retryMapInitialization()
    }

    async resetStartupData(): Promise<void> {
        if (await this.initService.resetFatalResource()) {
            this.reloadApplication()
            return
        }
        this.presentToast(this.translate.instant('MAIN.STARTUP.RESET_FAILED'))
    }

    ngOnDestroy(): void {
        this.destroyed = true
        this.resizeObserver?.disconnect()
        void this.backButtonListener?.remove()
        void this.resumeListener?.remove()
        window.removeEventListener('popstate', this.handlePopState)
        this.mapService.destroyMap()
    }

    /** The start hint would cover the sheet or a page opened meanwhile. */
    private presentStartupHint(): void {
        if (this.selectedFeature() || this.overlayOpen() || this.menuIsOpen()) {
            return
        }
        const featureCount = this.dataService.getGeojson().features.length
        if (featureCount > 0) {
            this.alertService.showAlert(
                `${featureCount} ${this.translate.instant(
                    'MAIN.START_SNACK_ITEMS_IN_MEMORY'
                )}`
            )
        } else {
            this.alertService.requestRefreshTooltip()
        }
    }

    /**
     * The linked object was found after the map started elsewhere: shows its
     * area, downloads it, then opens the object.
     */
    private showLateLinkedObject(coordinates: {
        lon: number
        lat: number
    }): void {
        if (!this.idOsmObjectOnStart) return
        if (!this.mapReady) {
            this.lateLinkedObject = coordinates
            return
        }
        this.lateLinkedObject = undefined
        this.linkedObjectPending = false
        this.linkedObjectDownload?.unsubscribe()
        this.mapService.focusOn({
            center: [coordinates.lon, coordinates.lat],
            zoom: LINKED_OBJECT_ZOOM,
        })
        this.linkedObjectDownload = this.loadData$()
            .pipe(take(1), takeUntilDestroyed(this.destroyRef))
            .subscribe({ next: () => this.openRequestedObject(true) })
    }

    private openRequestedObject(reportMissing: boolean): void {
        if (!this.idOsmObjectOnStart) {
            return
        }

        let origineData: FeatureIdSource = 'data_changed'
        let feature = this.dataService.getFeatureById(
            this.idOsmObjectOnStart,
            origineData
        )
        if (!feature) {
            origineData = 'data'
            feature = this.dataService.getFeatureById(
                this.idOsmObjectOnStart,
                origineData
            )
        }

        if (!feature) {
            if (reportMissing) {
                this.presentToast(
                    this.translate.instant('MAIN.LINKED_OBJECT_NOT_FOUND')
                )
            }
            return
        }
        this.mapService.showModal({
            type: 'Read',
            geojson: feature,
            origineData,
        })
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }
}
