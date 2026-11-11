import { Component, input, output } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MAX_OSM_TAG_LENGTH } from '@app/utils/osm-tags'
import { isSafeExternalUrl } from '@app/utils/safe-external-url'
import { TranslateModule } from '@ngx-translate/core'
import type { Preset, Tag } from '@osmgo/type'
import { DisplayPresetLabelPipe } from '@pipes/displayPresetLabel.pipe'
import {
    isEditablePreset,
    isMultiKeyPreset,
    isMultiValuePreset,
} from '../../editor-tag'
import {
    MultiSelectComponent,
    type TagsPatch,
} from '../multi-select/multi-select.component'
import { OpeningHoursComponent } from '../opening-hours/opening-hours.component'
import type { TagSelectionChange } from '../select/select.component'
import { SelectComponent } from '../select/select.component'
import { SemiComboComponent } from '../semi-combo/semi-combo.component'

@Component({
    selector: 'edit-presets',
    styleUrls: ['Presets.component.scss'],
    templateUrl: './Presets.component.html',
    imports: [
        DisplayPresetLabelPipe,
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MultiSelectComponent,
        OpeningHoursComponent,
        SelectComponent,
        SemiComboComponent,
        TranslateModule,
    ],
})
export class EditPresets {
    readonly displayCode = input(false)
    readonly tag = input.required<Tag>()
    readonly language = input('en')
    readonly preset = input.required<Preset>()
    /** Every tag of the object, for the fields that write several tags. */
    readonly tags = input<Tag[]>([])

    readonly openPrimaryListModal = output<unknown>()
    readonly addTags = output<Record<string, string>>()
    readonly tagChange = output<TagSelectionChange>()
    readonly tagsPatch = output<TagsPatch>()

    readonly maxLength = MAX_OSM_TAG_LENGTH

    get isMultiKeyPreset(): boolean {
        return isMultiKeyPreset(this.preset())
    }

    get isMultiValuePreset(): boolean {
        return isMultiValuePreset(this.preset())
    }

    get isEditable(): boolean {
        return isEditablePreset(this.preset())
    }

    get fieldLabel(): string {
        const preset = this.preset()
        return preset.lbl?.[this.language()] || preset.lbl?.['en'] || ''
    }

    /** A number field stays a text input: `ele=120 m` or `NE` are kept. */
    get inputType(): string {
        const type = this.preset().type
        return type === 'number' ? 'text' : type || 'text'
    }

    /** Positive integers (seats, levels…) get a digit keypad; `layer=-1` needs the minus. */
    get inputMode(): string | null {
        const preset = this.preset()
        if (preset.type !== 'number') return null
        return preset.iDtype === 'integer' && (preset.minValue ?? -1) >= 0
            ? 'numeric'
            : 'decimal'
    }

    get valueLimitReached(): boolean {
        return String(this.tag().value ?? '').length >= this.maxLength
    }

    editValue(value: string): void {
        this.tag().value =
            this.preset().type === 'number' && /^-?\d+,\d*$/.test(value.trim())
                ? value.replace(',', '.')
                : value
    }

    get canOpenLink(): boolean {
        return isSafeExternalUrl(this.tag().value)
    }

    get openingHoursValue(): string {
        return String(this.tag().value ?? '')
    }

    emitOpenModal(tag: Tag): void {
        if (!this.displayCode() && this.preset().type === 'list') {
            this.openPrimaryListModal.emit(tag)
        }
    }
}
