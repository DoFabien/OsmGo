import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
    assetsDir,
    tapBrandPresetsPath,
    tapPresetsPath,
    tapTagsPath,
} from './_paths'
import { convert, getConfigTag } from './osmToOsmgo/index.js'

interface TagConfig {
    id: string
    icon?: string
    presets: string[]
    moreFields?: string[]
    geometry: string[]
    tags: Record<string, string | number>
}

interface Preset {
    key?: string
    keys?: string[]
    options?: Array<{ v: string }>
}

type CatalogGeometry = 'point' | 'vertex' | 'line' | 'area' | 'relation'

interface ConvertedFeature {
    id: string
    geometry: { type: string }
    properties: {
        type: string
        usedByWays?: string[]
        way_geometry?: { type: string }
    }
}

const tagsConfig = JSON.parse(fs.readFileSync(tapTagsPath, 'utf8')) as {
    primaryKeys: string[]
    tags: TagConfig[]
}
const basePresets = JSON.parse(
    fs.readFileSync(tapPresetsPath, 'utf8')
) as Record<string, Preset>
const brandPresets = JSON.parse(
    fs.readFileSync(tapBrandPresetsPath, 'utf8')
) as Record<string, Preset>
const presets = { ...basePresets, ...brandPresets }
const spritesDirectory = path.join(assetsDir, 'mapStyle', 'sprites')
const sprites = JSON.parse(
    fs.readFileSync(path.join(spritesDirectory, 'sprites.json'), 'utf8')
) as Record<string, unknown>
const sprites2x = JSON.parse(
    fs.readFileSync(path.join(spritesDirectory, 'sprites@2x.json'), 'utf8')
) as Record<string, unknown>

const unique = (values: string[], label: string): void => {
    assert.equal(new Set(values).size, values.length, `${label} must be unique`)
}

const fixtureBounds = {
    minlat: 0,
    minlon: 0,
    maxlat: 1,
    maxlon: 1,
}
const fixtureNodes = [
    { type: 'node', id: 1, lat: 0, lon: 0 },
    { type: 'node', id: 2, lat: 0, lon: 0.01 },
    { type: 'node', id: 3, lat: 0.01, lon: 0.01 },
    { type: 'node', id: 4, lat: 0.01, lon: 0 },
]

const relationElements = (
    tag: TagConfig
): { elements: Array<Record<string, unknown>>; featureId: string } => {
    if (tag.tags.type === 'multipolygon') {
        return {
            elements: [
                ...fixtureNodes,
                { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1] },
                {
                    type: 'relation',
                    id: 20,
                    tags: tag.tags,
                    members: [{ type: 'way', ref: 10, role: 'outer' }],
                },
            ],
            featureId: 'relation/20',
        }
    }
    if (tag.tags.type === 'multilinestring') {
        return {
            elements: [
                ...fixtureNodes.slice(0, 2),
                { type: 'way', id: 10, nodes: [1, 2] },
                {
                    type: 'relation',
                    id: 20,
                    tags: tag.tags,
                    members: [{ type: 'way', ref: 10, role: '' }],
                },
            ],
            featureId: 'relation/20',
        }
    }
    if (
        tag.tags.type === 'public_transport' &&
        tag.tags.public_transport === 'stop_area'
    ) {
        return {
            elements: [
                fixtureNodes[0],
                {
                    type: 'relation',
                    id: 20,
                    tags: tag.tags,
                    members: [{ type: 'node', ref: 1, role: 'stop' }],
                },
            ],
            featureId: 'relation/20',
        }
    }
    assert.fail(
        `${tag.id} declares relation geometry without a compatible converter constructor`
    )
}

const geometryFixture = (
    tag: TagConfig,
    geometry: CatalogGeometry
): { elements: Array<Record<string, unknown>>; featureId: string } => {
    if (geometry === 'relation') return relationElements(tag)

    const tags =
        geometry === 'area' && tag.tags.area === undefined
            ? { ...tag.tags, area: 'yes' }
            : tag.tags
    if (geometry === 'point') {
        return {
            elements: [{ ...fixtureNodes[0], tags }],
            featureId: 'node/1',
        }
    }
    if (geometry === 'vertex') {
        return {
            elements: [
                { ...fixtureNodes[0], tags },
                fixtureNodes[1],
                { type: 'way', id: 10, nodes: [1, 2] },
            ],
            featureId: 'node/1',
        }
    }

    return {
        elements: [
            ...(geometry === 'area' ? fixtureNodes : fixtureNodes.slice(0, 2)),
            {
                type: 'way',
                id: 10,
                nodes: geometry === 'area' ? [1, 2, 3, 4, 1] : [1, 2],
                tags,
            },
        ],
        featureId: 'way/10',
    }
}

const assertGeometryIsRendered = (
    tag: TagConfig,
    geometry: CatalogGeometry
): void => {
    const fixture = geometryFixture(tag, geometry)
    const result = convert(
        { bounds: fixtureBounds, elements: fixture.elements },
        {
            tagConfig: tagsConfig.tags,
            primaryKeys: tagsConfig.primaryKeys,
        }
    )
    const feature = result.geojson.features.find(
        (candidate: ConvertedFeature) => candidate.id === fixture.featureId
    ) as ConvertedFeature | undefined
    assert.ok(feature, `${tag.id} cannot render declared ${geometry} geometry`)

    const sourceGeometry = feature.properties.way_geometry ?? feature.geometry
    const isExpectedGeometry =
        geometry === 'point'
            ? sourceGeometry.type === 'Point' &&
              !feature.properties.usedByWays?.length
            : geometry === 'vertex'
              ? sourceGeometry.type === 'Point' &&
                Boolean(feature.properties.usedByWays?.length)
              : geometry === 'line'
                ? ['LineString', 'MultiLineString'].includes(
                      sourceGeometry.type
                  )
                : geometry === 'area'
                  ? ['Polygon', 'MultiPolygon'].includes(sourceGeometry.type)
                  : feature.properties.type === 'relation'
    assert.ok(
        isExpectedGeometry,
        `${tag.id} renders ${sourceGeometry.type} instead of declared ${geometry} geometry`
    )
}

const supportedGeometries = new Set([
    'point',
    'vertex',
    'line',
    'area',
    'relation',
])
const tagIds = tagsConfig.tags.map((tag) => tag.id)
const presetIds = Object.keys(presets)
const spriteIds = Object.keys(sprites)
const generatedFileBudgets = new Map([
    [tapTagsPath, 8_000_000],
    [tapPresetsPath, 3_500_000],
    [tapBrandPresetsPath, 6_500_000],
    [path.join(assetsDir, 'imagery.json'), 3_500_000],
])

unique(tagIds, 'Tag IDs')
assert.ok(
    Object.keys(basePresets).every((id) => !id.endsWith('#brand')),
    'Base presets must not contain brand catalogs'
)
assert.ok(
    Object.keys(brandPresets).every((id) => id.endsWith('#brand')),
    'The lazy brand catalog must only contain brand presets'
)
unique(tagsConfig.primaryKeys, 'Primary keys')
assert.deepEqual(
    Object.keys(sprites2x).sort(),
    [...spriteIds].sort(),
    'DPR 1 and DPR 2 sprite indexes must contain the same IDs'
)

for (const tag of tagsConfig.tags) {
    assert.ok(tag.id.trim(), 'Every tag must have a non-empty ID')
    assert.ok(
        tag.id.split('/').every((segment) => segment.trim()),
        `${tag.id} must use non-empty hierarchy segments`
    )
    assert.ok(
        Object.keys(tag.tags).some((key) =>
            tagsConfig.primaryKeys.includes(key)
        ),
        `${tag.id} must use a declared primary key`
    )
    assert.ok(
        tag.geometry.length > 0 &&
            tag.geometry.every((geometry) => supportedGeometries.has(geometry)),
        `${tag.id} must only use supported geometries`
    )
    unique(tag.presets, `${tag.id} presets`)
    unique(tag.moreFields ?? [], `${tag.id} additional fields`)

    const ancestors = tagsConfig.tags.filter(
        (candidate) =>
            candidate.id === tag.id || tag.id.startsWith(`${candidate.id}/`)
    )
    const expectedPresets = [
        ...new Set(ancestors.flatMap((ancestor) => ancestor.presets)),
    ]
    const expectedMoreFields = [
        ...new Set(ancestors.flatMap((ancestor) => ancestor.moreFields ?? [])),
    ]
    const primaryTag = Object.entries(tag.tags).find(([key]) =>
        tagsConfig.primaryKeys.includes(key)
    )
    assert.ok(primaryTag, `${tag.id} must have a usable primary tag`)
    const inheritedConfig = getConfigTag(
        {
            properties: {
                configId: tag.id,
                primaryTag: { key: primaryTag[0], value: primaryTag[1] },
                tags: tag.tags,
            },
        },
        tagsConfig.tags
    )
    assert.equal(
        inheritedConfig.id,
        tag.id,
        `${tag.id} must resolve to its exact hierarchy entry`
    )
    assert.deepEqual(
        inheritedConfig.presets,
        expectedPresets,
        `${tag.id} must inherit presets only from slash-delimited ancestors`
    )
    assert.deepEqual(
        inheritedConfig.moreFields,
        expectedMoreFields,
        `${tag.id} must inherit additional fields only from slash-delimited ancestors`
    )

    if (tag.tags.type !== undefined) {
        assert.ok(
            tag.geometry.includes('relation'),
            `${tag.id} uses relation type=${tag.tags.type} without declaring relation geometry`
        )
    }
    for (const geometry of tag.geometry as CatalogGeometry[]) {
        assertGeometryIsRendered(tag, geometry)
    }
    for (const presetId of [...tag.presets, ...(tag.moreFields ?? [])]) {
        assert.ok(presets[presetId], `${tag.id} references missing ${presetId}`)
    }
    if (tag.icon) {
        assert.ok(sprites[tag.icon], `${tag.id} references missing ${tag.icon}`)
    }
}

assert.ok(sprites['maki-circle'], 'The fallback map icon must exist')
for (const [presetId, preset] of Object.entries(presets)) {
    const fieldKeys = [
        ...(preset.key ? [preset.key] : []),
        ...(preset.keys ?? []),
    ]
    assert.ok(
        fieldKeys.length > 0 && fieldKeys.every((key) => key.trim()),
        `${presetId} must define valid field keys`
    )
    unique(preset.keys ?? [], `${presetId} alternative field keys`)
    unique(
        (preset.options ?? []).map((option) => option.v),
        `${presetId} option values`
    )
}

// Progressive floors catch accidental truncation while allowing upstream
// cleanup without pinning an exact generated result.
assert.ok(tagIds.length >= 1500, 'Generated tag count dropped below 1500')
assert.ok(presetIds.length >= 850, 'Generated preset count dropped below 850')
assert.ok(spriteIds.length >= 700, 'Generated sprite count dropped below 700')

for (const fileName of ['sprites.png', 'sprites@2x.png']) {
    assert.ok(
        fs.statSync(path.join(spritesDirectory, fileName)).size > 0,
        `${fileName} must be a non-empty file`
    )
}

for (const [filePath, maximumBytes] of generatedFileBudgets) {
    assert.ok(
        fs.statSync(filePath).size <= maximumBytes,
        `${path.basename(filePath)} exceeds its ${maximumBytes} byte budget`
    )
}

console.log(
    `Generated catalog valid: ${tagIds.length} tags, ${presetIds.length} presets, ${spriteIds.length} sprites.`
)
