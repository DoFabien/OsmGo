import { TestBed } from '@angular/core/testing'
import { MatDialogRef } from '@angular/material/dialog'
import { TranslateModule } from '@ngx-translate/core'
import type { Preset } from '@osmgo/type'
import { ConfigService } from '@services/config.service'
import { TagsService } from '@services/tags.service'
import { ModalAddTag } from './modal.addTag'

describe('ModalAddTag', () => {
    const presets: Record<string, Preset> = {
        phone: {
            _id: 'phone',
            key: 'phone',
            type: 'tel',
            lbl: { en: 'Phone' },
        },
        elevation: {
            _id: 'elevation',
            key: 'ele',
            type: 'number',
            lbl: { en: 'Elevation', fr: 'Altitude' },
        },
        payment_multi: {
            _id: 'payment_multi',
            key: 'payment:',
            type: 'text',
            lbl: { en: 'Accepted Payments' },
        },
        diet_multi: {
            _id: 'diet_multi',
            key: 'diet:',
            type: 'multiCombo',
            options: [{ v: 'vegan' }],
            lbl: { en: 'Diet types' },
        },
        gender: {
            _id: 'gender',
            type: 'text',
            keys: ['male', 'female'],
            options: [{ v: 'male' }, { v: 'female' }],
            lbl: { en: 'Gender' },
        },
    }
    const close = vi.fn()

    function create(options: {
        moreFields?: string[]
        usedList?: string[]
        language?: string
    }) {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: [ModalAddTag, TranslateModule.forRoot()],
            providers: [
                { provide: MatDialogRef, useValue: { close } },
                { provide: TagsService, useValue: { presets: () => presets } },
                {
                    provide: ConfigService,
                    useValue: {
                        config: () => ({
                            languageTags: options.language ?? 'fr',
                            countryTags: 'FR',
                        }),
                    },
                },
            ],
        })
        const fixture = TestBed.createComponent(ModalAddTag)
        fixture.componentRef.setInput('moreFields', options.moreFields ?? [])
        fixture.componentRef.setInput('usedList', options.usedList ?? [])
        fixture.detectChanges()
        return fixture
    }

    const options = (fixture: ReturnType<typeof create>) =>
        Array.from(
            fixture.nativeElement.querySelectorAll(
                '.tag-option'
            ) as NodeListOf<HTMLElement>
        )

    beforeEach(() => close.mockReset())

    it('lists the optional fields of the category, without prefix presets or unknown ids', () => {
        const fixture = create({
            moreFields: ['phone', 'payment_multi', 'missing', 'gender'],
        })

        const labels = options(fixture).map(
            (option) => option.querySelector('strong')?.textContent
        )

        expect(labels).toEqual(['Phone', 'Gender'])
    })

    it('falls back to the English label when the language has none', () => {
        const fixture = create({
            moreFields: ['phone', 'elevation'],
            language: 'fr',
        })

        const labels = options(fixture).map(
            (option) => option.querySelector('strong')?.textContent
        )

        expect(labels).toEqual(['Phone', 'Altitude'])
    })

    it('shows the real OSM key under the label', () => {
        const fixture = create({ moreFields: ['elevation', 'gender'] })

        const keys = options(fixture).map(
            (option) => option.querySelector('small')?.textContent
        )

        expect(keys).toEqual(['ele', 'male, female'])
    })

    it('answers with the preset id and its real key', () => {
        const fixture = create({ moreFields: ['elevation'] })

        options(fixture)[0].click()

        expect(close).toHaveBeenCalledWith({
            key: 'ele',
            presetId: 'elevation',
        })
    })

    it('answers a multi-key field without any key', () => {
        const fixture = create({ moreFields: ['gender'] })

        options(fixture)[0].click()

        expect(close).toHaveBeenCalledWith({ key: '', presetId: 'gender' })
    })

    it('offers a multiCombo prefix field and answers it without any key', () => {
        const fixture = create({ moreFields: ['diet_multi'] })

        expect(options(fixture)[0].querySelector('small')?.textContent).toBe(
            'diet:*'
        )
        options(fixture)[0].click()

        expect(close).toHaveBeenCalledWith({ key: '', presetId: 'diet_multi' })
    })

    it('finds a multiCombo prefix field when searching', () => {
        const fixture = create({})
        fixture.componentInstance.onSearchInput('diet')
        fixture.detectChanges()

        const keys = options(fixture).map(
            (option) => option.querySelector('small')?.textContent
        )

        expect(keys).toContain('diet:*')
    })

    it('does not offer a multiCombo field that the object already shows', () => {
        const fixture = create({
            moreFields: ['diet_multi', 'phone'],
            usedList: ['diet_multi'],
        })

        const labels = options(fixture).map(
            (option) => option.querySelector('strong')?.textContent
        )

        expect(labels).toEqual(['Phone'])
    })

    it('never offers a prefix preset when searching', () => {
        const fixture = create({})
        fixture.componentInstance.onSearchInput('payment')
        fixture.detectChanges()

        const keys = options(fixture).map(
            (option) => option.querySelector('small')?.textContent
        )

        expect(keys).not.toContain('payment:')
        expect(close).not.toHaveBeenCalled()
    })

    it('offers a free key typed by the user', () => {
        const fixture = create({})
        fixture.componentInstance.onSearchInput(' check  date ')
        fixture.detectChanges()

        const custom = fixture.nativeElement.querySelector(
            '.tag-option--custom'
        ) as HTMLElement
        expect(custom.querySelector('small')?.textContent).toBe('check_date')

        custom.click()

        expect(close).toHaveBeenCalledWith({ key: 'check_date' })
    })

    it('keeps the case, digits and namespaces of a typed key', () => {
        const fixture = create({})

        for (const key of [
            'socket:type2',
            'ref:FR:SIRET',
            'fuel:octane_95',
            'seamark:light:1:colour',
        ]) {
            close.mockReset()
            fixture.componentInstance.onSearchInput(key)
            fixture.detectChanges()
            const custom = fixture.nativeElement.querySelector(
                '.tag-option--custom'
            ) as HTMLElement
            expect(custom.querySelector('small')?.textContent).toBe(key)
            custom.click()
            expect(close).toHaveBeenCalledWith({ key })
        }
    })

    it('resolves a capitalized key to the matching field', () => {
        const fixture = create({})
        fixture.componentInstance.onSearchInput('Phone')
        fixture.detectChanges()

        const custom = fixture.nativeElement.querySelector(
            '.tag-option--custom'
        ) as HTMLElement
        expect(custom.querySelector('small')?.textContent).toBe('phone')
        custom.click()

        expect(close).toHaveBeenCalledWith({ key: 'phone', presetId: 'phone' })
    })

    it('resolves a typed key to the matching field', () => {
        const fixture = create({})
        fixture.componentInstance.onSearchInput('elevation')
        fixture.detectChanges()

        const custom = fixture.nativeElement.querySelector(
            '.tag-option--custom'
        ) as HTMLElement
        expect(custom.querySelector('strong')?.textContent).toBe('Altitude')
        custom.click()

        expect(close).toHaveBeenCalledWith({
            key: 'ele',
            presetId: 'elevation',
        })
    })

    it('does not offer a key that is already on the object', () => {
        const fixture = create({ usedList: ['note'] })
        fixture.componentInstance.onSearchInput('note')
        fixture.detectChanges()

        expect(
            fixture.nativeElement.querySelector('.tag-option--custom')
        ).toBeNull()
    })

    it('does not offer a key made only of separators', () => {
        const fixture = create({})
        fixture.componentInstance.onSearchInput(':::')
        fixture.detectChanges()

        expect(
            fixture.nativeElement.querySelector('.tag-option--custom')
        ).toBeNull()
    })

    it('limits the search text', () => {
        const fixture = create({})

        const input = fixture.nativeElement.querySelector(
            'input'
        ) as HTMLInputElement

        expect(input.getAttribute('maxlength')).toBe('255')
    })
})
