export const SURVEY_DATE_KEYS = ['survey:date', 'check_date']

/**
 * Keys to set to today when an object is surveyed: the date keys it already
 * has, so that it keeps a single date, or the configured key when it has none.
 */
export const surveyDateKeysToSet = (
    presentKeys: Iterable<string>,
    configuredKey: string
): string[] => {
    const present = new Set(presentKeys)
    const existing = SURVEY_DATE_KEYS.filter((key) => present.has(key))
    return existing.length > 0 ? existing : [configuredKey]
}
