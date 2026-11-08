export const NATIVE_OAUTH_REDIRECT_URI = 'osmgo://auth'

/**
 * The query of an `osmgo://auth` callback, or `null` for any other URL. It is
 * read by prefix: the WebView of Android 7 parses a custom scheme without a
 * host, so `new URL(url).hostname` is empty there.
 */
export const readNativeOAuthCallback = (
    url: string
): URLSearchParams | null => {
    if (!url.toLowerCase().startsWith(NATIVE_OAUTH_REDIRECT_URI)) return null
    const rest = url.slice(NATIVE_OAUTH_REDIRECT_URI.length)
    if (!/^\/?(?:[?#]|$)/.test(rest)) return null
    const query = rest.split('#')[0]
    const start = query.indexOf('?')
    return new URLSearchParams(start === -1 ? '' : query.slice(start + 1))
}
