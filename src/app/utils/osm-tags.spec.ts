import {
    findInvalidOsmTag,
    normalizedOsmTagMap,
    normalizeOsmTagKey,
    normalizeOsmTags,
    osmTagMapsEqual,
    osmTextLength,
    requireValidOsmTag,
} from './osm-tags'

describe('OSM tag normalization', () => {
    it('keeps zero, trims strings and rejects invalid keys and values', () => {
        expect(
            normalizeOsmTags({
                ' level ': 0,
                name: '  Bench  ',
                empty: '   ',
                undefined: 'invalid key',
                ignored: undefined,
            })
        ).toEqual({ level: '0', name: 'Bench' })
        expect(normalizeOsmTagKey(undefined)).toBeUndefined()
    })

    it('compares canonical maps independently of input order and value type', () => {
        const first = normalizedOsmTagMap([
            { key: 'level', value: 0 },
            { key: 'name', value: 'Bench' },
        ])
        const second = normalizedOsmTagMap([
            { key: 'name', value: 'Bench' },
            { key: 'level', value: '0' },
        ])

        expect(osmTagMapsEqual(first, second)).toBe(true)
    })

    it('normalizes Unicode and validates strict custom-tag boundaries', () => {
        expect(requireValidOsmTag(' cuisine ', ' Cafe\u0301 ')).toEqual({
            key: 'cuisine',
            value: 'Café',
        })
        expect(() => requireValidOsmTag('', 'value')).toThrow()
        expect(() => requireValidOsmTag('name', 'bad\u0000value')).toThrow()
        expect(() => requireValidOsmTag('x'.repeat(256), 'value')).toThrow()
    })

    it.each(['payment:', ' diet: ', ':'])(
        'refuses the incomplete namespace key %j',
        (key) => {
            expect(() => requireValidOsmTag(key, 'cash')).toThrow()
        }
    )

    it('counts code points rather than UTF-16 units', () => {
        expect(osmTextLength('😀'.repeat(255))).toBe(255)
        expect(requireValidOsmTag('name', '😀'.repeat(255)).value).toHaveLength(
            510
        )
        expect(() => requireValidOsmTag('name', '😀'.repeat(256))).toThrow()
    })

    it('finds the first tag OpenStreetMap would refuse', () => {
        expect(findInvalidOsmTag({ name: 'Bench', level: 0 })).toBeUndefined()
        expect(findInvalidOsmTag({ '': '', x: 'y' })).toBeUndefined()
        expect(findInvalidOsmTag({ 'payment:': 'cash' })).toEqual({
            key: 'payment:',
            reason: 'key',
        })
        expect(findInvalidOsmTag({ '': 'orphan value' })).toEqual({
            key: '',
            reason: 'key',
        })
        expect(findInvalidOsmTag({ inscription: 'x'.repeat(256) })).toEqual({
            key: 'inscription',
            reason: 'value',
        })
    })
})
