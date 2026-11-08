export function normalizeSearchText(value: unknown): string {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLocaleLowerCase()
        .trim()
        .replace(/\s+/g, ' ')
}

export function includesNormalizedSearch(
    value: unknown,
    normalizedQuery: string
): boolean {
    return normalizeSearchText(value).includes(normalizedQuery)
}

/** A key typed by the user, kept as written (`ref:FR:SIRET`, `socket:type2`). */
export function nameToOsmKey(name: string): string {
    return String(name ?? '')
        .normalize('NFC')
        .trim()
        .replace(/\s+/g, '_')
}

export function osmTagKeyToPresetId(key: string): string {
    return key.split(':').join('/')
}

export function presetIdMatchesQuery(
    presetId: string,
    queryId: string
): boolean {
    if (!queryId) return false
    return presetId === queryId || presetId.startsWith(`${queryId}/`)
}
