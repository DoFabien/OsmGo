import { HttpClient } from '@angular/common/http'
import { DOCUMENT, signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { ActivatedRoute, Router } from '@angular/router'
import { TranslateService } from '@ngx-translate/core'
import type { CompassHeading, OsmGoFeatureCollection } from '@osmgo/type'
import { AlertService } from '@services/alert.service'
import { AppStorage } from '@services/app-storage.service'
import { type Config, ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { LocationService } from '@services/location.service'
import { TagsService } from '@services/tags.service'
import type { FeatureCollection } from 'geojson'
import type {
    FilterSpecification,
    MapGeoJSONFeature,
    Map as MapLibreMap,
} from 'maplibre-gl'
import {
    firstValueFrom,
    NEVER,
    type Observable,
    of,
    Subject,
    Subscription,
    throwError,
} from 'rxjs'
import {
    deduplicateSelectableFeatures,
    type MapInitializationError,
    MapService,
} from './map.service'
import { MapLayerController } from './map-layer.controller'
import { MapLifecycleController } from './map-lifecycle.controller'

describe('MapService initialization', () => {
    const config = {
        centerWhenGpsIsReady: false,
        lastView: { lng: 2, lat: 48, zoom: 18, bearing: 0 },
    } as Config

    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    function createService() {
        const service = Object.create(MapService.prototype) as MapService
        const errorState = signal<MapInitializationError | null>(null)
        Object.defineProperties(service, {
            lifecycle: { value: new MapLifecycleController() },
            mapCreated: { value: false, writable: true },
            styleReady: { value: false, writable: true },
            loadingDataState: { value: { set: vi.fn() } },
            isDisplaySatelliteBaseMapState: { value: { set: vi.fn() } },
            basemapSourceFingerprint: { value: null, writable: true },
            basemapAttributionText: { value: '', writable: true },
            mapInitializationErrorState: { value: errorState },
            mapInitializationError: { value: errorState.asReadonly() },
            _ngZone: { value: { run: (callback: () => void) => callback() } },
        })
        return service
    }

    it('turns a style request failure into a retryable state', () => {
        const service = createService()
        vi.spyOn(service, 'getMapStyle')
            .mockReturnValueOnce(throwError(() => new Error('offline')))
            .mockReturnValueOnce(of({ version: 8, sources: {}, layers: [] }))
        Object.defineProperties(service, {
            document: {
                value: {
                    createElement: () => ({ getContext: () => null }),
                },
            },
        })

        expect(() => service.initMap(config)).not.toThrow()
        expect(service.mapInitializationError()?.messageKey).toBe(
            'MAIN.MAP_INITIALIZATION.STYLE_FAILED'
        )

        service.retryMapInitialization()

        expect(service.getMapStyle).toHaveBeenCalledTimes(2)
        expect(service.mapInitializationError()?.messageKey).toBe(
            'MAIN.MAP_INITIALIZATION.WEBGL_REQUIRED'
        )
    })

    it('catches constructor failures without leaking a global error', () => {
        const service = createService()
        vi.spyOn(service, 'getMapStyle').mockReturnValue(
            of({ version: 8, sources: {}, layers: [] })
        )
        Object.defineProperties(service, {
            document: {
                value: {
                    createElement: () => ({
                        getContext: () => ({ getExtension: () => null }),
                    }),
                },
            },
            zone: {
                value: {
                    runOutsideAngular: (callback: () => void) => callback(),
                },
            },
        })
        vi.spyOn(
            service as unknown as {
                createMapInstance: () => MapLibreMap
            },
            'createMapInstance'
        ).mockImplementation(() => {
            throw new Error('GPU initialization failed')
        })

        expect(() => service.initMap(config)).not.toThrow()
        expect(service.mapInitializationError()?.messageKey).toBe(
            'MAIN.MAP_INITIALIZATION.CREATION_FAILED'
        )
    })

    it('removes a partially configured map after a setup failure', () => {
        const service = createService()
        const remove = vi.fn()
        const activeMap = {
            getZoom: () => 18,
            addControl: () => {
                throw new Error('Control setup failed')
            },
            remove,
        } as unknown as MapLibreMap
        vi.spyOn(service, 'getMapStyle').mockReturnValue(
            of({ version: 8, sources: {}, layers: [] })
        )
        Object.defineProperties(service, {
            document: {
                value: {
                    createElement: () => ({
                        getContext: () => ({ getExtension: () => null }),
                    }),
                },
            },
            zone: {
                value: {
                    runOutsideAngular: (callback: () => void) => callback(),
                },
            },
            configService: { value: { setCurrentZoom: vi.fn() } },
        })
        vi.spyOn(
            service as unknown as {
                createMapInstance: () => MapLibreMap
            },
            'createMapInstance'
        ).mockReturnValue(activeMap)

        service.initMap(config)

        expect(remove).toHaveBeenCalledOnce()
        expect(service.map).toBeUndefined()
        expect(service.mapInitializationError()?.messageKey).toBe(
            'MAIN.MAP_INITIALIZATION.CREATION_FAILED'
        )
    })
})

describe('selectable feature deduplication', () => {
    const feature = (id: number, source: string, label: string) =>
        ({
            source,
            properties: { type: 'node', id, label },
        }) as unknown as MapGeoJSONFeature

    it.each([
        ['official first', false],
        ['pending first', true],
    ])('prioritizes pending data with %s', (_label, pendingFirst) => {
        const official = feature(1, 'data', 'official')
        const pending = feature(1, 'data_changed', 'pending')
        const other = feature(2, 'data', 'other')
        const duplicates = pendingFirst
            ? [pending, other, official]
            : [official, other, pending]

        const result = deduplicateSelectableFeatures(duplicates)

        expect(result).toHaveLength(2)
        expect(
            result.find((candidate) => candidate.properties.id === 1)
                ?.properties.label
        ).toBe('pending')
        expect(result.find((candidate) => candidate.properties.id === 2)).toBe(
            other
        )
    })
})

describe('MapService lifecycle', () => {
    const setPrivate = (service: MapService, key: string, value: unknown) => {
        Object.defineProperty(service, key, {
            value,
            writable: true,
            configurable: true,
        })
    }

    it('tears one map session down exactly once', () => {
        const service = Object.create(MapService.prototype) as MapService
        const removeMap = vi.fn()
        const removePositionMarker = vi.fn()
        const removeMoveMarker = vi.fn()
        const firstCleanup = vi.fn()
        const secondCleanup = vi.fn()
        const unsubscribeSession = vi.fn()
        const unsubscribeInit = vi.fn()
        service.map = { remove: removeMap } as unknown as MapLibreMap
        service.layersAreLoaded = true
        service.markerPositionate = {
            remove: removePositionMarker,
        } as never
        service.markerMove = { remove: removeMoveMarker } as never
        setPrivate(service, 'mapCreated', true)
        setPrivate(service, 'styleReady', true)
        setPrivate(service, 'loadingDataState', { set: vi.fn() })
        setPrivate(service, 'markerMovingState', { set: vi.fn() })
        setPrivate(service, 'markerMoveMovingState', { set: vi.fn() })
        const satelliteState = { set: vi.fn() }
        setPrivate(service, 'isDisplaySatelliteBaseMapState', satelliteState)
        setPrivate(service, 'basemapSourceFingerprint', '{"stale":true}')
        setPrivate(service, 'basemapAttributionText', 'Stale attribution')
        const lifecycle = new MapLifecycleController()
        lifecycle.trackSession(new Subscription(unsubscribeSession))
        lifecycle.trackInitialization(new Subscription(unsubscribeInit))
        lifecycle.trackCleanup(firstCleanup, secondCleanup)
        setPrivate(service, 'lifecycle', lifecycle)

        service.destroyMap()
        service.destroyMap()

        expect(unsubscribeInit).toHaveBeenCalledOnce()
        expect(unsubscribeSession).toHaveBeenCalledOnce()
        expect(secondCleanup).toHaveBeenCalledBefore(firstCleanup)
        expect(removePositionMarker).toHaveBeenCalledOnce()
        expect(removeMoveMarker).toHaveBeenCalledOnce()
        expect(removeMap).toHaveBeenCalledOnce()
        expect(service.layersAreLoaded).toBe(false)
        expect(satelliteState.set).toHaveBeenCalledWith(false)
        expect(
            (service as unknown as { basemapSourceFingerprint: unknown })
                .basemapSourceFingerprint
        ).toBeNull()
        expect(
            (service as unknown as { basemapAttributionText: string })
                .basemapAttributionText
        ).toBe('')
    })

    it('replaces movement markers instead of accumulating sessions', () => {
        const service = Object.create(MapService.prototype) as MapService
        const firstMarker = { addTo: vi.fn(), remove: vi.fn() }
        const secondMarker = { addTo: vi.fn(), remove: vi.fn() }
        service.positionIsFollow = true
        service.headingIsLocked = true
        service.map = {
            getCenter: () => ({ lng: 2, lat: 48 }),
        } as unknown as MapLibreMap
        setPrivate(service, 'markerMovingState', { set: vi.fn() })
        setPrivate(service, 'markerMoveMovingState', { set: vi.fn() })
        vi.spyOn(service, 'createDomMoveMarker')
            .mockReturnValueOnce(firstMarker as never)
            .mockReturnValueOnce(secondMarker as never)

        service.positionateMarker()
        service.positionateMarker()
        service.cancelNewMarker()
        expect(service.positionIsFollow).toBe(false)
        expect(service.headingIsLocked).toBe(false)

        expect(firstMarker.addTo).toHaveBeenCalledOnce()
        expect(firstMarker.remove).toHaveBeenCalledOnce()
        expect(secondMarker.addTo).toHaveBeenCalledOnce()
        expect(secondMarker.remove).toHaveBeenCalledOnce()
    })

    it('skips the move line while the map has no style (WebGL context lost)', () => {
        const service = Object.create(MapService.prototype) as MapService
        service.map = {
            getSource: vi.fn(() => {
                throw new TypeError(
                    "Cannot read properties of null (reading 'getSource')"
                )
            }),
        } as unknown as MapLibreMap
        setPrivate(service, 'mapCreated', true)
        setPrivate(service, 'moveOrigin', [2, 48])
        const drawMoveLine = (
            service as unknown as {
                drawMoveLine: (target: [number, number]) => void
            }
        ).drawMoveLine.bind(service)

        expect(() => drawMoveLine([2.001, 48.001])).not.toThrow()
    })

    it('joins the original position to the move marker, then clears the line', () => {
        const service = Object.create(MapService.prototype) as MapService
        const setData = vi.fn()
        const getSource = vi.fn(() => ({ setData }))
        service.map = { getSource } as unknown as MapLibreMap
        setPrivate(service, 'mapCreated', true)
        setPrivate(service, 'markerMovingState', { set: vi.fn() })
        setPrivate(service, 'markerMoveMovingState', { set: vi.fn() })
        setPrivate(service, 'moveOrigin', [2, 48])
        const drawMoveLine = (
            service as unknown as {
                drawMoveLine: (target: [number, number]) => void
            }
        ).drawMoveLine.bind(service)

        drawMoveLine([2.001, 48.001])

        expect(getSource).toHaveBeenCalledWith('move_line')
        expect(setData).toHaveBeenLastCalledWith({
            type: 'FeatureCollection',
            features: [
                expect.objectContaining({
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [2, 48],
                            [2.001, 48.001],
                        ],
                    },
                }),
                expect.objectContaining({
                    geometry: { type: 'Point', coordinates: [2, 48] },
                }),
            ],
        })

        service.cancelNewMarker()

        expect(setData).toHaveBeenLastCalledWith({
            type: 'FeatureCollection',
            features: [],
        })
        drawMoveLine([3, 49])
        expect(setData).toHaveBeenCalledTimes(2)
    })
})

describe('MapService filters', () => {
    function createService(): MapService {
        const service = Object.create(MapService.prototype) as MapService
        Object.defineProperty(service, 'layerController', {
            value: new MapLayerController(),
        })
        return service
    }

    it('adds the measurement filter when enabled', () => {
        const setFilter = vi.fn().mockName('setFilter')
        const map = {
            getLayer: () => ({ id: 'way_fill' }),
            getFilter: () => ['all'],
            setFilter,
        } as unknown as MapLibreMap
        const service = createService()

        const filter = service.toogleMesureFilter(true, 'way_fill', 5_000, map)

        expect(filter).toEqual(['all', ['<', ['get', 'mesure'], 5_000]])
        expect(setFilter).toHaveBeenCalledWith('way_fill', filter)
    })

    it('removes the measurement filter when disabled', () => {
        const initialFilter: FilterSpecification = [
            'all',
            ['<', ['get', 'mesure'], 5_000],
            ['==', ['get', 'type'], 'way'],
        ]
        const setFilter = vi.fn().mockName('setFilter')
        const map = {
            getLayer: () => ({ id: 'way_fill' }),
            getFilter: () => initialFilter,
            setFilter,
        } as unknown as MapLibreMap
        const service = createService()

        const filter = service.toogleMesureFilter(false, 'way_fill', 5_000, map)

        expect(filter).toEqual(['all', ['==', ['get', 'type'], 'way']])
        expect(initialFilter).toHaveLength(3)
        expect(setFilter).toHaveBeenCalledWith('way_fill', filter)
    })

    it('leaves a missing layer filter unchanged', () => {
        const setFilter = vi.fn().mockName('setFilter')
        const map = {
            getLayer: () => undefined,
            getFilter: () => undefined,
            setFilter,
        } as unknown as MapLibreMap
        const service = createService()

        expect(
            service.toogleMesureFilter(true, 'missing', 100, map)
        ).toBeUndefined()
        expect(setFilter).not.toHaveBeenCalled()
    })

    it('replaces an existing measurement clause instead of stacking it', () => {
        let filter: FilterSpecification = ['all']
        const map = {
            getLayer: () => ({ id: 'way_fill' }),
            getFilter: () => filter,
            setFilter: (_layer: string, next: FilterSpecification) => {
                filter = next
            },
        } as unknown as MapLibreMap
        const service = createService()

        service.toogleMesureFilter(true, 'way_fill', 5_000, map)
        service.toogleMesureFilter(true, 'way_fill', 2_500, map)

        expect(filter).toEqual(['all', ['<', ['get', 'mesure'], 2_500]])
    })

    it('applies and clears hidden tags on official and pending layers', () => {
        const filters = new Map<string, FilterSpecification>([
            ['marker', ['all']],
            ['marker_changed', ['all']],
            ['way_fill_changed', ['all']],
        ])
        const map = {
            getLayer: (id: string) =>
                filters.has(id) ? ({ id } as unknown) : undefined,
            getFilter: (id: string) => filters.get(id),
            setFilter: (id: string, filter: FilterSpecification) =>
                filters.set(id, filter),
        } as unknown as MapLibreMap
        const service = createService()
        service.map = map
        Object.defineProperty(service, 'mapCreated', { value: true })
        service.layersAreLoaded = true

        service.filterMakerByIds(['amenity/bench', 'amenity/bench'])
        service.filterMakerByIds(['amenity/bench'])

        for (const filter of filters.values()) {
            expect(filter).toEqual([
                'all',
                ['match', ['get', 'configId'], ['amenity/bench'], false, true],
            ])
        }

        service.filterMakerByIds([])
        for (const filter of filters.values()) expect(filter).toEqual(['all'])
    })

    it('keeps one numeric old-tag threshold across repeated updates', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'))
        let filter: FilterSpecification = ['all']
        const setFilter = vi.fn((_layer: string, next: FilterSpecification) => {
            filter = next
        })
        const map = {
            getLayer: () => ({ id: 'icon-old' }),
            getFilter: () => filter,
            setFilter,
            setLayoutProperty: vi.fn(),
        } as unknown as MapLibreMap
        const service = createService()
        service.map = map
        Object.defineProperty(service, 'mapCreated', { value: true })
        service.layersAreLoaded = true

        service.showOldTagIcon(3)
        service.showOldTagIcon(5)

        expect(filter).toHaveLength(2)
        expect(filter[1]).toEqual([
            '>',
            Date.now() - 31_536_000_000 * 5,
            ['get', 'time'],
        ])
        expect(typeof (filter[1] as unknown[])[1]).toBe('number')
        vi.useRealTimers()
    })
})

describe('MapService heading normalization', () => {
    it.each([
        [0, 0, 0],
        [10, 350, 20],
        [350, 10, 340],
        [720, -360, 0],
    ])('normalizes %s° against a %s° bearing', (heading, bearing, expected) => {
        const service = Object.create(MapService.prototype) as MapService

        expect(service.getIconRotate(heading, bearing)).toBe(expected)
    })
})

describe('MapService URL synchronization', () => {
    function createService(
        params: Record<string, string | null>,
        navigate: ReturnType<typeof vi.fn>
    ): MapService {
        const service = Object.create(MapService.prototype) as MapService
        service.map = {
            getCenter: () => ({ lng: 2.123456789, lat: 48.987654321 }),
            getZoom: () => 18.126,
        } as unknown as MapLibreMap
        Object.defineProperties(service, {
            activatedRoute: {
                value: {
                    snapshot: {
                        queryParamMap: {
                            get: (key: string) => params[key] ?? null,
                        },
                    },
                },
            },
            router: {
                value: { navigate, currentNavigation: vi.fn(() => null) },
            },
            mapMoveEndSubject: { value: new Subject<void>() },
            _ngZone: {
                value: {
                    run: (callback: () => Promise<boolean>) => callback(),
                },
            },
            pendingMapUrlSignature: { value: undefined, writable: true },
        })
        return service
    }

    it('skips navigation when the rounded map URL is already current', () => {
        const navigate = vi.fn(() => Promise.resolve(true))
        const service = createService(
            {
                center: '2.1234568,48.9876543',
                zoom: '18.13',
                id: null,
                add: null,
            },
            navigate
        )

        service.setCenterInUrl()

        expect(navigate).not.toHaveBeenCalled()
    })

    it('coalesces pending updates and observes navigation failures', async () => {
        let rejectNavigation!: (reason: unknown) => void
        const navigate = vi.fn(
            () =>
                new Promise<boolean>((_resolve, reject) => {
                    rejectNavigation = reject
                })
        )
        const service = createService({}, navigate)
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined)

        service.setCenterInUrl()
        service.setCenterInUrl()

        expect(navigate).toHaveBeenCalledOnce()
        expect(navigate).toHaveBeenCalledWith([], {
            replaceUrl: true,
            relativeTo: expect.anything(),
            queryParams: {
                center: '2.1234568,48.9876543',
                zoom: '18.13',
                id: null,
                add: null,
            },
            queryParamsHandling: 'merge',
        })

        rejectNavigation(new Error('navigation rejected'))
        await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce())

        navigate.mockResolvedValueOnce(true)
        service.setCenterInUrl()
        expect(navigate).toHaveBeenCalledTimes(2)
        consoleError.mockRestore()
    })

    it('waits for a navigation in progress instead of cancelling it', () => {
        const navigate = vi.fn(() => Promise.resolve(true))
        const service = createService({}, navigate)
        const { currentNavigation } = (
            service as unknown as {
                router: { currentNavigation: ReturnType<typeof vi.fn> }
            }
        ).router
        currentNavigation.mockReturnValue({ trigger: 'imperative' })
        const retries = vi.fn()
        ;(
            service as unknown as { mapMoveEndSubject: Subject<void> }
        ).mapMoveEndSubject.subscribe(retries)

        service.setCenterInUrl()

        expect(navigate).not.toHaveBeenCalled()
        expect(retries).toHaveBeenCalledOnce()

        currentNavigation.mockReturnValue(null)
        service.setCenterInUrl()

        expect(navigate).toHaveBeenCalledOnce()
    })
})

describe('MapService redraw ordering', () => {
    const setPrivate = (service: MapService, key: string, value: unknown) => {
        Object.defineProperty(service, key, {
            value,
            writable: true,
            configurable: true,
        })
    }

    it('ignores an older render that finishes after the latest one', async () => {
        const service = Object.create(MapService.prototype) as MapService
        const dataSource = { setData: vi.fn() }
        const waysSource = { setData: vi.fn() }
        const map = {
            hasImage: () => true,
            getSource: (id: string) =>
                id === 'data' ? dataSource : waysSource,
        } as unknown as MapLibreMap
        service.map = map
        setPrivate(service, 'mapCreated', true)
        setPrivate(service, 'layersAreLoaded', true)
        setPrivate(service, 'officialRenderRevision', 0)
        setPrivate(service, 'pendingRenderRevision', 0)
        setPrivate(service, 'activeRenderCount', 0)
        setPrivate(service, 'loadingDataState', { set: vi.fn() })
        let resolveFirst!: () => void
        let resolveSecond!: () => void
        const firstIcons = new Promise<void>((resolve) => {
            resolveFirst = resolve
        })
        const secondIcons = new Promise<void>((resolve) => {
            resolveSecond = resolve
        })
        vi.spyOn(service, 'addMissingIconsToMap')
            .mockReturnValueOnce(firstIcons)
            .mockReturnValueOnce(secondIcons)
        const first: OsmGoFeatureCollection = {
            type: 'FeatureCollection',
            features: [],
        }
        const second: OsmGoFeatureCollection = {
            type: 'FeatureCollection',
            features: [],
        }
        const render = (
            service as unknown as {
                renderMarkerCollection(
                    collection: OsmGoFeatureCollection,
                    target: 'official'
                ): Promise<void>
            }
        ).renderMarkerCollection.bind(service)

        const older = render(first, 'official')
        const latest = render(second, 'official')
        resolveSecond()
        await latest
        resolveFirst()
        await older

        expect(dataSource.setData).toHaveBeenCalledOnce()
        expect(dataSource.setData).toHaveBeenCalledWith(second)
        expect(waysSource.setData).toHaveBeenCalledOnce()
    })

    it('uses a generated fallback while preserving the requested image ID', async () => {
        const service = Object.create(MapService.prototype) as MapService
        const addImage = vi.fn()
        const map = {
            hasImage: () => false,
            addImage,
        } as unknown as MapLibreMap
        const fallbackBitmap = {} as ImageBitmap
        vi.spyOn(service, 'generateIconFromSprite')
            .mockRejectedValueOnce(new Error('Missing sprite'))
            .mockResolvedValueOnce({
                id: 'circle-#000000-maki-circle',
                blob: fallbackBitmap,
            })

        await service.addMissingIconsToMap(['circle-#000000-missing'], map)

        expect(addImage).toHaveBeenCalledWith(
            'circle-#000000-missing',
            fallbackBitmap,
            { pixelRatio: 1 }
        )
    })
})

describe('MapService aerial imagery', () => {
    function createHarness() {
        const sources = new Map<string, unknown>()
        const layers = new Set<string>(['bboxLayer'])
        const controls = new Set<unknown>()
        const addSource = vi.fn((id: string, source: unknown) => {
            sources.set(id, source)
        })
        const removeSource = vi.fn((id: string) => {
            sources.delete(id)
        })
        const addLayer = vi.fn((layer: { id: string }) => {
            if (layers.has(layer.id)) throw new Error('Layer already exists')
            layers.add(layer.id)
        })
        const removeLayer = vi.fn((id: string) => {
            layers.delete(id)
        })
        const setLayoutProperty = vi.fn()
        const addControl = vi.fn((control: unknown) => controls.add(control))
        const removeControl = vi.fn((control: unknown) =>
            controls.delete(control)
        )
        const map = {
            addControl,
            addLayer,
            addSource,
            getLayer: (id: string) =>
                layers.has(id) ? ({ id } as unknown) : undefined,
            getSource: (id: string) => sources.get(id),
            hasControl: (control: unknown) => controls.has(control),
            removeControl,
            removeLayer,
            removeSource,
            setLayoutProperty,
        } as unknown as MapLibreMap
        const service = Object.create(MapService.prototype) as MapService
        service.map = map
        service.layersAreLoaded = true
        Object.defineProperty(service, 'mapCreated', { value: true })
        Object.defineProperty(service, 'isDisplaySatelliteBaseMapState', {
            value: { set: vi.fn() },
        })
        Object.defineProperty(service, 'basemapSourceFingerprint', {
            value: null,
            writable: true,
        })
        Object.defineProperty(service, 'basemapAttributionText', {
            value: '',
            writable: true,
        })
        return {
            addControl,
            addLayer,
            addSource,
            removeControl,
            removeLayer,
            removeSource,
            service,
            setLayoutProperty,
        }
    }

    it('uses the maximum tile zoom supplied by the imagery index', () => {
        const { addSource, service } = createHarness()

        service.displaySatelliteBaseMap(
            {
                id: 'test-imagery',
                name: 'Test imagery',
                tiles: ['https://example.test/{z}/{x}/{y}.jpeg'],
                max_zoom: 19,
            },
            true
        )

        expect(addSource).toHaveBeenCalledWith(
            'basemap',
            expect.objectContaining({ maxzoom: 19 })
        )
    })

    it('falls back to a sensible maximum zoom when the index has none', () => {
        const { addSource, service } = createHarness()

        service.displaySatelliteBaseMap(
            {
                id: 'no-max-zoom',
                name: 'No max zoom',
                tiles: ['https://example.test/{z}/{x}/{y}.jpeg'],
            },
            true
        )

        expect(addSource).toHaveBeenCalledWith(
            'basemap',
            expect.objectContaining({ maxzoom: 19 })
        )
    })

    it('ignores imagery whose tile URL MapLibre cannot fill in', () => {
        const { addLayer, addSource, service } = createHarness()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        service.displaySatelliteBaseMap(
            {
                id: 'arcgis',
                name: 'ArcGIS export',
                tiles: [
                    'https://example.test/export?bbox={bbox-epsg-3857}&imageSR={wkid}',
                ],
            },
            true
        )

        expect(addSource).not.toHaveBeenCalled()
        expect(addLayer).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledOnce()
        warn.mockRestore()
    })

    it('switches A to B to A without retaining stale sources', () => {
        const { addLayer, addSource, removeLayer, removeSource, service } =
            createHarness()
        const mapA = {
            id: 'a',
            name: 'A',
            tiles: ['https://a.test/{z}/{x}/{y}.png'],
        }
        const mapB = {
            id: 'b',
            name: 'B',
            tiles: ['https://b.test/{z}/{x}/{y}.png'],
        }

        service.displaySatelliteBaseMap(mapA, true)
        service.displaySatelliteBaseMap(mapB, true)
        service.displaySatelliteBaseMap(mapA, true)

        expect(addSource).toHaveBeenCalledTimes(3)
        expect(removeSource).toHaveBeenCalledTimes(2)
        expect(addLayer).toHaveBeenCalledTimes(3)
        expect(removeLayer).toHaveBeenCalledTimes(2)
        expect(addSource.mock.calls.at(-1)?.[1]).toEqual(
            expect.objectContaining({ tiles: mapA.tiles })
        )
    })

    it('does not recreate a source or layer for identical updates', () => {
        const { addLayer, addSource, removeLayer, removeSource, service } =
            createHarness()
        const basemap = {
            id: 'a',
            name: 'A',
            tiles: ['https://a.test/{z}/{x}/{y}.png'],
        }

        service.displaySatelliteBaseMap(basemap, true)
        service.displaySatelliteBaseMap(basemap, true)

        expect(addSource).toHaveBeenCalledTimes(1)
        expect(addLayer).toHaveBeenCalledTimes(1)
        expect(removeSource).not.toHaveBeenCalled()
        expect(removeLayer).not.toHaveBeenCalled()
    })

    it('toggles visibility without recreating the basemap', () => {
        const {
            addLayer,
            addSource,
            removeLayer,
            removeSource,
            service,
            setLayoutProperty,
        } = createHarness()
        const basemap = {
            id: 'a',
            name: 'A',
            tiles: ['https://a.test/{z}/{x}/{y}.png'],
        }

        service.displaySatelliteBaseMap(basemap, true)
        service.displaySatelliteBaseMap(basemap, false)
        service.displaySatelliteBaseMap(basemap, true)

        expect(addSource).toHaveBeenCalledTimes(1)
        expect(addLayer).toHaveBeenCalledTimes(1)
        expect(removeSource).not.toHaveBeenCalled()
        expect(removeLayer).not.toHaveBeenCalled()
        expect(setLayoutProperty.mock.calls).toEqual([
            ['basemap', 'visibility', 'none'],
            ['basemap', 'visibility', 'visible'],
        ])
    })

    it('updates attribution without replacing identical tiles', () => {
        const { addControl, addSource, removeControl, service } =
            createHarness()
        const tiles = ['https://a.test/{z}/{x}/{y}.png']

        service.displaySatelliteBaseMap(
            { id: 'a', name: 'A', tiles, attribution: { text: 'Source A' } },
            true
        )
        service.displaySatelliteBaseMap(
            { id: 'b', name: 'B', tiles, attribution: { text: 'Source B' } },
            true
        )

        expect(addSource).toHaveBeenCalledTimes(1)
        expect(addControl).toHaveBeenCalledTimes(2)
        expect(removeControl).toHaveBeenCalledTimes(1)
    })
})

describe('MapService with a stubbed MapLibre map', () => {
    type Handler = (event?: unknown) => void

    function createFakeMap() {
        const handlers = new Map<string, Handler[]>()
        const sources = new Map<
            string,
            {
                setData: ReturnType<typeof vi.fn>
                updateData: ReturnType<typeof vi.fn>
            }
        >()
        const layerIds: string[] = []
        let bearing = 0
        const map = {
            addControl: vi.fn(),
            addLayer: vi.fn((layer: { id: string }) => {
                layerIds.push(layer.id)
            }),
            addSource: vi.fn((id: string) => {
                sources.set(id, {
                    setData: vi.fn(),
                    updateData: vi.fn(() => Promise.resolve()),
                })
            }),
            fitBounds: vi.fn(),
            easeTo: vi.fn(),
            flyTo: vi.fn(),
            getBearing: vi.fn(() => bearing),
            getCenter: () => ({ lng: 2, lat: 48 }),
            getContainer: () => ({ clientHeight: 800, clientWidth: 400 }),
            getFilter: () => ['all'],
            getLayer: (id: string) =>
                layerIds.includes(id) ? { id } : undefined,
            getSource: (id: string) => sources.get(id),
            getZoom: vi.fn(() => 17),
            hasControl: () => true,
            hasImage: () => true,
            isMoving: vi.fn(() => false),
            jumpTo: vi.fn(
                (camera: { bearing?: number }, _eventData?: unknown) => {
                    if (camera.bearing !== undefined) bearing = camera.bearing
                }
            ),
            off: vi.fn(),
            on: vi.fn((name: string, handler: Handler) => {
                handlers.set(name, [...(handlers.get(name) ?? []), handler])
            }),
            queryRenderedFeatures: vi.fn(() => [] as unknown[]),
            remove: vi.fn(),
            removeControl: vi.fn(),
            setFilter: vi.fn(),
            setLayoutProperty: vi.fn(),
            setPaintProperty: vi.fn(),
            unproject: () => ({ toArray: () => [2, 48] }),
        }
        const emit = (name: string, event?: unknown) => {
            for (const handler of handlers.get(name) ?? []) handler(event)
        }
        // MapLibre rebuilds every source from a snapshot after a context loss.
        const rebuildSources = () => {
            for (const id of sources.keys()) {
                sources.set(id, {
                    setData: vi.fn(),
                    updateData: vi.fn(() => Promise.resolve()),
                })
            }
        }
        return { emit, layerIds, map, rebuildSources, sources }
    }

    function createHarness(
        options: {
            config?: Record<string, unknown>
            gpsReady?: boolean
            location?: unknown
        } = {}
    ) {
        const newLocation$ = new Subject<FeatureCollection>()
        const compassHeadingChanges$ = new Subject<CompassHeading>()
        const compassHeading = { trueHeading: null as number | null }
        const locationService = {
            compassHeading: () => compassHeading,
            compassHeadingChanges$,
            getCoordsPosition: vi.fn(() => [2.35, 48.85]),
            gpsIsReady: () => options.gpsReady ?? false,
            location: vi.fn(() => options.location),
            newLocation$,
            publishCurrentLocation: vi.fn(),
        }
        const configService = {
            config: () => ({
                centerWhenGpsIsReady: true,
                followPosition: true,
                lockMapHeading: true,
                ...options.config,
            }),
            freezeMapRenderer: false,
            getDisplayFixmeIcon: () => false,
            getFilterWayByArea: () => false,
            getFilterWayByLength: () => false,
            getOldTagsIcon: () => ({ display: false, year: 1 }),
            platforms: ['hybrid'],
            selecableLayers: ['marker', 'marker_changed', 'icon-change'],
            setCurrentZoom: vi.fn(),
            setLastView: vi.fn(),
        }
        const dataService = {
            geojson: { type: 'FeatureCollection', features: [] },
            geojsonChanged: { type: 'FeatureCollection', features: [] },
            getFeatureById: vi.fn(),
            getGeojsonBbox: () => ({ type: 'FeatureCollection', features: [] }),
        }
        const router = {
            currentNavigation: () => null,
            navigate: vi.fn(() => Promise.resolve(true)),
        }
        const animationFrames: Array<(time: number) => void> = []
        const windowStub = Object.assign(new EventTarget(), {
            requestAnimationFrame: (callback: (time: number) => void) =>
                animationFrames.push(callback),
            cancelAnimationFrame: (handle: number) => {
                animationFrames[handle - 1] = () => undefined
            },
        })
        let frameTime = 0
        /** Runs the display frames requested by the compass animation. */
        const runAnimationFrames = (max = 200) => {
            for (let i = 0; i < max && animationFrames.length > 0; i++) {
                frameTime += 16
                animationFrames.shift()?.(frameTime)
            }
        }
        const documentStub = {
            addEventListener: vi.fn(),
            baseURI: 'http://localhost/',
            defaultView: windowStub,
            createElement: () => ({
                getContext: () => ({ getExtension: () => null }),
            }),
            removeEventListener: vi.fn(),
            visibilityState: 'visible',
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: { get: vi.fn(() => NEVER) } },
                {
                    provide: AppStorage,
                    useValue: {
                        get: vi.fn(() => Promise.resolve(null)),
                        set: vi.fn(() => Promise.resolve()),
                    },
                },
                { provide: Router, useValue: router },
                {
                    provide: ActivatedRoute,
                    useValue: {
                        snapshot: { queryParamMap: { get: () => null } },
                    },
                },
                { provide: DOCUMENT, useValue: documentStub },
                { provide: DataService, useValue: dataService },
                {
                    provide: TagsService,
                    useValue: {
                        hiddenTagsIds: () => [],
                        jsonSprites: () => ({}),
                        tags: () => [],
                    },
                },
                { provide: AlertService, useValue: {} },
                { provide: LocationService, useValue: locationService },
                { provide: ConfigService, useValue: configService },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.runInInjectionContext(() => new MapService())
        const fake = createFakeMap()
        vi.spyOn(service, 'getMapStyle').mockReturnValue(
            of({ version: 8, sources: {}, layers: [] })
        )
        vi.spyOn(
            service as unknown as { createMapInstance: () => MapLibreMap },
            'createMapInstance'
        ).mockReturnValue(fake.map as unknown as MapLibreMap)
        vi.spyOn(service, 'addMissingIconsToMap').mockResolvedValue()
        const config = {
            centerWhenGpsIsReady: true,
            lastView: { lng: 2, lat: 48, zoom: 17, bearing: 0 },
        } as Config
        const boot = () => {
            service.initMap(config)
            fake.emit('style.load')
        }
        const fix = (accuracy = 5) =>
            ({
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [2.35, 48.85] },
                        properties: { accuracy },
                    },
                ],
            }) as FeatureCollection
        return {
            ...fake,
            boot,
            compassHeading,
            compassHeadingChanges$,
            configService,
            dataService,
            fix,
            locationService,
            newLocation$,
            router,
            service,
            windowStub,
            runAnimationFrames,
        }
    }

    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    describe('initialization errors', () => {
        it('keeps the map when a tile fails before the style is ready', () => {
            const { emit, map, service } = createHarness()
            service.initMap({
                centerWhenGpsIsReady: true,
                lastView: { lng: 2, lat: 48, zoom: 17, bearing: 0 },
            } as Config)

            emit('error', {
                error: new Error('Failed to fetch tile'),
                sourceId: 'basemap',
                tile: {},
            })
            emit('error', { error: new Error('Source down'), sourceId: 'x' })

            expect(service.mapInitializationError()).toBeNull()
            expect(map.remove).not.toHaveBeenCalled()
        })

        it('still reports a real style failure before the style is ready', () => {
            const { emit, map, service } = createHarness()
            service.initMap({
                centerWhenGpsIsReady: true,
                lastView: { lng: 2, lat: 48, zoom: 17, bearing: 0 },
            } as Config)

            emit('error', { error: new Error('Invalid style') })

            expect(service.mapInitializationError()?.messageKey).toBe(
                'MAIN.MAP_INITIALIZATION.CREATION_FAILED'
            )
            expect(map.remove).toHaveBeenCalledOnce()
        })

        it('adds the data layers once the style loads, without waiting for tiles', () => {
            const { boot, emit, layerIds, service } = createHarness()

            boot()
            emit('error', { error: new Error('late style warning') })

            expect(service.layersAreLoaded).toBe(true)
            expect(layerIds).toContain('marker')
            expect(service.mapInitializationError()).toBeNull()
        })

        it('registers no load listener that could delay the layers', () => {
            const { map, boot } = createHarness()

            boot()

            const events = map.on.mock.calls.map(([name]) => name)
            expect(events).toContain('style.load')
            expect(events).not.toContain('load')
        })
    })

    describe('layers', () => {
        it('draws the GPS position above the markers', () => {
            const { boot, layerIds } = createHarness()

            boot()

            const position = (id: string) => layerIds.indexOf(id)
            for (const above of ['location_circle', 'location_user']) {
                for (const below of [
                    'marker',
                    'marker_changed',
                    'icon-change',
                    'icon-old',
                    'icon-fixme',
                    'label',
                ]) {
                    expect(position(above)).toBeGreaterThan(position(below))
                }
            }
        })

        it('sends only the properties the style and tap handlers use', async () => {
            const { boot, sources, service } = createHarness()
            boot()
            await vi.waitFor(() =>
                expect(sources.get('data')?.setData).toHaveBeenCalled()
            )
            sources.get('data')?.setData.mockClear()
            sources.get('ways')?.setData.mockClear()
            const feature = {
                type: 'Feature',
                id: 'way/5',
                geometry: { type: 'Point', coordinates: [1, 2] },
                properties: {
                    id: 5,
                    type: 'way',
                    _name: 'Park',
                    icon: 'park',
                    marker: 'circle-#000000-park',
                    hexColor: '#000000',
                    configId: 'leisure/park',
                    way_geometry: {
                        type: 'LineString',
                        coordinates: [
                            [1, 2],
                            [3, 4],
                        ],
                    },
                    originalData: { huge: true },
                    usedByWays: ['1'],
                    relations: [{ role: 'x' }],
                    tags: { leisure: 'park' },
                    meta: { version: 1 },
                    primaryTag: { key: 'leisure', value: 'park' },
                },
            }

            service.redrawMarkers({
                type: 'FeatureCollection',
                features: [feature],
            } as unknown as OsmGoFeatureCollection)

            await vi.waitFor(() =>
                expect(sources.get('data')?.setData).toHaveBeenCalledOnce()
            )
            const drawn = sources.get('data')?.setData.mock
                .calls[0][0] as FeatureCollection
            expect(
                Object.keys(drawn.features[0].properties ?? {}).sort()
            ).toEqual([
                '_name',
                'configId',
                'hexColor',
                'icon',
                'id',
                'marker',
                'type',
            ])
            const ways = sources.get('ways')?.setData.mock
                .calls[0][0] as FeatureCollection
            expect(ways.features[0].geometry.type).toBe('LineString')
            expect(ways.features[0].properties).not.toHaveProperty(
                'way_geometry'
            )
            expect(ways.features[0].properties).not.toHaveProperty(
                'originalData'
            )
        })
    })

    describe('incremental redraws', () => {
        const node = (id: number, marker = 'circle-#000000-park') => ({
            type: 'Feature',
            id: `node/${id}`,
            geometry: { type: 'Point', coordinates: [1, id] },
            properties: {
                id,
                type: 'node',
                marker,
                hexColor: '#000000',
                icon: 'park',
                tags: { leisure: 'park' },
            },
        })
        const way = (id: number) => ({
            type: 'Feature',
            id: `way/${id}`,
            geometry: { type: 'Point', coordinates: [3, id] },
            properties: {
                id,
                type: 'way',
                marker: 'circle-#000000-park',
                hexColor: '#000000',
                icon: 'park',
                tags: { leisure: 'park' },
                way_geometry: {
                    type: 'LineString',
                    coordinates: [
                        [3, id],
                        [4, id],
                    ],
                },
            },
        })
        const collection = (...features: unknown[]) =>
            ({
                type: 'FeatureCollection',
                features,
            }) as unknown as OsmGoFeatureCollection

        async function drawn(
            harness: ReturnType<typeof createHarness>,
            sourceId: string,
            draw: () => void
        ) {
            const source = harness.sources.get(sourceId)
            const before =
                (source?.setData.mock.calls.length ?? 0) +
                (source?.updateData.mock.calls.length ?? 0)
            draw()
            await vi.waitFor(() =>
                expect(
                    (source?.setData.mock.calls.length ?? 0) +
                        (source?.updateData.mock.calls.length ?? 0)
                ).toBeGreaterThan(before)
            )
        }

        async function bootWithOfficial(features: unknown[]) {
            const harness = createHarness()
            harness.boot()
            await vi.waitFor(() =>
                expect(harness.sources.get('data')?.setData).toHaveBeenCalled()
            )
            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(collection(...features))
            )
            for (const source of harness.sources.values()) {
                source.setData.mockClear()
                source.updateData.mockClear()
            }
            return harness
        }

        it('redraws the whole layer when an incremental update fails', async () => {
            const harness = await bootWithOfficial([node(1), node(2), node(3)])
            const data = harness.sources.get('data')
            data?.updateData.mockRejectedValueOnce(new Error('diff failed'))

            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(collection(node(1), node(3)))
            )

            await vi.waitFor(() =>
                expect(data?.setData).toHaveBeenCalledWith({
                    type: 'FeatureCollection',
                    features: [
                        expect.objectContaining({ id: 'node/1' }),
                        expect.objectContaining({ id: 'node/3' }),
                    ],
                })
            )
        })

        it('removes an object that became pending instead of redrawing the official layer', async () => {
            const harness = await bootWithOfficial([
                node(1),
                node(2),
                node(3),
                way(4),
                way(5),
            ])

            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(
                    collection(node(1), node(3), way(4), way(5))
                )
            )
            await drawn(harness, 'ways', () =>
                harness.service.redrawMarkers(
                    collection(node(1), node(3), way(5))
                )
            )

            const data = harness.sources.get('data')
            const ways = harness.sources.get('ways')
            expect(data?.setData).not.toHaveBeenCalled()
            expect(data?.updateData).toHaveBeenNthCalledWith(1, {
                remove: ['node/2'],
                add: [],
            })
            expect(ways?.setData).not.toHaveBeenCalled()
            expect(ways?.updateData).toHaveBeenCalledOnce()
            expect(ways?.updateData).toHaveBeenCalledWith({
                remove: ['way/4'],
                add: [],
            })
        })

        it('replaces only the objects whose drawing changed', async () => {
            const harness = await bootWithOfficial([node(1), node(2), node(3)])

            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(
                    collection(node(1), node(2, 'circle-#ff0000-park'), node(3))
                )
            )

            const data = harness.sources.get('data')
            expect(data?.setData).not.toHaveBeenCalled()
            const diff = data?.updateData.mock.calls[0][0] as {
                add: Array<{ id: string; properties: { marker: string } }>
                remove: string[]
            }
            expect(diff.remove).toEqual([])
            expect(diff.add).toHaveLength(1)
            expect(diff.add[0].id).toBe('node/2')
            expect(diff.add[0].properties.marker).toBe('circle-#ff0000-park')
            expect(diff.add[0].properties).not.toHaveProperty('tags')
            expect(
                harness.sources.get('ways')?.updateData
            ).not.toHaveBeenCalled()
        })

        it('sends nothing when no drawn object changed', async () => {
            const harness = await bootWithOfficial([node(1), node(2), node(3)])
            const loading = vi.spyOn(harness.service, 'addMissingIconsToMap')
            loading.mockClear()

            harness.service.redrawMarkers(collection(node(1), node(2), node(3)))
            await vi.waitFor(() => expect(loading).toHaveBeenCalled())
            await Promise.resolve()

            const data = harness.sources.get('data')
            expect(data?.setData).not.toHaveBeenCalled()
            expect(data?.updateData).not.toHaveBeenCalled()
        })

        it('redraws everything after a download or a large change', async () => {
            const features = [1, 2, 3, 4, 5, 6].map((id) => node(id))
            const harness = await bootWithOfficial(features)
            const data = harness.sources.get('data')

            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(collection(...features), {
                    replace: true,
                })
            )
            expect(data?.setData).toHaveBeenCalledOnce()

            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(collection(node(1), node(2)))
            )
            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(collection(node(1)))
            )

            expect(data?.setData).toHaveBeenCalledTimes(2)
            expect(data?.updateData).toHaveBeenCalledOnce()
            expect(data?.updateData).toHaveBeenCalledWith({
                remove: ['node/2'],
                add: [],
            })
        })

        it('diffs against the last drawn state when redraws overlap', async () => {
            const harness = await bootWithOfficial([node(1), node(2), node(3)])
            let releaseOlder!: () => void
            vi.spyOn(harness.service, 'addMissingIconsToMap')
                .mockReturnValueOnce(
                    new Promise<void>((resolve) => {
                        releaseOlder = resolve
                    })
                )
                .mockResolvedValueOnce()

            harness.service.redrawMarkers(collection(node(1), node(3)))
            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(collection(node(1), node(2)))
            )
            releaseOlder()
            await Promise.resolve()
            await Promise.resolve()

            const data = harness.sources.get('data')
            expect(data?.setData).not.toHaveBeenCalled()
            expect(data?.updateData).toHaveBeenCalledOnce()
            expect(data?.updateData).toHaveBeenCalledWith({
                remove: ['node/3'],
                add: [],
            })
        })

        it('sends whole collections when two objects share an id', async () => {
            const harness = await bootWithOfficial([node(1), node(2), node(3)])
            const data = harness.sources.get('data')

            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(
                    collection(node(1), node(2), node(3), node(3))
                )
            )
            await drawn(harness, 'data', () =>
                harness.service.redrawMarkers(
                    collection(node(1), node(2), node(3), node(4))
                )
            )

            expect(data?.updateData).not.toHaveBeenCalled()
            expect(data?.setData).toHaveBeenCalledTimes(2)
        })
    })

    describe('WebGL context loss', () => {
        const listenerCounts = (map: ReturnType<typeof createFakeMap>['map']) =>
            map.on.mock.calls.reduce<Record<string, number>>(
                (counts, [name]) => {
                    counts[name] = (counts[name] ?? 0) + 1
                    return counts
                },
                {}
            )

        it('redraws the restored style without adding layers or listeners twice', async () => {
            vi.useFakeTimers()
            const harness = createHarness({ gpsReady: true })
            const { emit, map, service } = harness
            const loaded = vi.fn()
            service.mapLoaded$.subscribe(loaded)
            harness.boot()
            const listeners = listenerCounts(map)
            const addedSources = map.addSource.mock.calls.length
            const addedLayers = map.addLayer.mock.calls.length
            map.setLayoutProperty.mockClear()
            map.setPaintProperty.mockClear()
            map.jumpTo.mockClear()

            emit('webglcontextlost')
            harness.newLocation$.next(harness.fix())
            harness.compassHeadingChanges$.next({
                headingAccuracy: null,
                magneticHeading: 90,
                timestamp: 1,
                trueHeading: 90,
            })
            vi.advanceTimersByTime(150)
            emit('click', { point: { x: 1, y: 1 } })
            emit('rotate')
            emit('zoom')
            harness.rebuildSources()

            expect(service.layersAreLoaded).toBe(false)
            expect(map.setLayoutProperty).not.toHaveBeenCalled()
            expect(map.setPaintProperty).not.toHaveBeenCalled()
            expect(map.queryRenderedFeatures).not.toHaveBeenCalled()
            expect(map.jumpTo).not.toHaveBeenCalled()

            emit('webglcontextrestored')
            emit('style.load')
            vi.useRealTimers()

            expect(service.layersAreLoaded).toBe(true)
            expect(map.addSource).toHaveBeenCalledTimes(addedSources)
            expect(map.addLayer).toHaveBeenCalledTimes(addedLayers)
            expect(listenerCounts(map)).toEqual(listeners)
            for (const id of [
                'bbox',
                'data',
                'data_changed',
                'ways',
                'ways_changed',
            ]) {
                await vi.waitFor(() =>
                    expect(
                        harness.sources.get(id)?.setData
                    ).toHaveBeenCalledOnce()
                )
            }
            expect(
                harness.locationService.publishCurrentLocation
            ).toHaveBeenCalledTimes(2)
            expect(loaded).toHaveBeenCalledOnce()
            expect(service.mapInitializationError()).toBeNull()
        })

        it('puts the layers back on a style rebuilt without them', () => {
            const { boot, emit, layerIds, map, service, sources } =
                createHarness()
            boot()
            const listeners = listenerCounts(map)
            const layerCount = layerIds.length

            emit('webglcontextlost')
            sources.clear()
            layerIds.length = 0
            emit('webglcontextrestored')
            emit('style.load')

            expect(service.layersAreLoaded).toBe(true)
            expect(layerIds).toHaveLength(layerCount)
            expect(sources.has('data_changed')).toBe(true)
            expect(listenerCounts(map)).toEqual(listeners)
        })

        it('applies a basemap chosen while the style is rebuilt', () => {
            const { boot, emit, map, service } = createHarness()
            boot()
            const basemap = {
                id: 'aerial',
                tiles: ['https://tiles.example/{z}/{x}/{y}.png'],
            } as unknown as Parameters<MapService['displaySatelliteBaseMap']>[0]

            emit('webglcontextlost')
            service.displaySatelliteBaseMap(basemap, true)

            expect(map.addSource).not.toHaveBeenCalledWith(
                'basemap',
                expect.anything()
            )

            emit('webglcontextrestored')
            emit('style.load')

            expect(map.addSource).toHaveBeenCalledWith(
                'basemap',
                expect.objectContaining({ type: 'raster' })
            )
        })

        it('offers a retry when the context cannot be restored', () => {
            const { boot, emit, map, service } = createHarness()
            boot()

            emit('webglcontextlost')
            emit('error', { error: new Error('Late warning') })
            expect(service.mapInitializationError()).toBeNull()

            const failure = new Error('WebGL2 is required')
            failure.name = 'GPUInitializationError'
            emit('error', { error: failure })

            expect(service.mapInitializationError()?.messageKey).toBe(
                'MAIN.MAP_INITIALIZATION.CREATION_FAILED'
            )
            expect(map.remove).toHaveBeenCalledOnce()
            expect(map.off).toHaveBeenCalledWith(
                'webglcontextlost',
                expect.any(Function)
            )
        })
    })

    describe('centering on the position', () => {
        const located = {
            coords: { latitude: 48.85, longitude: 2.35, accuracy: 5 },
        }

        it('does not touch the GPS layers before they exist', () => {
            const { map, service } = createHarness({ location: located })
            service.initMap({
                centerWhenGpsIsReady: true,
                lastView: { lng: 2, lat: 48, zoom: 17, bearing: 0 },
            } as Config)

            expect(() => service.centerOnMyPosition()).not.toThrow()

            expect(map.setLayoutProperty).not.toHaveBeenCalled()
            expect(map.flyTo).toHaveBeenCalledWith(
                expect.objectContaining({ center: [2.35, 48.85] })
            )
        })

        it('waits for the first fix instead of failing without a position', () => {
            const { boot, fix, map, newLocation$, service } = createHarness()
            boot()

            expect(() => service.centerOnMyPosition()).not.toThrow()
            expect(map.flyTo).not.toHaveBeenCalled()

            service.positionIsFollow = false
            vi.mocked(service.locationService.location).mockReturnValue(
                located as GeolocationPosition
            )
            newLocation$.next(fix())

            expect(map.flyTo).toHaveBeenCalledOnce()
            expect(service.positionIsFollow).toBe(true)
        })

        const stubMoveMarker = (service: MapService) =>
            vi
                .spyOn(
                    service as unknown as {
                        createDomMoveMarker: () => unknown
                    },
                    'createDomMoveMarker'
                )
                .mockReturnValue({
                    addTo: vi.fn(),
                    remove: vi.fn(),
                    setLngLat: vi.fn(),
                })

        it('keeps north up after the compass until the GPS button is used', () => {
            const { boot, compassHeading, fix, map, newLocation$, service } =
                createHarness()
            boot()
            compassHeading.trueHeading = 90

            service.centerOnMyPosition(true)
            service.resetNorth()
            vi.mocked(service.locationService.location).mockReturnValue(
                located as GeolocationPosition
            )
            newLocation$.next(fix())

            expect(map.easeTo).toHaveBeenCalledWith(
                expect.objectContaining({ bearing: 0 })
            )
            expect(map.flyTo).toHaveBeenLastCalledWith(
                expect.objectContaining({ bearing: 0 })
            )
            expect(service.headingIsLocked).toBe(false)

            service.centerOnMyPosition()

            expect(service.headingIsLocked).toBe(true)
            expect(map.flyTo).toHaveBeenLastCalledWith(
                expect.objectContaining({ bearing: 90 })
            )
        })

        it('forgets the wait for a fix once the user moves the map', () => {
            const { boot, emit, fix, map, newLocation$, service } =
                createHarness()
            boot()

            service.centerOnMyPosition()
            emit('dragstart', { originalEvent: new Event('touchstart') })
            vi.mocked(service.locationService.location).mockReturnValue(
                located as GeolocationPosition
            )
            newLocation$.next(fix())

            expect(map.flyTo).not.toHaveBeenCalled()
            expect(map.jumpTo).not.toHaveBeenCalled()
        })

        it('leaves a new object where it was placed when the first fix arrives', () => {
            const { boot, fix, map, newLocation$, service } = createHarness()
            boot()
            stubMoveMarker(service)

            service.centerOnMyPosition()
            service.positionateMarker()
            vi.mocked(service.locationService.location).mockReturnValue(
                located as GeolocationPosition
            )
            newLocation$.next(fix())

            expect(map.flyTo).not.toHaveBeenCalled()
            expect(map.jumpTo).not.toHaveBeenCalled()
        })

        it('does not jump to a late fix while a node is placed or moved', () => {
            const { boot, fix, map, newLocation$, service } = createHarness()
            boot()
            stubMoveMarker(service)

            service.positionateMarker()
            service.centerOnMyPosition()
            vi.mocked(service.locationService.location).mockReturnValue(
                located as GeolocationPosition
            )
            newLocation$.next(fix())
            service.cancelNewMarker()
            newLocation$.next(fix())

            expect(map.flyTo).not.toHaveBeenCalled()
        })
    })

    describe('focusing on a place', () => {
        it('stops following, so that the next fix does not bring the map back', () => {
            const { boot, fix, map, newLocation$, service } = createHarness()
            boot()

            service.focusOn({ center: [5.7, 45.2], zoom: 18 })
            newLocation$.next(fix())

            expect(map.jumpTo).toHaveBeenCalledOnce()
            expect(map.jumpTo).toHaveBeenCalledWith({
                center: [5.7, 45.2],
                zoom: 18,
            })
            expect(service.positionIsFollow).toBe(false)
        })

        it('cancels a recenter that waits for the first fix', () => {
            const { boot, fix, map, newLocation$, service } = createHarness()
            boot()

            service.centerOnMyPosition()
            service.focusOn({
                bounds: [
                    [5.7, 45.2],
                    [5.8, 45.3],
                ],
                padding: 40,
            })
            vi.mocked(service.locationService.location).mockReturnValue({
                coords: { latitude: 48.85, longitude: 2.35, accuracy: 5 },
            } as GeolocationPosition)
            newLocation$.next(fix())

            expect(map.fitBounds).toHaveBeenCalledWith(
                [
                    [5.7, 45.2],
                    [5.8, 45.3],
                ],
                { padding: 40, maxZoom: 19, animate: false }
            )
            expect(map.flyTo).not.toHaveBeenCalled()
            expect(map.jumpTo).not.toHaveBeenCalled()
        })

        it('does nothing before the map exists', () => {
            const { map, service } = createHarness()

            expect(() => service.focusOn({ center: [5.7, 45.2] })).not.toThrow()
            expect(map.jumpTo).not.toHaveBeenCalled()
        })
    })

    describe('vector background', () => {
        it('refreshes its TileJSON once the style is loaded, then when back online', () => {
            const { boot, service, windowStub } = createHarness()
            const refresh = vi
                .spyOn(service, 'refreshBasemapTileJson')
                .mockReturnValue(undefined)

            boot()
            expect(refresh).toHaveBeenCalledWith()

            windowStub.dispatchEvent(new Event('online'))
            expect(refresh).toHaveBeenLastCalledWith({ reloadTiles: true })

            service.destroyMap()
            windowStub.dispatchEvent(new Event('online'))
            expect(refresh).toHaveBeenCalledTimes(2)
        })
    })

    describe('without a map', () => {
        const basemap = {
            id: 'aerial',
            name: 'Aerial',
            tiles: ['https://imagery.test/{z}/{x}/{y}.jpeg'],
        }

        it('keeps a chosen basemap for the map that starts next', () => {
            const { boot, map, service } = createHarness()

            expect(() =>
                service.displaySatelliteBaseMap(basemap, true)
            ).not.toThrow()
            boot()

            expect(map.addSource).toHaveBeenCalledWith(
                'basemap',
                expect.objectContaining({ tiles: basemap.tiles })
            )
        })

        it('ignores a way filter change', () => {
            const { service } = createHarness()

            expect(
                service.toogleMesureFilter(true, 'way_fill', 5000, undefined)
            ).toBeUndefined()
        })
    })

    describe('following the position', () => {
        it('zooms and centers with a single camera move on the first fix', () => {
            const { boot, fix, map, newLocation$ } = createHarness()
            boot()

            newLocation$.next(fix())

            expect(map.jumpTo).toHaveBeenCalledOnce()
            expect(map.jumpTo).toHaveBeenCalledWith(
                { center: [2.35, 48.85], zoom: 19 },
                { osmgoFollow: true }
            )

            newLocation$.next(fix())

            expect(map.jumpTo).toHaveBeenCalledTimes(2)
            expect(map.jumpTo).toHaveBeenLastCalledWith(
                { center: [2.35, 48.85] },
                { osmgoFollow: true }
            )
        })

        it('keeps the zoom of a deep link instead of zooming to the position', () => {
            const { boot, fix, map, newLocation$, service } = createHarness()
            boot()
            service.positionIsFollow = false

            newLocation$.next(fix())

            expect(map.jumpTo).not.toHaveBeenCalled()
        })

        it('does not zoom out when the map is already closer than the start zoom', () => {
            const { boot, fix, map, newLocation$ } = createHarness()
            boot()
            map.getZoom.mockReturnValue(21)

            newLocation$.next(fix())

            expect(map.jumpTo).toHaveBeenCalledWith(
                expect.objectContaining({ zoom: 21 }),
                expect.anything()
            )
        })

        it('leaves the bearing to the compass animation when it follows a fix', () => {
            const { boot, compassHeadingChanges$, fix, map, newLocation$ } =
                createHarness()
            vi.useFakeTimers()
            boot()
            compassHeadingChanges$.next({
                headingAccuracy: null,
                magneticHeading: 80,
                timestamp: 1,
                trueHeading: 80,
            })
            map.jumpTo.mockClear()

            newLocation$.next(fix())

            expect(map.jumpTo).toHaveBeenCalledOnce()
            expect(map.jumpTo).toHaveBeenCalledWith(
                { center: [2.35, 48.85], zoom: 19 },
                expect.anything()
            )
        })

        it('does not interrupt a running animation', () => {
            const { boot, fix, map, newLocation$ } = createHarness()
            boot()
            map.isMoving.mockReturnValue(true)

            newLocation$.next(fix())

            expect(map.jumpTo).not.toHaveBeenCalled()
        })

        it('leaves the camera alone while a menu or page is open', () => {
            const { boot, configService, fix, map, newLocation$ } =
                createHarness()
            boot()
            configService.freezeMapRenderer = true

            newLocation$.next(fix())

            expect(map.jumpTo).not.toHaveBeenCalled()
        })

        it('does not follow a fix while a node is being placed or moved', () => {
            const { boot, fix, map, newLocation$, service } = createHarness()
            boot()
            vi.spyOn(
                service as unknown as { createDomMoveMarker: () => unknown },
                'createDomMoveMarker'
            ).mockReturnValue({ addTo: vi.fn(), remove: vi.fn() })

            service.positionateMarker()
            newLocation$.next(fix())

            expect(service.positionIsFollow).toBe(false)
            expect(map.jumpTo).not.toHaveBeenCalled()
        })

        it('stops following when the user moves, zooms or rotates the map', () => {
            const { boot, emit, service } = createHarness()
            boot()

            for (const name of ['dragstart', 'zoomstart', 'rotatestart']) {
                service.positionIsFollow = true
                service.headingIsLocked = true

                emit(name, {})
                expect(service.positionIsFollow).toBe(true)

                emit(name, { originalEvent: new Event('mousedown') })
                expect(service.positionIsFollow).toBe(false)
                expect(service.headingIsLocked).toBe(false)
            }
        })
    })

    describe('compass', () => {
        const heading = (trueHeading: number): CompassHeading => ({
            headingAccuracy: null,
            magneticHeading: trueHeading,
            timestamp: 1,
            trueHeading,
        })

        it('turns the map smoothly toward the compass heading', () => {
            const { boot, compassHeadingChanges$, map, runAnimationFrames } =
                createHarness()
            boot()

            compassHeadingChanges$.next(heading(100))
            runAnimationFrames()

            const bearings = map.jumpTo.mock.calls
                .map(([camera]) => (camera as { bearing?: number }).bearing)
                .filter((value) => value !== undefined)
            expect(bearings.length).toBeGreaterThan(10)
            expect(bearings.at(-1)).toBeCloseTo(100, 0)
            for (const [, eventData] of map.jumpTo.mock.calls) {
                expect(eventData).toEqual({ osmgoFollow: true })
            }
        })

        it('does not interrupt the center button animation', () => {
            vi.useFakeTimers()
            const { boot, compassHeadingChanges$, map } = createHarness()
            boot()
            map.isMoving.mockReturnValue(true)

            compassHeadingChanges$.next(heading(100))
            vi.advanceTimersByTime(150)

            expect(map.jumpTo).not.toHaveBeenCalled()
        })

        it('rotates the position marker only when the heading is not locked', () => {
            vi.useFakeTimers()
            const { boot, compassHeadingChanges$, map, service } =
                createHarness()
            boot()
            service.headingIsLocked = false

            compassHeadingChanges$.next(heading(90))
            vi.advanceTimersByTime(150)

            expect(map.jumpTo).not.toHaveBeenCalled()
            expect(map.setLayoutProperty).toHaveBeenCalledWith(
                'location_user',
                'icon-rotate',
                90
            )
        })
    })

    describe('camera bookkeeping', () => {
        it('does not write the view or the URL for every GPS fix', () => {
            vi.useFakeTimers()
            const { boot, configService, emit, service } = createHarness()
            const syncUrl = vi
                .spyOn(service, 'setCenterInUrl')
                .mockImplementation(() => undefined)
            boot()

            for (let i = 0; i < 10; i++) {
                emit('move', { osmgoFollow: true })
                emit('moveend', { osmgoFollow: true })
                vi.advanceTimersByTime(1000)
            }

            expect(syncUrl).not.toHaveBeenCalled()
            expect(configService.setLastView).toHaveBeenCalledTimes(0)

            vi.advanceTimersByTime(15_000)

            expect(configService.setLastView).toHaveBeenCalledOnce()
        })

        it('saves the view and the URL shortly after a user move', () => {
            vi.useFakeTimers()
            const { boot, configService, emit, service } = createHarness()
            const syncUrl = vi
                .spyOn(service, 'setCenterInUrl')
                .mockImplementation(() => undefined)
            boot()

            emit('move', {})
            emit('moveend', {})
            vi.advanceTimersByTime(800)

            expect(syncUrl).toHaveBeenCalledOnce()
            expect(configService.setLastView).toHaveBeenCalledOnce()
        })

        it('skips both while a menu or page covers the map', () => {
            vi.useFakeTimers()
            const { boot, configService, emit, service } = createHarness()
            const syncUrl = vi
                .spyOn(service, 'setCenterInUrl')
                .mockImplementation(() => undefined)
            boot()
            configService.freezeMapRenderer = true

            emit('move', {})
            emit('moveend', {})
            vi.advanceTimersByTime(800)

            expect(syncUrl).not.toHaveBeenCalled()
            expect(configService.setLastView).not.toHaveBeenCalled()
        })
    })

    describe('map taps', () => {
        const tappedFeature = {
            layer: { id: 'marker' },
            properties: { id: 1, type: 'node' },
            source: 'data',
        }

        it('selects the feature under the finger', async () => {
            const { boot, emit, map, service } = createHarness()
            const select = vi
                .spyOn(service, 'selectFeature')
                .mockReturnValue(true)
            boot()
            map.queryRenderedFeatures.mockReturnValueOnce([tappedFeature])

            emit('click', { point: { x: 100, y: 200 } })

            await vi.waitFor(() => expect(select).toHaveBeenCalledOnce())
            expect(map.queryRenderedFeatures).toHaveBeenCalledOnce()
        })

        it('widens the query so that thin lines can be hit', async () => {
            const { boot, emit, map, service } = createHarness()
            const select = vi
                .spyOn(service, 'selectFeature')
                .mockReturnValue(true)
            boot()
            map.queryRenderedFeatures
                .mockReturnValueOnce([])
                .mockReturnValueOnce([tappedFeature])

            emit('click', { point: { x: 100, y: 200 } })

            await vi.waitFor(() => expect(select).toHaveBeenCalledOnce())
            expect(map.queryRenderedFeatures).toHaveBeenLastCalledWith(
                [
                    [90, 190],
                    [110, 210],
                ],
                expect.objectContaining({ layers: expect.any(Array) })
            )
        })

        it('reports a tap on empty ground as a background click', () => {
            const { boot, emit, service } = createHarness()
            const background = vi.fn()
            service.mapBackgroundClick$.subscribe(background)
            boot()

            emit('click', { point: { x: 100, y: 200 } })

            expect(background).toHaveBeenCalledOnce()
        })

        it('ignores taps while a node is placed or moved', () => {
            const { boot, emit, map, service } = createHarness()
            const background = vi.fn()
            service.mapBackgroundClick$.subscribe(background)
            vi.spyOn(
                service as unknown as { createDomMoveMarker: () => unknown },
                'createDomMoveMarker'
            ).mockReturnValue({ addTo: vi.fn(), remove: vi.fn() })
            boot()
            service.positionateMarker()

            emit('click', { point: { x: 100, y: 200 } })

            expect(map.queryRenderedFeatures).not.toHaveBeenCalled()
            expect(background).not.toHaveBeenCalled()
        })
    })

    describe('selecting a feature', () => {
        const mapFeature = {
            layer: { id: 'marker' },
            properties: { id: 7, type: 'node' },
        } as unknown as MapGeoJSONFeature

        it('finds an object that moved from official to pending data', () => {
            const { dataService, service } = createHarness()
            const pending = {
                id: 'node/7',
                properties: { changeType: 'Update' },
            }
            dataService.getFeatureById.mockImplementation(
                (_id: string, source: string) =>
                    source === 'data_changed' ? pending : undefined
            )
            const shown = vi.fn()
            service.showModal$.subscribe(shown)

            const found = service.selectFeature(mapFeature)

            expect(found).toBe(true)
            expect(shown).toHaveBeenCalledWith({
                type: 'Read',
                geojson: pending,
                origineData: 'data_changed',
            })
        })

        it('falls back to the official copy', () => {
            const { dataService, router, service } = createHarness()
            const official = { id: 'node/7', properties: {} }
            dataService.getFeatureById.mockImplementation(
                (_id: string, source: string) =>
                    source === 'data' ? official : undefined
            )
            const shown = vi.fn()
            service.showModal$.subscribe(shown)

            expect(service.selectFeature(mapFeature)).toBe(true)

            expect(shown).toHaveBeenCalledWith(
                expect.objectContaining({
                    geojson: official,
                    origineData: 'data',
                })
            )
            expect(router.navigate).toHaveBeenCalledOnce()
        })

        it('puts a pending object in the URL instead of the previous one', () => {
            const { dataService, router, service } = createHarness()
            dataService.getFeatureById.mockImplementation(
                (_id: string, source: string) =>
                    source === 'data_changed'
                        ? { id: 'node/7', properties: {} }
                        : undefined
            )

            service.selectFeature(mapFeature)

            expect(router.navigate).toHaveBeenCalledWith(
                [],
                expect.objectContaining({
                    queryParams: { id: 'node/7', zoom: null, center: null },
                })
            )
        })

        it('reports a missing object without opening anything', () => {
            const { service } = createHarness()
            const shown = vi.fn()
            service.showModal$.subscribe(shown)

            expect(service.selectFeature(mapFeature)).toBe(false)
            expect(shown).not.toHaveBeenCalled()
        })
    })
})

describe('MapService vector background TileJSON', () => {
    const style = {
        version: 8,
        sources: {
            openmaptiles: {
                type: 'vector',
                url: 'https://tiles.test/planet',
            },
        },
        layers: [],
    }
    const saved = {
        tiles: ['https://tiles.test/planet/v1/{z}/{x}/{y}.pbf'],
        minzoom: 0,
        maxzoom: 14,
        bounds: [-180, -85.05113, 180, 85.05113],
        attribution: 'OpenFreeMap',
    }
    const bundled = {
        tilejson: '3.0.0',
        tiles: ['https://tiles.test/planet/v0/{z}/{x}/{y}.pbf'],
        maxzoom: 14,
    }
    const latest = {
        tilejson: '3.0.0',
        tiles: ['https://tiles.test/planet/v2/{z}/{x}/{y}.pbf'],
        maxzoom: 14,
        vector_layers: [],
    }

    function createService(
        options: { stored?: unknown; remote?: () => Observable<unknown> } = {}
    ) {
        const service = Object.create(MapService.prototype) as MapService
        const responses: Record<string, () => Observable<unknown>> = {
            'http://localhost/assets/mapStyle/brigthCustom.json': () =>
                of(style),
            'http://localhost/assets/mapStyle/openfreemap-planet.json': () =>
                of(bundled),
            'https://tiles.test/planet':
                options.remote ??
                (() => throwError(() => new Error('offline'))),
        }
        const get = vi.fn(
            (url: string) =>
                responses[url]?.() ??
                throwError(() => new Error(`Unexpected request ${url}`))
        )
        const storage = {
            get: vi.fn(() => Promise.resolve(options.stored ?? null)),
            set: vi.fn(() => Promise.resolve()),
        }
        const source = { setTiles: vi.fn() }
        Object.defineProperties(service, {
            http: { value: { get } },
            storage: { value: storage },
            document: { value: { baseURI: 'http://localhost/' } },
            basemapTileJsonRefreshing: { value: false, writable: true },
            mapCreated: { value: true, writable: true },
        })
        service.layersAreLoaded = true
        service.map = {
            getSource: (id: string) =>
                id === 'openmaptiles' ? source : undefined,
        } as unknown as MapLibreMap
        return { get, service, source, storage }
    }

    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('starts offline from the last TileJSON received', async () => {
        const { get, service } = createService({ stored: saved })

        const mapStyle = await firstValueFrom(service.getMapStyle())

        expect(mapStyle.sources['openmaptiles']).toEqual({
            type: 'vector',
            ...saved,
        })
        expect(get).not.toHaveBeenCalledWith(
            'http://localhost/assets/mapStyle/openfreemap-planet.json'
        )
        expect(get).not.toHaveBeenCalledWith('https://tiles.test/planet')
    })

    it('falls back to the copy shipped with the app', async () => {
        const { service } = createService({ stored: { tiles: 'broken' } })

        const mapStyle = await firstValueFrom(service.getMapStyle())

        expect(mapStyle.sources['openmaptiles']).toEqual({
            type: 'vector',
            tiles: bundled.tiles,
            maxzoom: 14,
        })
    })

    it('keeps the remote TileJSON only when no copy can be read', async () => {
        const { get, service } = createService()
        get.mockImplementation((url: string) =>
            url.endsWith('brigthCustom.json')
                ? of(style)
                : throwError(() => new Error('missing'))
        )

        const mapStyle = await firstValueFrom(service.getMapStyle())

        expect(mapStyle.sources['openmaptiles']).toEqual(
            style.sources.openmaptiles
        )
    })

    it('saves a newer TileJSON and moves the background to its tiles', async () => {
        const { service, source, storage } = createService({
            stored: saved,
            remote: () => of(latest),
        })
        await firstValueFrom(service.getMapStyle())

        service.refreshBasemapTileJson()

        expect(storage.set).toHaveBeenCalledWith('basemapTileJson', {
            tiles: latest.tiles,
            maxzoom: 14,
        })
        expect(source.setTiles).toHaveBeenCalledWith(latest.tiles)

        service.refreshBasemapTileJson()

        expect(source.setTiles).toHaveBeenCalledOnce()
    })

    it('reloads the tiles once the connection is back', async () => {
        const { service, source } = createService({
            stored: saved,
            remote: () => of(saved),
        })
        await firstValueFrom(service.getMapStyle())

        service.refreshBasemapTileJson()
        expect(source.setTiles).not.toHaveBeenCalled()

        service.refreshBasemapTileJson({ reloadTiles: true })
        expect(source.setTiles).toHaveBeenCalledWith(saved.tiles)
    })

    it('keeps the current tiles when the refresh fails or is invalid', async () => {
        let response: Observable<unknown> = throwError(
            () => new Error('offline')
        )
        const { service, source, storage } = createService({
            stored: saved,
            remote: () => response,
        })
        await firstValueFrom(service.getMapStyle())

        service.refreshBasemapTileJson()
        response = of({ tiles: ['http://insecure.test/{z}/{x}/{y}.pbf'] })
        service.refreshBasemapTileJson()

        expect(storage.set).not.toHaveBeenCalled()
        expect(source.setTiles).not.toHaveBeenCalled()
    })

    it('does not block the start when the TileJSON server does not answer', async () => {
        vi.useFakeTimers()
        const { service, source } = createService({
            stored: saved,
            remote: () => NEVER,
        })
        await firstValueFrom(service.getMapStyle())

        service.refreshBasemapTileJson()
        vi.advanceTimersByTime(5_000)
        expect(console.warn).toHaveBeenCalledWith(
            'The basemap TileJSON could not be refreshed.',
            expect.anything()
        )

        expect(source.setTiles).not.toHaveBeenCalled()
        vi.useRealTimers()
    })
})

describe('MapService busy states', () => {
    function createService(): MapService {
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: { get: vi.fn(() => NEVER) } },
                { provide: AppStorage, useValue: {} },
                { provide: Router, useValue: {} },
                { provide: ActivatedRoute, useValue: {} },
                { provide: DataService, useValue: {} },
                { provide: TagsService, useValue: {} },
                { provide: AlertService, useValue: {} },
                { provide: LocationService, useValue: {} },
                { provide: ConfigService, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        return TestBed.runInInjectionContext(() => new MapService())
    }

    it('stays busy until every overlapping save has ended', () => {
        const service = createService()

        service.setIsProcessing(true)
        service.setIsProcessing(true)
        service.setIsProcessing(false)
        expect(service.isProcessing()).toBe(true)

        service.setIsProcessing(false)
        service.setIsProcessing(false)
        expect(service.isProcessing()).toBe(false)
        service.setIsProcessing(true)
        expect(service.isProcessing()).toBe(true)
    })

    it('does not present a download as a save', () => {
        const service = createService()

        service.setIsDownloading(true)

        expect(service.isProcessing()).toBe(false)
        expect(service.isBusy()).toBe(true)
    })
})
