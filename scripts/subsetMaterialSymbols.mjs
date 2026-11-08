import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import subsetFont from 'subset-font'
import {
    collectUsedIcons,
    loadSourceFont,
    sourceFontPath,
    subsetFontPath,
} from './materialSymbols.mjs'

// Material Symbols Rounded weighs 5 MB for 4000 icons. The application uses a
// few hundred: keep only those, with all the variation axes.
const icons = collectUsedIcons(loadSourceFont())

// The letters make the ligatures reachable, the code points keep the icon
// glyphs. Without the layout closure no unused ligature is added back.
const text = `abcdefghijklmnopqrstuvwxyz0123456789_${String.fromCodePoint(...icons.values())}`
const subset = await subsetFont(readFileSync(sourceFontPath), text, {
    targetFormat: 'woff2',
    noLayoutClosure: true,
})

mkdirSync(path.dirname(subsetFontPath), { recursive: true })
writeFileSync(subsetFontPath, subset)
console.log(
    `Material Symbols subset: ${icons.size} icons, ${Math.round(subset.length / 1024)} kB`
)
