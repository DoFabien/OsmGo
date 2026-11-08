import { readNativeOAuthCallback } from './native-oauth-callback'

describe('native OAuth callback', () => {
    it('reads the query of the callback', () => {
        const query = readNativeOAuthCallback(
            'osmgo://auth?code=abc&state=x%2By#fragment'
        )

        expect(query?.get('code')).toBe('abc')
        expect(query?.get('state')).toBe('x+y')
    })

    it('accepts a trailing slash and an empty query', () => {
        expect(
            readNativeOAuthCallback('osmgo://auth/?code=abc')?.get('code')
        ).toBe('abc')
        expect(readNativeOAuthCallback('OSMGO://auth')?.toString()).toBe('')
    })

    it.each([
        'osmgo://authority?code=abc',
        'osmgo://other?code=abc',
        'https://osmgo.com/?code=abc',
        'osmgo:auth?code=abc',
    ])('ignores %s', (url) => {
        expect(readNativeOAuthCallback(url)).toBeNull()
    })
})
