import { HttpClient } from '@angular/common/http'
import { DOCUMENT, inject, NgZone, Service, signal } from '@angular/core'
import { ActivatedRoute, type Params, Router } from '@angular/router'
import { resolveAppUrl } from '@app/utils/asset-url'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { TranslateService } from '@ngx-translate/core'
import {
    type CompassHeading,
    type EventShowModal,
    type FeatureIdSource,
    type MapMode,
    type OsmGoFeature,
    type OsmGoFeatureCollection,
    type OsmGoMarker,
    type Sprite,
    TagConfig,
} from '@osmgo/type'
import { setIconStyle } from '@scripts/osmToOsmgo/index.js'
import { AlertService } from '@services/alert.service'
import type { Basemap } from '@services/basemaps.service'
import { type Config, ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { LocationService } from '@services/location.service'
import {
    FEATURE_VISIBILITY_LAYER_IDS,
    MapLayerController,
} from '@services/map-layer.controller'
import { MapLifecycleController } from '@services/map-lifecycle.controller'
import { TagsService } from '@services/tags.service'
import destination from '@turf/destination'
import { point } from '@turf/helpers'
import type {
    BBox,
    Feature,
    FeatureCollection,
    LineString,
    MultiLineString,
    MultiPoint,
    Point,
} from 'geojson'
import {
    AttributionControl,
    type FilterSpecification,
    type GeoJSONSource,
    type LngLat,
    type LngLatLike,
    type MapGeoJSONFeature,
    type ErrorEvent as MapLibreErrorEvent,
    Map as MapLibreMap,
    type MapMouseEvent,
    type MapOptions,
    Marker,
    NavigationControl,
    type RasterSourceSpecification,
    ScaleControl,
    type StyleSpecification,
} from 'maplibre-gl'
import { type Observable, Subject } from 'rxjs'
import { debounceTime, filter, map, throttleTime } from 'rxjs/operators'
import type { ModalDismissData } from '../components/modal/modal'

export const getMarkerLayout = () => ({
    'icon-image': '{marker}',
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-anchor': 'bottom' as const,
})

const selectableFeaturePriority = (feature: MapGeoJSONFeature): number => {
    if (feature.source === 'data_changed') return 2
    if (feature.source === 'data') return 1
    return 0
}

export const deduplicateSelectableFeatures = (
    features: MapGeoJSONFeature[]
): MapGeoJSONFeature[] => {
    const featuresById = new globalThis.Map<string, MapGeoJSONFeature>()
    for (const feature of features) {
        const id = `${feature.properties.type}/${feature.properties.id}`
        const current = featuresById.get(id)
        if (
            !current ||
            selectableFeaturePriority(feature) >
                selectableFeaturePriority(current)
        ) {
            featuresById.set(id, feature)
        }
    }
    return [...featuresById.values()]
}

type HeadingWithTrueHeading = CompassHeading & { trueHeading: number }
type LoadedMapImage = Awaited<ReturnType<MapLibreMap['loadImage']>>['data']
type IconParameters = { shape: string; color: string; id: string }

export interface MapInitializationError {
    messageKey:
        | 'MAIN.MAP_INITIALIZATION.STYLE_FAILED'
        | 'MAIN.MAP_INITIALIZATION.WEBGL_REQUIRED'
        | 'MAIN.MAP_INITIALIZATION.CREATION_FAILED'
}

@Service()
export class MapService {
    private readonly _ngZone = inject(NgZone)
    readonly dataService = inject(DataService)
    readonly tagsService = inject(TagsService)
    readonly alertService = inject(AlertService)
    readonly locationService = inject(LocationService)
    readonly configService = inject(ConfigService)
    private readonly zone = inject(NgZone)
    private readonly http = inject(HttpClient)
    private readonly translate = inject(TranslateService)
    private readonly router = inject(Router)
    private readonly activatedRoute = inject(ActivatedRoute)
    private readonly document = inject(DOCUMENT)

    isFirstPosition: boolean = true
    private readonly loadingDataState = signal(false)
    readonly loadingData = this.loadingDataState.asReadonly()
    private readonly processingState = signal(false)
    readonly isProcessing = this.processingState.asReadonly()
    private readonly mapInitializationErrorState =
        signal<MapInitializationError | null>(null)
    readonly mapInitializationError =
        this.mapInitializationErrorState.asReadonly()
    private mapCreated = false
    private styleReady = false
    private readonly lifecycle = new MapLifecycleController()
    private readonly layerController = new MapLayerController()
    private officialRenderRevision = 0
    private pendingRenderRevision = 0
    private activeRenderCount = 0
    private lastMapConfig?: Config

    spritesCache: HTMLImageElement | undefined
    constructor() {
        // Preload sprites
        const pathSprites =
            window.devicePixelRatio === 1
                ? this.assetUrl('assets/mapStyle/sprites/sprites.png')
                : this.assetUrl('assets/mapStyle/sprites/sprites@2x.png')
        const spriteImage = new Image()
        spriteImage.onload = () => {
            this.spritesCache = spriteImage
        }
        spriteImage.onerror = (error) => {
            console.error(error)
        }
        spriteImage.src = pathSprites

        this.locationService.locationReady$.subscribe(() => {
            if (
                this.mapCreated &&
                this.configService.config().centerWhenGpsIsReady
            ) {
                this.map.setZoom(19)
            }
        })

        this.markerRedraw$.subscribe((geojson) => {
            void this.renderMarkerCollection(geojson, 'official')
        })

        this.changedMarkerRedraw$.subscribe(
            (geojson: OsmGoFeatureCollection) => {
                void this.renderMarkerCollection(geojson, 'pending')
            }
        )

        this.mapMove$.pipe(debounceTime(700)).subscribe(() => {
            if (!this.mapCreated) return
            const mapCenter = this.map.getCenter()
            const mapBearing = this.map.getBearing()
            const mapZoom = this.map.getZoom()
            const currentView = {
                lng: mapCenter.lng,
                lat: mapCenter.lat,
                zoom: mapZoom,
                bearing: mapBearing,
            }
            this.configService.setLastView(currentView)
        })

        this.mapMoveEndSubject.pipe(debounceTime(150)).subscribe(() => {
            if (this.mapCreated) this.setCenterInUrl()
        })
    }

    map!: MapLibreMap
    markerMove?: OsmGoMarker<OsmGoFeature<Point>>
    private readonly markerMoveMovingState = signal(false)
    readonly markerMoveMoving = this.markerMoveMovingState.asReadonly()
    mode: MapMode = 'Update'
    headingIsLocked: boolean = true
    private lastRenderedHeading: number | null = null
    positionIsFollow: boolean = true
    private readonly isDisplaySatelliteBaseMapState = signal(false)
    readonly isDisplaySatelliteBaseMap =
        this.isDisplaySatelliteBaseMapState.asReadonly()
    private basemapSourceFingerprint: string | null = null
    private basemapAttributionText = ''

    layersAreLoaded: boolean = false

    private readonly bboxChangedSubject = new Subject<OsmGoFeatureCollection>()
    readonly bboxChanged$ = this.bboxChangedSubject.asObservable()
    private readonly moveElementSubject = new Subject<ModalDismissData>()
    readonly moveElement$ = this.moveElementSubject.asObservable()
    private readonly showModalSubject = new Subject<EventShowModal>()
    readonly showModal$ = this.showModalSubject.asObservable()
    private readonly markerRedrawSubject = new Subject<OsmGoFeatureCollection>()
    readonly markerRedraw$ = this.markerRedrawSubject.asObservable()
    private readonly mapLoadedSubject = new Subject<void>()
    readonly mapLoaded$ = this.mapLoadedSubject.asObservable()
    private readonly changedMarkerRedrawSubject =
        new Subject<OsmGoFeatureCollection>()
    readonly changedMarkerRedraw$ =
        this.changedMarkerRedrawSubject.asObservable()
    private readonly featureChoiceSubject = new Subject<MapGeoJSONFeature[]>()
    readonly featureChoiceRequested$ = this.featureChoiceSubject.asObservable()
    private readonly mapBackgroundClickSubject = new Subject<void>()
    readonly mapBackgroundClick$ = this.mapBackgroundClickSubject.asObservable()
    markersLayer: OsmGoMarker[] = []

    attributionControl!: AttributionControl

    private readonly mapMoveSubject = new Subject<void>()
    readonly mapMove$ = this.mapMoveSubject.asObservable()
    private readonly mapMoveEndSubject = new Subject<void>()
    private pendingMapUrlSignature?: string
    private readonly markerMovingState = signal(false)
    readonly markerMoving = this.markerMovingState.asReadonly()
    markerPositionate?: OsmGoMarker<string>
    markerMaplibreUnknown: Record<string, LoadedMapImage> = {}

    setIsProcessing(isProcessing: boolean): void {
        this.processingState.set(isProcessing)
    }

    redrawBbox(geojson: OsmGoFeatureCollection): void {
        this.bboxChangedSubject.next(geojson)
    }

    moveElement(data: ModalDismissData): void {
        this.moveElementSubject.next(data)
    }

    showModal(data: EventShowModal): void {
        this.showModalSubject.next(data)
    }

    redrawMarkers(geojson: OsmGoFeatureCollection): void {
        this.markerRedrawSubject.next(geojson)
    }

    redrawChangedMarkers(geojson: OsmGoFeatureCollection): void {
        this.changedMarkerRedrawSubject.next(geojson)
    }

    private async renderMarkerCollection(
        geojson: OsmGoFeatureCollection,
        target: 'official' | 'pending'
    ): Promise<void> {
        const revision =
            target === 'official'
                ? ++this.officialRenderRevision
                : ++this.pendingRenderRevision
        if (!this.mapCreated || !this.layersAreLoaded) return
        const activeMap = this.map
        const isCurrent = (): boolean =>
            this.mapCreated &&
            this.layersAreLoaded &&
            this.map === activeMap &&
            revision ===
                (target === 'official'
                    ? this.officialRenderRevision
                    : this.pendingRenderRevision)
        const fallbackMarker = 'circle-#000000-maki-circle'
        const renderGeojson: OsmGoFeatureCollection = {
            ...geojson,
            features: geojson.features.map((feature) =>
                typeof feature.properties.marker === 'string' &&
                feature.properties.marker.length > 0
                    ? feature
                    : {
                          ...feature,
                          properties: {
                              ...feature.properties,
                              marker: fallbackMarker,
                          },
                      }
            ),
        }
        const missingMarkers = [
            ...new Set(
                renderGeojson.features
                    .map((feature) => feature.properties.marker)
                    .filter(
                        (marker): marker is string =>
                            typeof marker === 'string' &&
                            marker.length > 0 &&
                            !activeMap.hasImage(marker)
                    )
            ),
        ]
        this.activeRenderCount++
        this.loadingDataState.set(true)
        try {
            await this.addMissingIconsToMap(missingMarkers, activeMap)
            if (!isCurrent()) return
            const dataSourceId = target === 'official' ? 'data' : 'data_changed'
            const waysSourceId = target === 'official' ? 'ways' : 'ways_changed'
            const source = activeMap.getSource(dataSourceId) as
                | GeoJSONSource
                | undefined
            source?.setData(renderGeojson)
            this.drawWaysPoly(renderGeojson, waysSourceId, activeMap)
        } catch (error) {
            if (isCurrent()) console.error(error)
        } finally {
            this.activeRenderCount = Math.max(0, this.activeRenderCount - 1)
            if (this.activeRenderCount === 0) this.loadingDataState.set(false)
        }
    }

    async loadUnknownMarker(factor: number): Promise<void> {
        const roundedFactor = factor > 1 ? 2 : 1
        const markerShapes = ['circle', 'penta', 'square']
        await Promise.all(
            markerShapes.map(async (shape) => {
                const response = await this.map.loadImage(
                    this.assetUrl(
                        `assets/mapStyle/unknown-marker/${shape}-unknown@${roundedFactor}X.png`
                    )
                )
                this.markerMaplibreUnknown[shape] = response.data
            })
        )
    }

    filterMakerByIds(ids: string[]): void {
        if (!this.mapCreated || !this.layersAreLoaded) return
        this.layerController.excludePropertyValues(
            this.map,
            FEATURE_VISIBILITY_LAYER_IDS,
            'configId',
            ids
        )
    }

    drawWaysPoly(
        geojson: OsmGoFeatureCollection,
        source: string,
        targetMap = this.map
    ): void {
        const featuresWay: Feature[] = []
        for (const feature of geojson.features) {
            if (
                feature.properties.type !== 'node' &&
                feature.properties.way_geometry
            ) {
                featuresWay.push({
                    type: 'Feature',
                    properties: feature.properties,
                    geometry: feature.properties.way_geometry,
                })
            }
        }

        const mapSource = targetMap.getSource(source) as
            | GeoJSONSource
            | undefined
        mapSource?.setData({
            type: 'FeatureCollection',
            features: featuresWay,
        })
    }

    /** Converts a distance in meters to pixels at the current map scale. */
    getPixelDistFromMeter(_map: MapLibreMap, dist: number): number {
        const y = _map.getContainer().clientHeight / 2
        const mapWidth = _map.getContainer().clientWidth
        if (mapWidth <= 0 || !Number.isFinite(dist)) return 0

        function getDistance(latlng1: LngLat, latlng2: LngLat): number {
            const R = 6371000
            const rad = Math.PI / 180,
                lat1 = latlng1.lat * rad,
                lat2 = latlng2.lat * rad,
                a =
                    Math.sin(lat1) * Math.sin(lat2) +
                    Math.cos(lat1) *
                        Math.cos(lat2) *
                        Math.cos((latlng2.lng - latlng1.lng) * rad)
            const maxMeters = R * Math.acos(Math.max(-1, Math.min(a, 1)))
            return maxMeters
        }
        const distWidth = getDistance(
            _map.unproject([0, y]),
            _map.unproject([mapWidth, y])
        )
        if (!Number.isFinite(distWidth) || distWidth <= 0) return 0
        const pxPerMeter = mapWidth / distWidth

        return Math.round(dist * pxPerMeter)
    }

    getBbox(): BBox {
        const marginBuffer = this.configService.getMapMarginBuffer() || 50
        const mapContainer = this.map.getContainer()
        const w = mapContainer.offsetWidth
        const h = mapContainer.offsetHeight
        const cUL = this.map.unproject([0, 0]).toArray()
        const cUR = this.map.unproject([w, 0]).toArray()
        const cLR = this.map.unproject([w, h]).toArray()
        const cLL = this.map.unproject([0, h]).toArray()

        const coordinates = [cUL, cUR, cLR, cLL, cUL]
        const longitudes = coordinates.map(([longitude]) => longitude)
        const latitudes = coordinates.map(([, latitude]) => latitude)

        const pointMin: Point = {
            type: 'Point',
            coordinates: [Math.min(...longitudes), Math.min(...latitudes)],
        }
        const pointMax: Point = {
            type: 'Point',
            coordinates: [Math.max(...longitudes), Math.max(...latitudes)],
        }
        const coordsMin = destination(pointMin, marginBuffer / 1000, -135)
            .geometry.coordinates
        const coordsMax = destination(pointMax, marginBuffer / 1000, 45)
            .geometry.coordinates
        const bbox: BBox = [
            coordsMin[0],
            coordsMin[1],
            coordsMax[0],
            coordsMax[1],
        ]
        return bbox
    }

    resetNorth(): void {
        this.map.resetNorth()
    }

    displaySatelliteBaseMap(baseMap: Basemap, isDisplay: boolean): void {
        const bmSource: RasterSourceSpecification = {
            type: 'raster',
            tiles: baseMap.tiles,
            scheme: baseMap.scheme ?? 'xyz',
            tileSize: 256,
            maxzoom: baseMap.max_zoom,
        }
        this.upsertBasemap(bmSource, isDisplay)
        this.updateBasemapAttribution(
            isDisplay ? (baseMap.attribution?.text ?? '') : ''
        )
        this.isDisplaySatelliteBaseMapState.set(isDisplay)
    }

    private upsertBasemap(
        source: RasterSourceSpecification,
        isVisible: boolean
    ): void {
        const fingerprint = JSON.stringify(source)
        const existingSource = this.map.getSource('basemap')
        const sourceChanged =
            !existingSource || this.basemapSourceFingerprint !== fingerprint

        if (sourceChanged) {
            if (this.map.getLayer('basemap')) this.map.removeLayer('basemap')
            if (existingSource) this.map.removeSource('basemap')
            this.map.addSource('basemap', source)
            this.basemapSourceFingerprint = fingerprint
        }

        const existingLayer = this.map.getLayer('basemap')
        if (!existingLayer && isVisible) {
            const beforeLayer = this.map.getLayer('bboxLayer')
            this.map.addLayer(
                {
                    id: 'basemap',
                    type: 'raster',
                    source: 'basemap',
                    minzoom: 0,
                },
                beforeLayer ? 'bboxLayer' : undefined
            )
            return
        }
        if (existingLayer) {
            this.map.setLayoutProperty(
                'basemap',
                'visibility',
                isVisible ? 'visible' : 'none'
            )
        }
    }

    private updateBasemapAttribution(attribution: string): void {
        if (
            this.attributionControl &&
            this.basemapAttributionText === attribution
        ) {
            return
        }
        if (
            this.attributionControl &&
            this.map.hasControl(this.attributionControl)
        ) {
            this.map.removeControl(this.attributionControl)
        }
        this.attributionControl = new AttributionControl({
            customAttribution: attribution,
        })
        this.map.addControl(this.attributionControl)
        this.basemapAttributionText = attribution
    }
    centerOnMyPosition(): void {
        const currentZoom = this.map.getZoom()
        if (this.configService.config().lockMapHeading) {
            this.headingIsLocked = true
        }
        let bearing = 0
        if (this.configService.config().followPosition) {
            this.positionIsFollow = true
            if (this.configService.config().lockMapHeading) {
                bearing = this.locationService.compassHeading().trueHeading ?? 0

                this.map.setLayoutProperty('location_user', 'icon-rotate', 0)
            }
        }
        let newZoom = currentZoom
        if (currentZoom < 17) {
            newZoom = 18
        }
        this.map.flyTo({
            center: this.locationService.getCoordsPosition(),
            zoom: newZoom,
            bearing: bearing,
            speed: 2,
        })
    }
    changeLocationRadius(newRadius: number, transition = false): void {
        const pxRadius = this.getPixelDistFromMeter(this.map, newRadius)
        const duration = transition ? 300 : 0
        this.map.setPaintProperty(
            'location_circle',
            'circle-radius-transition',
            { duration: duration }
        )
        this.map.setPaintProperty('location_circle', 'circle-radius', pxRadius)
    }
    positionateMarker(): void {
        this.endMarkerMovement()
        this.markerPositionate = this.createDomMoveMarker(
            [this.map.getCenter().lng, this.map.getCenter().lat],
            ''
        )
        this.markerMovingState.set(true)
        this.markerPositionate.addTo(this.map)
    }

    openModalOsm(
        lngLat?: LngLat,
        tags?: Record<string, string | number>
    ): void {
        const coords = lngLat ?? this.markerPositionate?.getLngLat()
        if (!coords) return
        this.endMarkerMovement()
        let newTag: Record<string, string | number>

        if (tags) {
            newTag = { ...tags }
        } else {
            const configuredTags = this.tagsService.tags()
            const lastTagsUsed = this.tagsService
                .tags()
                .find((t) => t.id === this.tagsService.lastTagsUsedIds()[0])
            const defaultTag = lastTagsUsed ?? configuredTags[0]
            newTag = defaultTag ? { ...defaultTag.tags } : {}
        }

        const pt = point([coords.lng, coords.lat], {
            type: 'node',
            tags: newTag,
        }) as OsmGoFeature
        this.mode = 'Create'
        this.showModal({
            type: 'Create',
            geojson: pt,
            origineData: 'data_changed',
            openPrimaryTagModalOnStart: !tags,
        })
    }

    cancelNewMarker(): void {
        this.endMarkerMovement()
    }

    openModalWithNewPosition(): void {
        if (!this.markerMove) return
        this.markerMoveMovingState.set(false)
        this.markerMove.remove()
        const geojson = this.markerMove.data
        const newLngLat = this.markerMove.getLngLat()
        geojson.geometry.coordinates = [newLngLat.lng, newLngLat.lat]
        const origineData = geojson.properties.changeType
            ? 'data_changed'
            : 'data'
        this.showModal({
            type: this.mode,
            geojson: geojson,
            newPosition: true,
            origineData: origineData,
        })
        this.markerMove = undefined
    }

    cancelNewPosition(): void {
        if (!this.markerMove) return
        this.markerMoveMovingState.set(false)
        const geojson = this.markerMove.data
        const origineData = geojson.properties.changeType
            ? 'data_changed'
            : 'data'
        this.showModal({
            type: this.mode,
            geojson: geojson,
            origineData: origineData,
        })
        this.markerMove.remove()
        this.markerMove = undefined
    }

    private endMarkerMovement(): void {
        this.markerMovingState.set(false)
        this.markerMoveMovingState.set(false)
        this.markerPositionate?.remove()
        this.markerMove?.remove()
        this.markerPositionate = undefined
        this.markerMove = undefined
    }

    createDomMoveMarker<T>(coord: LngLatLike, data: T): OsmGoMarker<T> {
        const el = document.createElement('div')
        el.className = 'moveMarkerIcon'
        const marker = new Marker({ element: el, anchor: 'bottom' }).setLngLat(
            coord
        ) as OsmGoMarker<T>
        marker.data = data
        return marker
    }

    async resetDataMap(): Promise<void> {
        const emptyData = await this.dataService.resetDownloadedData()
        this.redrawBbox(emptyData.geojsonBbox)
        this.redrawMarkers(emptyData.geojson)
    }

    getMapStyle(): Observable<StyleSpecification> {
        return this.http
            .get<StyleSpecification>(
                this.assetUrl('assets/mapStyle/brigthCustom.json')
            )
            .pipe(
                map((maplibreStyle) => {
                    const spritesFullPath = this.assetUrl(
                        'assets/mapStyle/sprites/sprites'
                    )

                    return { ...maplibreStyle, sprite: spritesFullPath }
                })
            )
    }

    getIconStyle(feature: OsmGoFeature): OsmGoFeature {
        feature = setIconStyle(feature, this.tagsService.tags())
        return feature
    }

    initMap(config: Config): void {
        if (this.mapCreated || this.lifecycle.initializationInProgress) {
            return
        }
        this.lastMapConfig = config
        this.mapInitializationErrorState.set(null)
        const initialization = this.getMapStyle().subscribe({
            next: (mapStyle) => {
                if (this.mapCreated) return
                const canvas = this.document.createElement('canvas')
                if (!canvas.getContext('webgl2')) {
                    this.failMapInitialization(
                        'MAIN.MAP_INITIALIZATION.WEBGL_REQUIRED'
                    )
                    return
                }

                this.positionIsFollow = config.centerWhenGpsIsReady
                this.headingIsLocked = config.centerWhenGpsIsReady
                this.zone.runOutsideAngular(() => {
                    let activeMap: MapLibreMap | undefined
                    try {
                        activeMap = this.createMapInstance({
                            container: 'map',
                            style: mapStyle as StyleSpecification,
                            center: [config.lastView.lng, config.lastView.lat],
                            zoom: config.lastView.zoom,
                            bearing: config.lastView.bearing,
                            pitch: 0,
                            maxZoom: 22,
                            doubleClickZoom: false,
                            attributionControl: false,
                            dragRotate: true,
                            trackResize: false,
                            pitchWithRotate: false,
                            collectResourceTiming: false,
                        })
                        const configuredMap = activeMap
                        this.map = activeMap
                        this.mapCreated = true
                        this.styleReady = false
                        this.layersAreLoaded = false
                        this.configService.setCurrentZoom(activeMap.getZoom())

                        activeMap.addControl(new NavigationControl())
                        this.attributionControl = new AttributionControl({
                            customAttribution: '',
                        })
                        activeMap.addControl(this.attributionControl)
                        activeMap.addControl(
                            new ScaleControl({ maxWidth: 160, unit: 'metric' })
                        )

                        const onLoad = (): void => {
                            if (!this.mapCreated || this.map !== activeMap)
                                return
                            this.styleReady = true
                            this.mapIsLoaded()
                        }
                        const onError = (event: MapLibreErrorEvent): void => {
                            if (
                                !this.mapCreated ||
                                this.map !== activeMap ||
                                this.styleReady
                            ) {
                                return
                            }
                            this.failMapInitialization(
                                'MAIN.MAP_INITIALIZATION.CREATION_FAILED',
                                event.error,
                                activeMap
                            )
                        }
                        const onMove = (): void => {
                            if (!this.mapCreated || this.map !== activeMap)
                                return
                            this.mapMoveSubject.next()
                            const center = activeMap.getCenter()
                            if (this.markerMoving()) {
                                this.markerPositionate?.setLngLat(center)
                            }
                            if (this.markerMoveMoving()) {
                                this.markerMove?.setLngLat(center)
                            }
                        }
                        const onMoveEnd = (): void => {
                            if (this.mapCreated && this.map === activeMap) {
                                this.mapMoveEndSubject.next()
                            }
                        }
                        const onZoom = (): void => {
                            if (!this.mapCreated || this.map !== activeMap)
                                return
                            this.configService.setCurrentZoom(
                                activeMap.getZoom()
                            )
                            const location = this.locationService.location()
                            if (
                                this.layersAreLoaded &&
                                location?.coords.accuracy
                            ) {
                                this.changeLocationRadius(
                                    location.coords.accuracy,
                                    false
                                )
                            }
                        }
                        activeMap.on('load', onLoad)
                        activeMap.on('error', onError)
                        activeMap.on('move', onMove)
                        activeMap.on('moveend', onMoveEnd)
                        activeMap.on('zoom', onZoom)
                        this.lifecycle.trackCleanup(
                            () => configuredMap.off('load', onLoad),
                            () => configuredMap.off('error', onError),
                            () => configuredMap.off('move', onMove),
                            () => configuredMap.off('moveend', onMoveEnd),
                            () => configuredMap.off('zoom', onZoom)
                        )

                        this.lifecycle.trackSession(
                            this.bboxChanged$.subscribe((geojsonPolygon) => {
                                if (
                                    !this.layersAreLoaded ||
                                    this.map !== activeMap
                                ) {
                                    return
                                }
                                const source = activeMap.getSource('bbox') as
                                    | GeoJSONSource
                                    | undefined
                                source?.setData(geojsonPolygon)
                            })
                        )
                        this.lifecycle.trackSession(
                            this.moveElement$.subscribe((data) => {
                                if (
                                    this.map !== activeMap ||
                                    !data.mode ||
                                    !data.geojson ||
                                    data.geojson.geometry.type !== 'Point'
                                ) {
                                    return
                                }
                                this.endMarkerMovement()
                                this.mode = data.mode
                                const pointFeature =
                                    data.geojson as OsmGoFeature<Point>
                                const coordinates = pointFeature.geometry
                                    .coordinates as LngLatLike
                                activeMap.setCenter(coordinates)
                                this.markerMove = this.createDomMoveMarker(
                                    coordinates,
                                    pointFeature
                                )
                                this.markerMoveMovingState.set(true)
                                this.markerMove.addTo(activeMap)
                            })
                        )

                        const initialFeatures = [
                            ...this.dataService.geojson.features,
                            ...this.dataService.geojsonChanged.features,
                        ]
                        const missingMarkers = [
                            ...new Set(
                                initialFeatures
                                    .map((feature) => feature.properties.marker)
                                    .filter(
                                        (marker) =>
                                            !configuredMap.hasImage(marker)
                                    )
                            ),
                        ]
                        this.addMissingIconsToMap(
                            missingMarkers,
                            activeMap
                        ).catch((error) => {
                            if (this.mapCreated && this.map === activeMap) {
                                console.error(error)
                            }
                        })
                    } catch (error) {
                        this.failMapInitialization(
                            'MAIN.MAP_INITIALIZATION.CREATION_FAILED',
                            error,
                            activeMap
                        )
                    }
                })
            },
            error: (error: unknown) => {
                this.failMapInitialization(
                    'MAIN.MAP_INITIALIZATION.STYLE_FAILED',
                    error
                )
            },
        })
        this.lifecycle.trackInitialization(initialization)
    }

    retryMapInitialization(): void {
        if (!this.lastMapConfig) return
        this.initMap(this.lastMapConfig)
    }

    private createMapInstance(options: MapOptions): MapLibreMap {
        return new MapLibreMap(options)
    }

    private failMapInitialization(
        messageKey: MapInitializationError['messageKey'],
        cause?: unknown,
        activeMap?: MapLibreMap
    ): void {
        if (
            activeMap &&
            this.map !== activeMap &&
            this.mapInitializationErrorState()
        ) {
            return
        }
        if (cause) console.error('Map initialization failed.', cause)
        this.mapCreated = false
        this.styleReady = false
        this.layersAreLoaded = false
        this.loadingDataState.set(false)
        this.lifecycle.destroy(activeMap)
        if (activeMap && this.map === activeMap) {
            delete (this as { map?: MapLibreMap }).map
        }
        this._ngZone.run(() => {
            this.mapInitializationErrorState.set({ messageKey })
        })
    }

    destroyMap(): void {
        this.endMarkerMovement()
        const activeMap = this.mapCreated ? this.map : undefined
        this.mapCreated = false
        this.styleReady = false
        this.layersAreLoaded = false
        this.officialRenderRevision++
        this.pendingRenderRevision++
        this.loadingDataState.set(false)
        this.lifecycle.destroy(activeMap)
        this.lastRenderedHeading = null
        this.isFirstPosition = true
    }

    setCenterInUrl(): void {
        const center = this.map.getCenter()
        const lng = Math.round(center.lng * 10000000) / 10000000
        const lat = Math.round(center.lat * 10000000) / 10000000
        const zoom = Math.round(this.map.getZoom() * 100) / 100
        const centerParam = `${lng},${lat}`
        const zoomParam = `${zoom}`
        const currentParams = this.activatedRoute.snapshot.queryParamMap
        const urlAlreadyMatches =
            currentParams.get('center') === centerParam &&
            currentParams.get('zoom') === zoomParam &&
            currentParams.get('id') === null &&
            currentParams.get('add') === null
        const signature = `${centerParam}|${zoomParam}`
        if (urlAlreadyMatches || this.pendingMapUrlSignature === signature) {
            return
        }
        const queryParams: Params = {
            center: centerParam,
            zoom: zoomParam,
            id: null,
            add: null,
        }

        this.pendingMapUrlSignature = signature
        let navigation: Promise<boolean>
        try {
            navigation = this._ngZone.run(() =>
                this.router.navigate([], {
                    replaceUrl: true,
                    relativeTo: this.activatedRoute,
                    queryParams,
                    queryParamsHandling: 'merge',
                })
            )
        } catch (error) {
            this.pendingMapUrlSignature = undefined
            console.error('Could not synchronize the map URL.', error)
            return
        }
        void navigation
            .catch((error: unknown) => {
                console.error('Could not synchronize the map URL.', error)
            })
            .finally(() => {
                if (this.pendingMapUrlSignature === signature) {
                    this.pendingMapUrlSignature = undefined
                }
            })
    }

    getIconRotate(heading: number, mapBearing: number): number {
        return (((heading - mapBearing) % 360) + 360) % 360
    }

    toogleMesureFilter(
        enable: boolean,
        layerName: string,
        value: number,
        _map: MapLibreMap
    ): FilterSpecification | undefined {
        return this.layerController.toggleLessThanFilter(
            _map,
            layerName,
            'mesure',
            enable,
            value
        )
    }

    selectFeature(feature: MapGeoJSONFeature): void {
        const layer = feature['layer'].id
        let origineData: FeatureIdSource = 'data'
        if (
            [
                'label_changed',
                'marker_changed',
                'icon-change',
                'way_line_changed',
                'way_fill_changed',
            ].includes(layer)
        ) {
            origineData = 'data_changed'
        }

        const idFromMap = `${feature.properties.type}/${feature.properties.id}`
        const geojson = this.dataService.getFeatureById(idFromMap, origineData)
        if (!geojson) {
            console.error(`Feature ${idFromMap} was not found.`)
            return
        }

        if (origineData !== 'data_changed') {
            const queryParams: Params = {
                id: `${idFromMap}`,
                zoom: null,
                center: null,
            }
            this.router.navigate([], {
                replaceUrl: true,
                relativeTo: this.activatedRoute,
                queryParams,
                queryParamsHandling: 'merge',
            })
        }

        this.showModal({
            type: 'Read',
            geojson: geojson,
            origineData: origineData,
        })
    }

    showOldTagIcon(maxYearAgo: number): void {
        if (
            !this.mapCreated ||
            !this.layersAreLoaded ||
            !this.map.getLayer('icon-old')
        ) {
            return
        }
        const oneYear = 31_536_000_000
        const threshold = Date.now() - oneYear * maxYearAgo
        this.layerController.replaceComparisonFilter(
            this.map,
            'icon-old',
            'time',
            '>',
            ['>', threshold, ['get', 'time']]
        )
        this.layerController.setVisibility(this.map, 'icon-old', 'visible')
    }

    hideOldTagIcon(): void {
        if (
            !this.mapCreated ||
            !this.layersAreLoaded ||
            !this.map.getLayer('icon-old')
        ) {
            return
        }
        this.layerController.setVisibility(this.map, 'icon-old', 'none')
    }

    showFixmeIcon(): void {
        if (
            !this.mapCreated ||
            !this.layersAreLoaded ||
            !this.map.getLayer('icon-fixme')
        ) {
            return
        }
        this.layerController.setVisibility(this.map, 'icon-fixme', 'visible')
    }
    hideFixmeIcon(): void {
        if (
            !this.mapCreated ||
            !this.layersAreLoaded ||
            !this.map.getLayer('icon-fixme')
        ) {
            return
        }
        this.layerController.setVisibility(this.map, 'icon-fixme', 'none')
    }

    mapIsLoaded(): void {
        if (!this.mapCreated || !this.styleReady || this.layersAreLoaded) return
        const minzoom = 14

        this.map.addSource('bbox', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        })
        this.map.addSource('data', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        })
        this.map.addSource('data_changed', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        })
        this.map.addSource('ways', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        })
        this.map.addSource('ways_changed', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        })
        this.map.addSource('location_circle', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        })

        this.map.addLayer({
            id: 'bboxLayer',
            type: 'line',
            source: 'bbox',
            paint: {
                'line-color': '#ea1212',
                'line-width': 5,
                'line-dasharray': [2, 2],
            },
        })

        this.map.addLayer({
            id: 'way_fill',
            type: 'fill',
            minzoom: minzoom,
            source: 'ways',
            paint: {
                'fill-color': { property: 'hexColor', type: 'identity' },
                'fill-opacity': 0.3,
            },
            filter: [
                'all',
                // Types are not correct for the match filter used in the next line.
                // See this discussion for details: https://github.com/DoFabien/OsmGo/pull/117#discussion_r898447098
                // prettier-ignore
                [
                    'match',
                    ['geometry-type'],
                    ['Polygon', 'MultiPolygon'],
                    true,
                    false,
                ],
            ],
        })

        this.map.addLayer({
            id: 'way_line',
            type: 'line',
            source: 'ways',
            minzoom: minzoom,
            paint: {
                'line-color': { property: 'hexColor', type: 'identity' },
                'line-width': 4,
                'line-opacity': 0.7,
            },
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            // Types are not correct for the match filter used in the next line.
            // See this discussion for details: https://github.com/DoFabien/OsmGo/pull/117#discussion_r898447098
            // prettier-ignore
            filter: [
                'all',
                [
                    'match',
                    ['geometry-type'],
                    ['LineString', 'MultiLineString'],
                    true,
                    false,
                ],
            ],
        })

        this.map.addLayer({
            id: 'way_fill_changed',
            type: 'fill',
            source: 'ways_changed',
            paint: {
                'fill-color': { property: 'hexColor', type: 'identity' },
                'fill-opacity': 0.3,
            },
            filter: [
                'all',
                // Types are not correct for the match filter used in the next line.
                // See this discussion for details: https://github.com/DoFabien/OsmGo/pull/117#discussion_r898447098
                // prettier-ignore
                [
                    'match',
                    ['geometry-type'],
                    ['Polygon', 'MultiPolygon'],
                    true,
                    false,
                ],
            ],
        })

        this.map.addLayer({
            id: 'way_line_changed',
            type: 'line',
            source: 'ways_changed',
            paint: {
                'line-color': { property: 'hexColor', type: 'identity' },
                'line-width': 4,
                'line-opacity': 0.7,
            },
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            filter: [
                'all',
                // Types are not correct for the match filter used in the next line.
                // See this discussion for details: https://github.com/DoFabien/OsmGo/pull/117#discussion_r898447098
                // prettier-ignore
                [
                    'match',
                    ['geometry-type'],
                    ['LineString', 'MultiLineString'],
                    true,
                    false,
                ],
            ],
        })

        this.map.addLayer({
            id: 'label',
            type: 'symbol',
            minzoom: 16.5,
            source: 'data',
            layout: {
                'icon-image': 'none',
                'icon-anchor': 'bottom',
                'text-field': '{_name}',
                'text-font': ['Roboto-Regular'],
                'text-allow-overlap': false,
                'text-size': 11,
                'text-offset': [0, 1],
            },
            paint: {
                'text-color': '#0a0a0a',
                'text-halo-color': 'rgba(255,255,255,1)',
                'text-halo-width': 2,
            },
            filter: ['all'],
        })

        this.map.addLayer({
            id: 'label_changed',
            type: 'symbol',
            minzoom: 16.5,
            source: 'data_changed',
            layout: {
                'icon-image': 'none',
                'icon-anchor': 'bottom',
                'text-field': '{_name}',
                'text-font': ['Roboto-Regular'],
                'text-allow-overlap': false,
                'text-size': 11,
                'text-offset': [0, 1],
            },
            paint: {
                'text-color': '#0a0a0a',
                'text-halo-color': 'rgba(255,255,255,1)',
                'text-halo-width': 2,
            },
            filter: ['all'],
        })

        this.map.addLayer({
            id: 'location_circle',
            type: 'circle',
            source: 'location_circle',
            layout: {},
            paint: {
                'circle-color': '#9bbcf2',
                'circle-opacity': 0.2,
                'circle-radius': 0,
                'circle-stroke-width': 1,
                'circle-stroke-color': '#9bbcf2',
                'circle-stroke-opacity': 0.5,
                'circle-pitch-alignment': 'map',
                'circle-radius-transition': { duration: 0 },
            },
        })

        this.map.addLayer({
            id: 'location_user',
            type: 'symbol',
            source: 'location_circle',
            layout: {
                'icon-size': 0.5,
                'icon-image': 'location-without-orientation',
                'icon-ignore-placement': true,
                'icon-allow-overlap': true,
                'icon-pitch-alignment': 'map',
            },
        })

        this.map.addLayer({
            id: 'icon-old',
            type: 'symbol',
            source: 'data',
            minzoom: minzoom,
            layout: {
                'icon-image': 'Old',
                'icon-ignore-placement': true,
                'icon-offset': [-13, -12],
                visibility: 'none',
            },
            filter: ['all'],
        })

        this.map.addLayer({
            id: 'icon-fixme',
            type: 'symbol',
            source: 'data',
            minzoom: minzoom,
            layout: {
                'icon-image': 'Fixme',
                'icon-ignore-placement': true,
                'icon-offset': [13, -12],
                visibility: 'none',
            },
            filter: ['all', ['any', ['has', 'fixme'], ['has', 'deprecated']]],
        })

        this.map.addLayer({
            id: 'marker',
            type: 'symbol',
            minzoom: minzoom,
            source: 'data',
            layout: getMarkerLayout(),
            filter: ['all'],
        })

        this.map.addLayer({
            id: 'marker_changed',
            type: 'symbol',
            source: 'data_changed',
            minzoom: minzoom,
            layout: getMarkerLayout(),
            filter: ['all'],
        })

        this.map.addLayer({
            id: 'icon-change',
            type: 'symbol',
            source: 'data_changed',
            minzoom: minzoom,
            layout: {
                'icon-image': '{changeType}',
                'icon-ignore-placement': true,
                'icon-offset': [0, -35],
            },
            filter: ['all'],
        })

        this.layersAreLoaded = true

        this.redrawBbox(this.dataService.getGeojsonBbox())
        this.redrawChangedMarkers(this.dataService.geojsonChanged)
        this.redrawMarkers(this.dataService.geojson)

        this.filterMakerByIds(this.tagsService.hiddenTagsIds())

        const configOldTagIcon = this.configService.getOldTagsIcon()
        if (configOldTagIcon.display) {
            this.showOldTagIcon(configOldTagIcon.year)
        }

        if (this.configService.getDisplayFixmeIcon()) {
            this.showFixmeIcon()
        }

        // Area is measured in square meters.
        this.toogleMesureFilter(
            this.configService.getFilterWayByArea(),
            'way_fill',
            5000,
            this.map
        )
        this.toogleMesureFilter(
            this.configService.getFilterWayByArea(),
            'way_fill_changed',
            5000,
            this.map
        )
        // Length is measured in kilometers.
        this.toogleMesureFilter(
            this.configService.getFilterWayByLength(),
            'way_line',
            0.2,
            this.map
        )
        this.toogleMesureFilter(
            this.configService.getFilterWayByLength(),
            'way_line_changed',
            0.2,
            this.map
        )

        const activeMap = this.map
        const onClick = async (event: MapMouseEvent): Promise<void> => {
            if (!this.mapCreated || this.map !== activeMap) return
            const features = activeMap.queryRenderedFeatures(event.point, {
                layers: this.configService.selecableLayers,
            })
            if (!features.length) {
                this.mapBackgroundClickSubject.next()
                return
            }

            if (
                !this.configService.platforms.includes('hybrid') &&
                window.navigator.vibrate
            ) {
                window.navigator.vibrate(50)
            } else {
                try {
                    await Haptics.impact({ style: ImpactStyle.Heavy })
                } catch {}
            }

            const uniqFeaturesById = deduplicateSelectableFeatures(features)

            if (uniqFeaturesById.length > 1) {
                this.featureChoiceSubject.next(uniqFeaturesById)
            } else {
                this.selectFeature(uniqFeaturesById[0])
            }
        }

        const onTouchMove = (): void => {
            this.headingIsLocked = false
            this.positionIsFollow = false
        }

        const onRotate = (): void => {
            if (!this.mapCreated || this.map !== activeMap) return
            const trueHeading =
                this.locationService.compassHeading().trueHeading
            if (
                trueHeading !== null &&
                (!this.configService.config().lockMapHeading ||
                    !this.headingIsLocked)
            ) {
                const iconRotate = this.getIconRotate(
                    trueHeading,
                    activeMap.getBearing()
                )
                activeMap.setLayoutProperty(
                    'location_user',
                    'icon-rotate',
                    iconRotate
                )
            }
        }
        activeMap.on('click', onClick)
        activeMap.on('touchmove', onTouchMove)
        activeMap.on('rotate', onRotate)
        this.lifecycle.trackCleanup(
            () => activeMap.off('click', onClick),
            () => activeMap.off('touchmove', onTouchMove),
            () => activeMap.off('rotate', onRotate)
        )

        this.lifecycle.trackSession(
            this.locationService.compassHeadingChanges$
                .pipe(
                    filter((heading): heading is HeadingWithTrueHeading => {
                        if (heading.trueHeading === null) return false
                        return (
                            this.lastRenderedHeading === null ||
                            Math.abs(
                                heading.trueHeading - this.lastRenderedHeading
                            ) > 1
                        )
                    }),
                    throttleTime(100)
                )
                .subscribe((heading) => {
                    if (!this.mapCreated || this.map !== activeMap) return
                    if (this.lastRenderedHeading === null) {
                        activeMap.setLayoutProperty(
                            'location_user',
                            'icon-image',
                            'location-with-orientation'
                        )
                    }
                    this.lastRenderedHeading = heading.trueHeading

                    if (
                        this.configService.config().lockMapHeading &&
                        this.headingIsLocked
                    ) {
                        activeMap.rotateTo(heading.trueHeading)
                        activeMap.setLayoutProperty(
                            'location_user',
                            'icon-rotate',
                            0
                        )
                    } else {
                        const iconRotate = this.getIconRotate(
                            heading.trueHeading,
                            activeMap.getBearing()
                        )

                        activeMap.setLayoutProperty(
                            'location_user',
                            'icon-rotate',
                            iconRotate
                        )
                    }
                })
        )

        this.lifecycle.trackSession(
            this.locationService.newLocation$.subscribe(
                (geojsonPos: FeatureCollection) => {
                    if (!this.mapCreated || this.map !== activeMap) return
                    const locationSource = activeMap.getSource(
                        'location_circle'
                    ) as GeoJSONSource
                    locationSource.setData(geojsonPos)
                    if (geojsonPos.features[0]?.properties) {
                        const coordinates = (
                            geojsonPos.features[0].geometry as Point
                        ).coordinates as LngLatLike

                        if (geojsonPos.features[0].properties?.accuracy) {
                            this.changeLocationRadius(
                                geojsonPos.features[0].properties?.accuracy,
                                true
                            )
                        }

                        if (
                            this.configService.config().followPosition &&
                            this.positionIsFollow
                        ) {
                            activeMap.setCenter(coordinates)
                            if (this.isFirstPosition) {
                                activeMap.setZoom(18)
                                this.isFirstPosition = false
                            }
                        }
                    }
                }
            )
        )

        // Location may be ready before the map finishes loading.
        if (this.locationService.gpsIsReady()) {
            this.locationService.publishCurrentLocation()
        }

        this.mapLoadedSubject.next()
    }

    async addMissingIconsToMap(
        iconsIds: string[],
        targetMap = this.map
    ): Promise<void> {
        const pixelRatio = window.devicePixelRatio > 1 ? 2 : 1
        const promises: Array<Promise<{ blob: ImageBitmap; id: string }>> = []
        for (const iconId of iconsIds) {
            let iconParam: IconParameters
            const matchMarkerAndIcon = iconId.match(
                /^(circle|square|penta)-(#[0-9a-fA-F]{6})-([\w-]+)$/
            )
            const matchMarkerOnly = iconId.match(
                /^(circle|square|penta)-(#[0-9a-fA-F]{6})-$/
            )
            const matchShapeOnly = iconId.match(/^(circle|square|penta)-$/)

            if (matchMarkerAndIcon) {
                const [, shape, color, id] = matchMarkerAndIcon
                iconParam = { shape, color, id }
            } else if (matchMarkerOnly) {
                const [, shape, color] = matchMarkerOnly
                iconParam = { shape, color, id: 'maki-circle' }
            } else if (matchShapeOnly) {
                const [, shape] = matchShapeOnly
                iconParam = { shape, color: '#000000', id: 'maki-circle' }
            } else {
                iconParam = {
                    shape: 'circle',
                    color: '#000000',
                    id: 'maki-circle',
                }
            }

            promises.push(
                this.generateIconFromSprite(iconParam)
                    .then((image) => ({ ...image, id: iconId }))
                    .catch(async (error) => {
                        if (iconParam.id === 'maki-circle') throw error
                        const fallback = await this.generateIconFromSprite({
                            ...iconParam,
                            id: 'maki-circle',
                        })
                        return { ...fallback, id: iconId }
                    })
            )
        }

        const results = await Promise.allSettled(promises)
        for (const result of results) {
            if (result.status === 'rejected') {
                console.error(result.reason)
                continue
            }
            const image = result.value
            if (!targetMap.hasImage(image.id)) {
                targetMap.addImage(image.id, image.blob, { pixelRatio })
            }
        }
    }

    getCanvasFromSpriteId(spriteId: string): Promise<HTMLCanvasElement> {
        return new Promise((resolve, reject) => {
            const spriteParams = this.tagsService.jsonSprites()[spriteId]

            if (!spriteParams) {
                reject(
                    new Error(`Sprite parameters are missing for ${spriteId}.`)
                )
                return
            }
            const pxRatio = spriteParams.pixelRatio || 1
            const pathSprites =
                pxRatio === 1
                    ? this.assetUrl('assets/mapStyle/sprites/sprites.png')
                    : this.assetUrl('assets/mapStyle/sprites/sprites@2x.png')

            if (this.spritesCache) {
                const spriteImage = this.spritesCache
                const canvas = this.createCanvasFromSprite(
                    spriteImage,
                    spriteParams
                )
                resolve(canvas)
            } else {
                const spriteImage = new Image()
                spriteImage.onload = () => {
                    this.spritesCache = spriteImage
                    const canvas = this.createCanvasFromSprite(
                        spriteImage,
                        spriteParams
                    )
                    resolve(canvas)
                }
                spriteImage.onerror = (error) => {
                    reject(error)
                }
                spriteImage.src = pathSprites
            }
        })
    }

    private createCanvasFromSprite(
        spriteImage: HTMLImageElement,
        spriteParams: Sprite
    ): HTMLCanvasElement {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) {
            throw new Error('Unable to create a canvas context.')
        }
        const { x, y, width, height } = spriteParams
        canvas.width = width
        canvas.height = height
        ctx.drawImage(
            spriteImage,
            x,
            y,
            width,
            height,
            0,
            0,
            canvas.width,
            canvas.height
        )
        return canvas
    }

    combineCanvasMarkerAndIcon(
        canvasMarker: HTMLCanvasElement,
        canvasIcon: HTMLCanvasElement
    ): HTMLCanvasElement {
        const canvasCombined = document.createElement('canvas')
        canvasCombined.width = canvasMarker.width
        canvasCombined.height = canvasMarker.height

        const ctx = canvasCombined.getContext('2d')
        if (!ctx) {
            throw new Error('Unable to create a canvas context.')
        }
        ctx.drawImage(canvasMarker, 0, 0)
        ctx.drawImage(canvasIcon, 0, 0)
        return canvasCombined
    }

    async generateIconFromSprite(
        markerParam: IconParameters
    ): Promise<{ blob: ImageBitmap; id: string }> {
        const id = `${markerParam.shape}-${markerParam.color}-${markerParam.id}`
        const markerId = `${markerParam.shape}-${markerParam.color}`

        const canvasIcon = await this.getCanvasFromSpriteId(markerParam.id)
        const canvasMarker = await this.getCanvasFromSpriteId(markerId)

        const canvasCombined = this.combineCanvasMarkerAndIcon(
            canvasMarker,
            canvasIcon
        )

        return new Promise((resolve, reject) => {
            canvasCombined.toBlob(async (blob) => {
                if (!blob) {
                    reject(new Error(`Unable to render map icon ${id}.`))
                    return
                }
                try {
                    const imageBitmap = await createImageBitmap(blob)
                    resolve({ id, blob: imageBitmap })
                } catch (error) {
                    reject(error)
                }
            })
        })
    }

    private assetUrl(path: string): string {
        return resolveAppUrl(path, this.document.baseURI)
    }
}
