import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { TranslateModule } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { MapService } from '@services/map.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { TagsService } from '@services/tags.service'
import { ManageTagsComponent } from './manage-tags.component'

describe('ManageTagsComponent', () => {
    const filterMakerByIds = vi.fn()
    const closeOverlay = vi.fn()

    function create(map: object | null = {}) {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: [ManageTagsComponent, TranslateModule.forRoot()],
            providers: [
                { provide: ConfigService, useValue: {} },
                { provide: MapService, useValue: { map, filterMakerByIds } },
                {
                    provide: TagsService,
                    useValue: { hiddenTagsIds: () => ['shop/bakery'] },
                },
                { provide: MatDialog, useValue: {} },
                {
                    provide: OverlayNavigationService,
                    useValue: { close: closeOverlay },
                },
            ],
        })
        return TestBed.createComponent(ManageTagsComponent)
    }

    beforeEach(() => {
        filterMakerByIds.mockReset()
        closeOverlay.mockReset().mockResolvedValue(true)
    })

    it('refreshes the hidden tags on the map whatever the way out', () => {
        const fixture = create()
        fixture.detectChanges()

        // Android back, Escape or a tap outside destroy the screen without
        // calling back().
        fixture.destroy()

        expect(filterMakerByIds).toHaveBeenCalledWith(['shop/bakery'])
    })

    it('refreshes the map once when closed with the header arrow', () => {
        const fixture = create()
        fixture.detectChanges()

        fixture.componentInstance.back()
        fixture.destroy()

        expect(closeOverlay).toHaveBeenCalledOnce()
        expect(filterMakerByIds).toHaveBeenCalledOnce()
    })

    it('does not touch a map that does not exist yet', () => {
        const fixture = create(null)
        fixture.detectChanges()

        fixture.destroy()

        expect(filterMakerByIds).not.toHaveBeenCalled()
    })

    it('uses a short action label and warns once about hidden elements', () => {
        const fixture = create()
        fixture.detectChanges()

        const buttons = Array.from(
            fixture.nativeElement.querySelectorAll(
                '.tag-management-card > button'
            )
        ) as HTMLButtonElement[]

        expect(buttons).toHaveLength(3)
        for (const button of buttons) {
            expect(button.textContent).toContain('MANAGE_TAGS.OPEN')
        }
        expect(fixture.nativeElement.querySelectorAll('.warning')).toHaveLength(
            1
        )
    })

    it('keeps the visible label and the card title in the accessible name', () => {
        const fixture = create()
        fixture.detectChanges()

        const labels = Array.from(
            fixture.nativeElement.querySelectorAll(
                '.tag-management-card > button'
            )
        ).map((button) => (button as HTMLElement).getAttribute('aria-label'))

        expect(labels).toEqual([
            'MANAGE_TAGS.OPEN · MANAGE_TAGS.ACTIVE_TAGS',
            'MANAGE_TAGS.OPEN · MANAGE_TAGS.HIDDEN_TAGS',
            'MANAGE_TAGS.OPEN · MANAGE_TAGS.BOOKMARKED_TAGS',
        ])
    })
})
