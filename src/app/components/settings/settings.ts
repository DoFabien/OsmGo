import { Component, inject } from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatDialog } from '@angular/material/dialog'
import { MatDividerModule } from '@angular/material/divider'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatSelectModule } from '@angular/material/select'
import { MatSlideToggleModule } from '@angular/material/slide-toggle'
import { MatSliderModule } from '@angular/material/slider'
import {
    ConfirmDialogComponent,
    type ConfirmDialogData,
} from '@components/shared/confirm-dialog/confirm-dialog'
import { ScreenHeaderComponent } from '@components/shared/screen-header/screen-header'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmAuthService } from '@services/osm-auth.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { firstValueFrom } from 'rxjs'
import { take } from 'rxjs/operators'

@Component({
    selector: 'page-settings',
    templateUrl: './settings.html',
    styleUrls: ['./settings.scss'],
    imports: [
        MatButtonModule,
        MatDividerModule,
        MatFormFieldModule,
        MatIconModule,
        MatSelectModule,
        MatSliderModule,
        MatSlideToggleModule,
        ScreenHeaderComponent,
        TranslateModule,
    ],
})
export class SettingsPage {
    readonly configService = inject(ConfigService)
    readonly mapService = inject(MapService)
    readonly dataService = inject(DataService)
    private readonly osmAuthService = inject(OsmAuthService)
    private readonly dialog = inject(MatDialog)
    private readonly translate = inject(TranslateService)
    private readonly overlayNavigation = inject(OverlayNavigationService)

    back(): void {
        void this.overlayNavigation.close()
    }

    mapMarginBufferChange(value: number): void {
        this.configService.setMapMarginBuffer(value)
    }

    limitFeaturesChange(value: number): void {
        this.configService.setLimitFeatures(value)
    }

    lockMapHeadingChange(checked: boolean): void {
        this.configService.setLockMapHeading(checked)
    }

    followPositionChange(checked: boolean): void {
        this.configService.setFollowPosition(checked)
    }

    centerWhenGpsIsReadyChange(checked: boolean): void {
        this.configService.setCenterWhenGpsIsReady(checked)
    }

    openObjectSheetAsPreviewChange(checked: boolean): void {
        this.configService.setOpenObjectSheetAsPreview(checked)
    }

    defaultPrimarykeyWindowsChange(value: 'lastTags' | 'bookmarks'): void {
        this.configService.setDefaultPrimarykeyWindows(value)
    }

    filterWayByArea(checked: boolean): void {
        this.configService.setFilterWayByArea(checked)
        // value en m²!
        this.mapService.toogleMesureFilter(
            this.configService.getFilterWayByArea(),
            'way_fill',
            5000,
            this.mapService.map
        )
    }

    filterWayByLength(checked: boolean): void {
        this.configService.setFilterWayByLength(checked)
        // value en km!
        this.mapService.toogleMesureFilter(
            this.configService.getFilterWayByLength(),
            'way_line',
            0.2,
            this.mapService.map
        )
    }

    displayOldTagIconChange(checked: boolean): void {
        this.configService.setOldTagsIcon(
            checked,
            this.configService.config().oldTagsIcon.year
        )
        if (checked) {
            this.mapService.showOldTagIcon(
                this.configService.config().oldTagsIcon.year
            )
        } else {
            this.mapService.hideOldTagIcon()
        }
        // this.mapService
    }

    yearOldTagIconChange(year: number): void {
        this.configService.setOldTagsIcon(
            this.configService.config().oldTagsIcon.display,
            year
        )
        if (this.configService.config().oldTagsIcon.display) {
            this.mapService.showOldTagIcon(year)
        }
    }

    displayFixmeIconChange(checked: boolean): void {
        this.configService.setDisplayFixmeIcon(checked)
        if (checked) {
            this.mapService.showFixmeIcon()
        } else {
            this.mapService.hideFixmeIcon()
        }
    }

    addSurveyDateChange(checked: boolean): void {
        this.configService.setAddSurveyDate(checked)
    }

    checkedKeyChange(value: 'survey:date' | 'check_date'): void {
        this.configService.setCheckedKey(value)
    }

    displaySurveyCardChange(value: 'never' | 'when_older' | 'always'): void {
        this.configService.setDisplaySurveyCard(value)
    }

    yearOldSurveyCardChange(value: number): void {
        this.configService.setSurveyCardYear(value)
    }

    languageUiChange(value: string): void {
        this.configService.setUiLanguage(value)
    }

    languageTagsChange(value: string): void {
        this.configService.setLanguageTags(value)
    }

    countryTagsChange(value: string): void {
        this.configService.setCountryTags(value)
    }

    isSelectableLineChange(checked: boolean): void {
        this.configService.setIsSelectableLine(checked)
    }
    isSelectablePolygonChange(checked: boolean): void {
        this.configService.setIsSelectablePolygon(checked)
    }

    async deleteCache(): Promise<void> {
        await this.dataService.clearCache()
        const cachesKeys = await caches.keys()
        for (const key of cachesKeys) {
            await caches.delete(key)
        }

        window.location.replace(document.baseURI)
    }

    async changeIsDevServer(isDev: boolean): Promise<void> {
        if (isDev === this.configService.config().isDevServer) return
        if (this.dataService.changedFeatureCount() > 0) {
            const data: ConfirmDialogData = {
                title: this.translate.instant('SETTINGS.SWITCH_SERVER_TITLE'),
                message: this.translate.instant(
                    'SETTINGS.SWITCH_SERVER_MESSAGE'
                ),
                cancelLabel: this.translate.instant('SHARED.CANCEL'),
                confirmLabel: this.translate.instant(
                    'SETTINGS.SWITCH_SERVER_CONFIRM'
                ),
                destructive: true,
            }
            const confirmed = await firstValueFrom(
                this.dialog
                    .open(ConfirmDialogComponent, {
                        data,
                        maxWidth: 'calc(100vw - 32px)',
                        panelClass: 'osmgo-dialog',
                    })
                    .afterClosed()
                    .pipe(take(1))
            )
            if (!confirmed) return
        }
        await this.osmAuthService.clearAllAuthentication()
        await this.configService.switchOsmEnvironment(isDev)
        window.location.replace(document.baseURI)
    }
}
