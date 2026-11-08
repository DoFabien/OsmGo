import { TestBed } from '@angular/core/testing'
import { MatDialogRef } from '@angular/material/dialog'
import { TranslateModule } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { TagsService } from '@services/tags.service'
import { ActiveTagsComponent } from './active-tags.component'

describe('ActiveTagsComponent', () => {
    function render() {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: [ActiveTagsComponent, TranslateModule.forRoot()],
            providers: [
                { provide: MatDialogRef, useValue: { close: vi.fn() } },
                {
                    provide: ConfigService,
                    useValue: {
                        config: () => ({
                            languageTags: 'en',
                            countryTags: 'FR',
                        }),
                    },
                },
                {
                    provide: TagsService,
                    useValue: {
                        tags: () => [],
                        hiddenTagsIds: () => [],
                        jsonSprites: () => ({}),
                        bookmarksIds: () => [],
                    },
                },
            ],
        })
        const fixture = TestBed.createComponent(ActiveTagsComponent)
        fixture.detectChanges()
        return fixture
    }

    it('says there is no result instead of calling the search "undefined"', () => {
        const fixture = render()

        fixture.componentInstance.onSearchInput('zzzz')
        fixture.detectChanges()

        const empty = fixture.nativeElement.querySelector('.tag-dialog__empty')
        expect(empty.textContent).toContain('SHARED.NO_RESULTS')
        expect(empty.textContent).not.toContain('SHARED.UNDEFINED')
    })

    it('asks for three letters before searching', () => {
        const fixture = render()

        expect(
            fixture.nativeElement.querySelector('.tag-dialog__empty')
                .textContent
        ).toContain('MODAL_SELECTED_ITEM.SEARCH_TAG_AT_LEAST_3_LETTERS')
    })
})
