import { type ComponentFixture, TestBed } from '@angular/core/testing'
import { ActivatedRoute, convertToParamMap, type Params } from '@angular/router'
import { type Basemap, BasemapsService } from '@app/services/basemaps.service'
import { TranslateModule } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { InitService } from '@services/init.service'
import { MapService } from '@services/map.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { of, Subject } from 'rxjs'
import { BasemapsComponent } from './basemaps.component'

describe('BasemapsComponent', () => {
    let fixture: ComponentFixture<BasemapsComponent>
    let basemaps$: Subject<Array<{ id: string; name: string }>>
    let displaySatelliteBaseMap: ReturnType<typeof vi.fn>
    let setBasemap: ReturnType<typeof vi.fn>
    let closeOverlay: ReturnType<typeof vi.fn>
    let getBasemaps: ReturnType<typeof vi.fn>

    const configure = async (queryParams: Params) => {
        basemaps$ = new Subject()
        displaySatelliteBaseMap = vi.fn().mockName('displaySatelliteBaseMap')
        setBasemap = vi.fn().mockName('setBasemap')
        closeOverlay = vi.fn().mockName('close').mockResolvedValue(true)
        getBasemaps = vi.fn(() => basemaps$)

        await TestBed.configureTestingModule({
            imports: [BasemapsComponent, TranslateModule.forRoot()],
            providers: [
                {
                    provide: ActivatedRoute,
                    useValue: {
                        queryParamMap: of(convertToParamMap(queryParams)),
                    },
                },
                {
                    provide: BasemapsService,
                    useValue: { getBasemaps$: getBasemaps },
                },
                {
                    provide: ConfigService,
                    useValue: {
                        config: () => ({ basemap: { id: 'selected' } }),
                        lastView: () => ({ lng: 5.7, lat: 45.2, zoom: 17 }),
                        setBasemap,
                    },
                },
                { provide: InitService, useValue: { isLoaded: true } },
                {
                    provide: MapService,
                    useValue: { displaySatelliteBaseMap },
                },
                {
                    provide: OverlayNavigationService,
                    useValue: { close: closeOverlay },
                },
            ],
        }).compileComponents()

        fixture = TestBed.createComponent(BasemapsComponent)
        fixture.autoDetectChanges()
    }

    beforeEach(async () => {
        await configure({ lat: '48.85', lng: '2.35' })
    })

    it('looks for the imagery of the place given in the query', () => {
        expect(getBasemaps).toHaveBeenCalledWith(2.35, 48.85)
    })

    it('uses the last map view when the address gives no place', async () => {
        TestBed.resetTestingModule()
        await configure({ lat: 'north' })

        expect(getBasemaps).toHaveBeenCalledWith(5.7, 45.2)
    })

    it('renders asynchronously loaded basemaps without manual change detection', async () => {
        basemaps$.next([
            { id: 'selected', name: 'Selected map' },
            { id: 'other', name: 'Other map' },
        ])
        await fixture.whenStable()

        const cards = fixture.nativeElement.querySelectorAll('.basemap-card')

        expect(cards).toHaveLength(2)
        expect(cards[0].classList.contains('is-selected')).toBe(true)
        expect(cards[1].classList.contains('is-selected')).toBe(false)
    })

    it('updates the map before persisting the selected basemap', () => {
        const calls: string[] = []
        displaySatelliteBaseMap.mockImplementation(() => calls.push('map'))
        setBasemap.mockImplementation(() => calls.push('config'))
        closeOverlay.mockImplementation(() => {
            calls.push('close')
            return Promise.resolve(true)
        })
        const basemap: Basemap = {
            id: 'other',
            name: 'Other map',
            tiles: ['https://tiles.test/{z}/{x}/{y}.png'],
        }

        fixture.componentInstance.selectBaseMap(basemap)

        expect(calls).toEqual(['map', 'config', 'close'])
    })

    it('exposes the cards as list items that are real toggle buttons', async () => {
        basemaps$.next([
            { id: 'selected', name: 'Selected map' },
            { id: 'other', name: 'Other map' },
        ])
        await fixture.whenStable()

        const cards = Array.from(
            fixture.nativeElement.querySelectorAll(
                'ul[role="list"] > li > button'
            )
        ) as HTMLButtonElement[]

        expect(cards).toHaveLength(2)
        expect(cards.some((card) => card.hasAttribute('role'))).toBe(false)
        expect(cards.map((card) => card.getAttribute('aria-pressed'))).toEqual([
            'true',
            'false',
        ])
    })

    it('shows a spinner while loading', () => {
        expect(
            fixture.nativeElement.querySelector('mat-spinner')
        ).not.toBeNull()
        expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull()
    })

    it('replaces the spinner with an error and a retry button when loading fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined)

        basemaps$.error(new Error('offline'))
        await fixture.whenStable()

        expect(fixture.nativeElement.querySelector('mat-spinner')).toBeNull()
        const alert = fixture.nativeElement.querySelector('[role="alert"]')
        expect(alert.textContent).toContain('SETTINGS.AERIAL_IMAGERY_ERROR')
        expect(alert.querySelector('button').textContent).toContain(
            'SHARED.RETRY'
        )
    })

    it('loads the basemaps again when retrying', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        basemaps$.error(new Error('offline'))
        await fixture.whenStable()
        basemaps$ = new Subject()

        fixture.nativeElement.querySelector('[role="alert"] button').click()
        await fixture.whenStable()
        expect(
            fixture.nativeElement.querySelector('mat-spinner')
        ).not.toBeNull()

        basemaps$.next([{ id: 'other', name: 'Other map' }])
        await fixture.whenStable()

        expect(
            fixture.nativeElement.querySelectorAll('.basemap-card')
        ).toHaveLength(1)
        expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull()
    })

    it('says so when no basemap covers the area', async () => {
        basemaps$.next([])
        await fixture.whenStable()

        expect(fixture.nativeElement.querySelector('mat-spinner')).toBeNull()
        expect(fixture.nativeElement.textContent).toContain('SHARED.NO_RESULTS')
    })
})
