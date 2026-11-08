import type { TagConfig } from '@osmgo/type'
import { describe, expect, it } from 'vitest'
import { FilterExcludeTagByCountryCode } from './filterExcludeTagByCountryCode.pipe'

const tag = (id: string, extra: Partial<TagConfig> = {}): TagConfig => ({
    id,
    icon: '',
    markerColor: '',
    presets: [],
    geometry: ['point'],
    tags: {},
    ...extra,
})

describe('FilterExcludeTagByCountryCode', () => {
    const pipe = new FilterExcludeTagByCountryCode()
    const items = [
        tag('everywhere'),
        tag('philippines-only', { countryCodes: ['PH'] }),
        tag('not-in-france', { excludeCountryCodes: ['FR'] }),
    ]

    it('keeps the categories that apply to the country', () => {
        expect(pipe.transform(items, 'FR').map((item) => item.id)).toEqual([
            'everywhere',
        ])
        expect(pipe.transform(items, 'PH').map((item) => item.id)).toEqual([
            'everywhere',
            'philippines-only',
            'not-in-france',
        ])
    })
})
