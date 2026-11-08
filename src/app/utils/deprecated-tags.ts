/**
 * Tags written by the fix of a deprecated tag. As in iD, a `*` replacement
 * keeps the value the object already has for that key, or falls back to `yes`.
 */
export const resolveReplacementTags = (
    replace: Record<string, string | number>,
    tags: Record<string, string | number | undefined>
): Record<string, string | number> =>
    Object.fromEntries(
        Object.entries(replace).map(([key, value]) => [
            key,
            value === '*' ? (tags[key] ?? 'yes') : value,
        ])
    )
