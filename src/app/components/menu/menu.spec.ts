import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { Router } from '@angular/router'
import { TranslateService } from '@ngx-translate/core'
import { AlertService } from '@services/alert.service'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmAuthService } from '@services/osm-auth.service'
import { OsmApiService } from '@services/osmApi.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { of, throwError } from 'rxjs'
import { MenuPage } from './menu'

describe('MenuPage swipes', () => {
    const pointerAt = (clientX: number): PointerEvent =>
        ({ clientX }) as PointerEvent

    const createPage = (): MenuPage =>
        TestBed.runInInjectionContext(() => new MenuPage())

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                { provide: MapService, useValue: {} },
                { provide: OsmApiService, useValue: {} },
                { provide: DataService, useValue: {} },
                { provide: ConfigService, useValue: {} },
                { provide: AlertService, useValue: {} },
                { provide: MatDialog, useValue: {} },
                { provide: MatSnackBar, useValue: {} },
                { provide: TranslateService, useValue: {} },
                { provide: Router, useValue: {} },
                { provide: OsmAuthService, useValue: {} },
            ],
        })
    })

    it('closes the menu after a left swipe', () => {
        const page = createPage()
        vi.spyOn(page, 'closeMenu').mockReturnValue(undefined)

        page.startSwipe(pointerAt(100))
        page.endSwipe(pointerAt(40))

        expect(page.closeMenu).toHaveBeenCalled()
    })

    it('ignores a canceled swipe', () => {
        const page = createPage()
        vi.spyOn(page, 'closeMenu').mockReturnValue(undefined)

        page.startSwipe(pointerAt(100))
        page.cancelSwipe()
        page.endSwipe(pointerAt(40))

        expect(page.closeMenu).not.toHaveBeenCalled()
    })
})

describe('MenuPage login', () => {
    const snackBarOpen = vi.fn()
    const login = vi.fn()

    const createPage = (): MenuPage => {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            providers: [
                { provide: MapService, useValue: {} },
                { provide: ConfigService, useValue: {} },
                { provide: MatDialog, useValue: {} },
                { provide: MatSnackBar, useValue: { open: snackBarOpen } },
                {
                    provide: TranslateService,
                    useValue: { instant: (key: string) => key },
                },
                { provide: Router, useValue: {} },
                { provide: OsmAuthService, useValue: { login } },
            ],
        })
        return TestBed.runInInjectionContext(() => new MenuPage())
    }

    beforeEach(() => {
        snackBarOpen.mockReset()
        login.mockReset()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    it('shows an error message when the login cannot start', () => {
        login.mockReturnValue(throwError(() => new Error('offline')))

        createPage().login()

        expect(snackBarOpen).toHaveBeenCalledWith(
            'MENU.LOGIN_ERROR',
            'SHARED.CLOSE',
            expect.objectContaining({ duration: expect.any(Number) })
        )
    })

    it('stays silent when the login starts', () => {
        login.mockReturnValue(of(undefined))

        createPage().login()

        expect(snackBarOpen).not.toHaveBeenCalled()
    })
})

describe('MenuPage basemaps', () => {
    const createPage = (center?: { lng: number; lat: number }) => {
        const open = vi.fn(() => Promise.resolve(true))
        TestBed.configureTestingModule({
            providers: [
                {
                    provide: MapService,
                    useValue: { currentCenter: () => center },
                },
                {
                    provide: ConfigService,
                    useValue: {
                        lastView: () => ({ lng: 5.7, lat: 45.2, zoom: 17 }),
                    },
                },
                { provide: OverlayNavigationService, useValue: { open } },
                { provide: MatDialog, useValue: {} },
                { provide: MatSnackBar, useValue: {} },
                { provide: TranslateService, useValue: {} },
                { provide: OsmAuthService, useValue: {} },
            ],
        })
        const page = TestBed.runInInjectionContext(() => new MenuPage())
        return { open, page }
    }

    it('opens the basemaps of the map center, with coordinates in the query', () => {
        const { open, page } = createPage({ lng: 2.35, lat: 48.85 })

        page.openBaseMapsPage()

        expect(open).toHaveBeenCalledWith('/basemaps', {
            lng: 2.35,
            lat: 48.85,
        })
    })

    it('uses the last view when the map could not start', () => {
        const { open, page } = createPage()

        page.openBaseMapsPage()

        expect(open).toHaveBeenCalledWith('/basemaps', { lng: 5.7, lat: 45.2 })
    })
})
