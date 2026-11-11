import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router'
import { SwUpdate } from '@angular/service-worker'
import { Capacitor } from '@capacitor/core'
import { TranslateService } from '@ngx-translate/core'
import { AlertService } from '@services/alert.service'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { InitService } from '@services/init.service'
import { LocationService } from '@services/location.service'
import { MapService } from '@services/map.service'
import { OsmAuthService } from '@services/osm-auth.service'
import { OsmApiService } from '@services/osmApi.service'
import { overlayCanDeactivate } from '@services/overlay-navigation.service'
import { TagsService } from '@services/tags.service'
import { firstValueFrom, of, Subject, throwError } from 'rxjs'
import type { Mock } from 'vitest'
import { MainPage } from './main'

interface MainPageDependencies {
    modalCtrl?: Record<string, unknown>
    osmApi?: Record<string, unknown>
    osmAuthService?: Record<string, unknown>
    mapService?: Record<string, unknown>
    dataService?: Record<string, unknown>
    alertService?: Record<string, unknown>
    configService?: Record<string, unknown>
    activatedRoute?: Record<string, unknown>
    swUpdate?: Record<string, unknown>
    snackBar?: Record<string, unknown>
    locationService?: Record<string, unknown>
    initService?: Record<string, unknown>
}

interface MainPageMapServiceStub extends Record<string, unknown> {
    featureChoiceRequested$: Subject<unknown>
    mapBackgroundClick$: Subject<void>
    showModal$: Subject<unknown>
    setCenterInUrl: Mock
}

const createPage = ({
    modalCtrl = {},
    osmApi = {},
    osmAuthService = {},
    mapService = {},
    dataService = {},
    alertService = {},
    configService = {},
    activatedRoute = {},
    swUpdate = {},
    snackBar = {},
    locationService = {},
    initService = {},
}: MainPageDependencies = {}) => {
    const resolvedMapService: MainPageMapServiceStub = {
        featureChoiceRequested$: new Subject(),
        mapBackgroundClick$: new Subject(),
        markerMoveMoving: signal(false),
        markerMoving: signal(false),
        mapInitializationError: signal(null),
        showModal$: new Subject(),
        setCenterInUrl: vi.fn(),
        ...mapService,
    } as MainPageMapServiceStub
    const resolvedAlertService = {
        newAlert$: new Subject(),
        displayRefreshTooltip$: new Subject(),
        showAlert: vi.fn(),
        requestRefreshTooltip: vi.fn(),
        ...alertService,
    }
    const resolvedConfigService = {
        freezeMapRenderer: false,
        config: () => ({ openObjectSheetAsPreview: false }),
        ...configService,
    }
    const router = { config: [], events: new Subject(), navigate: vi.fn() }
    TestBed.resetTestingModule()
    TestBed.configureTestingModule({
        providers: [
            {
                provide: MatDialog,
                useValue: {
                    openDialogs: [],
                    afterOpened: new Subject(),
                    afterAllClosed: new Subject(),
                    closeAll: vi.fn(),
                    ...modalCtrl,
                },
            },
            { provide: MatSnackBar, useValue: snackBar },
            { provide: OsmApiService, useValue: osmApi },
            { provide: TagsService, useValue: { jsonSprites: () => ({}) } },
            { provide: MapService, useValue: resolvedMapService },
            { provide: DataService, useValue: dataService },
            { provide: LocationService, useValue: locationService },
            { provide: AlertService, useValue: resolvedAlertService },
            { provide: ConfigService, useValue: resolvedConfigService },
            { provide: Router, useValue: router },
            {
                provide: TranslateService,
                useValue: { instant: (key: string) => key },
            },
            { provide: SwUpdate, useValue: swUpdate },
            { provide: InitService, useValue: initService },
            { provide: OsmAuthService, useValue: osmAuthService },
            {
                provide: ActivatedRoute,
                useValue: {
                    snapshot: { queryParamMap: convertToParamMap({}) },
                    ...activatedRoute,
                },
            },
        ],
    })
    const page = TestBed.runInInjectionContext(() => new MainPage())

    return {
        page,
        mapService: resolvedMapService,
        configService: resolvedConfigService,
        router,
    }
}

describe('MainPage', () => {
    it('delegates a map initialization retry to MapService', () => {
        const retryMapInitialization = vi.fn()
        const { page } = createPage({
            mapService: { retryMapInitialization },
        })

        page.retryMapInitialization()

        expect(retryMapInitialization).toHaveBeenCalledOnce()
    })

    it.each([
        { reset: true, reloaded: true },
        { reset: false, reloaded: false },
    ])(
        'reloads after a startup data reset only when it happened ($reset)',
        async ({ reset, reloaded }) => {
            const { page } = createPage({
                initService: {
                    resetFatalResource: () => Promise.resolve(reset),
                },
            })
            const reload = vi
                .spyOn(page, 'reloadApplication')
                .mockImplementation(() => undefined)
            vi.spyOn(page, 'presentToast').mockReturnValue(undefined)

            await page.resetStartupData()

            expect(reload).toHaveBeenCalledTimes(reloaded ? 1 : 0)
            if (reloaded) expect(page.presentToast).not.toHaveBeenCalled()
            else
                expect(page.presentToast).toHaveBeenCalledWith(
                    'MAIN.STARTUP.RESET_FAILED'
                )
        }
    )

    it.each([
        { native: false, expected: true },
        { native: true, expected: false },
    ])(
        'sets the PWA update indicator to $expected when native is $native',
        ({ native, expected }) => {
            const platform = vi
                .spyOn(Capacitor, 'isNativePlatform')
                .mockReturnValue(native)
            const queryParams = new Subject<Record<string, string>>()
            const versionUpdates = new Subject<{ type: string }>()
            const { page } = createPage({
                activatedRoute: {
                    queryParams,
                    snapshot: { queryParamMap: { get: () => null } },
                },
                swUpdate: {
                    checkForUpdate: vi.fn(() => Promise.resolve(false)),
                    isEnabled: true,
                    unrecoverable: new Subject(),
                    versionUpdates,
                },
            })

            page.ngOnInit()
            versionUpdates.next({ type: 'VERSION_READY' })

            expect(page.newVersion()).toBe(expected)
            platform.mockRestore()
        }
    )

    it('restores pending local objects from negative URL IDs', () => {
        const queryParams = new Subject<Record<string, string>>()
        const routeParams: Record<string, string> = { id: 'node/-1' }
        const { page } = createPage({
            activatedRoute: {
                queryParams,
                snapshot: {
                    queryParamMap: {
                        get: (key: string) => routeParams[key] ?? null,
                    },
                },
            },
            swUpdate: { isEnabled: false, versionUpdates: new Subject() },
        })

        page.ngOnInit()

        expect(page.idOsmObjectOnStart).toBe('node/-1')
        expect(page.loadOsmDataOnStart).toBe(true)
    })

    it('forwards the original native OAuth callback URL', () => {
        const queryParams = new Subject<Record<string, string>>()
        const nativeCallbackUrl =
            'osmgo://auth?code=authorization-code&state=oauth-state'
        const handleCallback = vi.fn().mockReturnValue(of(undefined))
        const { page, router } = createPage({
            activatedRoute: {
                queryParams,
                snapshot: { queryParamMap: { get: () => null } },
            },
            osmAuthService: {
                handleCallback,
                loadToken: () => Promise.resolve(null),
            },
            osmApi: { getUserDetail$: () => of(undefined) },
            swUpdate: { versionUpdates: new Subject() },
        })
        ;(page as unknown as { initialDataLoaded: boolean }).initialDataLoaded =
            true
        page.ngOnInit()

        queryParams.next({
            code: 'authorization-code',
            state: 'oauth-state',
            nativeOAuthCallbackUrl: nativeCallbackUrl,
        })

        expect(handleCallback).toHaveBeenCalledWith(nativeCallbackUrl)
        expect(router.navigate).toHaveBeenCalledWith([], {
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
    })

    it('updates menu state and renderer state together', () => {
        const { page, configService } = createPage()

        page.openMenu()

        expect(page.menuIsOpen()).toBe(true)
        expect(configService.freezeMapRenderer).toBe(true)

        page.closeMenu()

        expect(page.menuIsOpen()).toBe(false)
        expect(configService.freezeMapRenderer).toBe(false)
    })

    it('opens and deactivates the routed overlay without destroying the map page', () => {
        const { page, configService } = createPage()

        page.onOverlayActivate({})

        expect(page.overlayOpen()).toBe(true)
        expect(page.overlaySize()).toBe('standard')
        expect(configService.freezeMapRenderer).toBe(true)

        page.onOverlayDeactivate()

        expect(page.overlayOpen()).toBe(false)
        expect(configService.freezeMapRenderer).toBe(false)
    })

    it('protects an overlay workflow that cannot be closed yet', () => {
        const { page, router } = createPage()
        page.onOverlayActivate({ canCloseOverlay: () => false })

        page.closeOverlay()

        expect(router.navigate).not.toHaveBeenCalled()
    })

    it('closes a routed overlay while preserving map query parameters', () => {
        const { page, router } = createPage()
        page.onOverlayActivate({})

        page.closeOverlay()

        expect(router.navigate).toHaveBeenCalledWith(['/'], {
            queryParams: { lng: null, lat: null },
            queryParamsHandling: 'merge',
            replaceUrl: true,
        })
    })

    it('does not trap browser history when no internal state is open', () => {
        const pushState = vi.spyOn(window.history, 'pushState')
        const { page } = createPage()

        ;(page as unknown as { handlePopState: () => void }).handlePopState()

        expect(pushState).not.toHaveBeenCalled()
    })

    it('stops reacting to modal requests after destruction', () => {
        const showModal$ = new Subject<unknown>()
        const modalCtrl = { open: vi.fn().mockName('MatDialog.open') }
        createPage({
            modalCtrl,
            mapService: { showModal$ },
        })

        TestBed.resetTestingModule()
        showModal$.next({
            type: 'Read',
            geojson: { id: 'node/1' },
            origineData: 'data',
        })

        expect(modalCtrl.open).not.toHaveBeenCalled()
    })

    it('opens a read selection full screen in the mobile bottom sheet', () => {
        const showModal$ = new Subject<any>()
        const feature = { id: 'node/1' }
        const modalCtrl = { open: vi.fn() }
        const { page } = createPage({
            modalCtrl,
            mapService: { showModal$ },
        })

        showModal$.next({
            type: 'Read',
            geojson: feature,
            origineData: 'data',
        })

        expect(page.selectedFeature()).toEqual({
            type: 'Read',
            geojson: feature,
            origineData: 'data',
        })
        expect(page.sheetLevel()).toBe('expanded')
        expect(modalCtrl.open).not.toHaveBeenCalled()
    })

    it('opens a read selection as a preview when the setting asks for it', () => {
        const showModal$ = new Subject<any>()
        const { page } = createPage({
            mapService: { showModal$ },
            configService: {
                config: () => ({ openObjectSheetAsPreview: true }),
            },
        })

        showModal$.next({
            type: 'Read',
            geojson: { id: 'node/1' },
            origineData: 'data',
        })

        expect(page.sheetLevel()).toBe('medium')
    })

    describe('stacked features', () => {
        const stackedFeatures = [
            { properties: { type: 'node', id: 1 } },
            { properties: { type: 'node', id: 2 } },
            { properties: { type: 'way', id: 3 } },
        ]

        const missingFeatures = new Set<unknown>()

        const createStackedPage = () => {
            missingFeatures.clear()
            const showModal$ = new Subject<any>()
            const featureChoiceRequested$ = new Subject<unknown>()
            const afterClosed = new Subject<unknown>()
            const modalCtrl = {
                open: vi.fn(() => ({
                    componentRef: { setInput: vi.fn() },
                    afterClosed: () => afterClosed,
                })),
            }
            const selectFeature = vi.fn((feature: any) => {
                if (missingFeatures.has(feature)) return false
                showModal$.next({
                    type: 'Read',
                    geojson: {
                        id: `${feature.properties.type}/${feature.properties.id}`,
                    },
                    origineData: 'data',
                })
                return true
            })
            const created = createPage({
                modalCtrl,
                mapService: {
                    showModal$,
                    featureChoiceRequested$,
                    selectFeature,
                },
            })
            featureChoiceRequested$.next(stackedFeatures)
            return {
                ...created,
                modalCtrl,
                afterClosed,
                showModal$,
                selectFeature,
            }
        }

        it('keeps the choice dialog and enables browsing from the chosen object', () => {
            const { page, modalCtrl, afterClosed } = createStackedPage()

            expect(modalCtrl.open).toHaveBeenCalledOnce()
            afterClosed.next(stackedFeatures[1])

            expect(page.selectedFeature()?.geojson.id).toBe('node/2')
            expect(page.stackNavigation()).toEqual({ index: 1, count: 3 })
        })

        it('browses neighbours in both directions and wraps around', () => {
            const { page, afterClosed } = createStackedPage()
            afterClosed.next(stackedFeatures[0])

            page.showStackedFeature(-1)
            expect(page.selectedFeature()?.geojson.id).toBe('way/3')
            expect(page.stackNavigation()).toEqual({ index: 2, count: 3 })

            page.showStackedFeature(1)
            expect(page.selectedFeature()?.geojson.id).toBe('node/1')
        })

        it('keeps the sheet level chosen by the user while browsing', () => {
            const { page, afterClosed } = createStackedPage()
            afterClosed.next(stackedFeatures[0])
            page.sheetLevel.set('medium')

            page.showStackedFeature(1)

            expect(page.sheetLevel()).toBe('medium')
        })

        it('forgets the stack when another object is selected', () => {
            const { page, afterClosed, showModal$ } = createStackedPage()
            afterClosed.next(stackedFeatures[0])

            showModal$.next({
                type: 'Read',
                geojson: { id: 'node/99' },
                origineData: 'data',
            })

            expect(page.stackNavigation()).toBeNull()
        })

        it('forgets the stack when the sheet closes', () => {
            const { page, afterClosed } = createStackedPage()
            afterClosed.next(stackedFeatures[0])

            page.closeSelection()

            expect(page.stackNavigation()).toBeNull()
        })

        it('hides the arrows while the stacked object is edited', () => {
            const { page, afterClosed } = createStackedPage()
            afterClosed.next(stackedFeatures[0])

            page.editSelectedFeature()

            expect(page.stackNavigation()).toBeNull()
        })

        it('keeps the position when the next object can no longer be found', () => {
            const { page, afterClosed, selectFeature } = createStackedPage()
            afterClosed.next(stackedFeatures[0])
            missingFeatures.add(stackedFeatures[1])
            missingFeatures.add(stackedFeatures[2])

            page.showStackedFeature(1)

            expect(selectFeature).toHaveBeenCalledWith(stackedFeatures[1])
            expect(selectFeature).toHaveBeenCalledWith(stackedFeatures[2])
            expect(page.selectedFeature()?.geojson.id).toBe('node/1')
            expect(page.stackNavigation()).toEqual({ index: 0, count: 3 })
        })

        it('skips an object that disappeared and shows the next one', () => {
            const { page, afterClosed } = createStackedPage()
            afterClosed.next(stackedFeatures[0])
            missingFeatures.add(stackedFeatures[1])

            page.showStackedFeature(1)

            expect(page.selectedFeature()?.geojson.id).toBe('way/3')
            expect(page.stackNavigation()).toEqual({ index: 2, count: 3 })
        })

        it('does not move to a chosen object that cannot be opened', () => {
            const { page, afterClosed } = createStackedPage()
            afterClosed.next(stackedFeatures[0])
            missingFeatures.add(stackedFeatures[2])

            page.openStackedFeatureChoice()
            afterClosed.next(stackedFeatures[2])

            expect(page.selectedFeature()?.geojson.id).toBe('node/1')
            expect(page.stackNavigation()).toEqual({ index: 0, count: 3 })
        })

        it('reopens the choice dialog from the counter', () => {
            const { page, modalCtrl, afterClosed } = createStackedPage()
            afterClosed.next(stackedFeatures[0])

            page.openStackedFeatureChoice()

            expect(modalCtrl.open).toHaveBeenCalledTimes(2)
        })
    })

    describe('back navigation', () => {
        const closeInternalState = (page: MainPage): boolean =>
            (
                page as unknown as { closeInternalState(): boolean }
            ).closeInternalState()

        const withSheet = (page: MainPage, sheet: Record<string, unknown>) =>
            Object.defineProperty(page, 'objectSheet', {
                value: () => sheet,
            })

        const openRead = (showModal$: Subject<any>) =>
            showModal$.next({
                type: 'Read',
                geojson: { id: 'node/1' },
                origineData: 'data',
            })

        it('closes the topmost dialog before anything else', () => {
            const first = { close: vi.fn() }
            const second = { close: vi.fn() }
            const requestExit = vi.fn()
            const { page } = createPage({
                modalCtrl: { openDialogs: [first, second] },
            })
            withSheet(page, { closeCategory: () => true, requestExit })
            page.openMenu()

            expect(closeInternalState(page)).toBe(true)

            expect(second.close).toHaveBeenCalledOnce()
            expect(first.close).not.toHaveBeenCalled()
            expect(page.menuIsOpen()).toBe(true)
            expect(requestExit).not.toHaveBeenCalled()
        })

        it('closes the category picker before leaving the editor', () => {
            const showModal$ = new Subject<any>()
            const requestExit = vi.fn()
            const closeCategory = vi.fn(() => true)
            const { page } = createPage({ mapService: { showModal$ } })
            openRead(showModal$)
            withSheet(page, { closeCategory, requestExit })

            expect(closeInternalState(page)).toBe(true)

            expect(closeCategory).toHaveBeenCalledOnce()
            expect(requestExit).not.toHaveBeenCalled()
        })

        it('cancels the placement of a new object', () => {
            const cancelNewMarker = vi.fn()
            const { page } = createPage({
                mapService: {
                    cancelNewMarker,
                    markerMoving: signal(true),
                },
            })
            withSheet(page, { closeCategory: () => false })

            expect(closeInternalState(page)).toBe(true)

            expect(cancelNewMarker).toHaveBeenCalledOnce()
        })

        it('cancels the move of an object and keeps its sheet', () => {
            const showModal$ = new Subject<any>()
            const cancelNewPosition = vi.fn()
            const requestExit = vi.fn()
            const { page } = createPage({
                mapService: {
                    cancelNewPosition,
                    markerMoveMoving: signal(true),
                    showModal$,
                },
            })
            openRead(showModal$)
            withSheet(page, { closeCategory: () => false, requestExit })

            expect(closeInternalState(page)).toBe(true)

            expect(cancelNewPosition).toHaveBeenCalledOnce()
            expect(requestExit).not.toHaveBeenCalled()
        })

        it('closes the menu before the mode behind it', () => {
            const cancelNewMarker = vi.fn()
            const { page } = createPage({
                mapService: { cancelNewMarker, markerMoving: signal(true) },
            })
            page.menuIsOpen.set(true)

            expect(closeInternalState(page)).toBe(true)

            expect(page.menuIsOpen()).toBe(false)
            expect(cancelNewMarker).not.toHaveBeenCalled()
        })

        it('asks the sheet to exit when nothing else is open', () => {
            const showModal$ = new Subject<any>()
            const requestExit = vi.fn()
            const { page } = createPage({ mapService: { showModal$ } })
            openRead(showModal$)
            withSheet(page, { closeCategory: () => false, requestExit })

            expect(closeInternalState(page)).toBe(true)

            expect(requestExit).toHaveBeenCalledOnce()
        })

        it('lets the caller offer to quit when nothing is open', () => {
            const { page } = createPage()
            withSheet(page, { closeCategory: () => false })

            expect(closeInternalState(page)).toBe(false)
        })

        it('does not stack a second exit confirmation', () => {
            const open = vi.fn()
            const { page } = createPage({
                modalCtrl: { open, openDialogs: [{ close: vi.fn() }] },
            })

            page.presentConfirm()

            expect(open).not.toHaveBeenCalled()
        })

        it('leaves the closing of a routed overlay to the router on browser back', () => {
            const { page, router } = createPage()
            page.onOverlayActivate({})

            ;(
                page as unknown as { handlePopState: () => void }
            ).handlePopState()

            expect(router.navigate).not.toHaveBeenCalled()
            expect(page.overlayOpen()).toBe(true)
        })

        it('closes the menu on browser back', () => {
            const { page } = createPage()
            page.menuIsOpen.set(true)

            ;(
                page as unknown as { handlePopState: () => void }
            ).handlePopState()

            expect(page.menuIsOpen()).toBe(false)
        })

        describe('in a browser', () => {
            const effectServices = {
                dataService: { externalStateChange: signal(false) },
                initService: { lateLinkedObjectCoords: signal(null) },
            }
            const popState = (page: MainPage) =>
                (
                    page as unknown as { handlePopState: () => void }
                ).handlePopState()

            afterEach(() => {
                vi.restoreAllMocks()
                vi.useRealTimers()
            })

            it('adds one history entry while something is open, so that back closes it', () => {
                const pushState = vi
                    .spyOn(window.history, 'pushState')
                    .mockImplementation(() => undefined)
                const { page } = createPage(effectServices)

                page.openMenu()
                TestBed.tick()
                page.closeMenu()
                page.openMenu()
                TestBed.tick()

                expect(pushState).toHaveBeenCalledOnce()
            })

            it('does not add a history entry in the native app', () => {
                vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
                const pushState = vi
                    .spyOn(window.history, 'pushState')
                    .mockImplementation(() => undefined)
                const { page } = createPage(effectServices)

                page.openMenu()
                TestBed.tick()

                expect(pushState).not.toHaveBeenCalled()
            })

            it('goes forward to its entry again when back leaves something open', () => {
                vi.useFakeTimers()
                vi.spyOn(window.history, 'pushState').mockImplementation(
                    () => undefined
                )
                const forward = vi
                    .spyOn(window.history, 'forward')
                    .mockImplementation(() => undefined)
                const showModal$ = new Subject<any>()
                const close = vi.fn()
                const { page } = createPage({
                    ...effectServices,
                    mapService: { showModal$ },
                    modalCtrl: { openDialogs: [{ close }] },
                })
                openRead(showModal$)
                TestBed.tick()

                popState(page)
                vi.runOnlyPendingTimers()

                expect(close).toHaveBeenCalledOnce()
                expect(page.selectedFeature()).not.toBeNull()
                expect(forward).toHaveBeenCalledOnce()
                // The popstate event of that forward move closes nothing.
                popState(page)
                expect(page.selectedFeature()).not.toBeNull()
            })

            it('removes the closed object from the address when back closed its sheet', () => {
                vi.useFakeTimers()
                const showModal$ = new Subject<any>()
                const { page, router } = createPage({
                    ...effectServices,
                    mapService: { showModal$ },
                    activatedRoute: {
                        snapshot: {
                            queryParamMap: {
                                has: (key: string) => key === 'id',
                            },
                        },
                    },
                })
                openRead(showModal$)
                withSheet(page, {
                    closeCategory: () => false,
                    requestExit: () => page.closeSelection(),
                })
                router.navigate.mockClear()

                popState(page)
                // closeSelection's own update can lose to the router's
                // restoration of the entry below.
                router.navigate.mockClear()
                vi.runOnlyPendingTimers()

                expect(router.navigate).toHaveBeenCalledWith([], {
                    replaceUrl: true,
                    relativeTo: expect.anything(),
                    queryParams: { id: null },
                    queryParamsHandling: 'merge',
                })
            })

            it('closes the dialogs of a routed overlay on back', () => {
                const closeAll = vi.fn()
                const { page } = createPage({ modalCtrl: { closeAll } })
                page.onOverlayActivate({})

                popState(page)

                expect(closeAll).toHaveBeenCalledOnce()
            })
        })

        it('closes an open select panel before the dialog or sheet under it', () => {
            const backdrop = document.createElement('div')
            backdrop.className = 'cdk-overlay-transparent-backdrop'
            const click = vi.fn()
            backdrop.addEventListener('click', click)
            document.body.append(backdrop)
            const dialog = { close: vi.fn() }
            const { page } = createPage({
                modalCtrl: { openDialogs: [dialog] },
            })

            try {
                expect(closeInternalState(page)).toBe(true)
            } finally {
                backdrop.remove()
            }

            expect(click).toHaveBeenCalledOnce()
            expect(dialog.close).not.toHaveBeenCalled()
        })
    })

    it('guards the overlay routes so that browser back honours canCloseOverlay', () => {
        const overlay = { path: 'pushData' }
        const redirect = { path: 'callback', redirectTo: '' }
        const { router } = createPage()
        ;(router as unknown as { config: unknown[] }).config.push({
            path: '',
            children: [redirect, overlay],
        })

        TestBed.runInInjectionContext(() => new MainPage())

        expect(overlay).toHaveProperty('canDeactivate', [overlayCanDeactivate])
        expect(redirect).not.toHaveProperty('canDeactivate')
    })

    describe('service worker', () => {
        const createSwPage = () => {
            const versionUpdates = new Subject<{ type: string }>()
            const unrecoverable = new Subject<unknown>()
            const checkForUpdate = vi.fn(() => Promise.resolve(false))
            const action = new Subject<void>()
            const dismissed = new Subject<{ dismissedByAction: boolean }>()
            const open = vi.fn(() => ({
                afterDismissed: () => dismissed,
                onAction: () => action,
            }))
            const platform = vi
                .spyOn(Capacitor, 'isNativePlatform')
                .mockReturnValue(false)
            const created = createPage({
                activatedRoute: {
                    queryParams: new Subject(),
                    snapshot: { queryParamMap: { get: () => null } },
                },
                snackBar: { open },
                swUpdate: {
                    checkForUpdate,
                    isEnabled: true,
                    unrecoverable,
                    versionUpdates,
                },
            })
            created.page.ngOnInit()
            platform.mockRestore()
            return {
                ...created,
                action,
                checkForUpdate,
                dismissed,
                open,
                unrecoverable,
                versionUpdates,
            }
        }

        it('offers to reload when the worker is in an unrecoverable state', () => {
            const { open, unrecoverable } = createSwPage()

            unrecoverable.next({ reason: 'broken' })

            expect(open).toHaveBeenCalledWith(
                'MAIN.SW.UNRECOVERABLE',
                'MAIN.SW.RELOAD',
                expect.objectContaining({ duration: 0 })
            )
            TestBed.resetTestingModule()
        })

        it('offers to reload when a new version fails to install', () => {
            const { open, versionUpdates } = createSwPage()

            versionUpdates.next({ type: 'VERSION_INSTALLATION_FAILED' })

            expect(open).toHaveBeenCalledWith(
                'MAIN.SW.INSTALLATION_FAILED',
                'MAIN.SW.RELOAD',
                expect.anything()
            )
            TestBed.resetTestingModule()
        })

        it('reloads the app from the prompt and does not stack prompts', () => {
            const { action, dismissed, open, page, unrecoverable } =
                createSwPage()
            const reload = vi
                .spyOn(page, 'reloadApplication')
                .mockImplementation(() => undefined)

            unrecoverable.next({})
            unrecoverable.next({})
            expect(open).toHaveBeenCalledOnce()

            action.next()
            expect(reload).toHaveBeenCalledOnce()

            dismissed.next({ dismissedByAction: true })
            unrecoverable.next({})
            expect(open).toHaveBeenCalledTimes(2)
            TestBed.resetTestingModule()
        })

        it('shows a persistent prompt again once the message covering it is gone', () => {
            const { dismissed, open, page, unrecoverable } = createSwPage()
            const toastDismissed = new Subject<void>()
            const snackBar = TestBed.inject(MatSnackBar) as unknown as {
                _openedSnackBarRef: unknown
            }

            unrecoverable.next({})
            snackBar._openedSnackBarRef = {
                afterDismissed: () => toastDismissed,
            }
            dismissed.next({ dismissedByAction: false })
            expect(open).toHaveBeenCalledOnce()

            snackBar._openedSnackBarRef = null
            toastDismissed.next()

            expect(open).toHaveBeenCalledTimes(2)
            expect(open).toHaveBeenLastCalledWith(
                'MAIN.SW.UNRECOVERABLE',
                'MAIN.SW.RELOAD',
                expect.objectContaining({ duration: 0 })
            )
            expect(page.newVersion()).toBe(false)
            TestBed.resetTestingModule()
        })

        it('does not show a timed prompt again after it expired', () => {
            const { dismissed, open, versionUpdates } = createSwPage()

            versionUpdates.next({ type: 'VERSION_INSTALLATION_FAILED' })
            dismissed.next({ dismissedByAction: false })

            expect(open).toHaveBeenCalledOnce()
            TestBed.resetTestingModule()
        })

        it('checks for an update at startup, then not again on an immediate return to the foreground', () => {
            const { checkForUpdate } = createSwPage()

            document.dispatchEvent(new Event('visibilitychange'))
            document.dispatchEvent(new Event('visibilitychange'))

            expect(checkForUpdate).toHaveBeenCalledOnce()
            TestBed.resetTestingModule()
        })

        it('does not ask the worker anything in the native app', () => {
            const checkForUpdate = vi.fn(() => Promise.resolve(false))
            const platform = vi
                .spyOn(Capacitor, 'isNativePlatform')
                .mockReturnValue(true)
            const { page } = createPage({
                activatedRoute: {
                    queryParams: new Subject(),
                    snapshot: { queryParamMap: { get: () => null } },
                },
                swUpdate: { checkForUpdate, isEnabled: true },
            })

            page.ngOnInit()
            document.dispatchEvent(new Event('visibilitychange'))

            expect(checkForUpdate).not.toHaveBeenCalled()
            platform.mockRestore()
            TestBed.resetTestingModule()
        })
    })

    describe('leaving the editor', () => {
        const openEditor = () => {
            const showModal$ = new Subject<any>()
            const redrawMarkers = vi.fn()
            const redrawChangedMarkers = vi.fn()
            const created = createPage({
                dataService: {
                    getGeojson: () => ({ features: [] }),
                    getGeojsonChanged: () => ({ features: [] }),
                },
                mapService: {
                    redrawChangedMarkers,
                    redrawMarkers,
                    showModal$,
                },
            })
            const feature = { id: 'node/1' }
            showModal$.next({
                type: 'Read',
                geojson: feature,
                origineData: 'data',
            })
            return { ...created, feature, redrawChangedMarkers, redrawMarkers }
        }

        it('returns to the reading sheet of an existing object after abandoning', () => {
            const { feature, page, router } = openEditor()
            page.editSelectedFeature()
            expect(page.selectedFeature()?.type).toBe('Update')

            page.handleSheetSession({ type: 'Cancel' })

            expect(page.selectedFeature()).toEqual({
                type: 'Read',
                geojson: feature,
                origineData: 'data',
            })
            expect(page.sheetLevel()).toBe('expanded')
            expect(router.navigate).not.toHaveBeenCalled()
        })

        it('keeps the object in the URL after abandoning', () => {
            const { mapService, page } = openEditor()
            page.editSelectedFeature()

            page.handleSheetSession({ type: 'Cancel' })

            expect(mapService.setCenterInUrl).not.toHaveBeenCalled()
        })
    })

    describe('redrawing after a session', () => {
        const setup = (selectionOrigin: 'data' | 'data_changed') => {
            const showModal$ = new Subject<any>()
            const redrawMarkers = vi.fn()
            const redrawChangedMarkers = vi.fn()
            const created = createPage({
                dataService: {
                    getGeojson: () => ({ features: [] }),
                    getGeojsonChanged: () => ({ features: [] }),
                },
                mapService: {
                    redrawChangedMarkers,
                    redrawMarkers,
                    showModal$,
                },
            })
            showModal$.next({
                type: 'Update',
                geojson: { id: 'node/1' },
                origineData: selectionOrigin,
            })
            return { ...created, redrawChangedMarkers, redrawMarkers }
        }

        it('redraws both layers when an official object becomes a pending change', () => {
            const { page, redrawChangedMarkers, redrawMarkers } = setup('data')

            page.handleSheetSession({
                geojson: { id: 'node/1' },
                origineData: 'data_changed',
                redraw: true,
            } as any)

            expect(redrawMarkers).toHaveBeenCalledOnce()
            expect(redrawChangedMarkers).toHaveBeenCalledOnce()
        })

        it('redraws only the pending layer when a pending object is edited', () => {
            const { page, redrawChangedMarkers, redrawMarkers } =
                setup('data_changed')

            page.handleSheetSession({
                geojson: { id: 'node/1' },
                origineData: 'data_changed',
                redraw: true,
            } as any)

            expect(redrawMarkers).not.toHaveBeenCalled()
            expect(redrawChangedMarkers).toHaveBeenCalledOnce()
        })

        it('redraws the official layer when a change is reverted to its original', () => {
            const { page, redrawMarkers } = setup('data_changed')

            page.handleSheetSession({
                geojson: { id: 'node/1' },
                origineData: 'data',
                redraw: true,
            } as any)

            expect(redrawMarkers).toHaveBeenCalledOnce()
        })
    })

    it('hides the selected sheet while its marker is being moved', () => {
        const showModal$ = new Subject<any>()
        const markerMoveMoving = signal(false)
        const feature = { id: 'node/1' }
        const { page } = createPage({
            mapService: { showModal$, markerMoveMoving },
        })

        showModal$.next({
            type: 'Read',
            geojson: feature,
            origineData: 'data',
        })

        expect(page.displayedSelection()?.geojson).toBe(feature)

        markerMoveMoving.set(true)

        expect(page.displayedSelection()).toBeNull()
        expect(page.selectedFeature()?.geojson).toBe(feature)
        expect(page.mapControlsBottom()).toBe(
            'max(46px, calc(env(safe-area-inset-bottom) + 42px))'
        )

        markerMoveMoving.set(false)

        expect(page.displayedSelection()?.geojson).toBe(feature)
    })

    it('closes the selected sheet after a click on the map background', () => {
        const showModal$ = new Subject<any>()
        const mapBackgroundClick$ = new Subject<void>()
        const { page, router } = createPage({
            mapService: { showModal$, mapBackgroundClick$ },
        })

        showModal$.next({
            type: 'Read',
            geojson: { id: 'node/1' },
            origineData: 'data',
        })
        mapBackgroundClick$.next()

        expect(page.selectedFeature()).toBeNull()
        expect(page.sheetLevel()).toBe('medium')
        expect(router.navigate).toHaveBeenCalledWith([], {
            replaceUrl: true,
            relativeTo: expect.anything(),
            queryParams: { id: null },
            queryParamsHandling: 'merge',
        })
    })

    it('ignores map background clicks when no sheet is open', () => {
        const mapBackgroundClick$ = new Subject<void>()
        const { router } = createPage({
            mapService: { mapBackgroundClick$ },
        })

        mapBackgroundClick$.next()

        expect(router.navigate).not.toHaveBeenCalled()
    })

    it('routes edit requests into the expanded object sheet', () => {
        const showModal$ = new Subject<{
            type: string
            geojson: { id: string }
            origineData: string
        }>()
        const modalCtrl = {
            open: vi.fn(),
        }
        const feature = { id: 'node/1' }
        const { page, configService } = createPage({
            modalCtrl,
            mapService: {
                showModal$,
                setCenterInUrl: vi.fn(),
            },
        })

        showModal$.next({
            type: 'Update',
            geojson: feature,
            origineData: 'data',
        })

        expect(page.selectedFeature()).toEqual({
            type: 'Update',
            geojson: feature,
            origineData: 'data',
        })
        expect(page.sheetLevel()).toBe('expanded')
        expect(modalCtrl.open).not.toHaveBeenCalled()
        expect(configService.freezeMapRenderer).toBe(false)
    })

    it.each(['Create', 'Update'] as const)(
        'closes the object sheet after a successful %s',
        (type) => {
            const showModal$ = new Subject<any>()
            const { page, router } = createPage({
                mapService: { showModal$ },
            })
            showModal$.next({
                type,
                geojson: { id: 'node/1' },
                origineData: 'data',
            })

            page.handleSheetSession({
                geojson: { id: 'node/1' },
                origineData: 'data_changed',
            } as any)

            expect(page.selectedFeature()).toBeNull()
            expect(page.sheetLevel()).toBe('medium')
            expect(router.navigate).toHaveBeenCalledWith([], {
                replaceUrl: true,
                relativeTo: expect.anything(),
                queryParams: { id: null },
                queryParamsHandling: 'merge',
            })
        }
    )

    it('keeps a read sheet open after an action performed from that sheet', () => {
        const showModal$ = new Subject<any>()
        const updatedFeature = { id: 'node/1', updated: true }
        const { page } = createPage({ mapService: { showModal$ } })
        showModal$.next({
            type: 'Read',
            geojson: { id: 'node/1' },
            origineData: 'data',
        })

        page.handleSheetSession({
            geojson: updatedFeature,
            origineData: 'data_changed',
        } as any)

        expect(page.selectedFeature()).toEqual({
            type: 'Read',
            geojson: updatedFeature,
            origineData: 'data_changed',
        })
        expect(page.sheetLevel()).toBe('expanded')
    })

    it('ignores map background clicks while editing', () => {
        const showModal$ = new Subject<any>()
        const mapBackgroundClick$ = new Subject<void>()
        const { page, router } = createPage({
            mapService: { showModal$, mapBackgroundClick$ },
        })

        showModal$.next({
            type: 'Update',
            geojson: { id: 'node/1' },
            origineData: 'data',
        })
        mapBackgroundClick$.next()

        expect(page.selectedFeature()?.type).toBe('Update')
        expect(router.navigate).not.toHaveBeenCalled()
    })

    it('opens a corrected read feature in the existing unified editor', () => {
        const showModal$ = new Subject<any>()
        const originalFeature = { id: 'node/1', properties: { tags: {} } }
        const correctedFeature = {
            id: 'node/1',
            properties: { tags: { leisure: 'picnic_table' } },
        }
        const { page } = createPage({ mapService: { showModal$ } })
        showModal$.next({
            type: 'Read',
            geojson: originalFeature,
            origineData: 'data',
        })

        page.editSelectedFeature(correctedFeature as any)

        expect(page.selectedFeature()).toMatchObject({
            type: 'Update',
            geojson: correctedFeature,
            // the correction is a draft to save, not the state of the object
            baselineTags: {},
        })
        expect(page.sheetLevel()).toBe('expanded')
    })

    describe('after the map view starts', () => {
        const feature = { id: 'node/42', properties: {} }

        const boot = (
            options: {
                linkedId?: string
                objectOnStartCoords?: { lon: number; lat: number }
                zoom?: number
                features?: unknown[]
            } = {}
        ) => {
            vi.stubGlobal(
                'ResizeObserver',
                class {
                    observe(): void {}
                    disconnect(): void {}
                }
            )
            const mapLoaded$ = new Subject<void>()
            const init$ = new Subject<Record<string, unknown>>()
            const lateLinkedObjectCoords = signal<
                { lon: number; lat: number } | undefined
            >(undefined)
            const displayRefreshTooltip$ = new Subject<void>()
            const getFeatureById = vi.fn()
            const snackBarAction = new Subject<void>()
            const alertService = {
                newAlert$: new Subject(),
                displayRefreshTooltip$,
                showAlert: vi.fn(),
                requestRefreshTooltip: vi.fn(),
            }
            const created = createPage({
                mapService: {
                    focusOn: vi.fn(),
                    initMap: vi.fn(),
                    isBusy: () => false,
                    map: { getZoom: () => options.zoom ?? 18 },
                    mapLoaded$,
                    showModal: vi.fn(),
                },
                dataService: {
                    externalStateChange: () => false,
                    getFeatureById,
                    getGeojson: () => ({
                        type: 'FeatureCollection',
                        features: options.features ?? [],
                    }),
                },
                alertService,
                initService: {
                    initLoadData$: () => init$,
                    lateLinkedObjectCoords,
                },
                locationService: {
                    enableGeolocation: vi.fn(),
                    permissionDenied$: new Subject(),
                    resumeGeolocationInForeground: vi.fn(),
                },
                osmAuthService: { getToken: () => null },
                snackBar: {
                    open: vi.fn(() => ({
                        afterDismissed: () => new Subject(),
                        onAction: () => snackBarAction,
                    })),
                },
            })
            const { page } = created
            page.idOsmObjectOnStart = options.linkedId
            page.loadOsmDataOnStart = options.linkedId !== undefined
            Object.defineProperty(page, 'mapElement', {
                value: () => ({ nativeElement: document.createElement('div') }),
            })
            const loadData$ = vi
                .spyOn(page, 'loadData$')
                .mockImplementation(() => of(undefined))
            vi.spyOn(page, 'presentToast').mockReturnValue(undefined)
            page.ngAfterViewInit()
            init$.next({
                config: {},
                objectOnStartCoords: options.objectOnStartCoords,
            })
            return {
                ...created,
                alertService,
                displayRefreshTooltip$,
                getFeatureById,
                lateLinkedObjectCoords,
                loadData$,
                mapLoaded$,
                snackBarAction,
            }
        }

        afterEach(() => {
            TestBed.resetTestingModule()
            vi.unstubAllGlobals()
            vi.useRealTimers()
        })

        it('shows, downloads and opens a linked object found after the map started', () => {
            const {
                getFeatureById,
                lateLinkedObjectCoords,
                loadData$,
                mapLoaded$,
                mapService,
                page,
            } = boot({ linkedId: 'node/42' })

            mapLoaded$.next()
            expect(loadData$).toHaveBeenCalledOnce()
            expect(page.presentToast).not.toHaveBeenCalled()

            getFeatureById.mockImplementation((_id: string, source: string) =>
                source === 'data' ? feature : undefined
            )
            lateLinkedObjectCoords.set({ lon: 5.7, lat: 45.2 })
            TestBed.tick()

            expect(mapService['focusOn']).toHaveBeenCalledWith({
                center: [5.7, 45.2],
                zoom: 20,
            })
            expect(loadData$).toHaveBeenCalledTimes(2)
            expect(mapService['showModal']).toHaveBeenCalledWith({
                type: 'Read',
                geojson: feature,
                origineData: 'data',
            })
        })

        it('waits for the map when the linked object is found before it', () => {
            const {
                lateLinkedObjectCoords,
                loadData$,
                mapLoaded$,
                mapService,
            } = boot({ linkedId: 'node/42' })

            lateLinkedObjectCoords.set({ lon: 5.7, lat: 45.2 })
            TestBed.tick()
            expect(mapService['focusOn']).not.toHaveBeenCalled()

            mapLoaded$.next()

            expect(mapService['focusOn']).toHaveBeenCalledOnce()
            expect(loadData$).toHaveBeenCalledOnce()
        })

        it('says so, translated, when the linked object is not in its area', () => {
            const { lateLinkedObjectCoords, mapLoaded$, page } = boot({
                linkedId: 'node/42',
            })
            mapLoaded$.next()

            lateLinkedObjectCoords.set({ lon: 5.7, lat: 45.2 })
            TestBed.tick()

            expect(page.presentToast).toHaveBeenCalledWith(
                'MAIN.LINKED_OBJECT_NOT_FOUND'
            )
        })

        it('reports a linked object found in time but missing from the data', () => {
            const { mapLoaded$, page } = boot({
                linkedId: 'node/42',
                objectOnStartCoords: { lon: 5.7, lat: 45.2 },
            })

            mapLoaded$.next()

            expect(page.presentToast).toHaveBeenCalledWith(
                'MAIN.LINKED_OBJECT_NOT_FOUND'
            )
        })

        it('waits for the message on screen before the start hint', () => {
            vi.useFakeTimers()
            const { alertService, mapLoaded$ } = boot({ features: [{}] })
            const shown = new Subject<void>()
            const snackBar = TestBed.inject(MatSnackBar) as unknown as {
                _openedSnackBarRef: unknown
            }
            snackBar._openedSnackBarRef = { afterDismissed: () => shown }

            mapLoaded$.next()
            vi.advanceTimersByTime(2000)
            expect(alertService.showAlert).not.toHaveBeenCalled()

            snackBar._openedSnackBarRef = null
            shown.next()

            expect(alertService.showAlert).toHaveBeenCalledWith(
                'MAIN.START_SNACK_ITEMS_IN_MEMORY'
            )
        })

        it('skips the start hint while an object sheet is open', () => {
            vi.useFakeTimers()
            const { alertService, mapLoaded$, page } = boot({ features: [{}] })
            page.selectedFeature.set({
                type: 'Read',
                geojson: feature,
                origineData: 'data',
            } as never)

            mapLoaded$.next()
            vi.advanceTimersByTime(2000)

            expect(alertService.showAlert).not.toHaveBeenCalled()
        })

        it('downloads from the load prompt at the zoom the download button allows', () => {
            const {
                displayRefreshTooltip$,
                loadData$,
                mapLoaded$,
                snackBarAction,
            } = boot({ zoom: 15 })
            mapLoaded$.next()

            displayRefreshTooltip$.next()
            snackBarAction.next()

            expect(loadData$).toHaveBeenCalledOnce()
        })

        it('explains why the load prompt does not download when zoomed out', () => {
            const {
                alertService,
                displayRefreshTooltip$,
                loadData$,
                mapLoaded$,
                snackBarAction,
            } = boot({ zoom: 12 })
            mapLoaded$.next()

            displayRefreshTooltip$.next()
            snackBarAction.next()

            expect(loadData$).not.toHaveBeenCalled()
            expect(alertService.showAlert).toHaveBeenCalledWith(
                'MAIN.BUTTONS.REFRESH_ZOOM_HINT'
            )
        })
    })

    it('keeps existing data and clears processing after a download failure', () => {
        const mapService = {
            redrawBbox: vi.fn().mockName('redrawBbox'),
            redrawMarkers: vi.fn().mockName('redrawMarkers'),
            getBbox: () => [1, 2, 3, 4],
            setIsDownloading: vi.fn().mockName('setIsDownloading'),
        }
        const downloadError = new Error('Worker conversion failed')
        const osmApi = {
            getDataFromBbox: vi
                .fn()
                .mockName('getDataFromBbox')
                .mockReturnValue(throwError(() => downloadError)),
        }
        const dataService = {
            applyDownload: vi.fn().mockName('DataService.applyDownload'),
        }
        const alertService = {
            newAlert$: new Subject(),
            displayToolTipRefreshData: true,
        }
        const configService = {
            getLimitFeatures: () => 100,
            freezeMapRenderer: false,
        }
        const { page } = createPage({
            osmApi,
            mapService,
            dataService,
            alertService,
            configService,
        })
        vi.spyOn(console, 'error').mockReturnValue(undefined)
        vi.spyOn(page, 'presentToast').mockResolvedValue()

        page.loadData$().subscribe()

        expect(vi.mocked(mapService.setIsDownloading).mock.calls).toEqual([
            [true],
            [false],
        ])
        expect(dataService.applyDownload).not.toHaveBeenCalled()
        expect(page.presentToast).toHaveBeenCalledTimes(1)
        expect(page.presentToast).toHaveBeenCalledWith(
            'Worker conversion failed'
        )
    })

    it('persists a complete download atomically before redrawing the stored state', async () => {
        let acknowledgeDownload!: () => void
        const persisted = new Promise<void>((resolve) => {
            acknowledgeDownload = resolve
        })
        const result = {
            geojson: { type: 'FeatureCollection', features: [] },
            geojsonBbox: { type: 'FeatureCollection', features: [] },
        }
        // The stored state also keeps the newer versions of an upload.
        const merged = {
            geojson: { type: 'FeatureCollection', features: [{ id: 'n/1' }] },
            geojsonBbox: { type: 'FeatureCollection', features: [{}] },
        }
        const applyDownload = vi.fn().mockReturnValue(persisted)
        const mapService = {
            redrawBbox: vi.fn(),
            redrawMarkers: vi.fn(),
            getBbox: () => [1, 2, 3, 4],
            setIsDownloading: vi.fn(),
        }
        const { page } = createPage({
            osmApi: { getDataFromBbox: () => of(result) },
            dataService: {
                applyDownload,
                getGeojson: () => merged.geojson,
                getGeojsonBbox: () => merged.geojsonBbox,
            },
            mapService,
            alertService: {
                newAlert$: new Subject(),
                displayToolTipRefreshData: true,
            },
            configService: {
                getLimitFeatures: () => 100,
                freezeMapRenderer: false,
            },
        })

        const completed = firstValueFrom(page.loadData$())
        await Promise.resolve()

        expect(applyDownload).toHaveBeenCalledWith(result)
        expect(mapService.redrawMarkers).not.toHaveBeenCalled()

        acknowledgeDownload()
        await completed

        expect(mapService.redrawBbox).toHaveBeenCalledWith(merged.geojsonBbox)
        expect(mapService.redrawMarkers).toHaveBeenCalledWith(merged.geojson, {
            replace: true,
        })
        expect(mapService.setIsDownloading).toHaveBeenLastCalledWith(false)
    })

    it('keeps existing data when the worker result is incomplete', () => {
        const mapService = {
            redrawBbox: vi.fn(),
            redrawMarkers: vi.fn(),
            getBbox: () => [1, 2, 3, 4],
            setIsDownloading: vi.fn(),
        }
        const dataService = {
            applyDownload: vi.fn(),
        }
        const { page } = createPage({
            osmApi: {
                getDataFromBbox: () =>
                    of({
                        geojson: { type: 'FeatureCollection', features: [] },
                    }),
            },
            mapService,
            dataService,
            alertService: {
                newAlert$: new Subject(),
                displayToolTipRefreshData: true,
            },
            configService: {
                getLimitFeatures: () => 100,
                freezeMapRenderer: false,
            },
        })
        vi.spyOn(console, 'error').mockReturnValue(undefined)
        vi.spyOn(page, 'presentToast').mockResolvedValue()

        page.loadData$().subscribe()

        expect(dataService.applyDownload).not.toHaveBeenCalled()
        expect(mapService.setIsDownloading).toHaveBeenLastCalledWith(false)
        expect(page.presentToast).toHaveBeenCalledWith(
            'map worker result bbox: is not a feature collection'
        )
    })

    it('forwards marker movement from the unified sheet', () => {
        const showModal$ = new Subject<any>()
        const moveElement = vi.fn().mockName('moveElement')
        const movedFeature = {
            type: 'Move',
            geojson: { id: 'node/1' },
            mode: 'Update',
        }
        const { page } = createPage({
            mapService: {
                showModal$,
                moveElement,
                setCenterInUrl: vi.fn(),
            },
        })

        showModal$.next({
            type: 'Update',
            geojson: movedFeature.geojson,
            origineData: 'data',
        })
        page.handleSheetSession(movedFeature as any)

        expect(moveElement).toHaveBeenCalledWith(movedFeature)
        expect(page.selectedFeature()?.geojson).toBe(movedFeature.geojson)
    })

    it('gives the editor its unsaved draft back once the move ends', () => {
        const showModal$ = new Subject<any>()
        const geojson = { id: 'node/1', properties: { tags: { name: 'B' } } }
        const { page } = createPage({
            mapService: {
                showModal$,
                moveElement: vi.fn(),
                setCenterInUrl: vi.fn(),
            },
        })
        showModal$.next({ type: 'Update', geojson, origineData: 'data' })

        page.handleSheetSession({
            type: 'Move',
            geojson,
            mode: 'Update',
            baselineTags: { name: 'A' },
            moved: true,
        } as any)
        // the move is cancelled: the map service reopens the editor
        showModal$.next({ type: 'Update', geojson, origineData: 'data' })

        expect(page.selectedFeature()).toMatchObject({
            type: 'Update',
            baselineTags: { name: 'A' },
            // an earlier move of the same session is not forgotten
            newPosition: true,
        })

        // any later selection starts clean
        showModal$.next({ type: 'Update', geojson, origineData: 'data' })
        expect(page.selectedFeature()?.baselineTags).toBeUndefined()
    })
})
