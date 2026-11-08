import path from 'node:path'
import * as countryCoder from '@rapideditor/country-coder'
import fs from 'fs-extra'

interface LocationSet {
    include?: Array<unknown>
    exclude?: Array<unknown>
}

interface NameSuggestionPreset {
    name: string
    locationSet?: LocationSet
    tags: Record<string, string>
    addTags: Record<string, string>
}

const { buildIDPresets } = require('name-suggestion-index') as {
    buildIDPresets: (
        data: Record<string, unknown>,
        options: { sourcePresets: Record<string, unknown> }
    ) => { presets: Record<string, NameSuggestionPreset> }
}

export interface BrandOption extends NameSuggestionPreset {
    v: string
    lbl: { en: string }
    countryCodes?: Array<string>
    excludeCountryCodes?: Array<string>
}

const intersectRecords = (
    records: Array<Record<string, string>>
): Record<string, string> => {
    const [first = {}, ...rest] = records
    return Object.fromEntries(
        Object.entries(first).filter(([key, value]) =>
            rest.every((record) => record[key] === value)
        )
    )
}

const byLabel = (left: BrandOption, right: BrandOption): number =>
    left.lbl.en.length - right.lbl.en.length ||
    left.lbl.en.localeCompare(right.lbl.en)

const tagsSignature = ({ tags, addTags }: BrandOption): string =>
    JSON.stringify([
        Object.entries(tags).sort(),
        Object.entries(addTags).sort(),
    ])

/**
 * One option for candidates of the same value: countries are combined and
 * tags that the candidates do not share are omitted.
 */
const mergeCandidates = (
    value: string,
    candidates: Array<BrandOption>,
    claimedCodes: Array<string> = []
): BrandOption => {
    const canonical = [...candidates].sort(byLabel)[0]
    const isGlobal = candidates.some((candidate) => !candidate.countryCodes)
    const countryCodes = isGlobal
        ? undefined
        : [
              ...new Set(
                  candidates.flatMap(
                      (candidate) => candidate.countryCodes ?? []
                  )
              ),
          ].sort()
    // a country stays excluded only when every global candidate excludes it
    // and no regional candidate offers the brand there; the countries of
    // another variant of the brand are excluded too
    const globalCandidates = candidates.filter(
        (candidate) => !candidate.countryCodes
    )
    const offeredCodes = new Set(
        candidates.flatMap((candidate) => candidate.countryCodes ?? [])
    )
    const excludeCountryCodes = isGlobal
        ? [
              ...new Set([
                  ...(globalCandidates[0]?.excludeCountryCodes ?? []).filter(
                      (code) =>
                          !offeredCodes.has(code) &&
                          globalCandidates.every((candidate) =>
                              candidate.excludeCountryCodes?.includes(code)
                          )
                  ),
                  ...claimedCodes,
              ]),
          ].sort()
        : []

    const {
        countryCodes: _canonicalCountries,
        excludeCountryCodes: _canonicalExclusions,
        ...canonicalOption
    } = canonical
    return {
        ...canonicalOption,
        v: value,
        tags: intersectRecords(candidates.map((candidate) => candidate.tags)),
        addTags: intersectRecords(
            candidates.map((candidate) => candidate.addTags)
        ),
        ...(countryCodes ? { countryCodes } : {}),
        ...(excludeCountryCodes.length > 0 ? { excludeCountryCodes } : {}),
    }
}

/**
 * The NSI can describe a brand differently in some countries: McDonald's has
 * its own brand:wikidata in Ukraine. Candidates with the same tags make one
 * option; a regional variant with other tags keeps them in its own countries,
 * which the worldwide option then excludes. The countries of the options of a
 * value never overlap, so the brand value picks a single option wherever it is
 * offered. Worldwide variants that disagree are merged and lose the tags they
 * do not share.
 */
export const mergeBrandOptionsByValue = (
    options: Array<BrandOption>
): Array<BrandOption> => {
    const grouped = new Map<string, BrandOption[]>()
    for (const option of options) {
        grouped.set(option.v, [...(grouped.get(option.v) ?? []), option])
    }
    return [...grouped.entries()].flatMap(([value, candidates]) => {
        const variants = new Map<string, BrandOption[]>()
        for (const candidate of candidates) {
            const signature = tagsSignature(candidate)
            variants.set(signature, [
                ...(variants.get(signature) ?? []),
                candidate,
            ])
        }
        const globalCandidates = [...variants.values()]
            .filter((variant) => variant.some((option) => !option.countryCodes))
            .flat()
        // the most local variant keeps a country claimed by several ones
        const regionalOptions = [...variants.values()]
            .filter((variant) => variant.every((option) => option.countryCodes))
            .map((variant) => mergeCandidates(value, variant))
            .sort(
                (left, right) =>
                    (left.countryCodes?.length ?? 0) -
                        (right.countryCodes?.length ?? 0) ||
                    byLabel(left, right)
            )
        const claimedCodes = new Set<string>()
        const regionalVariants: Array<BrandOption> = []
        for (const option of regionalOptions) {
            const countryCodes = (option.countryCodes ?? []).filter(
                (code) => !claimedCodes.has(code)
            )
            if (countryCodes.length === 0) continue
            for (const code of countryCodes) claimedCodes.add(code)
            regionalVariants.push({ ...option, countryCodes })
        }
        const globalVariant =
            globalCandidates.length > 0
                ? [mergeCandidates(value, globalCandidates, [...claimedCodes])]
                : []
        return [...globalVariant, ...regionalVariants.sort(byLabel)]
    })
}

const readNameSuggestionData = (): Record<string, unknown> => {
    const packageEntry = require.resolve('name-suggestion-index')
    const dataPath = path.resolve(
        path.dirname(packageEntry),
        '../json/nsi.min.json'
    )
    const data = fs.readJsonSync(dataPath).nsi

    return Object.fromEntries(
        Object.entries(data).filter(([presetPath]) =>
            presetPath.startsWith('brands/')
        )
    )
}

const ISO_COUNTRY_LEVELS = new Set(['country', 'territory'])
const regionCountriesCache = new Map<string, Array<string>>()

/**
 * The countries of a region (UN M49 `150`, `eu`...). A member is a country or
 * a territory; a subterritory (metropolitan France, the Canary Islands) stands
 * for its parent country.
 */
const getRegionCountries = (region: string): Array<string> => {
    const cached = regionCountriesCache.get(region)
    if (cached) return cached

    const wanted = region.toLowerCase()
    const countryCodes = new Set<string>()
    for (const feature of countryCoder.featuresIn('001', true)) {
        const { groups, level, iso1A2, country } = feature.properties
        if (!groups?.some((group) => group.toLowerCase() === wanted)) continue
        const code =
            level === 'subterritory'
                ? country
                : ISO_COUNTRY_LEVELS.has(level)
                  ? (iso1A2 ?? country)
                  : undefined
        if (code) countryCodes.add(code.toLowerCase())
    }
    const sorted = [...countryCodes].sort()
    regionCountriesCache.set(region, sorted)
    return sorted
}

/**
 * The lowercase ISO 3166-1 codes of a NSI location: a country, a territory, a
 * subdivision (reduced to its country) or a region such as the UN M49 `150`
 * or `eu`. `undefined` when the location cannot be resolved, `'world'` for 001.
 */
const resolveLocation = (
    location: unknown,
    isExclusion: boolean
): Array<string> | 'world' | undefined => {
    if (typeof location !== 'string') return undefined
    const feature = countryCoder.feature(location)
    const level = feature?.properties.level
    if (level === 'world') return 'world'
    if (level && ISO_COUNTRY_LEVELS.has(level) && feature.properties.iso1A2) {
        return [feature.properties.iso1A2.toLowerCase()]
    }
    // metropolitan France (fx) widens an inclusion to France but must not
    // exclude its overseas territories
    if (level === 'subterritory' && feature.properties.country) {
        return isExclusion
            ? undefined
            : [feature.properties.country.toLowerCase()]
    }
    if (feature) {
        // a region can be named by its wikidata item (Q46 for Europe)
        const countryCodes = getRegionCountries(
            feature.properties.id ?? location
        )
        return countryCodes.length > 0 ? countryCodes : undefined
    }
    // a subdivision (us-ca) widens an inclusion to its country but must not
    // exclude the whole country
    const countryCode = location.match(/^([a-z]{2})-/)?.[1]
    return countryCode && !isExclusion ? [countryCode] : undefined
}

const resolveLocations = (
    locations: Array<unknown> | undefined,
    isExclusion: boolean
): { codes: Array<string>; world: boolean; unresolved: boolean } => {
    const codes = new Set<string>()
    let world = false
    let unresolved = false
    for (const location of locations ?? []) {
        const resolved = resolveLocation(location, isExclusion)
        if (resolved === 'world') {
            world = true
        } else if (resolved) {
            for (const code of resolved) codes.add(code)
        } else {
            unresolved = true
        }
    }
    return { codes: [...codes].sort(), world, unresolved }
}

/**
 * A brand available everywhere but in a few countries keeps no country list
 * and gets `excludeCountryCodes`; a regional brand gets the countries of its
 * region minus the excluded ones. A location that cannot be resolved (a
 * custom geojson area) leaves the brand global.
 */
export const getCountryCodes = (
    locationSet?: LocationSet
): { countryCodes?: Array<string>; excludeCountryCodes?: Array<string> } => {
    const include = resolveLocations(locationSet?.include, false)
    const exclude = resolveLocations(locationSet?.exclude, true)
    const excludedCodes = exclude.world ? [] : exclude.codes

    if (include.world || include.unresolved || include.codes.length === 0) {
        return excludedCodes.length > 0 && !include.unresolved
            ? { excludeCountryCodes: excludedCodes }
            : {}
    }
    const countryCodes = include.codes.filter(
        (code) => !excludedCodes.includes(code)
    )
    return countryCodes.length > 0 ? { countryCodes } : {}
}

export const getBrandOptions = (): Record<string, Array<BrandOption>> => {
    const sourcePresets = require('@openstreetmap/id-tagging-schema/dist/presets.json')
    const { presets } = buildIDPresets(readNameSuggestionData(), {
        sourcePresets,
    })
    const brandOptions: Record<string, Array<BrandOption>> = {}

    for (const [presetId, preset] of Object.entries(presets)) {
        const separatorIndex = presetId.lastIndexOf('/')
        const parentId = presetId.slice(0, separatorIndex)
        const { countryCodes, excludeCountryCodes } = getCountryCodes(
            preset.locationSet
        )
        const option: BrandOption = {
            v: preset.addTags.brand,
            lbl: { en: preset.name },
            ...preset,
        }

        if (countryCodes) {
            option.countryCodes = countryCodes
        }
        if (excludeCountryCodes) {
            option.excludeCountryCodes = excludeCountryCodes
        }

        brandOptions[parentId] ??= []
        brandOptions[parentId].push(option)
    }

    return Object.fromEntries(
        Object.entries(brandOptions).map(([presetId, options]) => [
            presetId,
            mergeBrandOptionsByValue(options),
        ])
    )
}
