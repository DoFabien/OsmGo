import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'

export const rootDirectory = fileURLToPath(new URL('..', import.meta.url))
export const sourceFontPath = path.join(
    rootDirectory,
    'node_modules',
    'material-symbols',
    'material-symbols-rounded.woff2'
)
export const subsetFontPath = path.join(
    rootDirectory,
    'src',
    'theme',
    'material-symbols',
    'material-symbols-rounded-subset.woff2'
)

const sourceDirectory = path.join(rootDirectory, 'src')
const assetsDirectory = path.join(sourceDirectory, 'assets')

const listSourceFiles = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            return entryPath === assetsDirectory
                ? []
                : listSourceFiles(entryPath)
        }
        return /\.(ts|html|scss)$/.test(entry.name) &&
            !entry.name.endsWith('.spec.ts')
            ? [entryPath]
            : []
    })

export const loadSourceFont = () => fontkit.create(readFileSync(sourceFontPath))

/** Icon glyphs of the font, by glyph id, with their private-use code point. */
export const iconCodePoints = (font) => {
    const codePointByGlyph = new Map()
    for (const codePoint of font.characterSet) {
        if (codePoint >= 0xe000) {
            codePointByGlyph.set(
                font.glyphForCodePoint(codePoint).id,
                codePoint
            )
        }
    }
    return codePointByGlyph
}

/**
 * Every word of the application sources that the complete font turns into an
 * icon. It is a superset of the icons really displayed, and it includes the
 * aliases (expand_more…) that the material-symbols typings do not list.
 */
export const collectUsedIcons = (font = loadSourceFont()) => {
    const codePointByGlyph = iconCodePoints(font)
    const words = new Set()
    for (const file of listSourceFiles(sourceDirectory)) {
        for (const word of readFileSync(file, 'utf8').matchAll(
            /[a-z0-9][a-z0-9_]+/g
        )) {
            words.add(word[0])
        }
    }
    const used = new Map()
    for (const word of words) {
        const glyphs = font.layout(word).glyphs
        const codePoint =
            glyphs.length === 1 ? codePointByGlyph.get(glyphs[0].id) : undefined
        if (codePoint !== undefined) used.set(word, codePoint)
    }
    return new Map(
        [...used].sort(([left], [right]) => left.localeCompare(right))
    )
}
