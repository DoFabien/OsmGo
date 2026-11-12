import { Component, computed, inject, input, output } from '@angular/core'
import { MatBadgeModule } from '@angular/material/badge'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { MatTooltipModule } from '@angular/material/tooltip'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { AlertService } from '@services/alert.service'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { InitService } from '@services/init.service'
import { LocationService } from '@services/location.service'
import { MapService, MIN_DOWNLOAD_ZOOM } from '@services/map.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'

@Component({
    selector: 'app-map-controls',
    templateUrl: './map-controls.html',
    styleUrls: ['./map-controls.scss'],
    imports: [
        MatBadgeModule,
        MatButtonModule,
        MatIconModule,
        MatProgressSpinnerModule,
        MatTooltipModule,
        TranslateModule,
    ],
})
export class MapControlsComponent {
    private readonly alertService = inject(AlertService)
    private readonly translate = inject(TranslateService)
    readonly configService = inject(ConfigService)
    readonly dataService = inject(DataService)
    readonly initService = inject(InitService)
    readonly locationService = inject(LocationService)
    readonly mapService = inject(MapService)
    private readonly overlayNavigation = inject(OverlayNavigationService)

    readonly newVersion = input(false)
    readonly mapUnavailable = input(false)
    readonly menuRequested = output<void>()
    readonly refreshRequested = output<void>()
    readonly addRequested = output<void>()

    openUpload(): void {
        void this.overlayNavigation.open('/pushData')
    }

    toggleBasemap(): void {
        this.mapService.displaySatelliteBaseMap(
            this.configService.getBasemap(),
            !this.mapService.isDisplaySatelliteBaseMap()
        )
    }

    /** What a tap on the compass does now. */
    readonly compassLabelKey = computed(() =>
        !this.mapService.followsHeading() && this.mapService.canFollowHeading()
            ? 'MAIN.BUTTONS.FOLLOW_HEADING'
            : 'MAIN.BUTTONS.RESET_NORTH'
    )

    readonly refreshBlockedByZoom = computed(
        () => (this.configService.currentZoom() ?? 0) < MIN_DOWNLOAD_ZOOM
    )

    requestRefresh(): void {
        if (this.mapService.isBusy()) return
        if (this.refreshBlockedByZoom()) {
            this.alertService.showAlert(
                this.translate.instant('MAIN.BUTTONS.REFRESH_ZOOM_HINT')
            )
            return
        }
        this.refreshRequested.emit()
    }

    centerOnMyPosition(): void {
        this.locationService.requestHeadingPermission()
        if (!this.locationService.gpsIsReady()) {
            this.locationService.resumeGeolocation()
            this.alertService.showAlert(
                this.translate.instant(this.missingPositionMessageKey())
            )
        }
        this.mapService.centerOnMyPosition()
    }

    private missingPositionMessageKey(): string {
        switch (this.locationService.geolocationIssue()) {
            case 'denied':
                return 'MAIN.LOCATION.DENIED'
            case 'unavailable':
                return 'MAIN.LOCATION.UNAVAILABLE'
            default:
                return 'MAIN.LOCATION.SEARCHING'
        }
    }
}
