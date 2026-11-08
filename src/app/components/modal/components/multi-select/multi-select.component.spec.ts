import { type ComponentFixture, TestBed } from '@angular/core/testing'
import { TranslateModule } from '@ngx-translate/core'
import type { Preset, Tag } from '@osmgo/type'
import { PendingFieldEntries } from '../../pending-field-entries'
import { MultiSelectComponent, type TagsPatch } from './multi-select.component'

describe('MultiSelectComponent', () => {
    const payment: Preset = {
        _id: 'payment_multi',
        key: 'payment:',
        type: 'multiCombo',
        iDtype: 'multiCombo',
        lbl: { en: 'Payment methods', fr: 'Moyens de paiement' },
        options: [
            { v: 'cash', lbl: { en: 'Cash', fr: 'Espèces' } },
            { v: 'cards', lbl: { en: 'Cards' } },
            { v: 'visa', lbl: { en: 'Visa' } },
        ],
    }
    const gender: Preset = {
        _id: 'gender',
        keys: ['male', 'female', 'unisex'],
        type: 'manyCombo',
        iDtype: 'manyCombo',
        lbl: { en: 'Gender' },
        options: [
            { v: 'male', lbl: { en: 'Male' } },
            { v: 'female', lbl: { en: 'Female' } },
            { v: 'unisex', lbl: { en: 'Unisex' } },
        ],
    }

    beforeEach(() => {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: [MultiSelectComponent, TranslateModule.forRoot()],
        })
    })

    function render(
        preset: Preset,
        tags: Tag[],
        options: { language?: string; displayCode?: boolean } = {}
    ): {
        fixture: ComponentFixture<MultiSelectComponent>
        patches: TagsPatch[]
    } {
        const fixture = TestBed.createComponent(MultiSelectComponent)
        fixture.componentRef.setInput('preset', preset)
        fixture.componentRef.setInput('tags', tags)
        fixture.componentRef.setInput('language', options.language ?? 'en')
        fixture.componentRef.setInput(
            'displayCode',
            options.displayCode ?? false
        )
        fixture.detectChanges()
        const patches: TagsPatch[] = []
        fixture.componentInstance.tagsPatch.subscribe((patch) =>
            patches.push(patch)
        )
        return { fixture, patches }
    }

    const buttons = (
        fixture: ComponentFixture<MultiSelectComponent>
    ): HTMLButtonElement[] =>
        Array.from(
            fixture.nativeElement.querySelectorAll('.multi-select-option')
        )

    const label = (button: HTMLButtonElement | undefined): string | undefined =>
        button?.querySelector('span')?.textContent?.trim()

    it('shows every option as a checkbox with its translated label', () => {
        const { fixture } = render(
            payment,
            [{ key: 'payment:cash', value: 'yes' }],
            { language: 'fr' }
        )

        const options = buttons(fixture)
        expect(options.map(label)).toEqual(['Espèces', 'Cards', 'Visa'])
        expect(options.map((button) => button.getAttribute('role'))).toEqual([
            'checkbox',
            'checkbox',
            'checkbox',
        ])
        expect(
            options.map((button) => button.getAttribute('aria-checked'))
        ).toEqual(['true', 'false', 'false'])
        expect(
            fixture.nativeElement.querySelector('[role="group"]')
        ).not.toBeNull()
    })

    it('writes prefix + option = yes when an option is checked', () => {
        const { fixture, patches } = render(payment, [])

        buttons(fixture)[1].click()

        expect(patches).toEqual([{ 'payment:cards': 'yes' }])
    })

    it('removes the tag when a checked option is unchecked', () => {
        const { fixture, patches } = render(payment, [
            { key: 'payment:cash', value: 'yes' },
        ])

        buttons(fixture)[0].click()

        expect(patches).toEqual([{ 'payment:cash': null }])
    })

    it('shows a value other than yes as it is, without changing it', () => {
        const { fixture, patches } = render(payment, [
            { key: 'payment:visa', value: 'no' },
        ])

        const visa = buttons(fixture)[2]
        expect(visa.getAttribute('aria-checked')).toBe('mixed')
        expect(visa.querySelector('small')?.textContent).toBe('no')
        expect(patches).toEqual([])
    })

    it('lists a tag of the prefix that is not an option', () => {
        const { fixture } = render(payment, [
            { key: 'payment:twint', value: 'yes' },
            { key: 'name', value: 'Bakery' },
        ])

        const labels = buttons(fixture).map(label)
        expect(labels).toEqual(['Cash', 'Cards', 'Visa', 'twint'])
    })

    it('adds a value typed by the user under the prefix', () => {
        const { fixture, patches } = render(payment, [])

        fixture.componentInstance.onCustomValueInput('  Twint Pay ')
        fixture.componentInstance.addCustomValue()

        expect(patches).toEqual([{ 'payment:twint_pay': 'yes' }])
        expect(fixture.componentInstance.customValue()).toBe('')
    })

    it('never writes an incomplete key from a typed value', () => {
        const { fixture, patches } = render(payment, [])

        fixture.componentInstance.onCustomValueInput('visa:')
        fixture.componentInstance.addCustomValue()
        fixture.componentInstance.onCustomValueInput('   ')
        fixture.componentInstance.addCustomValue()

        expect(patches).toEqual([])
    })

    it('writes each option key = yes for a field made of several keys', () => {
        const { fixture, patches } = render(gender, [
            { key: 'male', value: 'yes' },
        ])

        expect(
            buttons(fixture).map((button) =>
                button.getAttribute('aria-checked')
            )
        ).toEqual(['true', 'false', 'false'])
        buttons(fixture)[1].click()
        buttons(fixture)[0].click()

        expect(patches).toEqual([{ female: 'yes' }, { male: null }])
        expect(
            fixture.nativeElement.querySelector('.multi-select-custom')
        ).toBeNull()
    })

    it('edits the raw value of the tags in code mode', () => {
        const { fixture, patches } = render(
            payment,
            [{ key: 'payment:cash', value: 'yes' }],
            { displayCode: true }
        )

        const input = fixture.nativeElement.querySelector(
            '.multi-select-code input'
        ) as HTMLInputElement
        expect(input.value).toBe('yes')
        input.value = 'only'
        input.dispatchEvent(new Event('input'))

        expect(patches).toEqual([{ 'payment:cash': 'only' }])
        expect(buttons(fixture).map(label)).toEqual([
            'payment:cards',
            'payment:visa',
        ])
    })

    it('folds a long list but keeps the options in use visible', () => {
        const options = Array.from({ length: 20 }, (_value, index) => ({
            v: `method${index}`,
            lbl: { en: `Method ${index}` },
        }))
        const { fixture } = render({ ...payment, options }, [
            { key: 'payment:method18', value: 'yes' },
        ])

        expect(buttons(fixture)).toHaveLength(13)
        expect(label(buttons(fixture).at(-1))).toBe('Method 18')

        fixture.componentInstance.toggleExpanded()
        fixture.detectChanges()

        expect(buttons(fixture)).toHaveLength(20)
    })

    it('gives every option a touch target of at least 44 pixels', () => {
        const { fixture } = render(payment, [])

        const style = getComputedStyle(buttons(fixture)[0])
        expect(style.minHeight).toBe('44px')
        expect(style.minWidth).toBe('44px')
    })

    describe('a value other than yes', () => {
        it('comes back after yes and none instead of being lost', () => {
            const tags: Tag[] = [{ key: 'payment:visa', value: 'no' }]
            const { fixture, patches } = render(payment, tags)
            const visa = () =>
                fixture.componentInstance
                    .items()
                    .find((item) => item.key === 'payment:visa')
            const tap = () => {
                const item = visa()
                if (!item) throw new Error('Missing visa.')
                fixture.componentInstance.toggle(item)
                const value = patches.at(-1)?.['payment:visa']
                fixture.componentRef.setInput(
                    'tags',
                    value ? [{ key: 'payment:visa', value }] : []
                )
                fixture.detectChanges()
            }

            tap()
            tap()
            tap()
            tap()

            expect(patches).toEqual([
                { 'payment:visa': 'yes' },
                { 'payment:visa': null },
                { 'payment:visa': 'no' },
                { 'payment:visa': 'yes' },
            ])
        })
    })

    it('writes the option of a typed translated label', () => {
        const cheque: Preset = {
            ...payment,
            options: [
                ...(payment.options ?? []),
                { v: 'cheque', lbl: { en: 'Cheque', fr: 'Chèque' } },
            ],
        }
        const { fixture, patches } = render(cheque, [], { language: 'fr' })

        fixture.componentInstance.onCustomValueInput('Chèque')
        fixture.componentInstance.addCustomValue()
        fixture.componentInstance.onCustomValueInput('especes')
        fixture.componentInstance.addCustomValue()

        expect(patches).toEqual([
            { 'payment:cheque': 'yes' },
            { 'payment:cash': 'yes' },
        ])
    })

    it('reports a typed custom value as pending until it is added', () => {
        const pending = new PendingFieldEntries()
        TestBed.configureTestingModule({
            providers: [{ provide: PendingFieldEntries, useValue: pending }],
        })
        const { fixture, patches } = render(payment, [
            { key: 'payment:cash', value: 'yes' },
        ])

        fixture.componentInstance.onCustomValueInput('Cash')
        expect(pending.count()).toBe(0)
        fixture.componentInstance.onCustomValueInput('Twint')
        expect(pending.count()).toBe(1)

        pending.commitAll()

        expect(patches).toEqual([{ 'payment:twint': 'yes' }])
        expect(pending.count()).toBe(0)
    })
})
