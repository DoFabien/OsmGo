import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Builds the vector background from the OpenFreeMap "bright" style
// (OpenMapTiles schema). Usage:
//   curl -o bright.json https://tiles.openfreemap.org/styles/bright
//   curl -o planet.json https://tiles.openfreemap.org/planet
//   node scripts/buildBasemapStyle.mjs bright.json [planet.json]
// Osm Go draws its own objects: points of interest, shields, one-way arrows and
// the Natural Earth relief are left out, so the style needs neither the
// OpenFreeMap sprites nor its fonts.
// The style keeps the TileJSON URL, which the app refreshes in the background.
// The app starts from the last TileJSON it received, or from the copy written
// to openfreemap-planet.json: when MapLibre cannot fetch a TileJSON, it ignores
// the source for the whole session. Its versioned tile URLs keep working after
// OpenFreeMap publishes a new version, which the app then switches to.
const [, , sourceStylePath, sourceTileJsonPath] = process.argv
if (!sourceStylePath) {
    throw new Error(
        'Usage: node scripts/buildBasemapStyle.mjs <bright.json> [planet.json]'
    )
}

const rootDirectory = fileURLToPath(new URL('..', import.meta.url))
const styleDirectory = path.join(rootDirectory, 'src', 'assets', 'mapStyle')
const outputPath = path.join(styleDirectory, 'brigthCustom.json')
const tileJsonOutputPath = path.join(styleDirectory, 'openfreemap-planet.json')

const removedLayers = new Set([
    'poi_r20',
    'poi_r7',
    'poi_r1',
    'poi_transit',
    'highway-shield-non-us',
    'highway-shield-us-interstate',
    'road_shield_us',
    'airport',
    'road_oneway',
    'road_oneway_opposite',
])
const iconLayout = new Set([
    'text-anchor',
    'text-offset',
    'text-variable-anchor',
])

// The bundled Roboto glyphs only cover the Latin, Greek and Cyrillic scripts:
// a name in another script would not be drawn at all, so its Latin
// transcription comes first.
const localName = ['coalesce', ['get', 'name:latin'], ['get', 'name']]

const usesName = (expression) => JSON.stringify(expression).includes('"name')

const localFont = (fonts) =>
    fonts.map((font) => (/Bold/.test(font) ? 'Roboto-Bold' : 'Roboto-Regular'))

const source = JSON.parse(readFileSync(sourceStylePath, 'utf8'))

const layers = source.layers
    .filter((layer) => !removedLayers.has(layer.id))
    .filter((layer) => !layer.source || layer.source === 'openmaptiles')
    .map((layer) => {
        const layout = { ...(layer.layout ?? {}) }
        const paint = { ...(layer.paint ?? {}) }
        if (layout['icon-image'] !== undefined) {
            for (const key of Object.keys(layout)) {
                if (key.startsWith('icon-') || iconLayout.has(key)) {
                    delete layout[key]
                }
            }
            for (const key of Object.keys(paint)) {
                if (key.startsWith('icon-')) delete paint[key]
            }
        }
        if (layout['text-font'])
            layout['text-font'] = localFont(layout['text-font'])
        if (
            layout['text-field'] !== undefined &&
            usesName(layout['text-field'])
        ) {
            layout['text-field'] = localName
        }
        const result = { ...layer }
        if (Object.keys(layout).length > 0) result.layout = layout
        else delete result.layout
        if (Object.keys(paint).length > 0) result.paint = paint
        else delete result.paint
        return result
    })

layers.push({
    id: 'housenumber',
    type: 'symbol',
    source: 'openmaptiles',
    'source-layer': 'housenumber',
    minzoom: 17,
    layout: {
        'text-field': ['get', 'housenumber'],
        'text-font': ['Roboto-Regular'],
        'text-size': 9,
    },
    paint: {
        'text-color': '#334',
        'text-halo-color': 'rgba(255,255,255,0.8)',
        'text-halo-width': 2,
    },
})

const style = {
    version: 8,
    name: 'Osm Go Bright (OpenFreeMap)',
    sources: {
        openmaptiles: {
            type: 'vector',
            url: 'https://tiles.openfreemap.org/planet',
        },
    },
    sprite: './assets/mapStyle/sprites',
    glyphs: './assets/mapStyle/glyphs/{fontstack}/{range}.pbf',
    layers,
}

writeFileSync(outputPath, `${JSON.stringify(style, null, 4)}\n`)
console.log(`${layers.length} layers written to ${outputPath}`)

if (sourceTileJsonPath) {
    const tileJson = JSON.parse(readFileSync(sourceTileJsonPath, 'utf8'))
    if (
        !Array.isArray(tileJson.tiles) ||
        !tileJson.tiles.every((tile) => tile.startsWith('https://'))
    ) {
        throw new Error(`${sourceTileJsonPath} has no HTTPS tile URL.`)
    }
    const { tilejson, tiles, minzoom, maxzoom, bounds, attribution } = tileJson
    writeFileSync(
        tileJsonOutputPath,
        `${JSON.stringify(
            { tilejson, tiles, minzoom, maxzoom, bounds, attribution },
            null,
            4
        )}\n`
    )
    console.log(`${tiles[0]} written to ${tileJsonOutputPath}`)
}
