import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as fontkit from 'fontkit'
import { collectUsedIcons, subsetFontPath } from './materialSymbols.mjs'

const subset = fontkit.create(readFileSync(subsetFontPath))

const missing = [...collectUsedIcons().keys()].filter((name) => {
    const glyphs = subset.layout(name).glyphs
    return glyphs.length !== 1 || glyphs[0].id === 0
})
assert.deepEqual(
    missing,
    [],
    `Icons missing from the Material Symbols subset, run "npm run icons:subset": ${missing.join(', ')}`
)
for (const alias of ['expand_more', 'expand_less']) {
    assert.equal(
        subset.layout(alias).glyphs.length,
        1,
        `${alias} must render as an icon`
    )
}
assert.deepEqual(
    Object.keys(subset.variationAxes).sort(),
    ['FILL', 'GRAD', 'opsz', 'wght'],
    'The Material Symbols subset must keep its variation axes'
)

console.log('Material Symbols subset tests passed')
