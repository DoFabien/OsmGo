import { describe, expect, it } from 'vitest'
import { isSafeExternalUrl } from './safe-external-url'

describe('isSafeExternalUrl', () => {
    it('accepts http and https links to other hosts', () => {
        expect(isSafeExternalUrl('https://example.com/page?a=1')).toBe(true)
        expect(isSafeExternalUrl(' http://example.org ')).toBe(true)
    })

    it('rejects links to the app origin, including its aliases', () => {
        for (const value of [
            'https://localhost/_capacitor_http_interceptor_?u=https://evil.test/x.html',
            'https://LOCALHOST./a',
            'http://localhost:8080/',
            'https://app.localhost/',
            'http://127.0.0.1/',
            'https://[::1]/',
            'http://0.0.0.0/',
        ]) {
            expect(isSafeExternalUrl(value), value).toBe(false)
        }
    })

    it('rejects other schemes and values that are not links', () => {
        for (const value of [
            'javascript:alert(1)',
            'file:///etc/passwd',
            'data:text/html,hi',
            'osmgo://auth?code=1',
            'example.com',
            '',
            undefined,
            42,
        ]) {
            expect(isSafeExternalUrl(value), String(value)).toBe(false)
        }
    })
})
