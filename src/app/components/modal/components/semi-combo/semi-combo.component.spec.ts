import { type ComponentFixture, TestBed } from '@angular/core/testing'
import { TranslateModule } from '@ngx-translate/core'
import type { Preset, Tag } from '@osmgo/type'
import { PendingFieldEntries } from '../../pending-field-entries'
import type { TagSelectionChange } from '../select/select.component'
import { SemiComboComponent, splitSemiComboValue } from './semi-combo.component'

describe('SemiComboComponent', () => {
    const cuisine: Preset = {
        _id: 'cuisine',
        key: 'cuisine',
        type: 'semiCombo',
        iDtype: 'semiCombo',
        lbl: { en: 'Cuisine', fr: 'Cuisine' },
        options: [
            { v: 'pizza', lbl: { en: 'Pizza', fr: 'Pizza' } },
            { v: 'italian', lbl: { en: 'Italian', fr: 'Italienne' } },
            { v: 'burger', lbl: { en: 'Burger', fr: 'Hamburger' } },
        ],
    }

    beforeEach(() => {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: [SemiComboComponent, TranslateModule.forRoot()],
        })
    })

    function render(
        tag: Tag,
        options: {
            preset?: Preset
            language?: string
            displayCode?: boolean
        } = {}
    ): {
        fixture: ComponentFixture<SemiComboComponent>
        changes: TagSelectionChange[]
    } {
        const fixture = TestBed.createComponent(SemiComboComponent)
        fixture.componentRef.setInput('preset', options.preset ?? cuisine)
        fixture.componentRef.setInput('tag', tag)
        fixture.componentRef.setInput('language', options.language ?? 'en')
        fixture.componentRef.setInput(
            'displayCode',
            options.displayCode ?? false
        )
        fixture.detectChanges()
        const changes: TagSelectionChange[] = []
        fixture.componentInstance.tagChange.subscribe((change) =>
            changes.push(change)
        )
        return { fixture, changes }
    }

    const values = (changes: TagSelectionChange[]): unknown[] =>
        changes.map((change) => change.tag.value)

    it('splits semicolon separated values', () => {
        expect(splitSemiComboValue(' pizza ; local_specialty;;')).toEqual([
            'pizza',
            'local_specialty',
        ])
        expect(splitSemiComboValue(undefined)).toEqual([])
    })

    it('shows every value, with its label or as written when it is not listed', () => {
        const { fixture } = render(
            { key: 'cuisine', value: 'pizza;local_specialty' },
            { language: 'fr' }
        )

        const chips = Array.from(
            fixture.nativeElement.querySelectorAll('.semi-combo-values li span')
        ).map((chip) => (chip as HTMLElement).textContent?.trim())
        expect(chips).toEqual(['Pizza', 'local_specialty'])
    })

    it('adds a suggested value and keeps the values not in the list', () => {
        const tag = { key: 'cuisine', value: 'pizza;local_specialty' }
        const { fixture, changes } = render(tag)

        fixture.componentInstance.onQueryInput('ital')
        fixture.detectChanges()
        const suggestion = fixture.nativeElement.querySelector(
            '.semi-combo-suggestion'
        ) as HTMLButtonElement
        expect(suggestion.textContent?.trim()).toContain('Italian')
        suggestion.click()

        expect(changes).toEqual([
            {
                source: tag,
                tag: {
                    key: 'cuisine',
                    value: 'pizza;local_specialty;italian',
                },
            },
        ])
        expect(fixture.componentInstance.query()).toBe('')
    })

    it('resolves a typed label to its value and spells free values like iD', () => {
        const { fixture, changes } = render({ key: 'cuisine', value: '' })

        fixture.componentInstance.onQueryInput('Hamburger')
        fixture.componentInstance.addQuery()
        fixture.componentInstance.onQueryInput('Local Specialty; pizza')
        fixture.componentInstance.addQuery()

        expect(values(changes)).toEqual(['hamburger', 'local_specialty;pizza'])
    })

    it('matches a translated label', () => {
        const { fixture, changes } = render(
            { key: 'cuisine', value: '' },
            { language: 'fr' }
        )

        fixture.componentInstance.onQueryInput('hamburger')
        fixture.componentInstance.addQuery()

        expect(values(changes)).toEqual(['burger'])
    })

    it('does not add a value twice', () => {
        const { fixture, changes } = render({ key: 'cuisine', value: 'pizza' })

        fixture.componentInstance.addValue('pizza')

        expect(changes).toEqual([])
    })

    it('removes one value and keeps the others as written', () => {
        const { fixture, changes } = render({
            key: 'cuisine',
            value: 'pizza;local_specialty;italian',
        })

        const remove = fixture.nativeElement.querySelectorAll(
            '.semi-combo-values button'
        )[0] as HTMLButtonElement
        remove.click()

        expect(values(changes)).toEqual(['local_specialty;italian'])
    })

    it('only accepts listed values when the field refuses custom values', () => {
        const { fixture, changes } = render(
            { key: 'cuisine', value: '' },
            { preset: { ...cuisine, customValues: false } }
        )

        fixture.componentInstance.onQueryInput('local')
        fixture.componentInstance.addQuery()
        fixture.componentInstance.onQueryInput('Pizza')
        fixture.componentInstance.addQuery()

        expect(values(changes)).toEqual(['pizza'])
    })

    it('suggests the first values while the field is empty only', () => {
        const empty = render({ key: 'cuisine', value: '' })
        expect(empty.fixture.componentInstance.suggestions()).toHaveLength(3)

        const filled = render({ key: 'cuisine', value: 'pizza' })
        expect(filled.fixture.componentInstance.suggestions()).toEqual([])
    })

    it('edits the raw value in code mode', () => {
        const { fixture, changes } = render(
            { key: 'cuisine', value: 'pizza;italian' },
            { displayCode: true }
        )

        const input = fixture.nativeElement.querySelector(
            'input'
        ) as HTMLInputElement
        expect(input.value).toBe('pizza;italian')
        input.value = 'pizza'
        input.dispatchEvent(new Event('input'))

        expect(values(changes)).toEqual(['pizza'])
    })

    describe('text typed without the add button', () => {
        function renderWithPending(tag: Tag) {
            const pending = new PendingFieldEntries()
            TestBed.configureTestingModule({
                providers: [
                    { provide: PendingFieldEntries, useValue: pending },
                ],
            })
            return { ...render(tag), pending }
        }

        it('is reported as pending and added on commit', () => {
            const { fixture, changes, pending } = renderWithPending({
                key: 'cuisine',
                value: 'pizza',
            })

            expect(pending.count()).toBe(0)
            fixture.componentInstance.onQueryInput('Burger')
            expect(pending.count()).toBe(1)

            pending.commitAll()

            expect(values(changes)).toEqual(['pizza;burger'])
            expect(pending.count()).toBe(0)
            expect(fixture.componentInstance.query()).toBe('')
        })

        it('is not pending when it is already a value or is cleared', () => {
            const { fixture, pending } = renderWithPending({
                key: 'cuisine',
                value: 'pizza',
            })

            fixture.componentInstance.onQueryInput('Pizza')
            expect(pending.count()).toBe(0)
            fixture.componentInstance.onQueryInput('thai')
            expect(pending.count()).toBe(1)
            fixture.componentInstance.onQueryInput('  ')
            expect(pending.count()).toBe(0)
        })

        it('stops being pending once the field is removed', () => {
            const { fixture, pending } = renderWithPending({
                key: 'cuisine',
                value: '',
            })

            fixture.componentInstance.onQueryInput('thai')
            fixture.destroy()

            expect(pending.count()).toBe(0)
        })
    })

    it('names its field in the label of the add box', () => {
        const { fixture } = render({ key: 'cuisine', value: '' })

        const input: HTMLInputElement = fixture.nativeElement.querySelector(
            '.semi-combo-add input'
        )
        expect(input.getAttribute('aria-label')).toContain('ADD_VALUE_TO')
    })
})
