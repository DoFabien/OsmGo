import { TestBed } from '@angular/core/testing'
import { ConfigService } from '@services/config.service'
import type { FeatureCollection, Point, Polygon } from 'geojson'
import { LocationService } from './location.service'

describe('LocationService', () => {
    const position = {
        coords: {
            accuracy: 5,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            latitude: 48.85,
            longitude: 2.35,
            speed: null,
        },
        timestamp: 1,
    } as GeolocationPosition

    const createService = (): LocationService => {
        TestBed.configureTestingModule({
            providers: [{ provide: ConfigService, useValue: {} }],
        })
        return TestBed.runInInjectionContext(() => new LocationService())
    }

    interface WatchHandlers {
        success: (position: GeolocationPosition) => void
        error: (error: GeolocationPositionError) => void
        options?: PositionOptions
    }

    const stubGeolocation = () => {
        const watches: WatchHandlers[] = []
        const watchPosition = vi.fn(
            (
                success: WatchHandlers['success'],
                error: WatchHandlers['error'],
                options?: PositionOptions
            ) => {
                watches.push({ success, error, options })
                return watches.length
            }
        )
        const clearWatch = vi.fn()
        vi.stubGlobal('navigator', {
            ...navigator,
            geolocation: { watchPosition, clearWatch },
        })
        return { watches, watchPosition, clearWatch }
    }
    const positionError = (code: number) =>
        ({ code, message: 'error' }) as GeolocationPositionError

    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it('exposes the current position and GPS readiness as signals', () => {
        const service = createService()
        const { watches } = stubGeolocation()
        const locations: FeatureCollection<Point>[] = []
        service.newLocation$.subscribe((location) => locations.push(location))
        vi.spyOn(service, 'heading').mockReturnValue(undefined)

        service.enableGeolocation()
        watches[0].success(position)

        expect(service.gpsIsReady()).toBe(true)
        expect(service.location()).toBe(position)
        expect(service.getCoordsPosition()).toEqual([2.35, 48.85])
        expect(locations[0].features[0].geometry.coordinates).toEqual([
            2.35, 48.85,
        ])
    })

    it('starts watching immediately and accepts a recently cached position', () => {
        const service = createService()
        const { watches, watchPosition } = stubGeolocation()
        vi.spyOn(service, 'heading').mockReturnValue(undefined)

        service.enableGeolocation()

        expect(watchPosition).toHaveBeenCalledOnce()
        expect(watches[0].options).toEqual(
            expect.objectContaining({
                enableHighAccuracy: true,
                maximumAge: expect.any(Number),
            })
        )
        expect(watches[0].options?.maximumAge).toBeGreaterThan(0)
    })

    it('announces the first position only once', () => {
        const service = createService()
        const { watches } = stubGeolocation()
        vi.spyOn(service, 'heading').mockReturnValue(undefined)
        const ready = vi.fn()
        service.locationReady$.subscribe(ready)

        service.enableGeolocation()
        watches[0].success(position)
        watches[0].success(position)

        expect(ready).toHaveBeenCalledOnce()
    })

    it('clears the position and reports it once when permission is denied', () => {
        const service = createService()
        const { watches } = stubGeolocation()
        vi.spyOn(service, 'heading').mockReturnValue(undefined)
        const locations: FeatureCollection<Point>[] = []
        service.newLocation$.subscribe((location) => locations.push(location))
        const denied = vi.fn()
        service.permissionDenied$.subscribe(denied)
        service.enableGeolocation()
        watches[0].success(position)

        watches[0].error(positionError(1))
        watches[0].error(positionError(1))

        expect(locations.at(-1)?.features).toEqual([])
        expect(service.location()).toBeUndefined()
        expect(service.gpsIsReady()).toBe(false)
        expect(service.geolocationIssue()).toBe('denied')
        expect(denied).toHaveBeenCalledOnce()
    })

    it.each([
        [2, 'unavailable'],
        [3, 'timeout'],
    ] as const)(
        'keeps the last position after error code %s',
        (code, issue) => {
            const service = createService()
            const { watches } = stubGeolocation()
            vi.spyOn(service, 'heading').mockReturnValue(undefined)
            vi.spyOn(console, 'warn').mockImplementation(() => undefined)
            service.enableGeolocation()
            watches[0].success(position)

            watches[0].error(positionError(code))

            expect(service.location()).toBe(position)
            expect(service.gpsIsReady()).toBe(true)
            expect(service.geolocationIssue()).toBe(issue)

            watches[0].success(position)
            expect(service.geolocationIssue()).toBeNull()
        }
    )

    it('retries a denied request when the app returns to the foreground', () => {
        const service = createService()
        const { watches, watchPosition, clearWatch } = stubGeolocation()
        vi.spyOn(service, 'heading').mockReturnValue(undefined)
        service.enableGeolocation()
        watches[0].error(positionError(1))

        service.resumeGeolocation()

        expect(clearWatch).toHaveBeenCalledWith(1)
        expect(watchPosition).toHaveBeenCalledTimes(2)
        watches[1].success(position)
        expect(service.gpsIsReady()).toBe(true)
        expect(service.geolocationIssue()).toBeNull()
    })

    it('does not resume geolocation that was never enabled or was disabled', () => {
        const service = createService()
        const { watchPosition } = stubGeolocation()
        vi.spyOn(service, 'heading').mockReturnValue(undefined)

        service.resumeGeolocation()
        service.enableGeolocation()
        service.disableGeolocation()
        service.resumeGeolocation()

        expect(watchPosition).toHaveBeenCalledOnce()
    })

    it('restarts the watch once when visibilitychange and resume both announce the return', () => {
        const service = createService()
        const { watchPosition } = stubGeolocation()
        vi.spyOn(service, 'heading').mockReturnValue(undefined)
        const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)

        service.enableGeolocation()
        service.resumeGeolocationInForeground()
        service.resumeGeolocationInForeground()
        expect(watchPosition).toHaveBeenCalledTimes(2)

        now.mockReturnValue(20_000)
        service.resumeGeolocationInForeground()
        expect(watchPosition).toHaveBeenCalledTimes(3)
    })

    it('does not ask a denied permission again on return unless it was granted meanwhile', async () => {
        const service = createService()
        const { watches, watchPosition } = stubGeolocation()
        vi.spyOn(service, 'heading').mockReturnValue(undefined)
        const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
        let state: PermissionState = 'denied'
        const query = vi.fn(() => Promise.resolve({ state }))
        vi.stubGlobal('navigator', {
            ...navigator,
            permissions: { query },
        })
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        service.enableGeolocation()
        watches[0].error(positionError(1))
        service.resumeGeolocationInForeground()
        await vi.waitFor(() => expect(query).toHaveBeenCalledOnce())
        await Promise.resolve()
        expect(watchPosition).toHaveBeenCalledOnce()

        state = 'granted'
        now.mockReturnValue(20_000)
        service.resumeGeolocationInForeground()
        await vi.waitFor(() => expect(watchPosition).toHaveBeenCalledTimes(2))
    })

    it('ignores a watch callback that arrives after geolocation is disabled', () => {
        const service = createService()
        const { watches } = stubGeolocation()
        vi.spyOn(service, 'heading').mockReturnValue(undefined)

        service.enableGeolocation()
        service.disableGeolocation()
        watches[0].success(position)

        expect(service.location()).toBeUndefined()
        expect(service.gpsIsReady()).toBe(false)
    })

    it('accepts zero-valued orientation angles and normalizes heading', () => {
        const service = createService()
        const headings: number[] = []
        service.compassHeadingChanges$.subscribe((heading) => {
            if (heading.trueHeading !== null) headings.push(heading.trueHeading)
        })

        ;(
            service as unknown as {
                onDeviceOrientation: (
                    event: Partial<DeviceOrientationEvent>
                ) => void
            }
        ).onDeviceOrientation({ absolute: true, alpha: 0, beta: 0, gamma: 0 })

        expect(headings).toEqual([0])
    })

    it('uses the iOS compass heading when the orientation is not absolute', () => {
        const service = createService()
        const headings: Array<number | null> = []
        service.compassHeadingChanges$.subscribe((heading) =>
            headings.push(heading.trueHeading)
        )
        const onDeviceOrientation = (
            service as unknown as {
                onDeviceOrientation: (event: object) => void
            }
        ).onDeviceOrientation
        const screenAngle = window.screen.orientation?.angle ?? 0

        onDeviceOrientation({ absolute: false, alpha: 10, beta: 0, gamma: 0 })
        onDeviceOrientation({
            absolute: false,
            alpha: 10,
            beta: 0,
            gamma: 0,
            webkitCompassHeading: 90,
        })

        expect(headings).toEqual([null, (90 + screenAngle + 360) % 360])
    })

    it('waits for an explicit request before asking for orientation permission', async () => {
        const service = createService()
        const requestPermission = vi.fn(() =>
            Promise.resolve('denied' as const)
        )
        const orientationDescriptor = Object.getOwnPropertyDescriptor(
            window,
            'DeviceOrientationEvent'
        )
        const absoluteDescriptor = Object.getOwnPropertyDescriptor(
            window,
            'ondeviceorientationabsolute'
        )
        Object.defineProperty(window, 'DeviceOrientationEvent', {
            configurable: true,
            value: { requestPermission },
        })
        Object.defineProperty(window, 'ondeviceorientationabsolute', {
            configurable: true,
            value: null,
        })

        try {
            service.heading()

            expect(service.orientationPermission()).toBe('prompt')
            expect(requestPermission).not.toHaveBeenCalled()

            service.requestHeadingPermission()

            expect(requestPermission).toHaveBeenCalledOnce()
            await vi.waitFor(() =>
                expect(service.orientationPermission()).toBe('denied')
            )
        } finally {
            if (orientationDescriptor) {
                Object.defineProperty(
                    window,
                    'DeviceOrientationEvent',
                    orientationDescriptor
                )
            } else {
                delete (window as { DeviceOrientationEvent?: unknown })
                    .DeviceOrientationEvent
            }
            if (absoluteDescriptor) {
                Object.defineProperty(
                    window,
                    'ondeviceorientationabsolute',
                    absoluteDescriptor
                )
            } else {
                delete (window as { ondeviceorientationabsolute?: unknown })
                    .ondeviceorientationabsolute
            }
        }
    })

    it.each([
        { latitude: Number.NaN },
        { latitude: 91 },
        { longitude: -181 },
        { accuracy: -1 },
        { accuracy: Number.POSITIVE_INFINITY },
    ])('rejects invalid geolocation coordinates: %o', (coords) => {
        const service = createService()
        const invalidPosition = {
            ...position,
            coords: { ...position.coords, ...coords },
        } as GeolocationPosition

        const accepted = (
            service as unknown as {
                setLocation: (value: GeolocationPosition) => boolean
            }
        ).setLocation(invalidPosition)

        expect(accepted).toBe(false)
        expect(service.location()).toBeUndefined()
        expect(service.gpsIsReady()).toBe(false)
    })

    it('builds a finite geodesic accuracy circle at the poles', () => {
        const service = createService()
        const polarPosition = {
            ...position,
            coords: { ...position.coords, latitude: 90, longitude: 180 },
        } as GeolocationPosition
        ;(
            service as unknown as {
                setLocation: (value: GeolocationPosition) => boolean
            }
        ).setLocation(polarPosition)

        const circle = service.getGeoJSONCirclePosition(8)
        const coordinates = (circle.features[0].geometry as Polygon)
            .coordinates[0]

        expect(coordinates).toHaveLength(9)
        expect(coordinates[0]).toEqual(coordinates.at(-1))
        expect(coordinates.flat().every(Number.isFinite)).toBe(true)
        expect(
            coordinates.every(
                ([longitude, latitude]) =>
                    longitude >= -180 &&
                    longitude <= 180 &&
                    latitude >= -90 &&
                    latitude <= 90
            )
        ).toBe(true)
    })

    it.each([0, 2, 3.5, Number.POSITIVE_INFINITY, 4097])(
        'rejects an invalid accuracy-circle point count: %s',
        (points) => {
            const service = createService()
            ;(
                service as unknown as {
                    setLocation: (value: GeolocationPosition) => boolean
                }
            ).setLocation(position)

            expect(() => service.getGeoJSONCirclePosition(points)).toThrow(
                RangeError
            )
        }
    )
})
