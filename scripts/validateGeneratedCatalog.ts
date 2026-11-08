import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
    assetsDir,
    tapBrandPresetsPath,
    tapPresetsPath,
    tapTagsPath,
} from './_paths'
import { isUnsupportedField, MULTI_VALUE_FIELD_TYPES } from './_utils'
import { isUnusableTileTemplate } from './basemap-utils'
import { convert, getConfigTag } from './osmToOsmgo/index.js'

interface TagConfig {
    id: string
    icon?: string
    presets: string[]
    moreFields?: string[]
    geometry: string[]
    tags: Record<string, string | number>
    addTags?: Record<string, string | number>
    lbl?: Record<string, string>
    deprecated?: boolean
    matchScore?: number
}

interface PresetOption {
    v: string
    countryCodes?: string[]
    excludeCountryCodes?: string[]
}

interface Preset {
    key?: string
    keys?: string[]
    type?: string
    iDtype?: string
    options?: PresetOption[]
}

type CatalogGeometry = 'point' | 'vertex' | 'line' | 'area' | 'relation'

interface ConvertedFeature {
    id: string
    geometry: { type: string }
    properties: {
        type: string
        configId?: string
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

// A brand can have one option per country variant (McDonald's in Ukraine):
// a value picks a single option wherever it is offered.
const assertOneBrandOptionPerCountry = (
    presetId: string,
    options: PresetOption[]
): void => {
    const byValue = new Map<string, PresetOption[]>()
    for (const option of options) {
        byValue.set(option.v, [...(byValue.get(option.v) ?? []), option])
    }
    for (const variants of byValue.values()) {
        if (variants.length === 1) continue
        const worldwide = variants.filter((option) => !option.countryCodes)
        assert.ok(
            worldwide.length <= 1,
            `${presetId} offers ${variants[0].v} twice worldwide`
        )
        const regionalCodes = variants.flatMap(
            (option) => option.countryCodes ?? []
        )
        unique(regionalCodes, `${presetId} countries of ${variants[0].v}`)
        assert.ok(
            regionalCodes.every(
                (code) =>
                    worldwide[0]?.excludeCountryCodes?.includes(code) ?? true
            ),
            `${presetId} offers ${variants[0].v} twice in a country`
        )
    }
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

type TagValues = Record<string, string | number>

// iD writes "*" for "any value": a concrete object carries "yes" instead.
const concreteTags = (tags: TagValues): TagValues =>
    Object.fromEntries(
        Object.entries(tags).map(([key, value]) => [
            key,
            value === '*' ? 'yes' : value,
        ])
    )

const relationElements = (
    tag: TagConfig,
    tags: TagValues
): { elements: Array<Record<string, unknown>>; featureId: string } => {
    if (tag.tags.type === 'multipolygon') {
        return {
            elements: [
                ...fixtureNodes,
                { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1] },
                {
                    type: 'relation',
                    id: 20,
                    tags,
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
                    tags,
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
                    tags,
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
    geometry: CatalogGeometry,
    objectTags: TagValues
): { elements: Array<Record<string, unknown>>; featureId: string } => {
    if (geometry === 'relation') return relationElements(tag, objectTags)

    const tags =
        geometry === 'area' && objectTags.area === undefined
            ? { ...objectTags, area: 'yes' }
            : objectTags
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

const convertFixture = (
    tag: TagConfig,
    geometry: CatalogGeometry,
    objectTags: TagValues
): ConvertedFeature | undefined => {
    const fixture = geometryFixture(tag, geometry, objectTags)
    const result = convert(
        { bounds: fixtureBounds, elements: fixture.elements },
        {
            tagConfig: tagsConfig.tags,
            primaryKeys: tagsConfig.primaryKeys,
        }
    )
    return result.geojson.features.find(
        (candidate: ConvertedFeature) => candidate.id === fixture.featureId
    ) as ConvertedFeature | undefined
}

const assertGeometryIsRendered = (
    tag: TagConfig,
    geometry: CatalogGeometry
): void => {
    const feature = convertFixture(tag, geometry, concreteTags(tag.tags))
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

const roundTripProblems: string[] = []

const isSubsetOf = (tags: TagValues, supersetTags: TagValues): boolean =>
    Object.entries(tags).every(([key, value]) => {
        const other = supersetTags[key]
        return (
            other !== undefined &&
            (value === '*' || other === '*' || String(other) === String(value))
        )
    })

// Converting what a category writes (its tags, then its tags and addTags)
// must give the category back, or a more specific one that carries all of its
// tags.
const checkRoundTrip = (
    tag: TagConfig,
    geometry: CatalogGeometry,
    objectTags: TagValues,
    label: string
): void => {
    const feature = convertFixture(tag, geometry, concreteTags(objectTags))
    const resolvedId = feature?.properties.configId
    if (!resolvedId || resolvedId === tag.id) {
        if (!resolvedId) {
            roundTripProblems.push(`${tag.id} (${geometry}, ${label}) is lost`)
        }
        return
    }
    const resolved = tagsConfig.tags.find(
        (candidate) => candidate.id === resolvedId
    )
    if (resolved && isSubsetOf(tag.tags, resolved.tags)) return
    // iD scores the road bridge below the road it is made of on purpose
    if (
        resolved &&
        tag.id.startsWith(`${resolved.id}/`) &&
        (tag.matchScore ?? 1) < (resolved.matchScore ?? 1)
    ) {
        return
    }
    roundTripProblems.push(
        `${tag.id} (${geometry}, ${label}) resolves to ${resolvedId}`
    )
}

const supportedGeometries = new Set([
    'point',
    'vertex',
    'line',
    'area',
    'relation',
])
const withoutFrenchLabel: string[] = []
const tagIds = tagsConfig.tags.map((tag) => tag.id)
const presetIds = Object.keys(presets)
const spriteIds = Object.keys(sprites)
// About 15 % above the generated sizes of November 2026 (tags 5.36 MB,
// presets 2.15 MB, brands 4.95 MB): an iD or NSI update fits, a jump beyond
// is a drift to look at before raising a budget.
const generatedFileBudgets = new Map([
    [tapTagsPath, 6_200_000],
    [tapPresetsPath, 2_500_000],
    [tapBrandPresetsPath, 5_700_000],
    [path.join(assetsDir, 'imagery.json'), 1_000_000],
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
    const isBrandList = (presetId: string): boolean =>
        presetId.endsWith('#brand')
    const hasOwnBrands = tag.presets.some(isBrandList)
    const expectedPresets = [
        ...new Set(
            ancestors.flatMap((ancestor) =>
                ancestor.presets.filter(
                    (presetId) =>
                        ancestor === tag ||
                        !hasOwnBrands ||
                        !isBrandList(presetId)
                )
            )
        ),
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
        checkRoundTrip(tag, geometry, tag.tags, 'tags')
        checkRoundTrip(
            tag,
            geometry,
            { ...tag.tags, ...tag.addTags },
            'tags and addTags'
        )
    }
    for (const presetId of [...tag.presets, ...(tag.moreFields ?? [])]) {
        assert.ok(presets[presetId], `${tag.id} references missing ${presetId}`)
        assert.ok(
            !isUnsupportedField(presets[presetId]),
            `${tag.id} references ${presetId}, a field keyed by a prefix that is not a multiCombo`
        )
    }
    assert.ok(tag.icon, `${tag.id} must have an icon`)
    assert.ok(sprites[tag.icon], `${tag.id} references missing ${tag.icon}`)
    if (!tag.lbl?.fr) {
        withoutFrenchLabel.push(tag.id)
    }
}

// A school, a station or a bus stop housed in a building stays what it is:
// like iD, a building only wins over the categories that score below it
// (barrier=wall, public_transport=station).
const buildingScore =
    tagsConfig.tags.find((tag) => tag.id === 'building/yes')?.matchScore ?? 1
for (const tag of tagsConfig.tags) {
    if (
        tag.deprecated ||
        'building' in tag.tags ||
        'building' in (tag.addTags ?? {}) ||
        (tag.matchScore ?? 1) < buildingScore
    ) {
        continue
    }
    const geometry = (
        tag.geometry.includes('area') ? 'area' : tag.geometry[0]
    ) as CatalogGeometry
    if (geometry === 'relation') continue
    checkRoundTrip(
        tag,
        geometry,
        { ...tag.tags, building: 'yes' },
        'tags and building=yes'
    )
    checkRoundTrip(
        tag,
        geometry,
        { ...tag.tags, ...tag.addTags, building: 'yes' },
        'tags, addTags and building=yes'
    )
}

for (const primaryKey of tagsConfig.primaryKeys) {
    assert.ok(
        tagsConfig.tags.some((tag) => primaryKey in tag.tags),
        `Primary key ${primaryKey} is not used by any category`
    )
}

assert.deepEqual(
    roundTripProblems,
    [],
    'Converting what a category writes must give the category back'
)
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
    if (presetId.endsWith('#brand')) {
        assertOneBrandOptionPerCountry(presetId, preset.options ?? [])
    } else {
        unique(
            (preset.options ?? []).map((option) => option.v),
            `${presetId} option values`
        )
    }
    // only a multiCombo writes under a key prefix (payment:cash=yes)
    assert.ok(
        !isUnsupportedField(preset),
        `${presetId} is keyed by a prefix but is not a multiCombo`
    )
    // a single choice would replace "pizza;italian" or male=yes by one value
    assert.ok(
        !MULTI_VALUE_FIELD_TYPES.includes(preset.iDtype ?? '') ||
            preset.type === preset.iDtype,
        `${presetId} holds several values and must keep its ${preset.iDtype} editor`
    )
    if (preset.type === 'manyCombo') {
        assert.ok(
            !preset.key &&
                (preset.options ?? []).length > 0 &&
                (preset.options ?? []).every((option) =>
                    preset.keys?.includes(option.v)
                ),
            `${presetId} must offer one option per field key`
        )
    }
    if (preset.type === 'multiCombo') {
        assert.ok(
            (preset.options ?? []).every(
                (option) =>
                    option.v.trim() &&
                    !option.v.startsWith(':') &&
                    !option.v.endsWith(':')
            ),
            `${presetId} options must complete its key prefix`
        )
    }
}

const imagery = JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'imagery.json'), 'utf8')
) as Array<{ properties: { id: string; tiles: string[] } }>
for (const layer of imagery) {
    assert.ok(
        !layer.properties.tiles.some(isUnusableTileTemplate),
        `${layer.properties.id} uses a tile URL that is not https or has an unresolved placeholder`
    )
}

// The labels come from iD: they are listed, never invented. The cap keeps the
// list from growing.
const MAX_WITHOUT_FRENCH_LABEL = 10
if (withoutFrenchLabel.length > 0) {
    console.warn(
        `${withoutFrenchLabel.length} categories have no French label: ${withoutFrenchLabel.join(', ')}`
    )
}
assert.ok(
    withoutFrenchLabel.length <= MAX_WITHOUT_FRENCH_LABEL,
    `${withoutFrenchLabel.length} categories have no French label (${MAX_WITHOUT_FRENCH_LABEL} allowed)`
)

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
