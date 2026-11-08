import assert from 'node:assert/strict'
import {
    type BrandOption,
    getBrandOptions,
    getCountryCodes,
    mergeBrandOptionsByValue,
} from './nameSuggestionIndex'

const brandOptions = getBrandOptions()
const pharmacyBrands = brandOptions['amenity/pharmacy']
const bePharmacy = pharmacyBrands.find((brand) => brand.v === 'Be')

assert.ok(bePharmacy, 'The Be pharmacy brand should be imported')
assert.deepEqual(
    bePharmacy.countryCodes,
    ['il'],
    'The Be pharmacy brand should be available in Israel'
)
// a value can have several options (one per country variant), but never two
// in the same country
const isOfferedIn = (option: BrandOption, code: string): boolean =>
    option.countryCodes
        ? option.countryCodes.includes(code)
        : !option.excludeCountryCodes?.includes(code)
const listedCountries = new Set(
    Object.values(brandOptions).flatMap((options) =>
        options.flatMap((option) => option.countryCodes ?? [])
    )
)
assert.ok(
    Object.values(brandOptions).every((options) => {
        const byValue = new Map<string, BrandOption[]>()
        for (const option of options) {
            byValue.set(option.v, [...(byValue.get(option.v) ?? []), option])
        }
        return (
            options.every((option) => typeof option.v === 'string') &&
            [...byValue.values()].every(
                (variants) =>
                    variants.filter((option) => !option.countryCodes).length <=
                        1 &&
                    [...listedCountries].every(
                        (code) =>
                            variants.filter((option) =>
                                isOfferedIn(option, code)
                            ).length <= 1
                    )
            )
        )
    }),
    'A brand value must give a single option in every country'
)

const mergedConflict = mergeBrandOptionsByValue([
    {
        name: 'Example France',
        v: 'Example',
        lbl: { en: 'Example France' },
        countryCodes: ['fr'],
        locationSet: { include: ['fr'] },
        tags: { shop: 'books', 'brand:wikidata': 'Q1' },
        addTags: { brand: 'Example', 'brand:wikidata': 'Q1' },
    },
    {
        name: 'Example Belgium',
        v: 'Example',
        lbl: { en: 'Example Belgium' },
        countryCodes: ['be'],
        locationSet: { include: ['be'] },
        tags: { shop: 'books', 'brand:wikidata': 'Q2' },
        addTags: { brand: 'Example', 'brand:wikidata': 'Q2' },
    },
])

// two regional variants keep their own tags in their own countries
assert.deepEqual(
    mergedConflict.map((option) => [option.countryCodes, option.tags]),
    [
        [['fr'], { shop: 'books', 'brand:wikidata': 'Q1' }],
        [['be'], { shop: 'books', 'brand:wikidata': 'Q2' }],
    ]
)
assert.deepEqual(mergedConflict[1].addTags, {
    brand: 'Example',
    'brand:wikidata': 'Q2',
})

assert.deepEqual(getCountryCodes({ include: ['fr', 'be'] }), {
    countryCodes: ['be', 'fr'],
})
// a subdivision widens to its country, a region to its countries
assert.deepEqual(getCountryCodes({ include: ['us-ca'] }), {
    countryCodes: ['us'],
})
const europe = getCountryCodes({ include: ['150'] }).countryCodes ?? []
assert.ok(europe.includes('fr') && europe.includes('de'))
assert.ok(!europe.includes('us'))
const european = getCountryCodes({ include: ['eu'], exclude: ['fr'] })
assert.ok(european.countryCodes?.includes('de'))
assert.ok(!european.countryCodes?.includes('fr'))
// a worldwide brand keeps no country list, only the countries it skips
assert.deepEqual(getCountryCodes({ include: ['001'], exclude: ['fr', 'de'] }), {
    excludeCountryCodes: ['de', 'fr'],
})
assert.deepEqual(getCountryCodes({ include: ['001'] }), {})
assert.deepEqual(getCountryCodes(undefined), {})
// an exclusion on a subdivision must not exclude its whole country
assert.deepEqual(getCountryCodes({ include: ['001'], exclude: ['us-ca'] }), {})
// metropolitan France stands for France, a region its wikidata item
assert.deepEqual(getCountryCodes({ include: ['fx', 'be'] }), {
    countryCodes: ['be', 'fr'],
})
assert.deepEqual(getCountryCodes({ include: ['001'], exclude: ['fx'] }), {})
const q46 = getCountryCodes({ include: ['Q46'] }).countryCodes ?? []
assert.ok(q46.includes('fr') && q46.includes('de') && !q46.includes('us'))
// an area that cannot be resolved stays global rather than disappearing
assert.deepEqual(getCountryCodes({ include: ['custom_area.geojson'] }), {})

const mcDonalds = brandOptions['amenity/fast_food/burger'].find(
    (brand) => brand.v === "McDonald's"
)
assert.ok(mcDonalds, "McDonald's must hang on the burger fast food preset")
assert.equal(mcDonalds.countryCodes, undefined)
assert.ok(mcDonalds.excludeCountryCodes?.includes('cn'))
assert.ok(!mcDonalds.excludeCountryCodes?.includes('fr'))
// the worldwide option keeps the tags that a regional variant changes
assert.equal(mcDonalds.tags['brand:wikidata'], 'Q38076')
assert.equal(mcDonalds.tags.cuisine, 'burger')
assert.equal(mcDonalds.addTags['brand:wikidata'], 'Q38076')
const ukrainianMcDonalds = brandOptions['amenity/fast_food/burger'].find(
    (brand) => brand.v === "McDonald's" && brand.countryCodes?.includes('ua')
)
assert.ok(ukrainianMcDonalds, "McDonald's keeps its Ukrainian variant")
assert.deepEqual(ukrainianMcDonalds.countryCodes, ['ua'])
assert.notEqual(ukrainianMcDonalds.tags['brand:wikidata'], 'Q38076')
assert.ok(mcDonalds.excludeCountryCodes?.includes('ua'))

const mergedGlobal = mergeBrandOptionsByValue([
    {
        name: 'Example',
        v: 'Example',
        lbl: { en: 'Example' },
        excludeCountryCodes: ['fr', 'de'],
        locationSet: { include: ['001'], exclude: ['fr', 'de'] },
        tags: { shop: 'books' },
        addTags: { brand: 'Example' },
    },
    {
        name: 'Example Deutschland',
        v: 'Example',
        lbl: { en: 'Example Deutschland' },
        countryCodes: ['de'],
        locationSet: { include: ['de'] },
        tags: { shop: 'books' },
        addTags: { brand: 'Example' },
    },
])
assert.equal(mergedGlobal[0].countryCodes, undefined)
assert.deepEqual(mergedGlobal[0].excludeCountryCodes, ['fr'])

const mergedVariant = mergeBrandOptionsByValue([
    {
        name: 'Example',
        v: 'Example',
        lbl: { en: 'Example' },
        locationSet: { include: ['001'] },
        tags: { shop: 'books', 'brand:wikidata': 'Q1' },
        addTags: { brand: 'Example', 'brand:wikidata': 'Q1' },
    },
    {
        name: 'Example Ukraine',
        v: 'Example',
        lbl: { en: 'Example Ukraine' },
        countryCodes: ['ua'],
        locationSet: { include: ['ua'] },
        tags: { shop: 'books', 'brand:wikidata': 'Q2' },
        addTags: { brand: 'Example', 'brand:wikidata': 'Q2' },
    },
])
assert.deepEqual(
    mergedVariant.map((option) => [
        option.countryCodes,
        option.excludeCountryCodes,
        option.tags['brand:wikidata'],
    ]),
    [
        [undefined, ['ua'], 'Q1'],
        [['ua'], undefined, 'Q2'],
    ]
)

console.log('Name Suggestion Index tests passed')
