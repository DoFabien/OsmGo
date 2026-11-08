export interface TagConflict {
    key: string
    base?: string
    mine?: string
    theirs?: string
}

export interface TagMergeResult {
    /** Merged tags; for a conflicting key the local value is kept. */
    tags: Record<string, string>
    conflicts: TagConflict[]
    /** Keys whose value comes from the current OpenStreetMap version. */
    adoptedRemoteKeys: string[]
}

/**
 * Three-way merge of OSM tags: `base` is the version the user started from,
 * `mine` the local edit and `theirs` the current OpenStreetMap version. A key
 * changed on one side only is taken from that side; a key changed differently
 * on both sides is reported as a conflict.
 */
export const mergeOsmTags = (
    base: Record<string, string>,
    mine: Record<string, string>,
    theirs: Record<string, string>
): TagMergeResult => {
    const tags: Record<string, string> = {}
    const conflicts: TagConflict[] = []
    const adoptedRemoteKeys: string[] = []
    const keys = new Set([
        ...Object.keys(base),
        ...Object.keys(mine),
        ...Object.keys(theirs),
    ])

    for (const key of keys) {
        const baseValue = base[key]
        const mineValue = mine[key]
        const theirsValue = theirs[key]
        let value: string | undefined
        if (mineValue === theirsValue) {
            value = mineValue
        } else if (mineValue === baseValue) {
            value = theirsValue
            adoptedRemoteKeys.push(key)
        } else if (theirsValue === baseValue) {
            value = mineValue
        } else {
            conflicts.push({
                key,
                base: baseValue,
                mine: mineValue,
                theirs: theirsValue,
            })
            value = mineValue
        }
        if (value !== undefined) tags[key] = value
    }
    return { tags, conflicts, adoptedRemoteKeys }
}

export interface PositionMergeResult {
    position: [number, number]
    conflict: boolean
}

const samePosition = (
    left: readonly number[],
    right: readonly number[]
): boolean => left[0] === right[0] && left[1] === right[1]

/** Three-way merge of a node position. */
export const mergeNodePosition = (
    base: readonly number[],
    mine: readonly number[],
    theirs: readonly number[]
): PositionMergeResult => {
    if (samePosition(mine, theirs) || samePosition(theirs, base)) {
        return { position: [mine[0], mine[1]], conflict: false }
    }
    if (samePosition(mine, base)) {
        return { position: [theirs[0], theirs[1]], conflict: false }
    }
    return { position: [mine[0], mine[1]], conflict: true }
}
