// What describes the building itself: its type and shape, its address, where
// its outline comes from (`source=cadastre…`), and `type=multipolygon`.
const BUILDING_KEY =
    /^(building|roof|addr|source)(:|$)|^(height|min_height|est_height|layer|location|type)$/

/**
 * The tags left on a building once the place mapped on it (a bank, a bakery)
 * is gone, or `undefined` when the object is not a place on a building: a
 * point, a building on its own, an outline that is not a building.
 */
export const buildingTagsWithoutPlace = (
    type: string,
    tags: Record<string, string | number>,
    primaryKey: string | undefined
): Record<string, string> | undefined => {
    const building = String(tags['building'] ?? '')
    if (
        type === 'node' ||
        building === '' ||
        building === 'no' ||
        !primaryKey ||
        primaryKey === 'building'
    ) {
        return undefined
    }
    return Object.fromEntries(
        Object.entries(tags)
            .filter(([key]) => BUILDING_KEY.test(key))
            .map(([key, value]) => [key, String(value)])
    )
}
