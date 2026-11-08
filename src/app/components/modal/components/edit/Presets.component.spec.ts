import { type ComponentFixture, TestBed } from '@angular/core/testing'
import { By } from '@angular/platform-browser'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import type { Preset, Tag } from '@osmgo/type'
import { isEditablePreset, isMultiKeyPreset } from '../../editor-tag'
import { MultiSelectComponent } from '../multi-select/multi-select.component'
import { SelectComponent } from '../select/select.component'
import { SemiComboComponent } from '../semi-combo/semi-combo.component'
import { EditPresets } from './Presets.component'

const catalogPresets: Record<
    string,
    Preset
> = require('../../../../../assets/tagsAndPresets/presets.json')
for (const [id, preset] of Object.entries(catalogPresets)) {
    preset._id = id
}

describe('EditPresets', () => {
    beforeEach(() => {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: [EditPresets, TranslateModule.forRoot()],
        })
    })

    function render(
        preset: Preset,
        tag: Tag,
        displayCode = false
    ): ComponentFixture<EditPresets> {
        const fixture = TestBed.createComponent(EditPresets)
        fixture.componentRef.setInput('preset', preset)
        fixture.componentRef.setInput('tag', tag)
        fixture.componentRef.setInput('displayCode', displayCode)
        fixture.detectChanges()
        return fixture
    }

    it('uses the select editor for a multi-key preset without a primary key', () => {
        const fixture = TestBed.createComponent(EditPresets)
        fixture.componentRef.setInput('preset', {
            type: 'text',
            iDtype: 'manyCombo',
            keys: ['male', 'female', 'unisex'],
            options: [{ v: 'male' }, { v: 'female' }, { v: 'unisex' }],
        })
        const component = fixture.componentInstance

        expect(component.isMultiKeyPreset).toBe(true)
    })

    it('keeps the normal editor for a field with one primary key', () => {
        const fixture = TestBed.createComponent(EditPresets)
        fixture.componentRef.setInput('preset', {
            key: 'phone',
            keys: ['phone', 'contact:phone'],
            type: 'tel',
        })
        const component = fixture.componentInstance

        expect(component.isMultiKeyPreset).toBe(false)
    })

    describe('with the real preset catalog', () => {
        it('shows the gender field of toilets with male=yes and lets female be added', () => {
            const preset = catalogPresets['gender']
            expect(preset.type).toBe('manyCombo')
            const fixture = TestBed.createComponent(EditPresets)
            fixture.componentRef.setInput('preset', preset)
            fixture.componentRef.setInput('tag', {
                key: '',
                value: '',
                preset,
            })
            fixture.componentRef.setInput('tags', [
                { key: 'amenity', value: 'toilets' },
                { key: 'male', value: 'yes' },
            ])
            fixture.detectChanges()

            const field = fixture.nativeElement.querySelector(
                '.multi-select-field'
            )
            expect(field.textContent).toContain('Gender')
            expect(fixture.nativeElement.textContent).not.toContain('yes')
            expect(
                fixture.debugElement.query(By.directive(SelectComponent))
            ).toBeNull()

            const patches: unknown[] = []
            fixture.componentInstance.tagsPatch.subscribe((patch) =>
                patches.push(patch)
            )
            const multiSelect = fixture.debugElement.query(
                By.directive(MultiSelectComponent)
            ).componentInstance as MultiSelectComponent
            const female = multiSelect
                .items()
                .find((item) => item.key === 'female')
            if (!female) throw new Error('Missing female option.')
            multiSelect.toggle(female)

            expect(patches).toEqual([{ female: 'yes' }])
        })

        it('edits the payment methods with checkboxes', () => {
            const preset = catalogPresets['payment_multi']
            const fixture = TestBed.createComponent(EditPresets)
            fixture.componentRef.setInput('preset', preset)
            fixture.componentRef.setInput('tag', {
                key: '',
                value: '',
                preset,
            })
            fixture.componentRef.setInput('tags', [
                { key: 'payment:cash', value: 'yes' },
            ])
            fixture.componentRef.setInput('language', 'fr')
            fixture.detectChanges()

            const checked = fixture.nativeElement.querySelector(
                '[role="checkbox"][aria-checked="true"]'
            )
            expect(checked?.querySelector('span')?.textContent?.trim()).toBe(
                'Liquide'
            )
        })

        it('edits the cuisine as several values', () => {
            const preset = catalogPresets['cuisine']
            const fixture = render(preset, {
                key: 'cuisine',
                value: 'pizza;local_specialty',
                preset,
            })

            expect(
                fixture.debugElement.query(By.directive(SemiComboComponent))
            ).not.toBeNull()
            expect(
                fixture.nativeElement.querySelectorAll('.semi-combo-values li')
            ).toHaveLength(2)
        })

        it('renders a field for every editable preset', () => {
            const empty: string[] = []
            const first = Object.values(catalogPresets)[0]
            const fixture = render(first, { key: '', value: '' })
            for (const preset of Object.values(catalogPresets)) {
                if (!isEditablePreset(preset)) continue
                fixture.componentRef.setInput('tag', {
                    key: preset.key ?? '',
                    value: '',
                    preset,
                })
                fixture.componentRef.setInput('preset', preset)
                fixture.detectChanges()
                if (!fixture.nativeElement.querySelector('article')) {
                    empty.push(preset._id)
                }
            }

            expect(empty).toEqual([])
        }, 60_000)

        it('treats every multi-key preset as editable', () => {
            const multiKey =
                Object.values(catalogPresets).filter(isMultiKeyPreset)

            expect(multiKey.length).toBeGreaterThanOrEqual(8)
            expect(multiKey.every(isEditablePreset)).toBe(true)
        })
    })

    describe('prefix presets', () => {
        const payment: Preset = {
            _id: 'payment_multi',
            key: 'payment:',
            type: 'text',
            iDtype: 'multiCombo',
            lbl: { en: 'Accepted Payments' },
        }

        it('renders the checkboxes of a multiCombo prefix field', () => {
            const multiCombo: Preset = {
                ...payment,
                type: 'multiCombo',
                options: [{ v: 'cash', lbl: { en: 'Cash' } }],
            }
            const fixture = render(multiCombo, {
                key: '',
                value: '',
                preset: multiCombo,
            })

            expect(isEditablePreset(multiCombo)).toBe(true)
            expect(
                fixture.nativeElement.querySelector('[role="checkbox"]')
                    ?.textContent
            ).toContain('Cash')
        })

        it('renders nothing for a key that ends with a colon', () => {
            const fixture = render(payment, {
                key: 'payment:',
                value: '',
                preset: payment,
            })

            expect(fixture.nativeElement.querySelector('article')).toBeNull()
            expect(fixture.nativeElement.querySelector('input')).toBeNull()
            expect(isEditablePreset(payment)).toBe(false)
        })
    })

    describe('text fields', () => {
        const website: Preset = {
            _id: 'website',
            key: 'website',
            type: 'url',
            lbl: { en: 'Website' },
        }
        const note: Preset = {
            _id: 'description',
            key: 'description',
            type: 'text',
            lbl: { en: 'Description' },
        }

        it('limits the length and does not echo the raw OSM key as placeholder', () => {
            const fixture = render(note, { key: 'description', value: '' })
            const input = fixture.nativeElement.querySelector(
                'input'
            ) as HTMLInputElement

            expect(input.getAttribute('maxlength')).toBe('255')
            expect(input.getAttribute('placeholder')).toBeNull()
            expect(input.getAttribute('aria-label')).toBe('Description')
        })

        describe('a number field', () => {
            const level: Preset = {
                _id: 'level',
                key: 'level',
                type: 'number',
                lbl: { en: 'Level' },
            }
            const typeIn = (
                fixture: ComponentFixture<EditPresets>,
                text: string
            ): void => {
                const input = fixture.nativeElement.querySelector(
                    'input'
                ) as HTMLInputElement
                input.value = text
                input.dispatchEvent(new Event('input'))
                fixture.detectChanges()
            }

            it('is a text input with a decimal keyboard', () => {
                const fixture = render(level, { key: 'level', value: 2 })
                const input = fixture.nativeElement.querySelector(
                    'input'
                ) as HTMLInputElement

                expect(input.type).toBe('text')
                expect(input.getAttribute('inputmode')).toBe('decimal')
                expect(input.getAttribute('maxlength')).toBe('255')
            })

            it.each(['120 m', 'NE', '1;2'])(
                'keeps the value %s that is not a number',
                async (value) => {
                    const tag: Tag = { key: 'ele', value }
                    const fixture = render(level, tag)
                    await fixture.whenStable()
                    const input = fixture.nativeElement.querySelector(
                        'input'
                    ) as HTMLInputElement

                    expect(input.value).toBe(value)
                    typeIn(fixture, `${value}!`)
                    expect(tag.value).toBe(`${value}!`)
                }
            )

            it('turns a typed decimal comma into a point', () => {
                const tag: Tag = { key: 'height', value: '' }
                const fixture = render(level, tag)

                typeIn(fixture, '12,5')

                expect(tag.value).toBe('12.5')
            })
        })

        it('names the field on its clear button', () => {
            const translate = TestBed.inject(TranslateService)
            translate.setTranslation('en', {
                SHARED: { CLEAR_FIELD: 'Clear “{{field}}”' },
            })
            translate.use('en')
            const fixture = render(note, { key: 'description', value: 'x' })

            const clear = fixture.nativeElement.querySelector(
                '.field-control button'
            ) as HTMLButtonElement
            expect(clear.getAttribute('aria-label')).toBe('Clear “Description”')
        })

        it('tells the user when the limit is reached', () => {
            const fixture = render(note, {
                key: 'description',
                value: 'a'.repeat(255),
            })

            expect(
                fixture.nativeElement.querySelector('.field-hint')
            ).not.toBeNull()
        })

        it('does not show the limit message for a short value', () => {
            const fixture = render(note, {
                key: 'description',
                value: 'short',
            })

            expect(
                fixture.nativeElement.querySelector('.field-hint')
            ).toBeNull()
        })

        it('opens a normal external link', () => {
            const fixture = render(website, {
                key: 'website',
                value: 'https://example.org/page',
            })

            const link = fixture.nativeElement.querySelector('header a')
            expect(link?.getAttribute('href')).toBe('https://example.org/page')
        })

        it.each([
            'https://localhost/_capacitor_http_interceptor_?u=https://evil.test',
            'javascript:alert(1)',
            'http://127.0.0.1/',
            'not a link',
        ])('offers no link for %s while the field stays editable', (value) => {
            const fixture = render(website, { key: 'website', value })

            expect(fixture.nativeElement.querySelector('header a')).toBeNull()
            expect(fixture.nativeElement.querySelector('input')).not.toBeNull()
        })
    })
})
