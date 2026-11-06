import SphericalMercator from '@mapbox/sphericalmercator'
import * as cover from '@mapbox/tile-cover'
import {
    BING_MAX_ZOOM,
    IGN_BDORTHO_ID,
    IGN_BDORTHO_MAX_ZOOM,
} from '@osmgo/shared/basemap.constants'
import { pointOnFeature } from '@turf/point-on-feature'
import fs from 'fs-extra'
import stringify from 'json-stringify-pretty-compact'
import path from 'path'
import { fetchJson, fetchResponse } from './_fetch'
import { assetsDir } from './_paths'
import {
    buildTileTestUrl,
    compareImageryPriority,
    toImageryFeature,
} from './basemap-utils'

const url = `https://osmlab.github.io/editor-layer-index/imagery.geojson`

// Osm Go only offers current imagery as a background: historic layers, maps,
// elevation and overlays are left out to keep imagery.json small.
const keptCategories: string[] = ['photo']

const testMaxZoom = 16

const ignoredIds: string[] = [
    'osm-mapnik-black_and_white', // ignored because it does not support CORS
    'EsriWorldImageryClarity', // ignored because it does not support CORS
]

// check if the url is valid and if it supports CORS
const checkUrl = async (feature: any) => {
    // The deepest zooms are often missing outside the main areas: test at the
    // zoom Osm Go edits at, but never outside the layer's own range.
    const maxZoom = feature.properties.max_zoom || 15
    const testZoom = Math.max(
        feature.properties.min_zoom ?? 0,
        Math.min(maxZoom - 1, testMaxZoom)
    )
    const limits = { min_zoom: testZoom, max_zoom: testZoom }

    let coords = [79.08096313476562, 21.135184856708992]
    if (feature.geometry) {
        try {
            // a centroid can fall outside a coastal or multipart coverage
            const pointInside = pointOnFeature(feature)
            coords = pointInside.geometry.coordinates
        } catch (error) {
            console.error(error)
            return false
        }
    }
    const pointGeometry = {
        type: 'Point',
        coordinates: coords,
    }

    const testTile = cover.tiles(pointGeometry, limits)[0]
    if (!testTile) return false
    const [x, y, z] = testTile
    const quadkey = tileToQuadkey(x, y, z)

    const merc = new SphericalMercator({
        size: 256,
        antimeridian: false,
    })
    const bbox = merc.bbox(x, y, z, false, '900913')

    const tileTemplate = feature.properties['tiles']?.[0]
    if (typeof tileTemplate !== 'string') return false
    const testUrl = buildTileTestUrl(tileTemplate, x, y, z, bbox, quadkey)

    for (const timeout of [5_000, 15_000]) {
        try {
            const response = await fetchResponse(testUrl, timeout)

            if (
                response.status === 200 &&
                response.headers.get('access-control-allow-origin') === '*'
            ) {
                return feature
            }
            return false
        } catch {
            // network error or timeout: retry once with a longer timeout
        }
    }
    return false
}

const tileToQuadkey = (x, y, z) => {
    let quadkey = ''
    for (let i = z; i > 0; i--) {
        let digit = 0
        const mask = 1 << (i - 1)
        if ((x & mask) !== 0) {
            digit += 1
        }
        if ((y & mask) !== 0) {
            digit += 2
        }
        quadkey += digit
    }
    return quadkey
}

const mapWithConcurrency = async <T, R>(
    items: T[],
    concurrency: number,
    callback: (item: T) => Promise<R>
): Promise<R[]> => {
    const results = new Array<R>(items.length)
    let nextIndex = 0
    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (nextIndex < items.length) {
                const index = nextIndex
                nextIndex += 1
                results[index] = await callback(items[index])
            }
        }
    )
    await Promise.all(workers)
    return results
}

const run = async () => {
    console.log('Importing basemaps from')
    const data: any = await fetchJson(url)
    const features = data.features
    // const features = data.features.filter((feature:any) => feature.properties.id === 'Bing')

    const featuresToCheck = []
    const bing = []
    for (const feature of features) {
        if (ignoredIds.includes(feature.properties.id)) {
            // Ignore this imagery
            continue
        }

        if (
            feature.properties.overlay ||
            (feature.properties.type !== 'bing' &&
                !keptCategories.includes(feature.properties.category))
        ) {
            continue
        }

        let furl = feature.properties.url
        furl = furl.replace('{zoom}', '{z}')
        furl = furl.replace('{proj}', '3857')
        furl = furl.replace('{height}', '256')
        furl = furl.replace('{width}', '256')
        furl = furl.replace('{bbox}', '{bbox-epsg-3857}')

        // if {-y} => "scheme": "tms" ?
        feature.properties['tiles'] = []

        if (/\{apikey\}/.test(furl)) {
            continue
        }

        // Do not commit third-party Mapbox tokens from the upstream index.
        // GitHub push protection treats them as secrets, even when they are
        // intended for public imagery layers.
        if (/access_token=pk\./.test(furl)) {
            continue
        }

        feature.properties['local'] = feature.geometry ? true : false

        if (feature.properties.id === 'Bing') {
            // CORS...
            feature.properties['tiles'] = [
                'https://ecn.t0.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=587&mkt=en-gb&n=z',
                'https://ecn.t1.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=587&mkt=en-gb&n=z',
                'https://ecn.t2.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=587&mkt=en-gb&n=z',
                'https://ecn.t3.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=587&mkt=en-gb&n=z',
            ]
            feature.properties['attribution'] = {
                required: true,
                text: 'Bing© 2022 Microsoft Corporation',
                url: 'https://blog.openstreetmap.org/2010/11/30/microsoft-imagery-details/',
            }
            feature.properties['max_zoom'] = BING_MAX_ZOOM
            // default basemap with hard-coded tiles: keep it even when the
            // test tile times out
            bing.push(feature)
            continue
        } else if (feature.properties.id === IGN_BDORTHO_ID) {
            feature.properties['tiles'].push(furl)
            feature.properties['max_zoom'] = IGN_BDORTHO_MAX_ZOOM
        } else if (/\{switch:/.test(furl)) {
            // const fswitch = furl.match(/{switch\:.*\}/g)
            const fswitch = furl.match(/\{switch:.+?\}/g)
            const parts = fswitch[0].split(':')[1].slice(0, -1).split(',')

            for (const part of parts) {
                const uri = furl.replace(/\{switch:.+?\}/g, part)
                feature.properties['tiles'].push(uri)
            }
        } else {
            feature.properties['tiles'].push(furl)
        }

        // zoom is too low for Osm Go
        if (feature.properties.max_zoom && feature.properties.max_zoom < 14) {
            continue
        }

        featuresToCheck.push(feature)
    }

    const resultCheckUrl = await mapWithConcurrency(
        featuresToCheck,
        20,
        checkUrl
    )

    const resultFeatures = resultCheckUrl.filter((f) => f !== false)
    const noValidBaseMaps = resultCheckUrl.filter((f) => f === false)

    console.log(
        'Valid base maps :',
        resultFeatures.length,
        'Invalid base maps :',
        noValidBaseMaps.length
    )

    const ordered = [
        ...bing,
        ...resultFeatures.sort(compareImageryPriority),
    ].map(toImageryFeature)
    const outPath = path.join(assetsDir, 'imagery.json')

    fs.writeFileSync(outPath, stringify(ordered), 'utf-8')
}

run()
