import assert from 'node:assert/strict'
import {
    buildTileTestUrl,
    compareImageryPriority,
    invertTmsY,
    isUnusableTileTemplate,
    normalizeImageryUrl,
    simplifyRing,
    toImageryFeature,
} from './basemap-utils'

assert.equal(invertTmsY(0, 1), 1)
assert.equal(invertTmsY(2, 3), 5)
assert.equal(
    buildTileTestUrl(
        'https://tiles.test/{z}/{x}/{-y}?xy={x},{y}&bbox={bbox-epsg-3857}&q={quadkey}',
        2,
        3,
        4,
        [1, 2, 3, 4],
        '0123'
    ),
    'https://tiles.test/4/2/12?xy=2,3&bbox=1,2,3,4&q=0123'
)

const ordered = [
    { properties: { best: false, local: true } },
    { properties: { best: true, local: false } },
].sort(compareImageryPriority)
assert.equal(ordered[0].properties.best, true)

// collinear points disappear, corners stay
assert.deepEqual(
    simplifyRing(
        [
            [0, 0],
            [0.5, 0.001],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
        ],
        0.01
    ),
    [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
    ]
)

const tmsLayer = toImageryFeature({
    type: 'Feature',
    properties: {
        id: 'tms-layer',
        name: 'TMS layer',
        tiles: ['https://tiles.test/{z}/{x}/{-y}.png'],
        max_zoom: 19,
        category: 'photo',
        attribution: { text: '© Test', required: true },
        license_url: 'https://license.test',
        best: true,
    },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [1.123456, 2],
                [3, 2],
                [3, 4],
                [1.123456, 2],
            ],
        ],
    },
})
assert.deepEqual(tmsLayer.properties, {
    id: 'tms-layer',
    name: 'TMS layer',
    tiles: ['https://tiles.test/{z}/{x}/{y}.png'],
    scheme: 'tms',
    max_zoom: 19,
    category: 'photo',
    attribution: { text: '© Test' },
})
assert.deepEqual(tmsLayer.geometry.coordinates[0][0], [1.1235, 2])

assert.equal(
    normalizeImageryUrl(
        'https://tiles.test/export?bbox={bbox}&bboxSR={wkid}&imageSR={wkid}&size={width},{height}&proj={proj}&z={zoom}'
    ),
    'https://tiles.test/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&proj=3857&z={z}'
)
assert.equal(
    isUnusableTileTemplate('https://tiles.test/{z}/{x}/{-y}.png'),
    false
)
assert.equal(
    isUnusableTileTemplate(
        'https://tiles.test/wms?bbox={bbox-epsg-3857}&q={quadkey}'
    ),
    false
)
assert.equal(isUnusableTileTemplate('http://tiles.test/{z}/{x}/{y}.png'), true)
assert.equal(
    isUnusableTileTemplate('https://tiles.test/{z}/{x}/{y}?sr={wkid}'),
    true
)
assert.equal(
    isUnusableTileTemplate('https://tiles.test/{apikey}/{z}/{x}/{y}'),
    true
)
