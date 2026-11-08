import type { ComponentType } from '@angular/cdk/portal'
import { Component, inject, type OnDestroy } from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatDialog } from '@angular/material/dialog'
import { MatIconModule } from '@angular/material/icon'
import { ScreenHeaderComponent } from '@components/shared/screen-header/screen-header'
import { TranslateModule } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { MapService } from '@services/map.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { TagsService } from '@services/tags.service'
import { ActiveTagsComponent } from './active-tags/active-tags.component'
import { BookmarkedTagsComponent } from './bookmarked-tags/bookmarked-tags.component'
import { HiddenTagsComponent } from './hidden-tags/hidden-tags.component'

@Component({
    selector: 'app-manage-tags',
    templateUrl: './manage-tags.component.html',
    styleUrls: ['./manage-tags.component.scss'],
    imports: [
        MatButtonModule,
        MatIconModule,
        ScreenHeaderComponent,
        TranslateModule,
    ],
})
export class ManageTagsComponent implements OnDestroy {
    readonly configService = inject(ConfigService)
    readonly mapService = inject(MapService)
    readonly tagsService = inject(TagsService)
    private readonly dialog = inject(MatDialog)
    private readonly overlayNavigation = inject(OverlayNavigationService)

    refreshFilterMapAfterClose = false

    openHiddenTagsModal(): void {
        this.openTagDialog(HiddenTagsComponent, (data) => {
            if (data === true || data === undefined) {
                this.refreshFilterMapAfterClose = true
            }
        })
    }

    openActiveTagsModal(): void {
        this.openTagDialog(ActiveTagsComponent, (data) => {
            if (data === true || data === undefined) {
                this.refreshFilterMapAfterClose = true
            }
        })
    }

    openBookmarkedTagsModal(): void {
        this.openTagDialog(BookmarkedTagsComponent)
    }

    back() {
        void this.overlayNavigation.close()
    }

    ngOnDestroy(): void {
        // The screen can also be closed by the Android back button, Escape or a
        // tap outside, so the map is refreshed whatever the way out.
        if (this.mapService.map) {
            this.mapService.filterMakerByIds(this.tagsService.hiddenTagsIds())
        }
    }

    private openTagDialog<T>(
        component: ComponentType<T>,
        onClose?: (data: unknown) => void
    ): void {
        this.dialog
            .open(component, {
                width: '100vw',
                height: '100dvh',
                maxWidth: '100vw',
                maxHeight: '100dvh',
                panelClass: 'osmgo-fullscreen-dialog',
                autoFocus: 'dialog',
            })
            .afterClosed()
            .subscribe((data) => onClose?.(data))
    }
}
