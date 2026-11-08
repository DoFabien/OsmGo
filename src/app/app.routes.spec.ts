import { TestBed } from '@angular/core/testing'
import {
    provideRouter,
    type RedirectFunction,
    Router,
    type UrlTree,
} from '@angular/router'
import { routes } from './app.routes'

describe('app routes', () => {
    it('sends the former basemaps address to the one with query coordinates', () => {
        TestBed.configureTestingModule({ providers: [provideRouter([])] })
        const legacy = routes[0].children?.find(
            (route) => route.path === 'basemaps/:lng/:lat'
        )
        const redirect = legacy?.redirectTo as RedirectFunction

        const tree = TestBed.runInInjectionContext(() =>
            redirect({
                params: { lng: '2.35', lat: '48.85' },
                queryParams: { center: '2.35,48.85', zoom: '18' },
            } as unknown as Parameters<RedirectFunction>[0])
        ) as UrlTree

        expect(TestBed.inject(Router).serializeUrl(tree)).toBe(
            '/basemaps?center=2.35,48.85&zoom=18&lng=2.35&lat=48.85'
        )
    })
})
