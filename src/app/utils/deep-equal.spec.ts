import { isDeepEqual } from './deep-equal'

describe('isDeepEqual', () => {
    it('compares nested JSON values regardless of key order', () => {
        expect(
            isDeepEqual(
                { a: 1, b: { c: [1, 2, { d: 'x' }] } },
                { b: { c: [1, 2, { d: 'x' }] }, a: 1 }
            )
        ).toBe(true)
    })

    it('treats an undefined property like a missing one', () => {
        expect(isDeepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    })

    it.each([
        [{ a: 1 }, { a: 2 }],
        [
            [1, 2],
            [1, 2, 3],
        ],
        [{ a: [1] }, { a: { 0: 1 } }],
        [{ a: null }, { a: undefined }],
        [{ a: 1 }, null],
    ])('detects the difference between %j and %j', (left, right) => {
        expect(isDeepEqual(left, right)).toBe(false)
    })
})
