import { Component, computed, inject, input, signal } from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatDialogRef } from '@angular/material/dialog'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import type { Preset } from '@osmgo/type'
import { nameToOsmKey, osmTagKeyToPresetId } from '@osmgo/utils'
import { FilterByListPipe } from '@pipes/filterByList.pipe'
import { FilterPresetsByListPipe } from '@pipes/filterPresetsByList.pipe'
import { RemoveBrandsPipe } from '@pipes/removeBrands.pipe'
import { SearchForPipe } from '@pipes/searchFor.pipe'
import { ConfigService } from '@services/config.service'
import { TagsService } from '@services/tags.service'
import {
    isEditablePreset,
    isEditableTagKey,
    isMultiValuePreset,
    isPrefixPreset,
} from '../editor-tag'

export interface AddTagSelection {
    key: string
    presetId?: string
}

@Component({
    selector: 'modal-add-tag',
    templateUrl: './modal.addTag.html',
    styleUrls: ['./modal.addTag.scss'],
    imports: [
        FilterByListPipe,
        FilterPresetsByListPipe,
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        RemoveBrandsPipe,
        SearchForPipe,
        TranslateModule,
    ],
})
export class ModalAddTag {
    private readonly dialogRef = inject(MatDialogRef<ModalAddTag>)
    readonly tagsService = inject(TagsService)
    readonly configService = inject(ConfigService)
    readonly translate = inject(TranslateService)

    readonly moreFields = input<string[]>([])
    readonly usedList = input<string[]>([])

    readonly language = this.configService.config().languageTags
    readonly countryCode = this.configService.config().countryTags

    readonly presets: Array<Preset> = Object.values(
        this.tagsService.presets()
    ).filter(isEditablePreset)
    readonly fields = computed(() =>
        this.moreFields().filter((id) =>
            isEditablePreset(this.tagsService.presets()[id])
        )
    )
    readonly searchFilter = signal('')
    readonly customKey = computed(() => nameToOsmKey(this.searchFilter()))
    /** The field of the typed key, also when the keyboard capitalized it. */
    readonly customPreset = computed(() => {
        const presets = this.tagsService.presets()
        const presetId = osmTagKeyToPresetId(this.customKey())
        const preset = presets[presetId] ?? presets[presetId.toLowerCase()]
        return isEditablePreset(preset) ? preset : undefined
    })
    readonly customKeyIsAvailable = computed(() => {
        const used = this.usedList()
        const presetId = this.customPreset()?._id
        return (
            isEditableTagKey(this.customKey()) &&
            !used.includes(this.customKey()) &&
            !(presetId && used.includes(presetId))
        )
    })

    onSearchInput(value: string): void {
        this.searchFilter.set(value)
    }

    dismiss(data: AddTagSelection | null = null): void {
        this.dialogRef.close(data)
    }

    selectPreset(presetId: string): void {
        const preset = this.tagsService.presets()[presetId]
        if (!isEditablePreset(preset)) return
        this.dismiss({
            key: isMultiValuePreset(preset) ? '' : (preset.key ?? ''),
            presetId,
        })
    }

    selectCustomKey(): void {
        const preset = this.customPreset()
        if (preset) {
            this.selectPreset(preset._id)
            return
        }
        if (!this.customKeyIsAvailable()) return
        this.dismiss({ key: this.customKey() })
    }

    keyLabel(preset: Preset | undefined): string {
        if (!preset) return ''
        if (isPrefixPreset(preset)) return `${preset.key}*`
        return preset.key || preset.keys?.join(', ') || preset._id
    }

    label(preset: Preset | undefined): string {
        if (!preset) return ''
        return (
            preset.lbl?.[this.language] ||
            preset.lbl?.['en'] ||
            preset.key ||
            preset._id
        )
    }
}
