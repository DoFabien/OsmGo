import type { Preset, Tag, TagConfig } from '@osmgo/type'
import { OrderByPresetPipe } from './orderByPreset.pipe'

describe('OrderByPresetPipe', () => {
    const pipe = new OrderByPresetPipe()
    const config = (
        presets: string[],
        moreFields: string[] = []
    ): TagConfig => ({
        id: 'amenity/cafe',
        icon: 'cafe',
        markerColor: '#000',
        geometry: ['point'],
        tags: { amenity: 'cafe' },
        presets,
        moreFields,
    })

    it('orders the category fields, then more fields, extra tags and new fields', () => {
        const tags: Tag[] = [
            { key: 'note', value: 'x' },
            { key: 'wheelchair', value: 'yes' },
            { key: 'fresh', value: '', isJustAdded: true },
            { key: 'level', value: '1' },
            { key: 'cuisine', value: 'coffee' },
        ]

        const ordered = pipe.transform(
            tags,
            config(['cuisine', 'wheelchair'], ['level'])
        )

        expect(ordered.map((tag) => tag.key)).toEqual([
            'wheelchair',
            'cuisine',
            'level',
            'note',
            'fresh',
        ])
    })

    it('matches a namespaced key with its preset id', () => {
        const tags: Tag[] = [
            { key: 'note', value: 'x' },
            { key: 'contact:phone', value: '+33' },
        ]

        const ordered = pipe.transform(tags, config(['contact/phone']))

        expect(ordered.map((tag) => tag.key)).toEqual(['contact:phone', 'note'])
    })

    it('matches a field whose preset id differs from its key', () => {
        const preset = { _id: 'charge_fee', key: 'charge' } as Preset
        const tags: Tag[] = [
            { key: 'note', value: 'x' },
            { key: 'charge', value: '1 EUR', preset },
        ]

        const ordered = pipe.transform(tags, config(['charge_fee']))

        expect(ordered.map((tag) => tag.key)).toEqual(['charge', 'note'])
    })

    it('keeps a multi-key field in the category fields while it has no key', () => {
        const gender = { _id: 'gender', keys: ['male', 'female'] } as Preset
        const tags: Tag[] = [
            { key: 'note', value: 'x' },
            { key: '', value: '', preset: gender },
        ]

        const ordered = pipe.transform(tags, config(['gender']))

        expect(ordered[0].preset).toBe(gender)
    })
})
