import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    addAttributesToFeature,
    convert,
    findIncompleteMultipolygons,
    getConfigTag,
    mergeOldNewGeojsonData,
    setIconStyle,
    wayToPoint,
} from './index.js'

const converterDirectory = path.dirname(fileURLToPath(import.meta.url))
const tagConfigPath = path.join(
    converterDirectory,
    '..',
    '..',
    'src',
    'assets',
    'tagsAndPresets',
    'tags.json'
)
const tagConfig = JSON.parse(fs.readFileSync(tagConfigPath, 'utf8'))

const fixturePath = path.join(converterDirectory, 'fixture')
const f1 = fs.readFileSync(path.join(fixturePath, 'f1.osm'), 'utf8')
const osmMultipolygon = fs.readFileSync(
    path.join(fixturePath, 'multipolygon.json'),
    'utf8'
)

const result = convert(f1, {
    tagConfig: tagConfig.tags,
    primaryKeys: tagConfig.primaryKeys,
})
assert.equal(result.geojson.features.length, 1835)
assert.equal(result.geojsonBbox, null)

// No object of the fixture that Osm Go showed before the iD scores (listed in
// f1-visible.json) falls into a category hidden by default (TagsService)
const tagsServiceSource = fs.readFileSync(
    path.join(
        converterDirectory,
        '..',
        '..',
        'src',
        'app',
        'services',
        'tags.service.ts'
    ),
    'utf8'
)
const defaultHiddenIds = new Set(
    [
        ...tagsServiceSource
            .slice(
                tagsServiceSource.indexOf('defaultHiddenTagsIds'),
                tagsServiceSource.indexOf('getTagConfigFromTagsID')
            )
            .matchAll(/'([^']+)'/g),
    ].map((match) => match[1])
)
assert.ok(defaultHiddenIds.has('building/yes'))
const configIdById = new Map(
    result.geojson.features.map((feature) => [
        feature.id,
        feature.properties.configId,
    ])
)
const visibleBefore = JSON.parse(
    fs.readFileSync(path.join(fixturePath, 'f1-visible.json'), 'utf8')
)
assert.equal(visibleBefore.length, 1244)
assert.deepEqual(
    visibleBefore.filter((id) => defaultHiddenIds.has(configIdById.get(id))),
    [],
    'objects of f1 became hidden'
)

const resultMp = convert(osmMultipolygon, {
    tagConfig: tagConfig.tags,
    primaryKeys: tagConfig.primaryKeys,
})
assert.equal(resultMp.geojson.features.length, 3)

const emptyResult = convert(
    {
        bounds: { minlat: 0, minlon: 0, maxlat: 1, maxlon: 1 },
        elements: [],
    },
    {
        tagConfig: tagConfig.tags,
        primaryKeys: tagConfig.primaryKeys,
    }
)
assert.deepEqual(emptyResult, {
    geojson: { type: 'FeatureCollection', features: [] },
    geojsonBbox: null,
})

assert.throws(() => convert('invalid JSON', {}), SyntaxError)

const pointFeature = (id, coordinates, name, changeType) => ({
    type: 'Feature',
    id,
    properties: {
        name,
        ...(changeType ? { changeType } : {}),
    },
    geometry: { type: 'Point', coordinates },
})

const mergeBbox = {
    type: 'Feature',
    properties: {},
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
            ],
        ],
    },
}

const oldGeojson = {
    type: 'FeatureCollection',
    features: [
        pointFeature('node/stale', [0.25, 0.25], 'stale'),
        pointFeature('node/updated', [0.5, 0.5], 'old update'),
        pointFeature('node/outside', [2, 2], 'outside'),
        pointFeature('node/outside-updated', [3, 3], 'old outside update'),
        pointFeature('node/outside-kept', [4, 4], 'outside kept'),
    ],
}
const newGeojson = {
    type: 'FeatureCollection',
    features: [
        pointFeature('node/updated', [0.5, 0.5], 'new update'),
        pointFeature('node/outside-updated', [3, 3], 'new outside update'),
        pointFeature('node/new', [0.75, 0.75], 'new'),
    ],
}
const pendingGeojson = {
    type: 'FeatureCollection',
    features: [
        pointFeature('node/-1', [0.1, 0.1], 'pending create', 'Create'),
        pointFeature('node/updated', [0.5, 0.5], 'pending update', 'Update'),
        pointFeature('node/outside', [2, 2], 'pending delete', 'Delete'),
    ],
}
const oldSnapshot = structuredClone(oldGeojson)
const newSnapshot = structuredClone(newGeojson)
const pendingSnapshot = structuredClone(pendingGeojson)

const merged = mergeOldNewGeojsonData(
    oldGeojson,
    newGeojson,
    mergeBbox,
    pendingGeojson
)

assert.deepEqual(
    merged.features.map((feature) => [feature.id, feature.properties.name]),
    [
        ['node/outside-updated', 'new outside update'],
        ['node/outside-kept', 'outside kept'],
        ['node/new', 'new'],
    ]
)
assert.deepEqual(oldGeojson, oldSnapshot)
assert.deepEqual(newGeojson, newSnapshot)
assert.deepEqual(pendingGeojson, pendingSnapshot)

const mergeWithoutDeletionCandidates = mergeOldNewGeojsonData(
    {
        type: 'FeatureCollection',
        features: [pointFeature('node/outside', [2, 2], 'old')],
    },
    {
        type: 'FeatureCollection',
        features: [pointFeature('node/outside', [2, 2], 'new')],
    },
    mergeBbox,
    { type: 'FeatureCollection', features: [] }
)
assert.deepEqual(
    mergeWithoutDeletionCandidates.features.map(
        (feature) => feature.properties.name
    ),
    ['new']
)

const measuredGeometries = [
    {
        type: 'Polygon',
        coordinates: [
            [
                [0, 0],
                [0.01, 0],
                [0.01, 0.01],
                [0, 0.01],
                [0, 0],
            ],
        ],
    },
    {
        type: 'MultiPolygon',
        coordinates: [
            [
                [
                    [0, 0],
                    [0.01, 0],
                    [0.01, 0.01],
                    [0, 0.01],
                    [0, 0],
                ],
            ],
            [
                [
                    [0.02, 0.02],
                    [0.03, 0.02],
                    [0.03, 0.03],
                    [0.02, 0.03],
                    [0.02, 0.02],
                ],
            ],
        ],
    },
    {
        type: 'LineString',
        coordinates: [
            [0, 0],
            [0.01, 0.01],
        ],
    },
    {
        type: 'MultiLineString',
        coordinates: [
            [
                [0, 0],
                [0.01, 0.01],
            ],
            [
                [0.02, 0.02],
                [0.03, 0.03],
            ],
        ],
    },
]

for (const geometry of measuredGeometries) {
    const feature = {
        type: 'Feature',
        id: `way/${geometry.type}`,
        properties: { tags: {}, meta: {} },
        geometry: structuredClone(geometry),
    }

    wayToPoint(feature)

    assert.equal(feature.geometry.type, 'Point')
    assert.equal(feature.properties.way_geometry.type, geometry.type)
    assert.ok(feature.properties.mesure > 0)
}

const relationFixture = (elements) => ({
    bounds: { minlat: 0, minlon: 0, maxlat: 1, maxlon: 1 },
    elements,
})

assert.doesNotThrow(() =>
    convert(
        relationFixture([
            { type: 'relation', id: 1 },
            { type: 'relation', id: 2, members: [null] },
        ]),
        {}
    )
)

assert.doesNotThrow(() =>
    convert(
        relationFixture([
            {
                type: 'relation',
                id: 3,
                tags: { type: 'multipolygon', amenity: 'school' },
                members: [{ type: 'way', ref: 999, role: 'outer' }],
            },
        ]),
        {}
    )
)

const squareElements = [
    { type: 'node', id: 1, lat: 0, lon: 0 },
    { type: 'node', id: 2, lat: 0, lon: 0.01 },
    { type: 'node', id: 3, lat: 0.01, lon: 0.01 },
    { type: 'node', id: 4, lat: 0.01, lon: 0 },
    { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1] },
]

const taggedBuildings = convert(
    relationFixture([
        ...squareElements.slice(0, 4),
        {
            type: 'way',
            id: 223148298,
            nodes: [1, 2, 3, 4, 1],
            tags: {
                building: 'retail',
                shop: 'supermarket',
                name: 'Netto',
            },
        },
        {
            type: 'way',
            id: 223146925,
            nodes: [1, 2, 3, 4, 1],
            tags: {
                building: 'commercial',
                shop: 'garden_centre',
                name: 'France Rurale',
            },
        },
        {
            type: 'way',
            id: 11,
            nodes: [1, 2, 3, 4, 1],
            tags: { building: 'yes' },
        },
    ]),
    {
        tagConfig: tagConfig.tags,
        primaryKeys: tagConfig.primaryKeys,
    }
)
const taggedBuildingById = new Map(
    taggedBuildings.geojson.features.map((feature) => [feature.id, feature])
)
assert.equal(
    taggedBuildingById.get('way/223148298').properties.configId,
    'shop/supermarket'
)
assert.equal(
    taggedBuildingById.get('way/223146925').properties.configId,
    'shop/garden_centre'
)
assert.equal(
    taggedBuildingById.get('way/11').properties.configId,
    'building/yes'
)

const nestedRelations = convert(
    relationFixture([
        ...squareElements,
        {
            type: 'relation',
            id: 200,
            tags: { type: 'multipolygon', amenity: 'school' },
            members: [{ type: 'relation', ref: 100, role: 'outer' }],
        },
        {
            type: 'relation',
            id: 100,
            tags: { type: 'multipolygon', amenity: 'park' },
            members: [{ type: 'way', ref: 10, role: 'outer' }],
        },
    ]),
    {}
)
const nestedParent = nestedRelations.geojson.features.find(
    (feature) => feature.id === 'relation/200'
)
const nestedChild = nestedRelations.geojson.features.find(
    (feature) => feature.id === 'relation/100'
)
assert.ok(nestedParent)
assert.ok(nestedChild)
assert.equal(nestedParent.properties.way_geometry.type, 'Polygon')
assert.deepEqual(nestedChild.properties.relations, [
    {
        rel: 'relation/200',
        reltags: { type: 'multipolygon', amenity: 'school' },
        role: 'outer',
    },
])

const hierarchyFeature = {
    properties: {
        configId: 'shop/car_parts',
        primaryTag: { key: 'shop', value: 'car_parts' },
        tags: { shop: 'car_parts' },
    },
}
const hierarchyConfig = getConfigTag(hierarchyFeature, [
    { id: 'shop/car', tags: {}, presets: ['wrong-parent'] },
    { id: 'shop', tags: {}, presets: ['shared', 'shared'] },
    {
        id: 'shop/car_parts',
        tags: { shop: 'car_parts' },
        presets: ['specific', 'shared'],
        moreFields: ['name', 'name'],
    },
])
assert.deepEqual(hierarchyConfig.presets, ['shared', 'specific'])
assert.deepEqual(hierarchyConfig.moreFields, ['name'])

const derivedFeature = {
    type: 'Feature',
    id: 'node/1',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {
        type: 'node',
        tags: { amenity: 'bench' },
        meta: {},
        primaryTag: { key: 'amenity', value: 'bench' },
        _name: 'stale',
        fixme: true,
        unknowTags: true,
    },
}
addAttributesToFeature(derivedFeature)
assert.equal(derivedFeature.properties._name, undefined)
assert.equal(derivedFeature.properties.fixme, undefined)
setIconStyle(derivedFeature, [
    {
        id: 'amenity/bench',
        tags: { amenity: 'bench' },
        icon: 'bench',
        markerColor: '#123456',
    },
])
assert.equal(derivedFeature.properties.unknowTags, undefined)

const twoOuterWays = [
    ...squareElements,
    { type: 'node', id: 5, lat: 0.02, lon: 0.02 },
    { type: 'node', id: 6, lat: 0.02, lon: 0.03 },
    { type: 'node', id: 7, lat: 0.03, lon: 0.03 },
    { type: 'node', id: 8, lat: 0.03, lon: 0.02 },
    { type: 'way', id: 11, nodes: [5, 6, 7, 8, 5] },
]
// A multipolygon relation is an area whatever its tags say: the polygon tag
// rules only apply to closed ways.
const cutlineMultipolygon = convert(
    relationFixture([
        ...twoOuterWays,
        {
            type: 'relation',
            id: 300,
            tags: {
                type: 'multipolygon',
                area: 'no',
                man_made: 'cutline',
            },
            members: [
                { type: 'way', ref: 10, role: 'outer' },
                { type: 'way', ref: 11, role: 'outer' },
            ],
        },
    ]),
    {}
).geojson.features.find((feature) => feature.id === 'relation/300')
assert.ok(cutlineMultipolygon)
assert.equal(cutlineMultipolygon.properties.way_geometry.type, 'MultiPolygon')
assert.equal(cutlineMultipolygon.properties.way_geometry.coordinates.length, 2)

const closedWayAsLine = convert(
    relationFixture([
        ...squareElements,
        {
            type: 'way',
            id: 12,
            nodes: [1, 2, 3, 4, 1],
            tags: { man_made: 'cutline' },
        },
    ]),
    {}
).geojson.features.find((feature) => feature.id === 'way/12')
assert.equal(closedWayAsLine.properties.way_geometry.type, 'LineString')

const supportedRelations = convert(
    relationFixture([
        ...squareElements,
        {
            type: 'relation',
            id: 400,
            tags: { type: 'multilinestring', man_made: 'cutline' },
            members: [{ type: 'way', ref: 10, role: '' }],
        },
        {
            type: 'relation',
            id: 401,
            tags: {
                type: 'public_transport',
                public_transport: 'stop_area',
            },
            members: [{ type: 'node', ref: 1, role: 'stop' }],
        },
    ]),
    {}
)
assert.equal(
    supportedRelations.geojson.features.find(
        (feature) => feature.id === 'relation/400'
    )?.properties.way_geometry.type,
    'MultiLineString'
)
assert.equal(
    supportedRelations.geojson.features.find(
        (feature) => feature.id === 'relation/401'
    )?.properties.way_geometry.type,
    'GeometryCollection'
)

const incompleteWay = convert(
    relationFixture([
        { type: 'node', id: 1, lat: 0, lon: 0 },
        {
            type: 'way',
            id: 500,
            nodes: [1, 999],
            tags: { highway: 'service' },
        },
    ]),
    {}
)
assert.equal(
    incompleteWay.geojson.features.some((feature) => feature.id === 'way/500'),
    false
)

// --- category matching ---

const catalog = tagConfig.tags
const singleNode = (tags, extraElements = []) => {
    const result = convert(
        relationFixture([
            { type: 'node', id: 1, lat: 0.5, lon: 0.5, tags },
            ...extraElements,
        ]),
        { tagConfig: catalog, primaryKeys: tagConfig.primaryKeys }
    )
    return result.geojson.features.find((feature) => feature.id === 'node/1')
}

// iD and Osm Go write amenity=pharmacy together with healthcare=pharmacy:
// healthcare comes first in the primary keys, but no healthcare/pharmacy exists
const pharmacy = singleNode({ amenity: 'pharmacy', healthcare: 'pharmacy' })
assert.equal(pharmacy.properties.configId, 'amenity/pharmacy')
assert.equal(pharmacy.properties.unknowTags, undefined)
assert.notEqual(pharmacy.properties.icon, 'wiki-question')

// the richer amenity category wins over the bare healthcare one
for (const [tags, expected] of [
    [{ amenity: 'doctors', healthcare: 'doctor' }, 'amenity/doctors'],
    [{ amenity: 'hospital', healthcare: 'hospital' }, 'amenity/hospital'],
    [{ amenity: 'dentist', healthcare: 'dentist' }, 'amenity/dentist'],
    [{ amenity: 'clinic', healthcare: 'clinic' }, 'amenity/clinic'],
    [{ healthcare: 'doctor' }, 'healthcare/doctor'],
    [
        { public_transport: 'station', bus: 'yes' },
        'public_transport/station_bus',
    ],
]) {
    assert.equal(singleNode(tags).properties.configId, expected)
}

// a wildcard category needs the key, whatever its value is
assert.equal(
    singleNode({ historic: 'building', building: 'house' }).properties.configId,
    'historic/building'
)
assert.equal(
    singleNode({ historic: 'building' }).properties.unknowTags,
    true,
    'historic=building needs building=*'
)
assert.equal(
    singleNode({ railway: 'rail', 'railway:preserved': 'yes' }).properties
        .configId,
    'railway/preserved'
)

// categories whose ID is not made of their tags were unreachable
for (const [tags, expected] of [
    [{ playground: 'springy' }, 'playground/rocker'],
    [{ playground: 'climbingframe' }, 'playground/climbing_frame'],
    [{ playground: 'basketswing' }, 'playground/basket_swing'],
    [{ playground: 'balancebeam' }, 'playground/balance_beam'],
    [{ railway: 'wash' }, 'railway/train_wash'],
    [{ emergency: 'fire_alarm_box' }, 'emergency/fire_alarm'],
    [{ amenity: 'karaoke_box' }, 'amenity/karaoke'],
    [{ craft: 'insulation' }, 'craft/insulator'],
    [{ healthcare: 'birthing_centre' }, 'healthcare/birthing_center'],
    [{ shop: 'supermarket', organic: 'only' }, 'shop/organic'],
]) {
    const feature = singleNode(tags)
    assert.equal(feature.properties.configId, expected, JSON.stringify(tags))
    assert.equal(feature.properties.unknowTags, undefined)
}

// the most specific category wins, then the primary key priority
assert.equal(
    singleNode({ amenity: 'restaurant', cuisine: 'pizza' }).properties.configId,
    'amenity/restaurant/pizza'
)
assert.equal(
    singleNode({ shop: 'supermarket', building: 'retail' }).properties.configId,
    'shop/supermarket'
)

// iD scores a building (0.5) below a real category, even one that its search
// does not offer: a school, a station or a bus stop in a building stays one
for (const [tags, expected] of [
    [{ amenity: 'school', building: 'yes' }, 'amenity/school'],
    [{ amenity: 'school', building: 'school' }, 'amenity/school'],
    [{ railway: 'station', building: 'train_station' }, 'railway/station'],
    [
        { highway: 'bus_stop', public_transport: 'platform', building: 'roof' },
        'highway/bus_stop',
    ],
    [
        {
            highway: 'bus_stop',
            public_transport: 'platform',
            bus: 'yes',
            building: 'yes',
        },
        'public_transport/platform/bus',
    ],
    [{ amenity: 'kindergarten', building: 'yes' }, 'amenity/kindergarten'],
    [{ amenity: 'college', building: 'yes' }, 'amenity/college'],
    [{ amenity: 'university', building: 'university' }, 'amenity/university'],
    [{ amenity: 'nursing_home', building: 'yes' }, 'amenity/nursing_home'],
    [{ amenity: 'recycling', building: 'yes' }, 'amenity/recycling'],
    [{ amenity: 'bus_station', building: 'yes' }, 'amenity/bus_station'],
    [{ shop: 'yes', building: 'retail' }, 'shop/yes'],
    [{ office: 'yes', building: 'office' }, 'office/yes'],
    [{ amenity: 'toilets', building: 'yes' }, 'amenity/toilets'],
]) {
    assert.equal(
        singleNode(tags).properties.configId,
        expected,
        JSON.stringify(tags)
    )
}
assert.equal(
    singleNode({ building: 'yes' }).properties.configId,
    'building/yes'
)

// a deprecated category no longer applies once its upgrade is written, and
// its configId does not survive while another category fits
const upgradedPlatform = singleNode({
    railway: 'platform',
    public_transport: 'platform',
})
assert.equal(
    upgradedPlatform.properties.configId,
    'public_transport/platform_point'
)
assert.equal(upgradedPlatform.properties.deprecated, undefined)
upgradedPlatform.properties.configId = 'railway/platform'
setIconStyle(upgradedPlatform, catalog)
assert.equal(
    upgradedPlatform.properties.configId,
    'public_transport/platform_point'
)
assert.equal(singleNode({ railway: 'platform' }).properties.deprecated, true)

// an empty value does not stand for the object when another key has one
const emptyAmenity = singleNode({ amenity: '', shop: 'bakery' })
assert.deepEqual(emptyAmenity.properties.primaryTag, {
    key: 'shop',
    value: 'bakery',
})
assert.equal(emptyAmenity.properties.configId, 'shop/bakery')

// every category gives itself back when its own tags are converted
const roundTripPresets = [
    { id: 'a/b', tags: { a: 'b' }, presets: [] },
    { id: 'a/b/c', tags: { a: 'b', c: 'd' }, presets: [] },
    { id: 'z/star', tags: { z: '*', y: 'yes' }, presets: [] },
    { id: 'z/hidden', tags: { z: 'x' }, presets: [], searchable: false },
    { id: 'z/shown', tags: { z: 'x' }, presets: [] },
    { id: 'b/yes', tags: { b: 'yes' }, presets: [], matchScore: 0.5 },
    { id: 'h/hidden', tags: { h: 'x' }, presets: [], searchable: false },
    { id: 'r/road', tags: { r: 'road' }, presets: [] },
    {
        id: 'r/road/bridge',
        tags: { r: 'road', bridge: 'yes' },
        presets: [],
        matchScore: 0.25,
    },
]
const roundTrip = (tags, configId) =>
    getConfigTag(
        {
            properties: {
                tags,
                configId,
                primaryTag: { key: Object.keys(tags)[0], value: 'x' },
            },
        },
        roundTripPresets
    ).id
assert.equal(roundTrip({ a: 'b' }), 'a/b')
assert.equal(roundTrip({ a: 'b', c: 'd' }), 'a/b/c')
assert.equal(roundTrip({ z: 'anything', y: 'yes' }), 'z/star')
assert.equal(roundTrip({ z: 'x' }), 'z/shown', 'searchable categories first')
assert.equal(
    roundTrip({ h: 'x', b: 'yes' }),
    'h/hidden',
    'iD hides a category from its search, not from the map'
)
assert.equal(
    roundTrip({ r: 'road', bridge: 'yes' }),
    'r/road',
    'the iD score ranks the categories'
)
assert.equal(
    roundTrip({ r: 'road', bridge: 'yes' }, 'r/road/bridge'),
    'r/road/bridge',
    'a chosen category stays while no other one has more of its tags'
)
assert.equal(roundTrip({ a: 'b', c: '' }), 'a/b', 'an empty value is no tag')

// a stale configId is dropped when the tags change, kept while it still fits
const restaurant = singleNode({ amenity: 'restaurant' })
assert.equal(restaurant.properties.configId, 'amenity/restaurant')
restaurant.properties.tags = { amenity: 'cafe' }
restaurant.properties.primaryTag = { key: 'amenity', value: 'cafe' }
setIconStyle(restaurant, catalog)
assert.equal(restaurant.properties.configId, 'amenity/cafe')
assert.equal(
    getConfigTag(restaurant, catalog).id,
    'amenity/cafe',
    'the edited object is described by its new category'
)
const unchanged = singleNode({ amenity: 'cafe' })
unchanged.properties.tags = { amenity: 'cafe', name: 'Chez Paul' }
setIconStyle(unchanged, catalog)
assert.equal(unchanged.properties.configId, 'amenity/cafe')
const stalePresets = [
    { id: 'shop/old', tags: { shop: 'old' }, presets: ['old'] },
    { id: 'shop/new', tags: { shop: 'new' }, presets: ['new'] },
]
assert.equal(
    getConfigTag(
        {
            properties: {
                configId: 'shop/old',
                tags: { shop: 'new' },
                primaryTag: { key: 'shop', value: 'new' },
            },
        },
        stalePresets
    ).id,
    'shop/new'
)
// a configId from a former catalog falls back to the tags
assert.equal(
    getConfigTag(
        {
            properties: {
                configId: 'shop/removed',
                tags: { shop: 'new' },
                primaryTag: { key: 'shop', value: 'new' },
            },
        },
        stalePresets
    ).id,
    'shop/new'
)

// a custom tag has an encoded ID and is found through its tags
const customPresets = [
    {
        id: 'shop%3Aextra/caf%C3%A9%20bar',
        tags: { 'shop:extra': 'café bar', shop: 'yes' },
        presets: [],
    },
    { id: 'shop/yes', tags: { shop: 'yes' }, presets: [] },
]
assert.equal(
    getConfigTag(
        {
            properties: {
                tags: { 'shop:extra': 'café bar', shop: 'yes' },
                primaryTag: { key: 'shop', value: 'yes' },
            },
        },
        customPresets
    ).id,
    'shop%3Aextra/caf%C3%A9%20bar'
)

// a more specific category brings its own brands instead of the parent ones
const brandCatalog = [
    {
        id: 'amenity/fast_food',
        tags: { amenity: 'fast_food' },
        presets: ['amenity#fast_food#brand', 'takeaway'],
        moreFields: ['wheelchair'],
    },
    {
        id: 'amenity/fast_food/burger',
        tags: { amenity: 'fast_food', cuisine: 'burger' },
        presets: ['amenity#fast_food#burger#brand'],
    },
    {
        id: 'amenity/fast_food/kebab',
        tags: { amenity: 'fast_food', cuisine: 'kebab' },
        presets: ['kebab_field'],
    },
]
const brandsOf = (tags) =>
    getConfigTag(
        { properties: { tags, primaryTag: { key: 'amenity', value: 'x' } } },
        brandCatalog
    ).presets
assert.deepEqual(brandsOf({ amenity: 'fast_food', cuisine: 'burger' }), [
    'takeaway',
    'amenity#fast_food#burger#brand',
])
assert.deepEqual(brandsOf({ amenity: 'fast_food', cuisine: 'kebab' }), [
    'amenity#fast_food#brand',
    'takeaway',
    'kebab_field',
])

// getConfigTag hands out a copy, the catalog stays untouched
const exactCopy = getConfigTag(
    {
        properties: {
            tags: { amenity: 'bench' },
            primaryTag: { key: 'amenity', value: 'bench' },
        },
    },
    catalog
)
exactCopy.tags.amenity = 'changed'
exactCopy.lbl.en = 'changed'
assert.equal(
    catalog.find((c) => c.id === 'amenity/bench').tags.amenity,
    'bench'
)
assert.notEqual(catalog.find((c) => c.id === 'amenity/bench').lbl.en, 'changed')

// --- multipolygons ---

const holeElements = [
    { type: 'node', id: 21, lat: 0, lon: 0 },
    { type: 'node', id: 22, lat: 0, lon: 0.1 },
    { type: 'node', id: 23, lat: 0.1, lon: 0.1 },
    { type: 'node', id: 24, lat: 0.1, lon: 0 },
    { type: 'node', id: 25, lat: 0.04, lon: 0.04 },
    { type: 'node', id: 26, lat: 0.04, lon: 0.06 },
    { type: 'node', id: 27, lat: 0.06, lon: 0.06 },
    { type: 'node', id: 28, lat: 0.06, lon: 0.04 },
    { type: 'way', id: 30, nodes: [21, 22, 23, 24, 21] },
    { type: 'way', id: 31, nodes: [25, 26, 27, 28, 25] },
]
const convertRelation = (relation, extraElements = []) =>
    convert(
        relationFixture([...holeElements, ...extraElements, relation]),
        {}
    ).geojson.features.find((feature) => feature.id === 'relation/40')

// an empty role means outer, a node member (label, admin_centre) draws nothing
const lenientPark = convertRelation(
    {
        type: 'relation',
        id: 40,
        tags: { type: 'multipolygon', leisure: 'park' },
        members: [
            { type: 'way', ref: 30, role: '' },
            { type: 'way', ref: 31, role: 'inner' },
            { type: 'node', ref: 21, role: 'label' },
            { type: 'node', ref: 999, role: 'admin_centre' },
        ],
    },
    []
)
assert.ok(lenientPark, 'the park is not dropped by its label node')
assert.equal(lenientPark.properties.way_geometry.type, 'Polygon')
assert.equal(
    lenientPark.properties.way_geometry.coordinates.length,
    2,
    'the inner ring is kept'
)

// a multipolygon stays an area (with its holes) whatever the way tag rules say
const holedCutline = convertRelation({
    type: 'relation',
    id: 40,
    tags: { type: 'multipolygon', man_made: 'cutline' },
    members: [
        { type: 'way', ref: 30, role: 'outer' },
        { type: 'way', ref: 31, role: 'inner' },
    ],
})
assert.equal(holedCutline.properties.way_geometry.type, 'Polygon')
assert.equal(holedCutline.properties.way_geometry.coordinates.length, 2)
assert.ok(holedCutline.properties.mesure > 0)

// a member that is not in the answer still prevents the geometry
const missingMember = convertRelation({
    type: 'relation',
    id: 40,
    tags: { type: 'multipolygon', leisure: 'park' },
    members: [
        { type: 'way', ref: 30, role: 'outer' },
        { type: 'way', ref: 777, role: 'outer' },
    ],
})
assert.equal(missingMember, undefined)

// --- merging a new answer into the cache ---

const cachedWay = (id, wayGeometry, representativePoint) => ({
    type: 'Feature',
    id,
    properties: { type: 'way', way_geometry: wayGeometry },
    geometry: { type: 'Point', coordinates: representativePoint },
})
const downloadedArea = {
    type: 'Feature',
    properties: {},
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
            ],
        ],
    },
}
const largePark = cachedWay(
    'way/park',
    {
        type: 'Polygon',
        coordinates: [
            [
                [-5, -5],
                [5, -5],
                [5, 5],
                [-5, 5],
                [-5, -5],
            ],
        ],
    },
    [0.5, 0.5]
)
const deletedWay = cachedWay(
    'way/deleted',
    {
        type: 'LineString',
        coordinates: [
            [0.2, 0.2],
            [3, 3],
        ],
    },
    [1.5, 1.5]
)
const deletedNode = pointFeature('node/deleted', [0.3, 0.3], 'gone')
const incompleteRelation = cachedWay(
    'relation/partial',
    {
        type: 'Polygon',
        coordinates: [
            [
                [0.4, 0.4],
                [2, 0.4],
                [2, 2],
                [0.4, 0.4],
            ],
        ],
    },
    [1, 1]
)
const cacheBefore = {
    type: 'FeatureCollection',
    features: [largePark, deletedWay, deletedNode, incompleteRelation],
}
const emptyAnswer = { type: 'FeatureCollection', features: [] }
assert.deepEqual(
    mergeOldNewGeojsonData(
        cacheBefore,
        emptyAnswer,
        downloadedArea,
        undefined
    ).features.map((feature) => feature.id),
    ['way/park'],
    'only objects with a node in the area are proven deleted'
)
assert.deepEqual(
    mergeOldNewGeojsonData(
        cacheBefore,
        emptyAnswer,
        downloadedArea,
        undefined,
        new Set(['relation/partial'])
    ).features.map((feature) => feature.id),
    ['way/park', 'relation/partial'],
    'an object of the answer that could not be built is never deleted'
)

// --- second download: the cache is merged and the areas are united ---

const secondAreaTree = {
    primaryKeys: ['amenity'],
    tagConfig: [
        {
            id: 'amenity/bench',
            tags: { amenity: 'bench' },
            icon: 'maki-bench',
            markerColor: '#123456',
            presets: [],
        },
    ],
}
const benchAt = (id, lat, lon) => ({
    type: 'node',
    id,
    lat,
    lon,
    tags: { amenity: 'bench' },
})
const firstDownload = convert(
    {
        bounds: { minlat: 0, minlon: 0, maxlat: 1, maxlon: 1 },
        elements: [benchAt(1, 0.2, 0.2), benchAt(2, 0.8, 0.8)],
    },
    { ...secondAreaTree, oldGeojson: undefined }
)
assert.equal(firstDownload.geojsonBbox, null)
const secondDownload = convert(
    {
        bounds: { minlat: 0.5, minlon: 0.5, maxlat: 1.5, maxlon: 1.5 },
        // bench 2 was removed from the map, bench 3 is new
        elements: [benchAt(3, 1.2, 1.2)],
    },
    {
        ...secondAreaTree,
        oldGeojson: firstDownload.geojson,
        geojsonChanged: { type: 'FeatureCollection', features: [] },
        oldBboxFeature: downloadedArea,
    }
)
assert.deepEqual(
    secondDownload.geojson.features.map((feature) => feature.id).sort(),
    ['node/1', 'node/3'],
    'bench 2 is gone, bench 1 (outside of the second area) is kept'
)
assert.equal(secondDownload.geojsonBbox.features.length, 1)
const unitedArea = secondDownload.geojsonBbox.features[0].geometry
assert.equal(unitedArea.type, 'MultiPolygon')
const unitedPoints = unitedArea.coordinates[0][0].map(([x, y]) => `${x},${y}`)
for (const corner of ['0,0', '1.5,1.5', '0,1', '1.5,0.5']) {
    assert.ok(unitedPoints.includes(corner), `${corner} is a corner`)
}

// a relation of the answer whose members are cut by the area stays cached
const parkConfig = {
    primaryKeys: ['leisure'],
    tagConfig: [
        {
            id: 'leisure/park',
            tags: { leisure: 'park' },
            icon: 'maki-park',
            markerColor: '#123456',
            presets: [],
        },
    ],
}
const parkRelation = {
    type: 'relation',
    id: 40,
    tags: { type: 'multipolygon', leisure: 'park' },
    members: [{ type: 'way', ref: 30, role: 'outer' }],
}
const firstParkDownload = convert(
    {
        bounds: { minlat: 0, minlon: 0, maxlat: 1, maxlon: 1 },
        elements: [...holeElements.slice(0, 4), holeElements[8], parkRelation],
    },
    parkConfig
)
assert.deepEqual(
    firstParkDownload.geojson.features.map((feature) => feature.id),
    ['relation/40']
)
const cutParkDownload = convert(
    {
        bounds: { minlat: 0.05, minlon: 0.05, maxlat: 1, maxlon: 1 },
        // only the relation is in the answer: its outer way lies elsewhere
        elements: [parkRelation],
    },
    {
        ...parkConfig,
        oldGeojson: firstParkDownload.geojson,
        geojsonChanged: { type: 'FeatureCollection', features: [] },
        oldBboxFeature: downloadedArea,
    }
)
assert.deepEqual(
    cutParkDownload.geojson.features.map((feature) => feature.id),
    ['relation/40']
)
const deletedParkDownload = convert(
    {
        bounds: { minlat: 0.05, minlon: 0.05, maxlat: 1, maxlon: 1 },
        elements: [],
    },
    {
        ...parkConfig,
        oldGeojson: firstParkDownload.geojson,
        geojsonChanged: { type: 'FeatureCollection', features: [] },
        oldBboxFeature: downloadedArea,
    }
)
assert.deepEqual(deletedParkDownload.geojson.features, [])

// A multipolygon cut by the edge of the downloaded area is completed with its
// full version, without adding the outside objects to the result.
const incompleteFixture = JSON.parse(
    fs.readFileSync(
        path.join(fixturePath, 'incomplete-multipolygon.json'),
        'utf8'
    )
)
assert.deepEqual(
    findIncompleteMultipolygons(incompleteFixture.map, {
        primaryKeys: tagConfig.primaryKeys,
    }),
    [40]
)
assert.deepEqual(
    findIncompleteMultipolygons(JSON.stringify(incompleteFixture.map), {
        primaryKeys: tagConfig.primaryKeys,
        limit: 0,
    }),
    []
)
// a cut wood or lake is not worth a follow-up request
for (const tags of [
    { type: 'multipolygon', natural: 'wood', name: 'Bois' },
    { type: 'multipolygon', natural: 'water', water: 'lake' },
]) {
    const largeSurface = structuredClone(incompleteFixture.map)
    largeSurface.elements.find(
        (element) => element.type === 'relation' && element.id === 40
    ).tags = tags
    assert.deepEqual(
        findIncompleteMultipolygons(largeSurface, {
            primaryKeys: tagConfig.primaryKeys,
        }),
        [],
        JSON.stringify(tags)
    )
}
const withoutSupplement = convert(incompleteFixture.map, {
    tagConfig: tagConfig.tags,
    primaryKeys: tagConfig.primaryKeys,
})
assert.deepEqual(withoutSupplement.geojson.features, [])
const withSupplement = convert(incompleteFixture.map, {
    tagConfig: tagConfig.tags,
    primaryKeys: tagConfig.primaryKeys,
    supplementalElements: incompleteFixture.relationFull.elements,
})
assert.deepEqual(
    withSupplement.geojson.features.map((feature) => feature.id),
    ['relation/40']
)
const completedPark = withSupplement.geojson.features[0]
assert.equal(completedPark.properties.way_geometry.type, 'Polygon')
assert.equal(completedPark.properties.way_geometry.coordinates[0].length, 7)
assert.equal(completedPark.properties.meta.version, 3)
assert.deepEqual(
    convert(incompleteFixture.map, {
        tagConfig: tagConfig.tags,
        primaryKeys: tagConfig.primaryKeys,
        supplementalElements: 'not elements',
    }).geojson.features,
    []
)
