import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { ActivatedRoute, Router } from '@angular/router'
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
    const router = { events: new Subject(), navigate: vi.fn() }
    TestBed.resetTestingModule()
    TestBed.configureTestingModule({
        providers: [
            { provide: MatDialog, useValue: modalCtrl },
            { provide: MatSnackBar, useValue: {} },
            { provide: OsmApiService, useValue: osmApi },
            { provide: TagsService, useValue: { jsonSprites: () => ({}) } },
            { provide: MapService, useValue: resolvedMapService },
            { provide: DataService, useValue: dataService },
            { provide: LocationService, useValue: {} },
            { provide: AlertService, useValue: resolvedAlertService },
            { provide: ConfigService, useValue: resolvedConfigService },
            { provide: Router, useValue: router },
            { provide: TranslateService, useValue: {} },
            { provide: SwUpdate, useValue: swUpdate },
            { provide: InitService, useValue: {} },
            { provide: OsmAuthService, useValue: osmAuthService },
            { provide: ActivatedRoute, useValue: activatedRoute },
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
                swUpdate: { isEnabled: true, versionUpdates },
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
            queryParamsHandling: 'preserve',
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

        const createStackedPage = () => {
            const showModal$ = new Subject<any>()
            const featureChoiceRequested$ = new Subject<unknown>()
            const afterClosed = new Subject<unknown>()
            const modalCtrl = {
                open: vi.fn(() => ({
                    componentRef: { setInput: vi.fn() },
                    afterClosed: () => afterClosed,
                })),
            }
            const selectFeature = vi.fn((feature: any) =>
                showModal$.next({
                    type: 'Read',
                    geojson: {
                        id: `${feature.properties.type}/${feature.properties.id}`,
                    },
                    origineData: 'data',
                })
            )
            const created = createPage({
                modalCtrl,
                mapService: {
                    showModal$,
                    featureChoiceRequested$,
                    selectFeature,
                },
            })
            featureChoiceRequested$.next(stackedFeatures)
            return { ...created, modalCtrl, afterClosed, showModal$ }
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

        it('reopens the choice dialog from the counter', () => {
            const { page, modalCtrl, afterClosed } = createStackedPage()
            afterClosed.next(stackedFeatures[0])

            page.openStackedFeatureChoice()

            expect(modalCtrl.open).toHaveBeenCalledTimes(2)
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
        })
        expect(page.sheetLevel()).toBe('expanded')
    })

    it('keeps existing data and clears processing after a download failure', () => {
        const mapService = {
            redrawBbox: vi.fn().mockName('redrawBbox'),
            redrawMarkers: vi.fn().mockName('redrawMarkers'),
            getBbox: () => [1, 2, 3, 4],
            setIsProcessing: vi.fn().mockName('setIsProcessing'),
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

        expect(vi.mocked(mapService.setIsProcessing).mock.calls).toEqual([
            [true],
            [false],
        ])
        expect(dataService.applyDownload).not.toHaveBeenCalled()
        expect(page.presentToast).toHaveBeenCalledTimes(1)
        expect(page.presentToast).toHaveBeenCalledWith(
            'Worker conversion failed'
        )
    })

    it('persists a complete download atomically before redrawing it', async () => {
        let acknowledgeDownload!: () => void
        const persisted = new Promise<void>((resolve) => {
            acknowledgeDownload = resolve
        })
        const result = {
            geojson: { type: 'FeatureCollection', features: [] },
            geojsonBbox: { type: 'FeatureCollection', features: [] },
        }
        const applyDownload = vi.fn().mockReturnValue(persisted)
        const mapService = {
            redrawBbox: vi.fn(),
            redrawMarkers: vi.fn(),
            getBbox: () => [1, 2, 3, 4],
            setIsProcessing: vi.fn(),
        }
        const { page } = createPage({
            osmApi: { getDataFromBbox: () => of(result) },
            dataService: { applyDownload },
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

        expect(mapService.redrawBbox).toHaveBeenCalledWith(result.geojsonBbox)
        expect(mapService.redrawMarkers).toHaveBeenCalledWith(result.geojson)
        expect(mapService.setIsProcessing).toHaveBeenLastCalledWith(false)
    })

    it('keeps existing data when the worker result is incomplete', () => {
        const mapService = {
            redrawBbox: vi.fn(),
            redrawMarkers: vi.fn(),
            getBbox: () => [1, 2, 3, 4],
            setIsProcessing: vi.fn(),
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
        expect(mapService.setIsProcessing).toHaveBeenLastCalledWith(false)
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
})
