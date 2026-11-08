import area from '@turf/area'
import bboxPolygon from '@turf/bbox-polygon'
import length from '@turf/length'
import pointOnFeature from '@turf/point-on-feature'

import * as martinez from 'martinez-polygon-clipping'

const inside = (point, vs) => {
    // ray-casting algorithm based on
    // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html

    const x = point[0],
        y = point[1]

    let isInside = false
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        const xi = vs[i][0],
            yi = vs[i][1]
        const xj = vs[j][0],
            yj = vs[j][1]
        const intersect =
            yi > y != yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
        if (intersect) isInside = !isInside
    }
    return isInside
}

const osmElementId = (type, id) => {
    const value = String(id)
    return value.startsWith(`${type}/`) ? value : `${type}/${value}`
}

const normalizeRelationMembers = (members) => {
    const values = Array.isArray(members) ? members : members ? [members] : []
    return values
        .filter(
            (member) =>
                member &&
                ['node', 'way', 'relation'].includes(member.type) &&
                member.ref !== undefined &&
                member.ref !== null
        )
        .map((member) => ({
            type: member.type,
            ref: member.ref,
            role: typeof member.role === 'string' ? member.role : '',
        }))
}

export const wayToPoint = (feature) => {
    // /!\ mutable !

    if (feature.geometry.type !== 'Point') {
        // stock the original geometry in  feature.properties.way_geometry  .way_geometry
        feature.properties.way_geometry = { ...feature.geometry }
        switch (feature.geometry.type) {
            case 'Polygon':
            case 'MultiPolygon':
                feature.properties['mesure'] = area(feature.geometry)
                break
            case 'LineString':
            case 'MultiLineString':
                // May be we can use CheapRuler
                feature.properties['mesure'] = length(feature)
                break
        }
        feature.geometry = pointOnFeature(feature.geometry).geometry
    }
}

/**
 * Check if the given tags describe a way that should be a polygon given OSM wiki definition:
 * https://wiki.openstreetmap.org/wiki/Overpass_turbo/Polygon_Features
 * @param {*} tags
 * @returns true if the tags describe a way that is 'always' a polygon
 */
const wayIsRealyPolygon = (tags) => {
    if (tags['area'] === 'no') return false
    const keys = Object.keys(tags)
    // is always polygon
    // TODO TEST if (keys.includes('area:highway') && tags['area:highway'] !== "no") return true;
    // FROM : https://github.com/tyrasd/osm-polygon-features/blob/master/polygon-features.json
    if (keys.includes('building') && tags['building'] !== 'no') return true
    if (keys.includes('landuse') && tags['landuse'] !== 'no') return true
    if (keys.includes('amenity') && tags['amenity'] !== 'no') return true
    if (keys.includes('leisure') && tags['leisure'] !== 'no') return true
    if (keys.includes('area') && tags['area'] !== 'no') return true
    if (keys.includes('place') && tags['place'] !== 'no') return true
    if (keys.includes('shop') && tags['shop'] !== 'no') return true
    if (keys.includes('boundary') && tags['boundary'] !== 'no') return true
    if (keys.includes('tourism') && tags['tourism'] !== 'no') return true
    if (keys.includes('historic') && tags['historic'] !== 'no') return true
    if (keys.includes('public_transport') && tags['public_transport'] !== 'no')
        return true
    if (keys.includes('office') && tags['office'] !== 'no') return true
    if (keys.includes('building:part') && tags['building:part'] !== 'no')
        return true
    if (keys.includes('military') && tags['military'] !== 'no') return true
    if (keys.includes('ruins') && tags['ruins'] !== 'no') return true
    if (keys.includes('craft') && tags['craft'] !== 'no') return true
    if (keys.includes('golf') && tags['golf'] !== 'no') return true
    if (keys.includes('indoor') && tags['indoor'] !== 'no') return true

    if (
        keys.includes('highway') &&
        ['services', 'rest_area', 'escape', 'elevator'].includes(
            tags['highway']
        )
    )
        return true
    if (
        keys.includes('waterway') &&
        ['riverbank', 'dock', 'boatyard', 'dam'].includes(tags['waterway'])
    )
        return true
    if (
        keys.includes('barrier') &&
        [
            'city_wall',
            'ditch',
            'hedge',
            'retaining_wall',
            'wall',
            'spikes',
        ].includes(tags['barrier'])
    )
        return true
    if (
        keys.includes('railway') &&
        ['station', 'turntable', 'roundhouse', 'platform'].includes(
            tags['railway']
        )
    )
        return true
    if (
        keys.includes('power') &&
        ['plant', 'substation', 'generator', 'transformer'].includes(
            tags['power']
        )
    )
        return true

    if (
        keys.includes('natural') &&
        !['coastline', 'cliff', 'ridge', 'arete', 'tree_row'].includes(
            tags['natural']
        )
    )
        return true
    if (
        keys.includes('man_made') &&
        !['cutline', 'embankment', 'pipeline'].includes(tags['man_made'])
    )
        return true
    if (keys.includes('aeroway') && !['taxiway'].includes(tags['aeroway']))
        return true
    return false
}

const isFilteredByKeys = (tags, keysFilter) => {
    // true => in final result
    if (!keysFilter) return true
    if (!tags) return false
    const keys = Object.keys(tags)

    for (const k of keys) {
        if (keysFilter.includes(k)) {
            return true
        }
    }
    return false
}

// An empty value (amenity=) only stands for the object when no other primary
// key has a value, as in TagsService.findPkey.
const getPrimaryKeyOfObject = (feature, primaryKeys) => {
    const tags = feature.properties.tags
    let fallback = null
    for (const key of primaryKeys) {
        if (!Object.hasOwn(tags, key)) continue
        if (tags[key] !== '') return { key, value: tags[key] }
        fallback ??= { key, value: tags[key] }
    }
    return fallback
}

const tagConfigIndexCache = new WeakMap()

const getTagConfigIndex = (presets) => {
    const cached = tagConfigIndexCache.get(presets)
    if (cached) return cached

    const byId = new Map()
    const order = new Map()
    const byPair = new Map()
    const signatures = new Map()
    presets.forEach((variant, position) => {
        byId.set(variant.id, variant)
        order.set(variant, position)
        signatures.set(
            variant,
            JSON.stringify(Object.entries(variant.tags).sort())
        )
        for (const [key, value] of Object.entries(variant.tags)) {
            let values = byPair.get(key)
            if (!values) {
                values = new Map()
                byPair.set(key, values)
            }
            const variants = values.get(String(value))
            if (variants) {
                variants.push(variant)
            } else {
                values.set(String(value), [variant])
            }
        }
    })

    const index = {
        byId,
        order,
        byPair,
        signatures,
        inheritedById: new Map(),
    }
    tagConfigIndexCache.set(presets, index)
    return index
}

const hasTag = (tags, key, value) =>
    tags[key] !== undefined &&
    tags[key] !== null &&
    (value === '*' ? tags[key] !== '' : String(tags[key]) === String(value))

// A deprecated category whose upgrade would change nothing (railway=platform
// already written with public_transport=platform) no longer describes the
// object.
const isAlreadyUpgraded = (variant, tags) =>
    Boolean(variant.deprecated && variant.replace) &&
    Object.keys(variant.tags).every((key) =>
        Object.hasOwn(variant.replace, key)
    ) &&
    Object.entries(variant.replace).every(([key, value]) =>
        hasTag(tags, key, value)
    )

// Every exact tag counts 1, a "*" tag 0.5 and addTags that the object already
// carries count as extra evidence. A category whose tags are not all present
// on the object scores -1.
const countMatches = (variant, tags) => {
    let matches = 0
    for (const [key, value] of Object.entries(variant.tags)) {
        if (!hasTag(tags, key, value)) return -1
        matches += value === '*' ? 0.5 : 1
    }
    if (variant.addTags) {
        for (const [key, value] of Object.entries(variant.addTags)) {
            if (
                value !== '*' &&
                !Object.hasOwn(variant.tags, key) &&
                hasTag(tags, key, value)
            ) {
                matches += 1
            }
        }
    }
    return isAlreadyUpgraded(variant, tags) ? -1 : matches
}

// Mirrors the iD preset score: the matches weighed by the matchScore of the
// category (1 by default, 0.5 for a building).
const rankVariant = (variant, matches, primaryKey, index) => ({
    variant,
    matches,
    score: matches * (variant.matchScore ?? 1),
    hasPrimaryKey: Object.hasOwn(variant.tags, primaryKey),
    size: Object.keys(variant.tags).length,
    searchable: variant.searchable !== false,
    signature: index.signatures.get(variant),
    position: index.order.get(variant),
})

// The best score wins, then the category of the object's primary key, the
// category with the most tags and, between categories made of the same tags,
// the one that iD offers in its search. The catalog order settles the rest.
const isBetterRank = (candidate, best) =>
    !best ||
    candidate.score > best.score ||
    (candidate.score === best.score &&
        (candidate.hasPrimaryKey !== best.hasPrimaryKey
            ? candidate.hasPrimaryKey
            : candidate.size !== best.size
              ? candidate.size > best.size
              : candidate.searchable !== best.searchable &&
                  candidate.signature === best.signature
                ? candidate.searchable
                : candidate.position < best.position))

const findBestVariant = (tags, primaryKey, index) => {
    const seen = new Set()
    let best
    for (const [key, value] of Object.entries(tags)) {
        const values = index.byPair.get(key)
        if (!values) continue
        for (const variants of [values.get(String(value)), values.get('*')]) {
            if (!variants) continue
            for (const variant of variants) {
                if (seen.has(variant)) continue
                seen.add(variant)
                const matches = countMatches(variant, tags)
                if (matches < 0) continue
                const candidate = rankVariant(
                    variant,
                    matches,
                    primaryKey,
                    index
                )
                if (isBetterRank(candidate, best)) best = candidate
            }
        }
    }
    return best
}

const getInheritedConfigs = (featureID, index) => {
    const cached = index.inheritedById.get(featureID)
    if (cached) return cached

    const inherited = []
    let separator = featureID.indexOf('/')
    while (separator !== -1) {
        const parent = index.byId.get(featureID.slice(0, separator))
        if (parent) inherited.push(parent)
        separator = featureID.indexOf('/', separator + 1)
    }
    const exact = index.byId.get(featureID)
    if (exact) inherited.push(exact)
    inherited.sort(
        (left, right) => index.order.get(left) - index.order.get(right)
    )
    index.inheritedById.set(featureID, inherited)
    return inherited
}

// A configId only survives while the tags of its category are still on the
// object and no other category matches more of them; otherwise the object is
// matched again, so an edited object does not keep the category it had before.
// The iD weights only rank the categories that nobody chose (a road bridge
// picked by the user stays one).
const resolveVariant = (feature, presets) => {
    const index = getTagConfigIndex(presets)
    const tags = feature.properties.tags
    const primaryTag = feature.properties.primaryTag
    const best = findBestVariant(tags, primaryTag?.key ?? primaryTag?.k, index)
    const current = feature.properties.configId
        ? index.byId.get(feature.properties.configId)
        : undefined
    // a deprecated category is only kept while no other category fits
    if (current && !(current.deprecated && best && !best.variant.deprecated)) {
        const currentMatches = countMatches(current, tags)
        if (currentMatches >= 0 && (!best || currentMatches >= best.matches)) {
            return { variant: current, index }
        }
    }
    return { variant: best?.variant, index }
}

const isBrandPreset = (presetId) => presetId.endsWith('#brand')

const getUnknownTagConfig = (feature) => {
    const k = feature.properties.primaryTag.k ? 'k' : 'key'
    const v = feature.properties.primaryTag.k ? 'v' : 'value'

    const unkownsId = `${feature.properties.primaryTag[k]}/${feature.properties.primaryTag[v]}`
    const unkownsTagConfig = {
        key: feature.properties.primaryTag[k],
        icon: 'wiki-question',
        markerColor: '#000000',
        lbl: {
            en: `${feature.properties.primaryTag[k]} = ${feature.properties.primaryTag[v]}`,
        },
        presets: [],
        geometry: [],
        tags: {},
        id: unkownsId,
        unknowTags: true,
    }
    unkownsTagConfig['tags'][feature.properties.primaryTag[k]] =
        feature.properties.primaryTag[v]
    return unkownsTagConfig
}

export function getConfigTag(feature, presets) {
    const { variant, index } = resolveVariant(feature, presets)
    if (!variant) return getUnknownTagConfig(feature)

    const inherited = getInheritedConfigs(variant.id, index)
    const result = structuredClone(variant)
    // Presets and moreFields come from the slash-delimited parent IDs. The
    // brands of a more specific category (burger) replace those of its
    // parent (fast food) instead of adding a second brand field.
    const hasOwnBrands = (variant.presets ?? []).some(isBrandPreset)
    result.presets = [
        ...new Set(
            inherited.flatMap((config) =>
                (config.presets ?? []).filter(
                    (presetId) =>
                        config === variant ||
                        !hasOwnBrands ||
                        !isBrandPreset(presetId)
                )
            )
        ),
    ]
    result.moreFields = [
        ...new Set(inherited.flatMap((config) => config.moreFields ?? [])),
    ]
    return result
}

export function addAttributesToFeature(feature) {
    // /!\ mutable !
    // add properties values
    delete feature.properties['_name']
    delete feature.properties.fixme
    delete feature.properties.time
    if (feature.properties.tags.name) {
        feature.properties['_name'] = feature.properties.tags.name
    } else if (feature.properties.tags.ref) {
        feature.properties['_name'] = feature.properties.tags.ref
    }

    if (feature.properties.meta.timestamp) {
        feature.properties.time = new Date(
            feature.properties.meta.timestamp
        ).getTime()
    }
    if (feature.properties.tags.fixme) {
        feature.properties.fixme = true
    }
}

export function setIconStyle(feature, tagsConfig) {
    // /!\ mutable

    const configMarker =
        resolveVariant(feature, tagsConfig).variant ??
        getUnknownTagConfig(feature)
    delete feature.properties.unknowTags

    let markerShape
    if (feature.properties.type === 'node') {
        markerShape = 'circle'
    } else if (
        feature.properties.way_geometry.type === 'LineString' ||
        feature.properties.way_geometry.type === 'MultiLineString'
    ) {
        markerShape = 'penta'
    } else if (
        feature.properties.way_geometry.type === 'Polygon' ||
        feature.properties.way_geometry.type === 'MultiPolygon'
    ) {
        markerShape = 'square'
    } else {
        markerShape = 'star'
    }

    feature.properties.icon = configMarker.icon
        ? configMarker.icon
        : 'maki-circle'
    feature.properties.marker = `${markerShape}-${configMarker.markerColor}-${feature.properties.icon}`
    feature.properties.hexColor = configMarker.markerColor
    feature.properties.configId = configMarker.id
    if (configMarker.unknowTags) {
        feature.properties.unknowTags = true
    }

    if (configMarker.deprecated) {
        feature.properties['deprecated'] = configMarker.deprecated
    } else {
        if (feature.properties['deprecated']) {
            delete feature.properties['deprecated']
        }
    }
    addAttributesToFeature(feature)

    return feature
}

const getMergedGeojsonGeojsonChanged = (geojson, geojsonChanged) => {
    if (!geojsonChanged) {
        return geojson
    }
    const changedIds = new Set(
        geojsonChanged.features.map((feature) => feature.id)
    )
    return {
        ...geojson,
        features: geojson.features.filter(
            (feature) => !changedIds.has(feature.id)
        ),
    }
}

const bboxBounds = (bboxFeature) => {
    const ring = bboxFeature.geometry.coordinates[0]
    const longitudes = ring.map((coordinate) => coordinate[0])
    const latitudes = ring.map((coordinate) => coordinate[1])
    return [
        Math.min(...longitudes),
        Math.min(...latitudes),
        Math.max(...longitudes),
        Math.max(...latitudes),
    ]
}

const someCoordinate = (geometry, predicate) => {
    switch (geometry?.type) {
        case 'Point':
            return predicate(geometry.coordinates)
        case 'LineString':
        case 'MultiPoint':
            return geometry.coordinates.some(predicate)
        case 'Polygon':
        case 'MultiLineString':
            return geometry.coordinates.some((line) => line.some(predicate))
        case 'MultiPolygon':
            return geometry.coordinates.some((polygon) =>
                polygon.some((ring) => ring.some(predicate))
            )
        case 'GeometryCollection':
            return geometry.geometries.some((member) =>
                someCoordinate(member, predicate)
            )
        default:
            return false
    }
}

// The OSM map call returns every node of the area and every way or relation
// that uses one of them. A cached object that is missing from the answer is
// only proven deleted when one of its own nodes lies in the area: its
// representative point alone (a large park, a relation spanning the area)
// says nothing, because the object can simply be outside of the answer.
const isProvenAbsent = (feature, [west, south, east, north]) => {
    const isInside = ([longitude, latitude]) =>
        longitude >= west &&
        longitude <= east &&
        latitude >= south &&
        latitude <= north
    return someCoordinate(
        feature.properties?.way_geometry ?? feature.geometry,
        isInside
    )
}

export const mergeOldNewGeojsonData = (
    oldGeojson,
    newGeojson,
    newFeatureBbox,
    geojsonChanged,
    retainedIds
) => {
    const oldFeatures = oldGeojson.features ?? []
    const byId = new Map(oldFeatures.map((feature) => [feature.id, feature]))
    const bounds = bboxBounds(newFeatureBbox)
    const idsInsideBbox = new Set(
        oldFeatures
            .filter(
                (feature) =>
                    !retainedIds?.has(feature.id) &&
                    isProvenAbsent(feature, bounds)
            )
            .map((feature) => feature.id)
    )

    for (const feature of newGeojson.features ?? []) {
        byId.set(feature.id, feature)
        idsInsideBbox.delete(feature.id)
    }
    for (const deletedId of idsInsideBbox) {
        byId.delete(deletedId)
    }

    return getMergedGeojsonGeojsonChanged(
        {
            ...oldGeojson,
            features: [...byId.values()],
        },
        geojsonChanged
    )
}

const mergeBounds = (newBboxFeature, oldBboxFeature) => {
    if (!oldBboxFeature || oldBboxFeature.length === 0) {
        return { type: 'FeatureCollection', features: [newBboxFeature] }
    } else {
        // martinez union is fast !
        const unionBboxCoordinates = martinez.union(
            oldBboxFeature.geometry.coordinates,
            newBboxFeature.geometry.coordinates
        )
        const mergedFeature = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'MultiPolygon',
                coordinates: unionBboxCoordinates,
            },
        }
        return { type: 'FeatureCollection', features: [mergedFeature] }
    }
}

// A larger relation (a forest, a lake shore) would make the follow-up
// request heavy for one object.
const MAX_SUPPLEMENTED_RELATION_MEMBERS = 500

const isRingRole = (role) => role === '' || role === 'outer' || role === 'inner'

// A wood or a lake is huge and seldom edited here: completing it would add
// seconds to the download for one shape.
const LARGE_SURFACES = {
    natural: [
        'bare_rock',
        'beach',
        'glacier',
        'grassland',
        'heath',
        'sand',
        'scree',
        'scrub',
        'shingle',
        'water',
        'wetland',
        'wood',
    ],
    waterway: ['riverbank'],
    leisure: ['nature_reserve'],
}

const isLargeSurface = (tags, primaryKeys) => {
    const primaryTag = getPrimaryKeyOfObject(
        { properties: { tags } },
        primaryKeys ?? Object.keys(tags)
    )
    return Boolean(
        primaryTag &&
            LARGE_SURFACES[primaryTag.key]?.includes(String(primaryTag.value))
    )
}

// The map call only returns the ways that touch the area: a multipolygon that
// crosses its edge misses some of its rings and cannot be drawn. Its full
// version (`relation/{id}/full`) can then be given as supplemental elements.
export const findIncompleteMultipolygons = (osmData, options = {}) => {
    const osm = typeof osmData == 'string' ? JSON.parse(osmData) : osmData
    const limit = Number.isInteger(options.limit) ? options.limit : 20
    const keysFilter = options.primaryKeys ?? null
    const elements = Array.isArray(osm?.elements) ? osm.elements : []
    const present = new Set(
        elements.map((element) => osmElementId(element.type, element.id))
    )
    const ids = []
    for (const element of elements) {
        if (ids.length >= limit) break
        if (
            element.type !== 'relation' ||
            element.tags?.type !== 'multipolygon' ||
            !isFilteredByKeys(element.tags, keysFilter) ||
            isLargeSurface(element.tags, keysFilter)
        ) {
            continue
        }
        const members = normalizeRelationMembers(element.members)
        if (members.length > MAX_SUPPLEMENTED_RELATION_MEMBERS) continue
        const isIncomplete = members.some(
            (member) =>
                member.type !== 'node' &&
                isRingRole(member.role) &&
                !present.has(osmElementId(member.type, member.ref))
        )
        if (isIncomplete) ids.push(element.id)
    }
    return ids
}

// Elements that only complete the geometry of a relation of the answer: they
// lie outside of the area, so they are never part of the result themselves.
const collectSupplementalElements = (answerElements, supplementalElements) => {
    if (!Array.isArray(supplementalElements)) return []
    const seen = new Set(
        answerElements.map((element) => osmElementId(element.type, element.id))
    )
    const typeOrder = { node: 0, way: 1, relation: 2 }
    const supplement = []
    for (const element of supplementalElements) {
        if (!element || !(element.type in typeOrder)) continue
        const id = osmElementId(element.type, element.id)
        if (seen.has(id)) continue
        seen.add(id)
        supplement.push(element)
    }
    return supplement.sort(
        (first, second) => typeOrder[first.type] - typeOrder[second.type]
    )
}

export const convert = (osmData, options) => {
    let keysFilter = null
    if (options && options.primaryKeys) {
        keysFilter = options.primaryKeys
    }

    const osm = typeof osmData == 'string' ? JSON.parse(osmData) : osmData
    const bounds = {
        minlat: Number(osm.bounds.minlat),
        minlon: Number(osm.bounds.minlon),
        maxlat: Number(osm.bounds.maxlat),
        maxlon: Number(osm.bounds.maxlon),
    }

    const bboxCoordinates = [
        bounds.minlon,
        bounds.minlat,
        bounds.maxlon,
        bounds.maxlat,
    ]

    const getWayGeometry = (ndRefs, _features) => {
        if (!Array.isArray(ndRefs) || ndRefs.length < 2) return null
        const firstNodeId = ndRefs[0]
        const lastNodeId = ndRefs[ndRefs.length - 1]
        const typeGeom = firstNodeId == lastNodeId ? 'Polygon' : 'LineString'

        const coordinates = []
        for (let i = 0; i < ndRefs.length; i++) {
            const ndId = `node/${ndRefs[i]}`
            if (_features[ndId]) {
                coordinates.push(_features[ndId].geometry.coordinates)
            } else {
                return null
            }
        }
        if (typeGeom == 'LineString') {
            return coordinates.length >= 2
                ? { type: 'LineString', coordinates: coordinates }
                : null
        } else if (typeGeom == 'Polygon') {
            return coordinates.length >= 4
                ? { type: 'Polygon', coordinates: [coordinates] }
                : null
        }
    }

    const getMultiPolygon = (_rel, _features) => {
        const rel = { ..._rel }
        const members = []
        rel['tainted'] = false
        for (const roleMember of normalizeRelationMembers(rel.members)) {
            // Node members (label, admin_centre...) never draw a ring, and an
            // empty role is read as outer like the OSM tools do.
            if (roleMember.type === 'node') continue
            const role = roleMember.role === '' ? 'outer' : roleMember.role
            if (role !== 'outer' && role !== 'inner') continue
            const member = { ...roleMember, role }
            const memberId = osmElementId(member.type, member.ref)
            const geometry = _features[memberId]?.geometry

            if (!geometry) {
                rel['tainted'] = true
                continue
            }
            if (geometry.type === 'LineString') {
                members.push({
                    ...member,
                    typeGeom: 'LineString',
                    ring: [...geometry.coordinates],
                })
            } else if (geometry.type === 'MultiLineString') {
                members.push(
                    ...geometry.coordinates.map((ring) => ({
                        ...member,
                        typeGeom: 'LineString',
                        ring: [...ring],
                    }))
                )
            } else if (geometry.type === 'Polygon') {
                members.push({
                    ...member,
                    typeGeom: 'Polygon',
                    ring: [...geometry.coordinates[0]],
                })
                members.push(
                    ...geometry.coordinates.slice(1).map((ring) => ({
                        ...member,
                        role: 'inner',
                        typeGeom: 'Polygon',
                        ring: [...ring],
                    }))
                )
            } else if (geometry.type === 'MultiPolygon') {
                for (const polygon of geometry.coordinates) {
                    members.push({
                        ...member,
                        typeGeom: 'Polygon',
                        ring: [...polygon[0]],
                    })
                    members.push(
                        ...polygon.slice(1).map((ring) => ({
                            ...member,
                            role: 'inner',
                            typeGeom: 'Polygon',
                            ring: [...ring],
                        }))
                    )
                }
            } else {
                rel['tainted'] = true
            }
        }

        if (rel['tainted']) {
            return null
        }

        const outersPolygons = members.filter(
            (m) => m.role === 'outer' && m.typeGeom === 'Polygon' && m.ring
        )
        const innersPolygons = members.filter(
            (m) => m.role === 'inner' && m.typeGeom === 'Polygon' && m.ring
        )
        const outersLineString = members.filter(
            (m) => m.role === 'outer' && m.typeGeom === 'LineString' && m.ring
        )
        const innersLineString = members.filter(
            (m) => m.role === 'inner' && m.typeGeom === 'LineString' && m.ring
        )

        if (outersPolygons.length === 0 && outersLineString.length === 0) {
            // must be outer !
            return null
        }

        if (outersLineString.length > 0) {
            const chainedRings = chainLinestringToPolygonRigs(
                outersLineString.map((l) => l.ring)
            )
            if (!chainedRings) return null
            for (const r of chainedRings) {
                outersPolygons.push({
                    type: 'way',
                    ref: '',
                    role: 'outer',
                    typeGeom: 'Polygon',
                    ring: r,
                })
            }
        }

        if (innersLineString.length > 0) {
            const chainedRings = chainLinestringToPolygonRigs(
                innersLineString.map((l) => l.ring)
            )
            if (!chainedRings) return null
            for (const r of chainedRings) {
                innersPolygons.push({
                    type: 'way',
                    ref: '',
                    role: 'inner',
                    typeGeom: 'Polygon',
                    ring: r,
                })
            }
        }

        if (outersPolygons.length == 1) {
            // simple case ; 1 outer n inner
            const ring = [outersPolygons[0].ring]

            for (const innerPoly of innersPolygons) {
                if (!inside(innerPoly.ring[0], outersPolygons[0].ring)) {
                    return null
                }
                ring.push(innerPoly.ring)
            }
            return { type: 'Polygon', coordinates: ring }
        } else {
            // > 1 outter rig => multipolygon
            const rings = outersPolygons.map((p) => [p.ring])

            for (const innerPoly of innersPolygons) {
                let assigned = false
                for (let i = 0; i < rings.length; i++) {
                    const outRing = rings[i][0]
                    const innerPolyFirstCoords = innerPoly.ring[0]
                    if (inside(innerPolyFirstCoords, outRing)) {
                        // test if the first coords of inner is in polygon
                        rings[i].push(innerPoly.ring)
                        assigned = true
                    }
                }
                if (!assigned) return null
            }
            return { type: 'MultiPolygon', coordinates: rings }
        }
    }

    const chainLinestringToPolygonRigs = (rings) => {
        if (!Array.isArray(rings) || rings.length === 0) return null
        const pending = rings.map((ring) =>
            ring.map((coordinate) => [...coordinate])
        )
        const resultRings = []
        const sameCoordinate = (first, second) =>
            first?.[0] === second?.[0] && first?.[1] === second?.[1]

        while (pending.length > 0) {
            const currentRing = pending.shift()
            if (!currentRing || currentRing.length < 2) return null
            while (
                !sameCoordinate(
                    currentRing[0],
                    currentRing[currentRing.length - 1]
                )
            ) {
                const start = currentRing[0]
                const end = currentRing[currentRing.length - 1]
                const matchingIndex = pending.findIndex((candidate) => {
                    const candidateStart = candidate[0]
                    const candidateEnd = candidate[candidate.length - 1]
                    return (
                        sameCoordinate(candidateStart, end) ||
                        sameCoordinate(candidateEnd, end) ||
                        sameCoordinate(candidateEnd, start) ||
                        sameCoordinate(candidateStart, start)
                    )
                })
                if (matchingIndex < 0) return null
                let candidate = pending.splice(matchingIndex, 1)[0]
                const candidateStart = candidate[0]
                const candidateEnd = candidate[candidate.length - 1]
                if (sameCoordinate(candidateStart, end)) {
                    currentRing.push(...candidate.slice(1))
                } else if (sameCoordinate(candidateEnd, end)) {
                    candidate = candidate.reverse()
                    currentRing.push(...candidate.slice(1))
                } else if (sameCoordinate(candidateEnd, start)) {
                    currentRing.unshift(...candidate.slice(0, -1))
                } else {
                    candidate = candidate.reverse()
                    currentRing.unshift(...candidate.slice(0, -1))
                }
            }
            if (currentRing.length < 4) return null
            resultRings.push(currentRing)
        }
        return resultRings
    }

    const polygonGeometryToLines = (geometry) => {
        if (geometry.type === 'Polygon') {
            return geometry.coordinates.length === 1
                ? { type: 'LineString', coordinates: geometry.coordinates[0] }
                : { type: 'MultiLineString', coordinates: geometry.coordinates }
        }
        return {
            type: 'MultiLineString',
            coordinates: geometry.coordinates.flatMap((polygon) => polygon),
        }
    }

    const extractOsmGoData = (_features, tagConfig, primaryKeys) => {
        const featuresResult = []
        for (const idObject in _features) {
            if (supplementalIds.has(idObject)) continue
            const f = _features[idObject]

            if (f.properties.type == 'node') {
                if (f.geometry && f.properties.tags) {
                    if (tagConfig) {
                        const primaryTag = getPrimaryKeyOfObject(f, primaryKeys)
                        if (primaryTag) {
                            f.properties['primaryTag'] = primaryTag
                            setIconStyle(f, tagConfig)
                            featuresResult.push(f)
                        }
                    } else {
                        addAttributesToFeature(f)
                        featuresResult.push(f)
                    }
                }
            } else if (f.properties.type == 'way') {
                if (f.geometry && f.properties.tags) {
                    // transform geom
                    if (
                        f.geometry.type == 'Polygon' ||
                        f.geometry.type == 'MultiPolygon'
                    ) {
                        if (!wayIsRealyPolygon(f.properties.tags)) {
                            f.geometry = polygonGeometryToLines(f.geometry)
                        }
                    }
                    wayToPoint(f)
                    if (tagConfig) {
                        const primaryTag = getPrimaryKeyOfObject(f, primaryKeys)
                        if (primaryTag) {
                            f.properties['primaryTag'] = primaryTag
                            setIconStyle(f, tagConfig)
                            featuresResult.push(f)
                        }
                    } else {
                        addAttributesToFeature(f)
                        featuresResult.push(f)
                    }
                }
            } else if (f.properties.type == 'relation') {
                if (
                    f.geometry &&
                    f.properties.tags &&
                    isFilteredByKeys(f.properties.tags, keysFilter)
                ) {
                    // a multipolygon relation is an area whatever its tags are
                    wayToPoint(f)
                    if (tagConfig) {
                        const primaryTag = getPrimaryKeyOfObject(f, primaryKeys)

                        if (primaryTag) {
                            f.properties['primaryTag'] = primaryTag
                            setIconStyle(f, tagConfig)
                            featuresResult.push(f)
                        }
                    } else {
                        addAttributesToFeature(f)
                        featuresResult.push(f)
                    }
                }
            }
        }

        return featuresResult
    }

    const multiPolygonIds = []
    const _features = []
    const relationElements = []
    const supplementalElements = collectSupplementalElements(
        osm.elements,
        options?.supplementalElements
    )
    const supplementalIds = new Set(
        supplementalElements.map((element) =>
            osmElementId(element.type, element.id)
        )
    )
    const elements =
        supplementalElements.length > 0
            ? [...osm.elements, ...supplementalElements]
            : osm.elements
    for (const el of elements) {
        if (el.type === 'node') {
            const node = el
            const n = {
                type: 'Feature',
                id: osmElementId('node', el.id),
                properties: {
                    type: 'node',
                    id: el.id,
                    meta: {
                        timestamp: el.timestamp,
                        version: el.version,
                        changeset: el.changeset,
                        user: el.user,
                        uid: el.uid,
                    },
                },

                geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
            }
            // add tags to properties tags
            if (el.tags) {
                n.properties['tags'] = el.tags
            }
            _features[osmElementId('node', node.id)] = n
        } else if (el.type === 'way') {
            const way = el
            const w = {
                type: 'Feature',
                id: osmElementId('way', el.id),

                properties: {
                    type: 'way',
                    id: el.id,
                    meta: {
                        timestamp: el.timestamp,
                        version: el.version,
                        changeset: way.changeset,
                        user: el.user,
                        uid: el.uid,
                    },
                },
            }

            // add tags to properties tags
            if (el.tags) {
                w.properties['tags'] = el.tags
            }

            //add ndRefs
            if (el.nodes) {
                const ndRefs = []
                for (const refNodeId of el.nodes) {
                    ndRefs.push(refNodeId)
                    const nodeRef = _features[osmElementId('node', refNodeId)]
                    if (nodeRef) {
                        if (!nodeRef.properties['usedByWays']) {
                            nodeRef.properties['usedByWays'] = []
                        }
                        nodeRef.properties['usedByWays'].push(
                            osmElementId('way', el.id)
                        )
                    }
                }
                w['ndRefs'] = ndRefs
                const geometry = getWayGeometry(ndRefs, _features)
                if (geometry) {
                    w['geometry'] = geometry
                } else {
                    w['tainted'] = true
                }
            }
            _features[osmElementId('way', el.id)] = w
        } else if (el.type === 'relation') {
            relationElements.push(el)
        }
    }

    for (const el of relationElements) {
        const id = osmElementId('relation', el.id)
        _features[id] = {
            type: 'Feature',
            id,
            properties: {
                type: 'relation',
                id: el.id,
                tags:
                    el.tags &&
                    typeof el.tags === 'object' &&
                    !Array.isArray(el.tags)
                        ? el.tags
                        : {},
                meta: {
                    timestamp: el.timestamp,
                    version: el.version,
                    changeset: el.changeset,
                    user: el.user,
                    uid: el.uid,
                },
            },
            members: normalizeRelationMembers(el.members),
            tainted: false,
        }
    }

    for (const el of relationElements) {
        const id = osmElementId('relation', el.id)
        const r = _features[id]
        for (const member of r.members) {
            const refId = osmElementId(member.type, member.ref)
            const referencedFeature = _features[refId]
            if (referencedFeature) {
                if (!referencedFeature.properties.relations) {
                    referencedFeature.properties.relations = []
                }
                referencedFeature.properties.relations.push({
                    rel: id,
                    reltags: r.properties.tags,
                    role: member.role,
                })
            } else {
                r.tainted = true
            }
        }

        if (r.properties.tags.type === 'multipolygon') {
            multiPolygonIds.push(id)
        }
    }

    const unresolvedMultiPolygons = new Set(multiPolygonIds)
    let geometryResolved = true
    while (geometryResolved && unresolvedMultiPolygons.size > 0) {
        geometryResolved = false
        for (const idMPolygon of unresolvedMultiPolygons) {
            const geom = getMultiPolygon(_features[idMPolygon], _features)
            if (geom) {
                _features[idMPolygon]['geometry'] = geom
                unresolvedMultiPolygons.delete(idMPolygon)
                geometryResolved = true
            }
        }
    }

    for (const el of relationElements) {
        const relation = _features[osmElementId('relation', el.id)]
        if (relation.geometry || relation.tainted) continue
        const tags = relation.properties.tags
        const isMultiLineString = tags.type === 'multilinestring'
        const isStopArea =
            tags.type === 'public_transport' &&
            tags.public_transport === 'stop_area'
        if (!isMultiLineString && !isStopArea) continue

        const memberGeometries = relation.members
            .map(
                (member) =>
                    _features[osmElementId(member.type, member.ref)]?.geometry
            )
            .filter(Boolean)
            .map((geometry) => structuredClone(geometry))
        if (memberGeometries.length !== relation.members.length) {
            relation.tainted = true
            continue
        }
        if (isMultiLineString) {
            const coordinates = memberGeometries.flatMap((geometry) => {
                if (geometry.type === 'LineString')
                    return [geometry.coordinates]
                if (geometry.type === 'MultiLineString') {
                    return geometry.coordinates
                }
                if (geometry.type === 'Polygon') return geometry.coordinates
                if (geometry.type === 'MultiPolygon') {
                    return geometry.coordinates.flatMap((polygon) => polygon)
                }
                return []
            })
            if (coordinates.length > 0) {
                relation.geometry = { type: 'MultiLineString', coordinates }
            }
        } else if (memberGeometries.length > 0) {
            relation.geometry = {
                type: 'GeometryCollection',
                geometries: memberGeometries,
            }
        }
    }

    const featuresResult = extractOsmGoData(
        _features,
        options.tagConfig,
        options.primaryKeys
    )

    // Objects of the answer whose geometry cannot be built (a member of a
    // relation lies outside of the area): they exist, so the cache keeps them.
    const incompleteIds = new Set()
    for (const id in _features) {
        const f = _features[id]
        if (supplementalIds.has(id)) continue
        if (
            f.properties.type !== 'node' &&
            !f.geometry &&
            f.properties.tags &&
            isFilteredByKeys(f.properties.tags, keysFilter)
        ) {
            incompleteIds.add(f.id)
        }
    }

    const geojson = {
        type: 'FeatureCollection',
        features: featuresResult,
    }

    if (options && options.oldGeojson && options.geojsonChanged) {
        const limit = Number.isInteger(options.limitFeatures)
            ? options.limitFeatures
            : 9999
        const newFeatureBbox = bboxPolygon(bboxCoordinates)

        // le nombre de features de l'ancien set de données dépasse la limite. On lui envoie donc que les nouvelles données.
        if (options.oldGeojson.features.length > limit) {
            const newGeojson = getMergedGeojsonGeojsonChanged(
                geojson,
                options.geojsonChanged
            )
            const newBboxGeojson = mergeBounds(newFeatureBbox, null)
            return { geojson: newGeojson, geojsonBbox: newBboxGeojson }
        } else {
            const newGeojson = mergeOldNewGeojsonData(
                options.oldGeojson,
                geojson,
                newFeatureBbox,
                options.geojsonChanged,
                incompleteIds
            )
            const newBboxGeojson = mergeBounds(
                newFeatureBbox,
                options.oldBboxFeature
            )
            return { geojson: newGeojson, geojsonBbox: newBboxGeojson }
        }
    } else {
        return { geojson: geojson, geojsonBbox: null }
    }
}
