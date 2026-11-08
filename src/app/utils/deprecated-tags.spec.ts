import { describe, expect, it } from 'vitest'
import { resolveReplacementTags } from './deprecated-tags'

describe('resolveReplacementTags', () => {
    it('keeps fixed replacement values', () => {
        expect(resolveReplacementTags({ shop: 'bakery' }, {})).toEqual({
            shop: 'bakery',
        })
    })

    it('keeps the existing value for a wildcard replacement', () => {
        expect(
            resolveReplacementTags(
                { entrance: '*' },
                { building: 'entrance', entrance: 'main' }
            )
        ).toEqual({ entrance: 'main' })
    })

    it('falls back to yes when the object has no value for the key', () => {
        expect(
            resolveReplacementTags({ entrance: '*' }, { building: 'entrance' })
        ).toEqual({ entrance: 'yes' })
    })
})
