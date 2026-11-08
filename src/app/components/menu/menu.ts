import { CdkTrapFocus } from '@angular/cdk/a11y'
import { Component, inject, input, output } from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatDialog } from '@angular/material/dialog'
import { MatDividerModule } from '@angular/material/divider'
import { MatIconModule } from '@angular/material/icon'
import { MatSnackBar } from '@angular/material/snack-bar'
import { OsmAuthService } from '@app/services/osm-auth.service'
import {
    ConfirmDialogComponent,
    type ConfirmDialogData,
} from '@components/shared/confirm-dialog/confirm-dialog'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { MapService } from '@services/map.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { menuAnimations } from './menu.animations'

@Component({
    selector: 'menu-component',
    templateUrl: './menu.html',
    styleUrls: ['./menu.scss'],
    animations: menuAnimations,
    imports: [
        CdkTrapFocus,
        MatButtonModule,
        MatDividerModule,
        MatIconModule,
        TranslateModule,
    ],
})
export class MenuPage {
    readonly mapService = inject(MapService)
    readonly configService = inject(ConfigService)
    private readonly dialog = inject(MatDialog)
    private readonly translate = inject(TranslateService)
    private readonly overlayNavigation = inject(OverlayNavigationService)
    private readonly snackBar = inject(MatSnackBar)
    readonly osmAuthService = inject(OsmAuthService)

    private swipeStartX: number | null = null

    readonly closeEvent = output<void>()
    readonly exitApp = output<void>()
    readonly menuIsOpen = input(false)
    readonly newVersion = input(false)

    deleteDatapresentConfirm(): void {
        const data: ConfirmDialogData = {
            title: this.translate.instant('MENU.DELETE_DATA_CONFIRM_HEADER'),
            message: this.translate.instant('MENU.DELETE_DATA_CONFIRM_MESSAGE'),
            cancelLabel: this.translate.instant('SHARED.CANCEL'),
            confirmLabel: this.translate.instant('SHARED.CONFIRM'),
            destructive: true,
        }
        this.dialog
            .open(ConfirmDialogComponent, {
                data,
                autoFocus: 'dialog',
                maxWidth: 'calc(100vw - 32px)',
                panelClass: 'osmgo-dialog',
            })
            .afterClosed()
            .subscribe((confirmed) => {
                if (confirmed) {
                    void this.resetMapData()
                }
            })
    }

    private async resetMapData(): Promise<void> {
        try {
            await this.mapService.resetDataMap()
            this.closeMenu()
        } catch (error) {
            this.snackBar.open(
                error instanceof Error ? error.message : String(error),
                this.translate.instant('SHARED.CLOSE'),
                { duration: 4000 }
            )
        }
    }

    pushPage(path: string, queryParams?: Record<string, number>): void {
        this.closeMenu()
        void this.overlayNavigation.open(path, queryParams)
    }

    openBaseMapsPage() {
        const { lng, lat } =
            this.mapService.currentCenter() ?? this.configService.lastView()
        this.pushPage('/basemaps', { lng, lat })
    }

    closeMenu() {
        this.closeEvent.emit()
    }

    logout() {
        this.osmAuthService.logout()
        this.closeMenu()
    }

    login(): void {
        this.osmAuthService.login().subscribe({
            error: (error) => {
                console.error('Unable to start login.', error)
                this.snackBar.open(
                    this.translate.instant('MENU.LOGIN_ERROR'),
                    this.translate.instant('SHARED.CLOSE'),
                    { duration: 6000 }
                )
            },
        })
    }

    startSwipe(event: PointerEvent): void {
        this.swipeStartX = event.clientX
    }

    endSwipe(event: PointerEvent): void {
        if (
            this.swipeStartX !== null &&
            event.clientX - this.swipeStartX < -50
        ) {
            this.closeMenu()
        }
        this.swipeStartX = null
    }

    cancelSwipe(): void {
        this.swipeStartX = null
    }

    reloadApp() {
        window.location.reload()
    }

    exit() {
        this.exitApp.emit()
    }
}
