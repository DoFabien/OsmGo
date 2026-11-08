import { inject, Service, signal } from '@angular/core'
import type { CompassHeading } from '@osmgo/type'
import { ConfigService } from '@services/config.service'
import destination from '@turf/destination'
import { point as turfPoint } from '@turf/helpers'
// import { Geolocation } from '@capacitor/geolocation'
import type { FeatureCollection, Point } from 'geojson'
import { Subject } from 'rxjs'

const EMPTY_COMPASS_HEADING: CompassHeading = {
    magneticHeading: null,
    trueHeading: null,
    headingAccuracy: null,
    timestamp: null,
}

const GEOLOCATION_OPTIONS: PositionOptions = {
    enableHighAccuracy: true,
    maximumAge: 10_000,
    timeout: 15_000,
}
const POSITION_ERROR_PERMISSION_DENIED = 1
const POSITION_ERROR_TIMEOUT = 3
/** `visibilitychange` and the Capacitor `resume` event both announce a return. */
const FOREGROUND_RESUME_INTERVAL_MS = 1_000
const DEFAULT_ACCURACY_CIRCLE_POINTS = 64
const MAX_ACCURACY_CIRCLE_POINTS = 4096

type DeviceOrientationPermission = typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<'granted' | 'denied'>
}

type WebkitDeviceOrientationEvent = DeviceOrientationEvent & {
    webkitCompassHeading?: number
}

export type GeolocationIssue = 'denied' | 'unavailable' | 'timeout'

export type OrientationPermissionState =
    | 'unknown'
    | 'prompt'
    | 'granted'
    | 'denied'
    | 'unavailable'

@Service()
export class LocationService {
    readonly configService = inject(ConfigService)

    private readonly newLocationSubject = new Subject<
        FeatureCollection<Point>
    >()
    readonly newLocation$ = this.newLocationSubject.asObservable()
    private readonly compassHeadingSubject = new Subject<CompassHeading>()
    readonly compassHeadingChanges$ = this.compassHeadingSubject.asObservable()
    private readonly locationReadySubject = new Subject<GeolocationPosition>()
    readonly locationReady$ = this.locationReadySubject.asObservable()

    private readonly locationState = signal<GeolocationPosition | undefined>(
        undefined
    )
    readonly location = this.locationState.asReadonly()
    private readonly compassHeadingState = signal<CompassHeading>(
        EMPTY_COMPASS_HEADING
    )
    readonly compassHeading = this.compassHeadingState.asReadonly()
    private readonly gpsReadyState = signal(false)
    readonly gpsIsReady = this.gpsReadyState.asReadonly()
    private readonly orientationPermissionState =
        signal<OrientationPermissionState>('unknown')
    readonly orientationPermission =
        this.orientationPermissionState.asReadonly()
    private readonly geolocationIssueState = signal<GeolocationIssue | null>(
        null
    )
    readonly geolocationIssue = this.geolocationIssueState.asReadonly()
    private readonly permissionDeniedSubject = new Subject<void>()
    readonly permissionDenied$ = this.permissionDeniedSubject.asObservable()

    private watchId?: number
    private lastForegroundResume = Number.NEGATIVE_INFINITY
    private geolocationSession = 0
    private geolocationActive = false
    private orientationEventName?:
        | 'deviceorientationabsolute'
        | 'deviceorientation'

    watchPosition(): void {
        const session = this.geolocationSession
        if (this.watchId !== undefined) {
            navigator.geolocation?.clearWatch(this.watchId)
            this.watchId = undefined
        }
        if (!navigator.geolocation) {
            this.geolocationIssueState.set('unavailable')
            return
        }
        this.watchId = navigator.geolocation.watchPosition(
            (position: GeolocationPosition) => {
                if (session !== this.geolocationSession || !position?.coords) {
                    return
                }
                const hadPosition = this.gpsReadyState()
                const validPosition = this.setLocation(position)
                this.gpsReadyState.set(validPosition)
                if (!validPosition) return
                this.geolocationIssueState.set(null)
                if (!hadPosition) this.locationReadySubject.next(position)
            },
            (error: GeolocationPositionError) => {
                if (session === this.geolocationSession) {
                    this.handleGeolocationError(error)
                }
            },
            GEOLOCATION_OPTIONS
        )
    }

    enableGeolocation(): void {
        this.geolocationSession++
        this.geolocationActive = true
        this.geolocationIssueState.set(null)
        this.heading()
        this.watchPosition()
    }

    /** Restarts the watch when the user asks again. */
    resumeGeolocation(): void {
        if (this.geolocationActive) this.watchPosition()
    }

    /**
     * Restarts the watch once when the app returns to the foreground. A denied
     * permission is asked again only if it was granted in the settings
     * meanwhile: the app would otherwise prompt on every return.
     */
    resumeGeolocationInForeground(): void {
        const now = Date.now()
        if (now - this.lastForegroundResume < FOREGROUND_RESUME_INTERVAL_MS) {
            return
        }
        this.lastForegroundResume = now
        if (!this.geolocationActive) return
        if (this.geolocationIssueState() !== 'denied') {
            this.watchPosition()
            return
        }
        const session = this.geolocationSession
        void this.isGeolocationGranted().then((granted) => {
            if (
                granted &&
                session === this.geolocationSession &&
                this.geolocationIssueState() === 'denied'
            ) {
                this.watchPosition()
            }
        })
    }

    private async isGeolocationGranted(): Promise<boolean> {
        try {
            const status = await navigator.permissions?.query({
                name: 'geolocation',
            })
            return status?.state === 'granted'
        } catch {
            return false
        }
    }

    private handleGeolocationError(error: GeolocationPositionError): void {
        if (error.code === POSITION_ERROR_PERMISSION_DENIED) {
            const wasDenied = this.geolocationIssueState() === 'denied'
            this.geolocationIssueState.set('denied')
            this.clearLocation()
            if (!wasDenied) this.permissionDeniedSubject.next()
            return
        }
        const issue =
            error.code === POSITION_ERROR_TIMEOUT ? 'timeout' : 'unavailable'
        if (this.geolocationIssueState() !== issue) console.warn(error)
        this.geolocationIssueState.set(issue)
    }

    disableGeolocation(): void {
        this.geolocationSession++
        this.geolocationActive = false
        this.geolocationIssueState.set(null)
        if (this.watchId !== undefined) {
            navigator.geolocation.clearWatch(this.watchId)
            this.watchId = undefined
        }
        if (this.orientationEventName) {
            window.removeEventListener(
                this.orientationEventName,
                this.onDeviceOrientation,
                true
            )
            this.orientationEventName = undefined
        }
        this.clearLocation()
    }

    heading(): void {
        const orientationApi = this.prepareOrientationTracking()
        if (!orientationApi) return
        if (orientationApi?.requestPermission) {
            this.orientationPermissionState.set('prompt')
            return
        }
        this.orientationPermissionState.set('granted')
        this.listenForHeading()
    }

    requestHeadingPermission(): void {
        const orientationApi = this.prepareOrientationTracking()
        if (!orientationApi) return
        if (
            !orientationApi.requestPermission ||
            this.orientationPermission() === 'granted'
        ) {
            this.orientationPermissionState.set('granted')
            this.listenForHeading()
            return
        }
        try {
            void orientationApi
                .requestPermission()
                .then((permission) => {
                    this.orientationPermissionState.set(permission)
                    if (permission === 'granted') this.listenForHeading()
                })
                .catch(() => this.orientationPermissionState.set('denied'))
        } catch {
            this.orientationPermissionState.set('denied')
        }
    }

    private readonly onDeviceOrientation = (event: DeviceOrientationEvent) => {
        if (
            event.alpha === null ||
            event.beta === null ||
            event.gamma === null
        ) {
            return
        }

        const alphaRad = event.alpha * (Math.PI / 180)
        const betaRad = event.beta * (Math.PI / 180)
        const gammaRad = event.gamma * (Math.PI / 180)

        const cA = Math.cos(alphaRad)
        const sA = Math.sin(alphaRad)
        const sB = Math.sin(betaRad)
        const cG = Math.cos(gammaRad)
        const sG = Math.sin(gammaRad)

        const rA = -cA * sG - sA * sB * cG
        const rB = -sA * sG + cA * sB * cG

        const screenAngle = window.screen.orientation?.angle ?? 0
        const heading =
            ((Math.atan2(rA, rB) * 180) / Math.PI + screenAngle + 360) % 360

        const webkitHeading = (event as WebkitDeviceOrientationEvent)
            .webkitCompassHeading
        const webkitScreenHeading =
            !event.absolute &&
            typeof webkitHeading === 'number' &&
            Number.isFinite(webkitHeading)
                ? (webkitHeading + screenAngle + 360) % 360
                : null
        const newCompassHeading: CompassHeading = {
            magneticHeading: webkitScreenHeading ?? heading,
            trueHeading: event.absolute ? heading : webkitScreenHeading,
            headingAccuracy: null,
            timestamp: Date.now(),
        }

        this.compassHeadingState.set(newCompassHeading)
        this.compassHeadingSubject.next(newCompassHeading)
    }

    private setLocation(position: GeolocationPosition): boolean {
        if (!this.isValidPosition(position)) {
            this.clearLocation()
            return false
        }
        this.locationState.set(position)
        this.publishCurrentLocation()
        return true
    }

    private isValidPosition(position: GeolocationPosition): boolean {
        const { latitude, longitude, accuracy } = position.coords
        return (
            Number.isFinite(latitude) &&
            latitude >= -90 &&
            latitude <= 90 &&
            Number.isFinite(longitude) &&
            longitude >= -180 &&
            longitude <= 180 &&
            Number.isFinite(accuracy) &&
            accuracy >= 0
        )
    }

    private clearLocation(): void {
        this.locationState.set(undefined)
        this.gpsReadyState.set(false)
        this.newLocationSubject.next({
            type: 'FeatureCollection',
            features: [],
        })
    }

    getCoordsPosition(): [number, number] {
        const location = this.location()
        if (location?.coords) {
            return [location.coords.longitude, location.coords.latitude]
        }
        throw new Error('no location')
    }

    getGeojsonPos(): FeatureCollection<Point> | undefined {
        const location = this.location()
        if (!location?.coords) return undefined

        return {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [
                            location.coords.longitude,
                            location.coords.latitude,
                        ],
                    },
                    properties: {
                        accuracy: location.coords.accuracy,
                        trueHeading:
                            this.compassHeading().trueHeading ??
                            this.compassHeading().magneticHeading,
                    },
                },
            ],
        }
    }

    publishCurrentLocation(): void {
        const point = this.getGeojsonPos()
        if (point) this.newLocationSubject.next(point)
    }

    private listenForHeading(): void {
        if (!this.orientationEventName) return
        window.addEventListener(
            this.orientationEventName,
            this.onDeviceOrientation,
            true
        )
    }

    private prepareOrientationTracking():
        | DeviceOrientationPermission
        | undefined {
        if (this.orientationEventName) {
            window.removeEventListener(
                this.orientationEventName,
                this.onDeviceOrientation,
                true
            )
        }

        if (typeof window['ondeviceorientationabsolute'] === 'object') {
            this.orientationEventName = 'deviceorientationabsolute'
        } else if (typeof window['ondeviceorientation'] === 'object') {
            this.orientationEventName = 'deviceorientation'
        } else {
            this.orientationEventName = undefined
            this.orientationPermissionState.set('unavailable')
            return undefined
        }

        const orientationApi = window.DeviceOrientationEvent as
            | DeviceOrientationPermission
            | undefined
        if (!orientationApi) {
            this.orientationPermissionState.set('unavailable')
            return undefined
        }
        return orientationApi
    }

    getGeoJSONCirclePosition(
        points: number = DEFAULT_ACCURACY_CIRCLE_POINTS
    ): FeatureCollection {
        if (
            !Number.isInteger(points) ||
            points < 3 ||
            points > MAX_ACCURACY_CIRCLE_POINTS
        ) {
            throw new RangeError(
                `Accuracy circle points must be an integer between 3 and ${MAX_ACCURACY_CIRCLE_POINTS}.`
            )
        }
        const location = this.location()
        if (!location) throw new Error('no location')
        const radiusInKm = location.coords.accuracy / 1000
        const center = turfPoint([
            location.coords.longitude,
            location.coords.latitude,
        ])
        const coordinates: number[][] = []
        for (let i = 0; i < points; i++) {
            const [longitude, latitude] = destination(
                center,
                radiusInKm,
                (i / points) * 360,
                {
                    units: 'kilometers',
                }
            ).geometry.coordinates
            coordinates.push([
                ((((longitude + 180) % 360) + 360) % 360) - 180,
                latitude,
            ])
        }
        coordinates.push([...coordinates[0]])
        return {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [coordinates] },
                    properties: {},
                },
            ],
        }
    }
}
