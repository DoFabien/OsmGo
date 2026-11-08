import {
    isIncompleteOsmTagKey,
    MAX_OSM_TAG_LENGTH,
    normalizeOsmTagKey,
    requireValidOsmTag,
} from '@app/utils/osm-tags'
import type { Preset } from '@osmgo/type'

export type TagValueIssue = 'tooLong' | 'invalid'

/** Keys the editor may write: never empty and never a bare `prefix:`. */
export const isEditableTagKey = (key: unknown): boolean => {
    const normalized = normalizeOsmTagKey(key)
    return (
        normalized !== undefined &&
        !isIncompleteOsmTagKey(normalized) &&
        Array.from(normalized).length <= MAX_OSM_TAG_LENGTH
    )
}

export const tagValueIssue = (value: unknown): TagValueIssue | null => {
    const text = String(value ?? '')
        .normalize('NFC')
        .trim()
    if (text === '') return null
    if (Array.from(text).length > MAX_OSM_TAG_LENGTH) return 'tooLong'
    try {
        requireValidOsmTag('key', text)
        return null
    } catch {
        return 'invalid'
    }
}

/** A field that covers several keys (`male`, `female`, `unisex`…). */
export const isMultiKeyPreset = (preset: Preset | undefined): boolean =>
    !!preset &&
    !preset.key &&
    (preset.keys?.length ?? 0) > 0 &&
    (preset.options?.length ?? 0) > 0

/** One `yes` tag per option under a key prefix (`payment:cash=yes`). */
export const isPrefixPreset = (preset: Preset | undefined): boolean =>
    !!preset &&
    preset.type === 'multiCombo' &&
    !preset.keys?.length &&
    !!preset.key &&
    preset.key.length > 1 &&
    isIncompleteOsmTagKey(preset.key) &&
    isEditableTagKey(`${preset.key}x`)

/** One `yes` tag per option key (`male=yes`, `female=yes`). */
export const isManyKeyPreset = (preset: Preset | undefined): boolean =>
    !!preset && preset.type === 'manyCombo' && isMultiKeyPreset(preset)

/** A field that writes several tags, one per chosen option. */
export const isMultiValuePreset = (preset: Preset | undefined): boolean =>
    isPrefixPreset(preset) || isManyKeyPreset(preset)

/** The tag key that an option of a multi-value field writes. */
export const multiValueKey = (preset: Preset, option: string): string =>
    isPrefixPreset(preset) ? `${preset.key}${option}` : option

/** Whether a tag of the object belongs to a multi-value field. */
export const isCoveredByPreset = (
    preset: Preset | undefined,
    key: string
): boolean => {
    if (!preset) return false
    if (isPrefixPreset(preset)) {
        const prefix = preset.key ?? ''
        return key.startsWith(prefix) && key.length > prefix.length
    }
    return isManyKeyPreset(preset) && (preset.keys ?? []).includes(key)
}

/** Text compared without case or accents (`Chèque` matches `cheque`). */
export const searchText = (text: string): string =>
    text
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .trim()

/**
 * A value typed by the user, spelled as iD does: spaces become underscores
 * and the text is lower case, unless the field says otherwise.
 */
export const fieldValueSpelling = (preset: Preset, value: string): string => {
    let text = value.normalize('NFC').trim()
    if (preset.snake_case !== false) text = text.replace(/\s+/g, '_')
    if (preset.caseSensitive !== true) text = text.toLowerCase()
    return text
}

/**
 * Whether the editor can show a field for the preset. A key prefix
 * (`payment:`, `diet:`…) is only editable through a multiCombo field.
 */
export const isEditablePreset = (
    preset: Preset | undefined
): preset is Preset => {
    if (!preset) return false
    if (isMultiKeyPreset(preset) || isPrefixPreset(preset)) return true
    return !!preset.key && isEditableTagKey(preset.key)
}
