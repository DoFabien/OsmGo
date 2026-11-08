import type { TapPresetsJson, TapTagsJson } from '@osmgo/type'
import fs from 'fs'
import { tapPresetsPath, tapTagsPath } from './_paths'

/** Reads the tags from the tags and presets (tap) JSON definition. */
export const readTapTagsFromJson = (): TapTagsJson => {
    return JSON.parse(fs.readFileSync(tapTagsPath, 'utf8'))
}

/** Reads the presets from the tags and presets (tap) JSON definition. */
export const readTapPresetsFromJson = (): TapPresetsJson => {
    return JSON.parse(fs.readFileSync(tapPresetsPath, 'utf8'))
}

interface FieldLike {
    key?: string
    keys?: string[]
    type?: string
    iDtype?: string
}

/** iD field types that Osm Go edits with a multi-value editor of that type. */
export const MULTI_VALUE_FIELD_TYPES = ['semiCombo', 'multiCombo', 'manyCombo']

/**
 * Fields that the editor cannot write. Only a "multiCombo" field may be keyed
 * by a prefix: each of its options is a boolean tag under that prefix
 * (`payment:` + `cash` → `payment:cash=yes`). Any other field keyed by a
 * prefix would write a `payment:=cash` tag.
 */
export const isUnsupportedField = (field: FieldLike): boolean => {
    const keys = [field.key, ...(field.keys ?? [])]
    if (field.type === 'multiCombo') {
        return (
            !field.key?.endsWith(':') ||
            field.key.length < 2 ||
            (field.keys ?? []).length > 0
        )
    }
    return (
        field.iDtype === 'multiCombo' || keys.some((key) => key?.endsWith(':'))
    )
}

/**
 * Compact JSON for the generated catalogs: one category, preset or brand per
 * line with no indentation. The files are parsed at startup and stay readable
 * in a diff.
 */
export const stringifyCatalog = (value: object): string => {
    if (Array.isArray(value)) {
        return `[\n${value.map((entry) => JSON.stringify(entry)).join(',\n')}\n]`
    }
    const members = Object.entries(value).map(([key, member]) => {
        const text =
            Array.isArray(member) &&
            member.some((entry) => typeof entry === 'object')
                ? stringifyCatalog(member)
                : JSON.stringify(member)
        return `${JSON.stringify(key)}:${text}`
    })
    return `{\n${members.join(',\n')}\n}`
}
