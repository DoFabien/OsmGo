import { Location } from '@angular/common'
import { TestBed } from '@angular/core/testing'
import {
    NavigationEnd,
    ROUTER_CONFIGURATION,
    Router,
    type RouterStateSnapshot,
    type Routes,
} from '@angular/router'
import { Subject } from 'rxjs'
import {
    OverlayNavigationService,
    overlayCanDeactivate,
} from './overlay-navigation.service'

describe('OverlayNavigationService', () => {
    const overlayRoute = { path: 'settings' }
    const redirectRoute = { path: 'callback', redirectTo: '' }

    function createService(
        options: { resolution?: 'replace' | 'computed'; trigger?: string } = {}
    ) {
        const events = new Subject<unknown>()
        const router = {
            config: [
                { path: '', children: [redirectRoute, overlayRoute] },
                { path: '**', redirectTo: '' },
            ] as Routes,
            events,
            getCurrentNavigation: () => ({ trigger: options.trigger }),
            navigate: vi.fn((commands: unknown[]) => {
                router.url = commands[0] === '/' ? '/' : `/${commands[0]}`
                return Promise.resolve(true)
            }),
            url: '/',
        }
        const location = { back: vi.fn() }
        TestBed.configureTestingModule({
            providers: [
                { provide: Router, useValue: router },
                { provide: Location, useValue: location },
                {
                    provide: ROUTER_CONFIGURATION,
                    useValue: {
                        canceledNavigationResolution: options.resolution,
                    },
                },
            ],
        })
        const service = TestBed.inject(OverlayNavigationService)
        const goBackTo = (url: string) => {
            location.back.mockImplementation(() => {
                router.url = url
                events.next(new NavigationEnd(1, url, url))
            })
        }
        return { events, goBackTo, location, router, service }
    }

    afterEach(() => {
        vi.useRealTimers()
    })

    it('opens an overlay with the map query parameters', async () => {
        const { router, service } = createService()

        await service.open('settings')

        expect(router.navigate).toHaveBeenCalledWith(['settings'], {
            queryParamsHandling: 'preserve',
        })
    })

    it('adds the query parameters of an overlay to those of the map', async () => {
        const { router, service } = createService()

        await service.open('/basemaps', { lng: 2.35, lat: 48.85 })

        expect(router.navigate).toHaveBeenCalledWith(['/basemaps'], {
            queryParams: { lng: 2.35, lat: 48.85 },
            queryParamsHandling: 'merge',
        })
    })

    it('goes back instead of stacking a second map entry when the overlay was pushed', async () => {
        const { goBackTo, location, router, service } = createService()
        await service.open('settings')
        router.navigate.mockClear()
        goBackTo('/')

        await expect(service.close()).resolves.toBe(true)

        expect(location.back).toHaveBeenCalledOnce()
        expect(router.navigate).not.toHaveBeenCalled()
    })

    it('replaces the entry when the overlay was opened by a direct link', async () => {
        const { location, router, service } = createService()
        router.url = '/settings'

        await service.close()

        expect(location.back).not.toHaveBeenCalled()
        expect(router.navigate).toHaveBeenCalledWith(['/'], {
            queryParams: { lng: null, lat: null },
            queryParamsHandling: 'merge',
            replaceUrl: true,
        })
    })

    it('goes back only once per opening', async () => {
        const { goBackTo, location, router, service } = createService()
        await service.open('settings')
        goBackTo('/')
        await service.close()
        router.url = '/settings'

        await service.close()

        expect(location.back).toHaveBeenCalledOnce()
    })

    it('replaces the entry when going back leaves the overlay on screen', async () => {
        const { events, location, router, service } = createService()
        await service.open('settings')
        router.navigate.mockClear()
        location.back.mockImplementation(() => {
            events.next(new NavigationEnd(1, '/settings', '/settings'))
        })

        await service.close()

        expect(router.navigate).toHaveBeenCalledWith(['/'], {
            queryParams: { lng: null, lat: null },
            queryParamsHandling: 'merge',
            replaceUrl: true,
        })
    })

    it('replaces the entry when going back produces no navigation', async () => {
        vi.useFakeTimers()
        const { router, service } = createService()
        await service.open('settings')
        router.navigate.mockClear()

        const closing = service.close()
        await vi.advanceTimersByTimeAsync(1000)
        await closing

        expect(router.navigate).toHaveBeenCalledWith(['/'], {
            queryParams: { lng: null, lat: null },
            queryParamsHandling: 'merge',
            replaceUrl: true,
        })
    })

    describe('close guard', () => {
        const runGuard = (overlay: unknown) =>
            TestBed.runInInjectionContext(() =>
                overlayCanDeactivate(
                    overlay as never,
                    {} as never,
                    {} as RouterStateSnapshot,
                    {} as RouterStateSnapshot
                )
            )

        it('lets an overlay close unless it asks to stay', () => {
            createService()

            expect(runGuard({ canCloseOverlay: () => true })).toBe(true)
            expect(runGuard({})).toBe(true)
            expect(runGuard(null)).toBe(true)
            expect(runGuard({ canCloseOverlay: () => false })).toBe(false)
        })

        it('is attached once to the overlay routes only', () => {
            const { router, service } = createService()

            service.installCloseGuard()
            service.installCloseGuard()

            expect(overlayRoute).toHaveProperty('canDeactivate', [
                overlayCanDeactivate,
            ])
            expect(redirectRoute).not.toHaveProperty('canDeactivate')
            expect(router.config[1]).not.toHaveProperty('canDeactivate')
        })

        it('forgets the pushed entry after a refused browser back navigation', async () => {
            const { location, router, service } = createService({
                resolution: 'replace',
                trigger: 'popstate',
            })
            await service.open('settings')
            router.navigate.mockClear()

            runGuard({ canCloseOverlay: () => false })
            await service.close()

            expect(location.back).not.toHaveBeenCalled()
            expect(router.navigate).toHaveBeenCalledOnce()
        })

        it('keeps the pushed entry when the router restores the history position itself', async () => {
            const { goBackTo, location, router, service } = createService({
                resolution: 'computed',
                trigger: 'popstate',
            })
            await service.open('settings')
            router.navigate.mockClear()
            goBackTo('/')

            runGuard({ canCloseOverlay: () => false })
            await service.close()

            expect(location.back).toHaveBeenCalledOnce()
        })
    })
})
