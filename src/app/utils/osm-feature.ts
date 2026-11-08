import type { OsmGoFeature } from '@osmgo/type'

export const isNodeUsedByWay = (feature: OsmGoFeature): boolean => {
    const usedByWays = feature.properties.usedByWays
    return (
        usedByWays === true ||
        (Array.isArray(usedByWays) && usedByWays.length > 0)
    )
}

export const isNodeUsedByRelation = (feature: OsmGoFeature): boolean =>
    Array.isArray(feature.properties.relations) &&
    feature.properties.relations.length > 0

/**
 * OpenStreetMap refuses to delete a node that a way or a relation still
 * references (HTTP 412): such a node can only lose its tags.
 */
export const isNodeReferencedByWayOrRelation = (
    feature: OsmGoFeature
): boolean =>
    feature.properties.type === 'node' &&
    (isNodeUsedByWay(feature) || isNodeUsedByRelation(feature))
