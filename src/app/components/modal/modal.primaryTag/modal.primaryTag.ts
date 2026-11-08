import {
    Component,
    computed,
    inject,
    input,
    type OnInit,
    output,
    signal,
} from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatButtonToggleModule } from '@angular/material/button-toggle'
import { MatDialogRef } from '@angular/material/dialog'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { ScreenHeaderComponent } from '@components/shared/screen-header/screen-header'
import { TagListElementComponent } from '@components/tag-list-element/tag-list-element.component'
import { TranslateModule } from '@ngx-translate/core'
import type { TagConfig } from '@osmgo/type'
import { FilterByByGeometryTypePipe } from '@pipes/filter-by-geometry-type.pipe'
import { FilterBySearchablePipe } from '@pipes/filter-by-searchable.pipe'
import { FilterByTagsContentPipe } from '@pipes/filterByTagsContent.pipe'
import { FilterDeprecatedTagPipe } from '@pipes/filterDeprecatedTag.pipe'
import { FilterExcludeTagByCountryCode } from '@pipes/filterExcludeTagByCountryCode.pipe'
import { FiltersTagsByIdsPipe } from '@pipes/filters-tags-by-ids.pipe'
import { LimitDisplayTagsPipe } from '@pipes/limit-display-tags.pipe'
import { SortArrayPipe } from '@pipes/sort-array.pipe'
import { ConfigService } from '@services/config.service'
import { CustomTagError, TagsService } from '@services/tags.service'

export const normalizeCustomValue = (text: string): string =>
    text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, '_')

@Component({
    selector: 'modal-primary-tag',
    templateUrl: './modal.primaryTag.html',
    styleUrls: ['./modal.primaryTag.scss'],
    imports: [
        FilterByByGeometryTypePipe,
        FilterBySearchablePipe,
        FilterByTagsContentPipe,
        FilterDeprecatedTagPipe,
        FilterExcludeTagByCountryCode,
        FiltersTagsByIdsPipe,
        LimitDisplayTagsPipe,
        MatButtonModule,
        MatButtonToggleModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatProgressSpinnerModule,
        ScreenHeaderComponent,
        SortArrayPipe,
        TagListElementComponent,
        TranslateModule,
    ],
})
export class ModalPrimaryTag implements OnInit {
    private readonly dialogRef = inject(MatDialogRef<ModalPrimaryTag>, {
        optional: true,
    })
    readonly tagsService = inject(TagsService)
    readonly configService = inject(ConfigService)

    private swipeStartX: number | null = null

    loading = true
    readonly searchText = signal('')
    readonly customValuesOpen = signal(false)
    readonly customValue = computed(() =>
        normalizeCustomValue(this.searchText())
    )
    readonly customValueError = signal<string | null>(null)
    currentListOfTags: TagConfig[] = []
    oldTagConfig: TagConfig | undefined
    geometriesPossible: string[] = []
    geometryType: 'point' | 'vertex' | 'line' | 'area' = 'point'
    displayType: 'lastTags' | 'bookmarks' = 'lastTags'
    countryTags = ''
    readonly tagConfigInput = input.required<TagConfig>({ alias: 'tagConfig' })
    readonly geometryTypeInput = input.required<
        'point' | 'vertex' | 'line' | 'area'
    >({ alias: 'geometryType' })
    readonly embedded = input(false)
    readonly completed = output<TagConfig | null>()

    ngOnInit(): void {
        this.displayType =
            this.configService.config().defaultPrimarykeyWindows == 'bookmarks'
                ? 'bookmarks'
                : 'lastTags'
        this.oldTagConfig = this.tagConfigInput()
        this.geometryType = this.geometryTypeInput()
        this.countryTags = this.configService.config().countryTags
        this.currentListOfTags = this.tagsService.tags()
        this.loading = false
    }

    onSearchInput(value: string): void {
        this.searchText.set(value)
        if (value.length <= 2) {
            this.customValuesOpen.set(false)
            this.customValueError.set(null)
        }
    }

    dismiss(data: TagConfig | null = null): void {
        if (this.embedded()) {
            this.completed.emit(data)
            return
        }
        this.dialogRef?.close(data)
    }

    summit(data: TagConfig): void {
        this.dismiss(data)
    }
    cancel(): void {
        this.dismiss()
    }

    selected(config: TagConfig): void {
        this.summit(config)
    }

    addBookmark(tag: TagConfig): void {
        this.tagsService.addBookMark(tag)
    }
    removeBookmark(tag: TagConfig): void {
        this.tagsService.removeBookMark(tag)
    }

    addCustomValue(key: string, value: string): void {
        this.customValueError.set(null)
        try {
            this.summit(this.tagsService.addCustomTag(key, value))
        } catch (error) {
            const code =
                error instanceof CustomTagError ? error.code : 'invalid'
            this.customValueError.set(
                code === 'collision'
                    ? 'MODAL_SELECTED_ITEM.CUSTOM_TAG_COLLISION'
                    : 'MODAL_SELECTED_ITEM.CUSTOM_TAG_INVALID'
            )
        }
    }

    startSwipe(event: PointerEvent): void {
        this.swipeStartX = event.clientX
    }

    endSwipe(event: PointerEvent): void {
        if (this.swipeStartX === null) {
            return
        }

        const distance = event.clientX - this.swipeStartX
        if (distance < -50) {
            this.displayType = 'bookmarks'
        } else if (distance > 50) {
            this.displayType = 'lastTags'
        }
        this.swipeStartX = null
    }

    cancelSwipe(): void {
        this.swipeStartX = null
    }

    changePageLastTagsBookmarks(value: 'lastTags' | 'bookmarks'): void {
        this.displayType = value
        this.configService.setDefaultPrimarykeyWindows(value)
    }
}
