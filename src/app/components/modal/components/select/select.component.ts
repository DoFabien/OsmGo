import { Component, input, output } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { TranslateModule } from '@ngx-translate/core'
import type { Preset, Tag } from '@osmgo/type'
import { DisplayPresetLabelPipe } from '@pipes/displayPresetLabel.pipe'
import { isMultiKeyPreset } from '../../editor-tag'

export interface TagSelectionChange {
    source: Tag
    tag: Tag
}

@Component({
    selector: 'app-select',
    templateUrl: './select.component.html',
    styleUrls: ['./select.component.scss', '../style.scss'],
    imports: [
        DisplayPresetLabelPipe,
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatSelectModule,
        TranslateModule,
    ],
})
export class SelectComponent {
    readonly displayCode = input(false)
    readonly tag = input.required<Tag>()
    readonly preset = input.required<Preset>()
    readonly language = input('en')

    readonly addTags = output<Record<string, string>>()
    readonly tagChange = output<TagSelectionChange>()

    get isMultiKeyPreset(): boolean {
        return isMultiKeyPreset(this.preset())
    }

    get fieldLabel(): string {
        const preset = this.preset()
        return (
            preset.lbl?.[this.language()] ||
            preset.lbl?.['en'] ||
            preset.key ||
            preset.keys?.join(' · ') ||
            ''
        )
    }

    get codeLabel(): string {
        const preset = this.preset()
        return preset.key || this.tag().key || preset.keys?.join(' · ') || ''
    }

    get selectedValue(): string | number {
        return this.isMultiKeyPreset
            ? this.tag().value === 'yes'
                ? this.tag().key
                : ''
            : this.tag().value
    }

    selectChange(newValue: string): void {
        const source = this.tag()
        let nextTag: Tag
        if (this.isMultiKeyPreset) {
            const selectedKey = (this.preset().keys ?? []).includes(newValue)
                ? newValue
                : ''
            nextTag = {
                ...source,
                key: selectedKey,
                value: selectedKey ? 'yes' : '',
            }
        } else {
            nextTag = { ...source, value: newValue }
        }
        this.tagChange.emit({ source, tag: nextTag })

        const currentPresetOption = this.preset().options?.find(
            (po) => po.v == newValue
        )
        const extraTags = currentPresetOption?.tags
        if (extraTags) {
            this.addTags.emit(extraTags)
        }
    }

    valueChange(value: string | number): void {
        const source = this.tag()
        this.tagChange.emit({
            source,
            tag: { ...source, value: String(value) },
        })
    }
}
