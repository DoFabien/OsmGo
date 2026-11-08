import type { Tag } from '@osmgo/type'

export const MAX_OSM_TAG_LENGTH = 255
export const MAX_CHANGESET_COMMENT_LENGTH = 255

/** OpenStreetMap limits keys, values and changeset tags to 255 characters. */
export const osmTextLength = (value: string): number => Array.from(value).length

const containsInvalidControlCharacter = (value: string): boolean =>
    Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return (
            codePoint <= 8 ||
            codePoint === 11 ||
            codePoint === 12 ||
            (codePoint >= 14 && codePoint <= 31) ||
            (codePoint >= 127 && codePoint <= 159)
        )
    })

const normalizeTagText = (value: string): string =>
    value.normalize('NFC').trim()

export const normalizeOsmTagKey = (key: unknown): string | undefined => {
    if (typeof key !== 'string') return undefined
    const normalized = normalizeTagText(key)
    return normalized !== '' && normalized !== 'undefined'
        ? normalized
        : undefined
}

export const normalizeOsmTagValue = (value: unknown): string | undefined => {
    if (value === null || value === undefined) return undefined
    const normalized = normalizeTagText(String(value))
    return normalized === '' ? undefined : normalized
}

export const normalizedOsmTagMap = (
    tags: Iterable<{ key: unknown; value: unknown }>
): Map<string, string> => {
    const normalized = new Map<string, string>()
    for (const tag of tags) {
        const key = normalizeOsmTagKey(tag.key)
        const value = normalizeOsmTagValue(tag.value)
        if (key && value !== undefined) normalized.set(key, value)
    }
    return normalized
}

export const normalizeOsmTags = (
    tags: Record<string, unknown>
): Record<string, string> =>
    Object.fromEntries(
        normalizedOsmTagMap(
            Object.entries(tags).map(([key, value]) => ({ key, value }))
        )
    )

export const normalizeEditorTags = (tags: Tag[]): Tag[] =>
    tags.map((tag) => {
        const key = normalizeOsmTagKey(tag.key)
        const value = normalizeOsmTagValue(tag.value)
        return {
            ...tag,
            key: key ?? '',
            value: value ?? '',
        }
    })

/** A key that ends with a namespace separator (`payment:`) is incomplete. */
export const isIncompleteOsmTagKey = (key: string): boolean =>
    key.trim().endsWith(':')

export const requireValidOsmTag = (
    keyInput: unknown,
    valueInput: unknown
): { key: string; value: string } => {
    const key = normalizeOsmTagKey(keyInput)
    const value = normalizeOsmTagValue(valueInput)
    if (
        !key ||
        value === undefined ||
        isIncompleteOsmTagKey(key) ||
        osmTextLength(key) > MAX_OSM_TAG_LENGTH ||
        osmTextLength(value) > MAX_OSM_TAG_LENGTH ||
        containsInvalidControlCharacter(key) ||
        containsInvalidControlCharacter(value)
    ) {
        throw new Error('Invalid OSM tag key or value.')
    }
    return { key, value }
}

/**
 * Returns the first tag that OpenStreetMap would refuse, so an editor can
 * report it before the change joins the upload queue.
 */
export const findInvalidOsmTag = (
    tags: Record<string, unknown>
): { key: string; reason: 'key' | 'value' } | undefined => {
    for (const [keyInput, valueInput] of Object.entries(tags)) {
        const key = normalizeOsmTagKey(keyInput)
        const value = normalizeOsmTagValue(valueInput)
        if (key === undefined) {
            if (value !== undefined) return { key: keyInput, reason: 'key' }
            continue
        }
        if (
            isIncompleteOsmTagKey(key) ||
            osmTextLength(key) > MAX_OSM_TAG_LENGTH ||
            containsInvalidControlCharacter(key)
        ) {
            return { key, reason: 'key' }
        }
        if (
            value !== undefined &&
            (osmTextLength(value) > MAX_OSM_TAG_LENGTH ||
                containsInvalidControlCharacter(value))
        ) {
            return { key, reason: 'value' }
        }
    }
    return undefined
}

export const osmTagMapsEqual = (
    left: Map<string, string>,
    right: Map<string, string>
): boolean => {
    if (left.size !== right.size) return false
    for (const [key, value] of left) {
        if (right.get(key) !== value) return false
    }
    return true
}
