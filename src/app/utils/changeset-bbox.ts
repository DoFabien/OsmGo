import type { OsmGoFeature } from '@osmgo/type'
import type { Geometry } from 'geojson'

/** West, south, east, north, in degrees. */
export type ChangesetBbox = [number, number, number, number]

/**
 * Largest side of the area an open changeset may cover before a new one is
 * opened: one changeset spread over distant places is hard to review.
 */
export const MAX_CHANGESET_SPAN_DEGREES = 0.5

const extendWithGeometry = (
    bbox: ChangesetBbox | undefined,
    geometry: Geometry | null | undefined
): ChangesetBbox | undefined => {
    if (!geometry) return bbox
    if (geometry.type === 'GeometryCollection') {
        return geometry.geometries.reduce(extendWithGeometry, bbox)
    }
    let next = bbox
    const visit = (coordinates: unknown): void => {
        if (!Array.isArray(coordinates)) return
        if (typeof coordinates[0] === 'number') {
            const [lng, lat] = coordinates as number[]
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
            next = next
                ? [
                      Math.min(next[0], lng),
                      Math.min(next[1], lat),
                      Math.max(next[2], lng),
                      Math.max(next[3], lat),
                  ]
                : [lng, lat, lng, lat]
            return
        }
        for (const child of coordinates) visit(child)
    }
    visit(geometry.coordinates)
    return next
}

/** The area touched by the objects, from their full OSM geometry. */
export const featuresBbox = (
    features: readonly OsmGoFeature[]
): ChangesetBbox | undefined =>
    features.reduce<ChangesetBbox | undefined>(
        (bbox, feature) =>
            extendWithGeometry(
                bbox,
                (feature.properties.way_geometry as Geometry | undefined) ??
                    feature.geometry
            ),
        undefined
    )

export const unionBbox = (
    first: ChangesetBbox,
    second: ChangesetBbox
): ChangesetBbox => [
    Math.min(first[0], second[0]),
    Math.min(first[1], second[1]),
    Math.max(first[2], second[2]),
    Math.max(first[3], second[3]),
]

export const isChangesetBbox = (value: unknown): value is ChangesetBbox =>
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((coordinate) => Number.isFinite(coordinate)) &&
    value[0] <= value[2] &&
    value[1] <= value[3]

export const fitsInOneChangeset = (bbox: ChangesetBbox): boolean =>
    bbox[2] - bbox[0] <= MAX_CHANGESET_SPAN_DEGREES &&
    bbox[3] - bbox[1] <= MAX_CHANGESET_SPAN_DEGREES
