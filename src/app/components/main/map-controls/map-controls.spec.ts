import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { Router } from '@angular/router'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { AlertService } from '@services/alert.service'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { InitService } from '@services/init.service'
import { LocationService } from '@services/location.service'
import { MapService } from '@services/map.service'

import { MapControlsComponent } from './map-controls'

describe('MapControlsComponent', () => {
    const isBusy = signal(false)
    const currentZoom = signal(18)
    const gpsIsReady = signal(false)
    const uploadNeedsAttention = signal(false)
    const bearing = signal(0)
    const canFollowHeading = signal(true)
    const followsHeading = signal(true)
    const geolocationIssue = signal<
        'denied' | 'unavailable' | 'timeout' | null
    >(null)

    beforeEach(() => {
        isBusy.set(false)
        currentZoom.set(18)
        gpsIsReady.set(false)
        uploadNeedsAttention.set(false)
        geolocationIssue.set(null)
        canFollowHeading.set(true)
        followsHeading.set(true)
        TestBed.configureTestingModule({
            imports: [MapControlsComponent, TranslateModule.forRoot()],
            providers: [
                {
                    provide: ConfigService,
                    useValue: {
                        currentZoom,
                        getBasemap: () => ({}),
                    },
                },
                {
                    provide: DataService,
                    useValue: { changedFeatureCount: () => 0 },
                },
                {
                    provide: InitService,
                    useValue: { uploadNeedsAttention },
                },
                {
                    provide: LocationService,
                    useValue: {
                        geolocationIssue,
                        gpsIsReady,
                        requestHeadingPermission: vi.fn(),
                        resumeGeolocation: vi.fn(),
                    },
                },
                {
                    provide: MapService,
                    useValue: {
                        bearing,
                        canFollowHeading,
                        followsHeading,
                        resetNorth: vi.fn(),
                        toggleCompass: vi.fn(),
                        centerOnMyPosition: vi.fn(),
                        displaySatelliteBaseMap: vi.fn(),
                        isDisplaySatelliteBaseMap: () => false,
                        isBusy,
                        loadingData: () => false,
                        markerMoveMoving: () => false,
                        markerMoving: () => false,
                    },
                },
                { provide: Router, useValue: { navigate: vi.fn() } },
            ],
        })

        const translate = TestBed.inject(TranslateService)
        translate.setTranslation('fr', {
            MAIN: {
                BUTTONS: {
                    ADD_NEW: 'Créer un objet',
                    CENTER_GPS: 'Centrer la carte sur ma position',
                    FOLLOW_HEADING: "Orienter la carte selon l'appareil",
                    LOAD_DATA: 'Télécharger les données',
                    LOADING_DATA: 'Chargement',
                    MENU: 'Menu',
                    REFRESH_DATA: 'Actualiser',
                    REFRESH_ZOOM_HINT: 'Zoomez pour télécharger',
                    RESET_NORTH: 'Orienter la carte vers le nord',
                    VIEW_AREAL_MAP: 'Imagerie aérienne',
                },
                LOCATION: {
                    DENIED: 'Position bloquée',
                    SEARCHING: 'Recherche de la position',
                    UNAVAILABLE: 'Position indisponible',
                },
            },
        })
        translate.use('fr')
    })

    it('renders refresh as the explicit primary map action', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        const refreshRequested = vi.fn()
        fixture.componentInstance.refreshRequested.subscribe(refreshRequested)
        fixture.detectChanges()

        const refreshButton = fixture.nativeElement.querySelector(
            '[data-testid="load-osm-data"]'
        ) as HTMLButtonElement

        expect(refreshButton.classList).toContain('refresh-button')
        expect(refreshButton.textContent).toContain('Actualiser')
        expect(refreshButton.disabled).toBe(false)

        refreshButton.click()

        expect(refreshRequested).toHaveBeenCalledOnce()
    })

    it('renders the four map actions as independent rail zones', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        fixture.detectChanges()

        const rail = fixture.nativeElement.querySelector(
            '.map-action-dock--browse'
        ) as HTMLElement
        const basemap = rail.querySelector(
            '[data-testid="toggle-basemap"]'
        ) as HTMLElement
        const refresh = rail.querySelector(
            '[data-testid="load-osm-data"]'
        ) as HTMLElement
        const geolocation = rail.querySelector(
            '[data-testid="center-on-gps"]'
        ) as HTMLElement
        const add = rail.querySelector('[data-testid="add-poi"]') as HTMLElement

        expect(basemap.parentElement).toBe(rail)
        expect(refresh.parentElement).toBe(rail)
        expect(geolocation.parentElement).toBe(rail)
        expect(geolocation.classList).toContain('geolocation-button')
        expect(add.parentElement).toBe(rail)
    })

    it('keeps an explicit loading state on the primary action', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        isBusy.set(true)
        fixture.detectChanges()

        const refreshButton = fixture.nativeElement.querySelector(
            '[data-testid="load-osm-data"]'
        ) as HTMLButtonElement

        expect(refreshButton.textContent).toContain('Chargement')
        expect(refreshButton.querySelector('mat-spinner')).not.toBeNull()
        expect(
            refreshButton.querySelector('.refresh-button__content')
        ).not.toBeNull()
        expect(
            refreshButton.querySelector('.refresh-button__label')?.textContent
        ).toContain('Chargement')
        expect(refreshButton.disabled).toBe(true)
    })

    it('requests heading permission from the geolocation button handler', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        const locationService = TestBed.inject(LocationService)
        const mapService = TestBed.inject(MapService)

        fixture.componentInstance.centerOnMyPosition()

        expect(locationService.requestHeadingPermission).toHaveBeenCalledOnce()
        expect(mapService.centerOnMyPosition).toHaveBeenCalledOnce()
        expect(
            vi.mocked(locationService.requestHeadingPermission).mock
                .invocationCallOrder[0]
        ).toBeLessThan(
            vi.mocked(mapService.centerOnMyPosition).mock.invocationCallOrder[0]
        )
    })

    it('keeps the geolocation button usable while there is no position', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        fixture.detectChanges()

        const button = fixture.nativeElement.querySelector(
            '[data-testid="center-on-gps"]'
        ) as HTMLButtonElement

        expect(button.disabled).toBe(false)
        expect(button.classList).toContain('is-searching')

        gpsIsReady.set(true)
        fixture.detectChanges()

        expect(button.classList).not.toContain('is-searching')
    })

    it('asks for a position again and explains the state when there is no fix', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        const locationService = TestBed.inject(LocationService)
        const mapService = TestBed.inject(MapService)
        const showAlert = vi.spyOn(TestBed.inject(AlertService), 'showAlert')

        fixture.componentInstance.centerOnMyPosition()

        expect(locationService.resumeGeolocation).toHaveBeenCalledOnce()
        expect(showAlert).toHaveBeenCalledWith('Recherche de la position')
        expect(mapService.centerOnMyPosition).toHaveBeenCalledOnce()
    })

    it.each([
        ['denied', 'Position bloquée'],
        ['unavailable', 'Position indisponible'],
        ['timeout', 'Recherche de la position'],
    ] as const)('reports a %s position issue', (issue, message) => {
        geolocationIssue.set(issue)
        const fixture = TestBed.createComponent(MapControlsComponent)
        const showAlert = vi.spyOn(TestBed.inject(AlertService), 'showAlert')

        fixture.componentInstance.centerOnMyPosition()

        expect(showAlert).toHaveBeenCalledWith(message)
    })

    it('centers straight away when a position is known', () => {
        gpsIsReady.set(true)
        const fixture = TestBed.createComponent(MapControlsComponent)
        const locationService = TestBed.inject(LocationService)
        const mapService = TestBed.inject(MapService)
        const showAlert = vi.spyOn(TestBed.inject(AlertService), 'showAlert')

        fixture.componentInstance.centerOnMyPosition()

        expect(locationService.resumeGeolocation).not.toHaveBeenCalled()
        expect(showAlert).not.toHaveBeenCalled()
        expect(mapService.centerOnMyPosition).toHaveBeenCalledOnce()
    })

    it('names the refresh button after its visible text', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        fixture.detectChanges()
        const refreshButton = fixture.nativeElement.querySelector(
            '[data-testid="load-osm-data"]'
        ) as HTMLButtonElement

        expect(refreshButton.getAttribute('aria-label')).toBe('Actualiser')
        expect(refreshButton.textContent).toContain(
            refreshButton.getAttribute('aria-label') as string
        )

        isBusy.set(true)
        fixture.detectChanges()

        expect(refreshButton.getAttribute('aria-label')).toBe('Chargement')
    })

    it('explains the disabled refresh below the minimum download zoom', () => {
        currentZoom.set(12)
        const fixture = TestBed.createComponent(MapControlsComponent)
        const refreshRequested = vi.fn()
        fixture.componentInstance.refreshRequested.subscribe(refreshRequested)
        const showAlert = vi.spyOn(TestBed.inject(AlertService), 'showAlert')
        fixture.detectChanges()
        const refreshButton = fixture.nativeElement.querySelector(
            '[data-testid="load-osm-data"]'
        ) as HTMLButtonElement

        expect(refreshButton.getAttribute('aria-disabled')).toBe('true')
        expect(refreshButton.classList).toContain(
            'mat-mdc-button-disabled-interactive'
        )

        refreshButton.click()

        expect(refreshRequested).not.toHaveBeenCalled()
        expect(showAlert).toHaveBeenCalledWith('Zoomez pour télécharger')

        currentZoom.set(15)
        fixture.detectChanges()
        refreshButton.click()

        expect(refreshButton.getAttribute('aria-disabled')).toBeNull()
        expect(refreshRequested).toHaveBeenCalledOnce()
    })

    it('hides the map actions when the map could not start but keeps the menu', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        fixture.componentRef.setInput('mapUnavailable', true)
        fixture.detectChanges()
        const element: HTMLElement = fixture.nativeElement

        expect(element.querySelector('.map-action-dock--browse')).toBeNull()
        expect(
            element.querySelector('[data-testid="open-menu"]')
        ).not.toBeNull()
    })

    it('shows the upload button with an attention badge when an upload needs attention', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        fixture.detectChanges()
        const element: HTMLElement = fixture.nativeElement

        expect(element.querySelector('[data-testid="open-upload"]')).toBeNull()

        uploadNeedsAttention.set(true)
        fixture.detectChanges()

        const upload = element.querySelector('[data-testid="open-upload"]')
        expect(upload).not.toBeNull()
        expect(upload?.textContent).toContain('!')
    })

    it('always shows a compass pointing north that puts north up', () => {
        bearing.set(0)
        const fixture = TestBed.createComponent(MapControlsComponent)
        fixture.detectChanges()
        const compass = (fixture.nativeElement as HTMLElement).querySelector(
            '[data-testid="reset-north"]'
        ) as HTMLButtonElement
        const rotation = () =>
            compass.querySelector('mat-icon')?.getAttribute('style')

        expect(compass).not.toBeNull()
        expect(rotation()).toContain('rotate(0deg)')

        bearing.set(-170)
        fixture.detectChanges()
        expect(rotation()).toContain('rotate(170deg)')

        compass.click()
        expect(TestBed.inject(MapService).toggleCompass).toHaveBeenCalledOnce()
    })

    it('shows when the map turns with the phone and what a tap does', () => {
        const fixture = TestBed.createComponent(MapControlsComponent)
        fixture.detectChanges()
        const compass = (fixture.nativeElement as HTMLElement).querySelector(
            '[data-testid="reset-north"]'
        ) as HTMLButtonElement

        expect(compass.classList).toContain('is-following')
        expect(compass.getAttribute('aria-pressed')).toBe('true')
        expect(compass.getAttribute('aria-label')).toBe(
            'Orienter la carte vers le nord'
        )

        followsHeading.set(false)
        fixture.detectChanges()

        expect(compass.classList).not.toContain('is-following')
        expect(compass.getAttribute('aria-pressed')).toBe('false')
        expect(compass.getAttribute('aria-label')).toBe(
            "Orienter la carte selon l'appareil"
        )

        canFollowHeading.set(false)
        fixture.detectChanges()

        expect(compass.getAttribute('aria-label')).toBe(
            'Orienter la carte vers le nord'
        )
    })
})
