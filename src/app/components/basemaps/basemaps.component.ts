import { Component, computed, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { MatButtonModule } from '@angular/material/button'
import { MatRippleModule } from '@angular/material/core'
import { MatIconModule } from '@angular/material/icon'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { ActivatedRoute } from '@angular/router'
import { ScreenHeaderComponent } from '@components/shared/screen-header/screen-header'
import { TranslateModule } from '@ngx-translate/core'
import { type Basemap, BasemapsService } from '@services/basemaps.service'
import { ConfigService } from '@services/config.service'
import { InitService } from '@services/init.service'
import { MapService } from '@services/map.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import {
    BehaviorSubject,
    catchError,
    combineLatest,
    map,
    of,
    startWith,
    switchMap,
} from 'rxjs'

interface BasemapsState {
    status: 'loading' | 'ready' | 'error'
    basemaps: Basemap[]
}

@Component({
    selector: 'app-basemaps',
    templateUrl: './basemaps.component.html',
    styleUrls: ['./basemaps.component.scss'],
    imports: [
        MatButtonModule,
        MatIconModule,
        MatProgressSpinnerModule,
        MatRippleModule,
        ScreenHeaderComponent,
        TranslateModule,
    ],
})
export class BasemapsComponent {
    private readonly overlayNavigation = inject(OverlayNavigationService)
    private readonly route = inject(ActivatedRoute)
    private readonly basemapsService = inject(BasemapsService)
    readonly initService = inject(InitService)
    readonly configService = inject(ConfigService)
    readonly mapService = inject(MapService)

    private readonly reload$ = new BehaviorSubject(0)

    readonly state = toSignal(
        combineLatest([this.route.queryParamMap, this.reload$]).pipe(
            switchMap(([params]) =>
                this.basemapsService
                    .getBasemaps$(
                        ...this.coordinates(
                            params.get('lng'),
                            params.get('lat')
                        )
                    )
                    .pipe(
                        map(
                            (basemaps): BasemapsState => ({
                                status: 'ready',
                                basemaps,
                            })
                        ),
                        startWith<BasemapsState>({
                            status: 'loading',
                            basemaps: [],
                        }),
                        catchError((error: unknown) => {
                            console.error('Unable to load basemaps:', error)
                            return of<BasemapsState>({
                                status: 'error',
                                basemaps: [],
                            })
                        })
                    )
            )
        ),
        {
            initialValue: { status: 'loading', basemaps: [] } as BasemapsState,
        }
    )
    readonly basemaps = computed(() => this.state().basemaps)

    /** The place of the map, or its last view when the address has none. */
    private coordinates(
        lng: string | null,
        lat: string | null
    ): [number, number] {
        const longitude = Number.parseFloat(lng ?? '')
        const latitude = Number.parseFloat(lat ?? '')
        if (
            Number.isFinite(longitude) &&
            Number.isFinite(latitude) &&
            Math.abs(longitude) <= 180 &&
            Math.abs(latitude) <= 90
        ) {
            return [longitude, latitude]
        }
        const lastView = this.configService.lastView()
        return [lastView.lng, lastView.lat]
    }

    retry(): void {
        this.reload$.next(this.reload$.value + 1)
    }

    back(): void {
        void this.overlayNavigation.close()
    }

    selectBaseMap(basemap: Basemap): void {
        this.mapService.displaySatelliteBaseMap(basemap, true)
        this.configService.setBasemap(basemap)
        this.back()
    }
}
