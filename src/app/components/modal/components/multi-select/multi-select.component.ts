import {
    Component,
    computed,
    DestroyRef,
    inject,
    input,
    output,
    signal,
} from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MAX_OSM_TAG_LENGTH } from '@app/utils/osm-tags'
import { TranslateModule } from '@ngx-translate/core'
import type { Preset, PresetOption, Tag } from '@osmgo/type'
import {
    fieldValueSpelling,
    isCoveredByPreset,
    isEditableTagKey,
    isPrefixPreset,
    multiValueKey,
    searchText,
} from '../../editor-tag'
import { PendingFieldEntries } from '../../pending-field-entries'

/** Tags to write (`yes`, a raw value) or to remove (`null`). */
export type TagsPatch = Record<string, string | null>

interface MultiValueItem {
    key: string
    label: string
    value: string
    present: boolean
}

const COLLAPSED_ITEM_COUNT = 12

@Component({
    selector: 'app-multi-select',
    templateUrl: './multi-select.component.html',
    styleUrls: ['./multi-select.component.scss'],
    imports: [
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        TranslateModule,
    ],
})
export class MultiSelectComponent {
    readonly preset = input.required<Preset>()
    readonly tags = input.required<Tag[]>()
    readonly language = input('en')
    readonly displayCode = input(false)

    readonly tagsPatch = output<TagsPatch>()

    readonly maxLength = MAX_OSM_TAG_LENGTH
    readonly expanded = signal(false)
    readonly customValue = signal('')
    private readonly touchedKeys = signal<ReadonlySet<string>>(new Set())
    /** Values other than `yes` replaced by a tap, given back by the next taps. */
    private readonly replacedValues = new Map<string, string>()
    private readonly pendingEntries = inject(PendingFieldEntries, {
        optional: true,
    })

    constructor() {
        inject(DestroyRef).onDestroy(() => this.pendingEntries?.set(this, null))
    }

    readonly items = computed<MultiValueItem[]>(() => {
        const preset = this.preset()
        const language = this.language()
        const values = new Map<string, string>()
        for (const tag of this.tags()) {
            if (tag.key && isCoveredByPreset(preset, tag.key)) {
                values.set(tag.key, String(tag.value ?? '').trim())
            }
        }
        const items = (preset.options ?? []).map((option) => {
            const key = multiValueKey(preset, option.v)
            return {
                key,
                label: option.lbl?.[language] || option.lbl?.['en'] || option.v,
                value: values.get(key) ?? '',
                present: values.has(key),
            }
        })
        const listed = new Set(items.map((item) => item.key))
        const prefixLength = isPrefixPreset(preset)
            ? (preset.key ?? '').length
            : 0
        for (const [key, value] of values) {
            if (listed.has(key)) continue
            items.push({
                key,
                label: key.slice(prefixLength),
                value,
                present: true,
            })
        }
        return items
    })

    readonly visibleItems = computed(() => {
        const items = this.items()
        if (this.expanded() || items.length <= COLLAPSED_ITEM_COUNT) {
            return items
        }
        const touched = this.touchedKeys()
        return items.filter(
            (item, index) =>
                index < COLLAPSED_ITEM_COUNT ||
                item.value !== '' ||
                touched.has(item.key)
        )
    })

    readonly hiddenCount = computed(
        () => this.items().length - this.visibleItems().length
    )

    readonly canAddCustomValue = computed(
        () =>
            isPrefixPreset(this.preset()) &&
            this.preset().customValues !== false
    )

    get fieldLabel(): string {
        const preset = this.preset()
        return preset.lbl?.[this.language()] || preset.lbl?.['en'] || ''
    }

    get codeLabel(): string {
        const preset = this.preset()
        return isPrefixPreset(preset)
            ? `${preset.key}*`
            : (preset.keys ?? []).join(' · ')
    }

    itemLabel(item: MultiValueItem): string {
        return this.displayCode() ? item.key : item.label
    }

    ariaChecked(item: MultiValueItem): 'true' | 'false' | 'mixed' {
        if (item.value === 'yes') return 'true'
        return item.value === '' ? 'false' : 'mixed'
    }

    /** `no`, `only`… → `yes` → none → back to `no`: a tap never loses it. */
    toggle(item: MultiValueItem): void {
        this.touch(item.key)
        let value: string | null = 'yes'
        if (item.value === 'yes') {
            value = null
        } else if (item.value === '') {
            value = this.replacedValues.get(item.key) ?? 'yes'
        } else {
            this.replacedValues.set(item.key, item.value)
        }
        this.tagsPatch.emit({ [item.key]: value })
    }

    editValue(item: MultiValueItem, value: string): void {
        this.tagsPatch.emit({ [item.key]: value })
    }

    toggleExpanded(): void {
        this.expanded.update((expanded) => !expanded)
    }

    onCustomValueInput(value: string): void {
        this.customValue.set(value)
        const key = this.customValueKey()
        const pending =
            key !== null &&
            !this.items().some(
                (item) => item.key === key && item.value === 'yes'
            )
        this.pendingEntries?.set(
            this,
            pending ? () => this.addCustomValue() : null
        )
    }

    addCustomValue(): void {
        const key = this.customValueKey()
        this.pendingEntries?.set(this, null)
        if (key === null) return
        this.touch(key)
        this.customValue.set('')
        this.tagsPatch.emit({ [key]: 'yes' })
    }

    /** A listed option typed by its label (`Chèque`) keeps its own value. */
    private customValueKey(): string | null {
        const preset = this.preset()
        const text = this.customValue()
        const option = (preset.options ?? []).find(
            (candidate) =>
                candidate.v === text.trim() ||
                searchText(this.optionLabel(candidate)) === searchText(text)
        )
        const value = option ? option.v : fieldValueSpelling(preset, text)
        const key = value ? multiValueKey(preset, value) : ''
        return this.canAddCustomValue() && isEditableTagKey(key) ? key : null
    }

    private optionLabel(option: PresetOption): string {
        return option.lbl?.[this.language()] || option.lbl?.['en'] || option.v
    }

    private touch(key: string): void {
        this.touchedKeys.update((keys) => new Set([...keys, key]))
    }
}
