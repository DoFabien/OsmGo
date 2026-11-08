import { TestBed } from '@angular/core/testing'
import type { Tag } from '@osmgo/type'
import { SelectComponent } from './select.component'

describe('SelectComponent', () => {
    const genderPreset = {
        type: 'select',
        iDtype: 'radio',
        keys: ['male', 'female', 'unisex'],
        options: [{ v: 'male' }, { v: 'female' }, { v: 'unisex' }],
    }

    function createComponent(tag: Tag): SelectComponent {
        const fixture = TestBed.createComponent(SelectComponent)
        fixture.componentRef.setInput('preset', genderPreset)
        fixture.componentRef.setInput('tag', tag)
        const component = fixture.componentInstance
        return component
    }

    it('selects a real OSM key for a multi-key field', () => {
        const tag = { key: '', value: '' }
        const component = createComponent(tag)
        const tagChange = vi.fn()
        component.tagChange.subscribe(tagChange)

        component.selectChange('unisex')

        expect(tag).toEqual({ key: '', value: '' })
        expect(tagChange).toHaveBeenCalledWith({
            source: tag,
            tag: { key: 'unisex', value: 'yes' },
        })
    })

    it('replaces the previous key when the selection changes', () => {
        const tag = { key: 'unisex', value: 'yes' }
        const component = createComponent(tag)
        const tagChange = vi.fn()
        component.tagChange.subscribe(tagChange)

        component.selectChange('male')

        expect(tag).toEqual({ key: 'unisex', value: 'yes' })
        expect(tagChange).toHaveBeenCalledWith({
            source: tag,
            tag: { key: 'male', value: 'yes' },
        })
    })

    it('clears the current tag when the empty option is selected', () => {
        const tag = { key: 'unisex', value: 'yes' }
        const component = createComponent(tag)
        const tagChange = vi.fn()
        component.tagChange.subscribe(tagChange)

        component.selectChange('')

        expect(tag).toEqual({ key: 'unisex', value: 'yes' })
        expect(tagChange).toHaveBeenCalledWith({
            source: tag,
            tag: { key: '', value: '' },
        })
    })

    it('emits code edits without mutating its input', () => {
        const tag = { key: 'unisex', value: 'yes' }
        const component = createComponent(tag)
        const tagChange = vi.fn()
        component.tagChange.subscribe(tagChange)

        component.valueChange('no')

        expect(tag).toEqual({ key: 'unisex', value: 'yes' })
        expect(tagChange).toHaveBeenCalledWith({
            source: tag,
            tag: { key: 'unisex', value: 'no' },
        })
    })

    it('shows a multi-key field whose preset type is text, as in the catalog', () => {
        const fixture = TestBed.createComponent(SelectComponent)
        fixture.componentRef.setInput('preset', {
            ...genderPreset,
            type: 'text',
            lbl: { en: 'Gender' },
        })
        fixture.componentRef.setInput('tag', { key: 'male', value: 'yes' })

        expect(fixture.componentInstance.isMultiKeyPreset).toBe(true)
        expect(fixture.componentInstance.selectedValue).toBe('male')
        expect(fixture.componentInstance.fieldLabel).toBe('Gender')
    })

    it('labels a code-mode multi-key field with the tag key or the possible keys', () => {
        const fixture = TestBed.createComponent(SelectComponent)
        fixture.componentRef.setInput('preset', genderPreset)
        fixture.componentRef.setInput('tag', { key: '', value: '' })
        expect(fixture.componentInstance.codeLabel).toBe(
            'male · female · unisex'
        )

        fixture.componentRef.setInput('tag', { key: 'female', value: 'yes' })
        expect(fixture.componentInstance.codeLabel).toBe('female')
    })
})
