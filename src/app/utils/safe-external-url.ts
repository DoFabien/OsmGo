const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/**
 * Whether a tag value can be opened as an external link. Tag values come from
 * anyone who edits OpenStreetMap, so only web links to other hosts are
 * accepted: a link to the app's own origin (`https://localhost` in the Android
 * app) would be loaded with the app's privileges.
 */
export const isSafeExternalUrl = (value: unknown): value is string => {
    if (typeof value !== 'string') return false
    let url: URL
    try {
        url = new URL(value.trim())
    } catch {
        return false
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
    return !LOCAL_HOSTNAMES.has(hostname) && !hostname.endsWith('.localhost')
}
