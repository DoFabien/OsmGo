import {
    includesNormalizedSearch,
    nameToOsmKey,
    normalizeSearchText,
    osmTagKeyToPresetId,
    presetIdMatchesQuery,
} from '@osmgo/utils'

describe('search normalization', () => {
    it.each(['[', '(', '\\', '.'])('treats %s as literal text', (query) => {
        const normalizedQuery = normalizeSearchText(query)

        expect(() =>
            includesNormalizedSearch(`value ${query} suffix`, normalizedQuery)
        ).not.toThrow()
        expect(
            includesNormalizedSearch(`value ${query} suffix`, normalizedQuery)
        ).toBe(true)
    })

    it('matches accents and repeated whitespace consistently', () => {
        expect(
            includesNormalizedSearch(
                '  Café   de la Paix ',
                normalizeSearchText('cafe de   la paix')
            )
        ).toBe(true)
    })

    it('matches every value for an empty normalized query', () => {
        expect(
            includesNormalizedSearch('anything', normalizeSearchText('  '))
        ).toBe(true)
    })
})

describe('OSM key and preset identifiers', () => {
    it('keeps a custom key as typed, with spaces as underscores', () => {
        for (const key of [
            'socket:type2',
            'ref:FR:SIRET',
            'fuel:octane_95',
            'seamark:light:1:colour',
        ]) {
            expect(nameToOsmKey(`  ${key} `)).toBe(key)
        }
        expect(nameToOsmKey('  opening   hours ')).toBe('opening_hours')
        expect(osmTagKeyToPresetId('contact:social:twitter')).toBe(
            'contact/social/twitter'
        )
    })

    it('matches exact preset branches without sibling substring matches', () => {
        expect(
            presetIdMatchesQuery('contact/phone/mobile', 'contact/phone')
        ).toBe(true)
        expect(presetIdMatchesQuery('contact/telephone', 'contact/tel')).toBe(
            false
        )
    })
})
