/** Turns an editor-layer-index URL into the template MapLibre understands. */
export function normalizeImageryUrl(url: string): string {
    return url
        .replaceAll('{zoom}', '{z}')
        .replaceAll('{proj}', '3857')
        .replaceAll('{wkid}', '3857')
        .replaceAll('{height}', '256')
        .replaceAll('{width}', '256')
        .replaceAll('{bbox}', '{bbox-epsg-3857}')
}

const supportedPlaceholders = new Set([
    'z',
    'x',
    'y',
    '-y',
    'bbox-epsg-3857',
    'quadkey',
])

/**
 * A tile template that cannot be used from the app: plain `http:` is blocked
 * as mixed content on the https origins, and a placeholder that nothing
 * substitutes would be requested literally.
 */
export function isUnusableTileTemplate(template: string): boolean {
    if (!/^https:/i.test(template)) return true
    return [...template.matchAll(/\{([^}]*)\}/g)].some(
        ([, name]) => !supportedPlaceholders.has(name)
    )
}

export function invertTmsY(y: number, z: number): number {
    return 2 ** z - y - 1
}

export function buildTileTestUrl(
    template: string,
    x: number,
    y: number,
    z: number,
    bbox: number[],
    quadkey: string
): string {
    return template
        .replaceAll('{x}', String(x))
        .replaceAll('{y}', String(y))
        .replaceAll('{-y}', String(invertTmsY(y, z)))
        .replaceAll('{z}', String(z))
        .replaceAll('{bbox-epsg-3857}', bbox.join(','))
        .replaceAll('{quadkey}', quadkey)
}

export function compareImageryPriority(
    left: { properties: { best?: boolean; local?: boolean } },
    right: { properties: { best?: boolean; local?: boolean } }
): number {
    const bestDifference =
        Number(Boolean(right.properties.best)) -
        Number(Boolean(left.properties.best))
    if (bestDifference !== 0) return bestDifference
    return (
        Number(Boolean(right.properties.local)) -
        Number(Boolean(left.properties.local))
    )
}

type Position = number[]

/** ~1 km: enough to tell whether the user stands inside an imagery layer. */
const coverageTolerance = 0.01
const coordinatePrecision = 1e4

/** Douglas-Peucker simplification of a closed ring. */
export function simplifyRing(ring: Position[], tolerance: number): Position[] {
    const keep = new Array<boolean>(ring.length).fill(false)
    keep[0] = true
    keep[ring.length - 1] = true
    const stack: Array<[number, number]> = [[0, ring.length - 1]]

    while (stack.length) {
        const [start, end] = stack.pop()
        const [ax, ay] = ring[start]
        const [bx, by] = ring[end]
        const dx = bx - ax
        const dy = by - ay
        const length = Math.hypot(dx, dy)
        let farthest = 0
        let index = -1
        for (let i = start + 1; i < end; i++) {
            const [px, py] = ring[i]
            const distance =
                length === 0
                    ? Math.hypot(px - ax, py - ay)
                    : Math.abs(dy * (px - ax) - dx * (py - ay)) / length
            if (distance > farthest) {
                farthest = distance
                index = i
            }
        }
        if (farthest > tolerance) {
            keep[index] = true
            stack.push([start, index], [index, end])
        }
    }

    const simplified = ring.filter((_, i) => keep[i])
    // a ring smaller than the tolerance would collapse: keep it as is
    return simplified.length >= 4 ? simplified : ring
}

const roundRing = (ring: Position[]): Position[] =>
    ring.map(([x, y]) => [
        Math.round(x * coordinatePrecision) / coordinatePrecision,
        Math.round(y * coordinatePrecision) / coordinatePrecision,
    ])

const simplifyGeometry = (geometry: any) => {
    if (!geometry) return null
    const simplifyPolygon = (polygon: Position[][]) =>
        polygon.map((ring) => roundRing(simplifyRing(ring, coverageTolerance)))
    return {
        type: geometry.type,
        coordinates:
            geometry.type === 'MultiPolygon'
                ? geometry.coordinates.map(simplifyPolygon)
                : simplifyPolygon(geometry.coordinates),
    }
}

/**
 * Keeps only what Osm Go reads from an imagery layer, with a simplified
 * coverage. MapLibre does not know `{-y}`: those layers use the TMS scheme.
 */
export function toImageryFeature(feature: any) {
    const p = feature.properties
    const tms = p.tiles.some((tile: string) => tile.includes('{-y}'))
    const properties: Record<string, unknown> = {
        id: p.id,
        name: p.name,
        tiles: tms
            ? p.tiles.map((tile: string) => tile.replaceAll('{-y}', '{y}'))
            : p.tiles,
    }
    if (tms) properties.scheme = 'tms'
    for (const key of ['max_zoom', 'description', 'category', 'end_date']) {
        if (p[key] !== undefined) properties[key] = p[key]
    }
    if (p.attribution?.text)
        properties.attribution = { text: p.attribution.text }

    return {
        type: 'Feature',
        properties,
        geometry: simplifyGeometry(feature.geometry),
    }
}
