import { Component, computed, inject } from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatDialog } from '@angular/material/dialog'
import { MatDividerModule } from '@angular/material/divider'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatSelectModule } from '@angular/material/select'
import {
    type MatSlideToggleChange,
    MatSlideToggleModule,
} from '@angular/material/slide-toggle'
import { MatSliderModule } from '@angular/material/slider'
import { MatSnackBar } from '@angular/material/snack-bar'
import {
    ConfirmDialogComponent,
    type ConfirmDialogData,
} from '@components/shared/confirm-dialog/confirm-dialog'
import { ScreenHeaderComponent } from '@components/shared/screen-header/screen-header'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { DataService, UploadInFlightError } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmAuthService } from '@services/osm-auth.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { UploadCoordinatorService } from '@services/upload-coordinator.service'
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
    private readonly snackBar = inject(MatSnackBar)
    private readonly uploadCoordinator = inject(UploadCoordinatorService)

    /** Wiping local data while a request is running could lose or duplicate edits. */
    readonly uploadIsRunning = computed(
        () =>
            this.dataService.uploadInFlight() ||
            this.uploadCoordinator.inFlight()
    )

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
        this.mapService.toogleMesureFilter(
            this.configService.getFilterWayByArea(),
            'way_fill_changed',
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
        this.mapService.toogleMesureFilter(
            this.configService.getFilterWayByLength(),
            'way_line_changed',
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
        if (this.refuseWhileUploading()) return

        const pendingCount = this.dataService.changedFeatureCount()
        const messages = [
            this.translate.instant('SETTINGS.DELETE_CACHE_CONFIRM_MESSAGE'),
        ]
        if (pendingCount > 0) {
            messages.push(
                this.translate.instant(
                    pendingCount === 1
                        ? 'SETTINGS.DELETE_CACHE_PENDING_ONE'
                        : 'SETTINGS.DELETE_CACHE_PENDING_MANY',
                    { count: pendingCount }
                )
            )
        }
        if (this.dataService.hasActiveUploadJournal()) {
            messages.push(
                this.translate.instant(
                    'SETTINGS.DELETE_CACHE_UNRESOLVED_UPLOAD'
                )
            )
        }
        // Unreadable edits set aside at start-up are kept in the same storage:
        // clearing it destroys the only copy of what could not be recovered.
        const quarantinedCount = this.dataService.quarantinedCount()
        if (quarantinedCount > 0) {
            messages.push(
                this.translate.instant('SEND_DATA.QUARANTINE_MESSAGE', {
                    count: quarantinedCount,
                })
            )
        }
        // Copies kept by a reset or a change of server live there as well.
        const backups = await this.dataService.getStateBackups().catch(() => [])
        if (backups.length > 0) {
            messages.push(
                this.translate.instant('SEND_DATA.STATE_BACKUP_MESSAGE')
            )
        }
        const confirmed = await this.confirm({
            title: this.translate.instant(
                'SETTINGS.DELETE_CACHE_CONFIRM_TITLE'
            ),
            message: messages.join('\n\n'),
            cancelLabel: this.translate.instant('SHARED.CANCEL'),
            confirmLabel: this.translate.instant(
                'SETTINGS.DELETE_CACHE_CONFIRM'
            ),
            destructive: true,
        })
        // An upload may have started while the dialog was open.
        if (!confirmed || this.refuseWhileUploading()) return

        try {
            await this.dataService.clearCache()
        } catch (error) {
            if (!(error instanceof UploadInFlightError)) throw error
            this.refuseWhileUploading(true)
            return
        }
        // the service worker caches keep the app able to start offline
        const cachesKeys = await caches.keys()
        for (const key of cachesKeys) {
            if (!key.startsWith('ngsw:')) await caches.delete(key)
        }

        this.reloadApp()
    }

    async changeIsDevServer(change: MatSlideToggleChange): Promise<void> {
        const isDev = change.checked
        const restoreToggle = () => {
            change.source.checked = this.configService.config().isDevServer
        }
        if (isDev === this.configService.config().isDevServer) return
        if (this.refuseWhileUploading()) {
            restoreToggle()
            return
        }
        const messages = [
            this.translate.instant(
                this.dataService.changedFeatureCount() > 0
                    ? 'SETTINGS.SWITCH_SERVER_MESSAGE'
                    : 'SETTINGS.SWITCH_SERVER_MESSAGE_CLEAN'
            ),
        ]
        if (this.dataService.hasActiveUploadJournal()) {
            messages.push(
                this.translate.instant(
                    'SETTINGS.SWITCH_SERVER_UNRESOLVED_UPLOAD'
                )
            )
        }
        const confirmed = await this.confirm({
            title: this.translate.instant('SETTINGS.SWITCH_SERVER_TITLE'),
            message: messages.join('\n\n'),
            cancelLabel: this.translate.instant('SHARED.CANCEL'),
            confirmLabel: this.translate.instant(
                'SETTINGS.SWITCH_SERVER_CONFIRM'
            ),
            destructive: true,
        })
        if (!confirmed || this.refuseWhileUploading()) {
            restoreToggle()
            return
        }
        try {
            await this.configService.switchOsmEnvironment(isDev)
        } catch (error) {
            restoreToggle()
            if (error instanceof UploadInFlightError) {
                this.refuseWhileUploading(true)
            } else {
                this.snackBar.open(
                    this.translate.instant('SETTINGS.SWITCH_SERVER_FAILED'),
                    this.translate.instant('SHARED.CLOSE'),
                    { duration: 6000 }
                )
            }
            return
        }
        await this.osmAuthService.clearAllAuthentication()
        this.reloadApp()
    }

    private refuseWhileUploading(force = false): boolean {
        if (!force && !this.uploadIsRunning()) return false
        this.snackBar.open(
            this.translate.instant('SETTINGS.UPLOAD_IN_PROGRESS'),
            this.translate.instant('SHARED.CLOSE'),
            { duration: 5000 }
        )
        return true
    }

    private confirm(data: ConfirmDialogData): Promise<boolean> {
        return firstValueFrom(
            this.dialog
                .open(ConfirmDialogComponent, {
                    data,
                    maxWidth: 'calc(100vw - 32px)',
                    panelClass: 'osmgo-dialog',
                })
                .afterClosed()
                .pipe(take(1))
        ).then(Boolean)
    }

    private reloadApp(): void {
        window.location.replace(document.baseURI)
    }
}
