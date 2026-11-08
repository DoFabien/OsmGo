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
import { fieldValueSpelling, searchText } from '../../editor-tag'
import { PendingFieldEntries } from '../../pending-field-entries'
import type { TagSelectionChange } from '../select/select.component'

const SUGGESTION_COUNT = 8
const EMPTY_FIELD_SUGGESTION_COUNT = 6

/** `pizza; italian` → `['pizza', 'italian']`, every value kept as written. */
export const splitSemiComboValue = (value: unknown): string[] =>
    String(value ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part !== '')

@Component({
    selector: 'app-semi-combo',
    templateUrl: './semi-combo.component.html',
    styleUrls: ['./semi-combo.component.scss'],
    imports: [
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        TranslateModule,
    ],
})
export class SemiComboComponent {
    readonly tag = input.required<Tag>()
    readonly preset = input.required<Preset>()
    readonly language = input('en')
    readonly displayCode = input(false)

    readonly tagChange = output<TagSelectionChange>()

    readonly maxLength = MAX_OSM_TAG_LENGTH
    readonly query = signal('')
    private readonly pendingEntries = inject(PendingFieldEntries, {
        optional: true,
    })

    constructor() {
        inject(DestroyRef).onDestroy(() => this.pendingEntries?.set(this, null))
    }

    get fieldLabel(): string {
        const preset = this.preset()
        return preset.lbl?.[this.language()] || preset.lbl?.['en'] || ''
    }

    readonly values = computed(() => splitSemiComboValue(this.tag().value))

    get canAddCustomValue(): boolean {
        return this.preset().customValues !== false
    }

    readonly suggestions = computed<PresetOption[]>(() => {
        const values = this.values()
        const query = searchText(this.query())
        const available = (this.preset().options ?? []).filter(
            (option) => option.v !== '' && !values.includes(option.v)
        )
        if (query === '') {
            return values.length === 0
                ? available.slice(0, EMPTY_FIELD_SUGGESTION_COUNT)
                : []
        }
        return available
            .filter(
                (option) =>
                    searchText(this.optionLabel(option)).includes(query) ||
                    searchText(option.v).includes(query)
            )
            .slice(0, SUGGESTION_COUNT)
    })

    optionLabel(option: PresetOption): string {
        return option.lbl?.[this.language()] || option.lbl?.['en'] || option.v
    }

    valueLabel(value: string): string {
        if (this.displayCode()) return value
        const option = this.preset().options?.find(
            (candidate) => candidate.v === value
        )
        return option ? this.optionLabel(option) : value
    }

    onQueryInput(value: string): void {
        this.query.set(value)
        const pending = this.queryValues().some(
            (typed) => !this.values().includes(typed)
        )
        this.pendingEntries?.set(this, pending ? () => this.addQuery() : null)
    }

    addQuery(): void {
        const values = this.queryValues()
        this.pendingEntries?.set(this, null)
        if (values.length === 0) return
        this.addValues(values)
    }

    private queryValues(): string[] {
        return splitSemiComboValue(this.query())
            .map((text) => this.typedValue(text))
            .filter((value) => value !== '')
    }

    addValue(value: string): void {
        this.addValues([value])
    }

    removeValue(index: number): void {
        this.emitValue(
            this.values()
                .filter((_value, position) => position !== index)
                .join(';')
        )
    }

    private typedValue(text: string): string {
        const option = (this.preset().options ?? []).find(
            (candidate) =>
                candidate.v === text ||
                searchText(this.optionLabel(candidate)) === searchText(text)
        )
        if (option) return option.v
        return this.canAddCustomValue
            ? fieldValueSpelling(this.preset(), text)
            : ''
    }

    private addValues(newValues: string[]): void {
        const values = this.values()
        this.query.set('')
        this.pendingEntries?.set(this, null)
        const added = newValues.filter(
            (value, index) =>
                !values.includes(value) && newValues.indexOf(value) === index
        )
        if (added.length === 0) return
        this.emitValue([...values, ...added].join(';'))
    }

    editRawValue(value: string): void {
        this.emitValue(value)
    }

    private emitValue(value: string): void {
        const source = this.tag()
        this.tagChange.emit({ source, tag: { ...source, value } })
    }
}
