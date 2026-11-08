/**
 * Structural equality of JSON-compatible values. A property holding
 * `undefined` is treated like a missing property, as persistence does.
 */
export const isDeepEqual = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true
    if (
        typeof left !== 'object' ||
        typeof right !== 'object' ||
        left === null ||
        right === null
    ) {
        return false
    }
    if (Array.isArray(left) !== Array.isArray(right)) return false
    if (Array.isArray(left) && Array.isArray(right)) {
        return (
            left.length === right.length &&
            left.every((item, index) => isDeepEqual(item, right[index]))
        )
    }
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const keys = new Set([
        ...Object.keys(leftRecord),
        ...Object.keys(rightRecord),
    ])
    for (const key of keys) {
        if (!isDeepEqual(leftRecord[key], rightRecord[key])) return false
    }
    return true
}
