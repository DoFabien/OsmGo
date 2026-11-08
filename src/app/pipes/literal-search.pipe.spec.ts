import type { PresetOption, TagConfig } from '@osmgo/type'

import { FilterByPresetsContentPipe } from './filterByPresetsContent.pipe'
import { FilterByTagsContentPipe } from './filterByTagsContent.pipe'

describe('literal search pipes', () => {
    const presetOptions: PresetOption[] = [
        {
            v: 'covered[value]',
            lbl: { en: 'Café terrace' },
            terms: { en: ['night   club'] },
        },
        { v: 'plain', lbl: { en: 'Plain value' } },
    ]
    const tagConfigs: TagConfig[] = [
        {
            id: 'amenity-cafe',
            icon: '',
            markerColor: '',
            presets: [],
            geometry: ['point'],
            tags: { amenity: 'cafe', note: 'covered[value]' },
            lbl: { en: 'Café terrace' },
            terms: { en: ['night   club'] },
        },
        {
            id: 'plain',
            icon: '',
            markerColor: '',
            presets: [],
            geometry: ['point'],
            tags: { amenity: 'bench' },
            lbl: { en: 'Plain value' },
        },
    ]

    it.each(['[', 'cafe', 'night club'])(
        'filters preset options with the literal query %s',
        (query) => {
            expect(
                new FilterByPresetsContentPipe().transform(
                    presetOptions,
                    ['en'],
                    query
                )
            ).toEqual([presetOptions[0]])
        }
    )

    it.each(['[', 'cafe', 'night club'])(
        'filters tag configurations with the literal query %s',
        (query) => {
            expect(
                new FilterByTagsContentPipe().transform(
                    tagConfigs,
                    ['en'],
                    query
                )
            ).toEqual([tagConfigs[0]])
        }
    )

    describe('category ranking', () => {
        const category = (
            id: string,
            tags: Record<string, string>,
            lbl: Record<string, string>,
            terms?: Record<string, string>
        ): TagConfig => ({
            id,
            icon: '',
            markerColor: '',
            presets: [],
            geometry: ['point'],
            tags,
            lbl,
            terms,
        })
        const ids = (items: TagConfig[]) => items.map((item) => item.id)
        const search = (items: TagConfig[], language: string, query: string) =>
            ids(
                new FilterByTagsContentPipe().transform(
                    items,
                    [language],
                    query
                )
            )

        it('ranks exact, prefix, word then substring matches', () => {
            const items = [
                category('substring', { a: 'b' }, { fr: 'Plateau', en: 'x' }),
                category('word', { a: 'c' }, { fr: "Château d'eau", en: 'x' }),
                category('prefix', { a: 'd' }, { fr: 'Eau potable', en: 'x' }),
                category('exact', { a: 'e' }, { fr: 'Eau', en: 'x' }),
            ]

            expect(search(items, 'fr', 'eau')).toEqual([
                'exact',
                'prefix',
                'word',
                'substring',
            ])
        })

        it('searches the English label and the tag values too', () => {
            const items = [
                category(
                    'bench',
                    { amenity: 'bench' },
                    { fr: 'Banc', en: 'Bench' }
                ),
                category(
                    'tree',
                    { natural: 'tree' },
                    { fr: 'Arbre', en: 'Tree' }
                ),
                category(
                    'stop',
                    { highway: 'bus_stop' },
                    { fr: 'Arrêt', en: 'Stop' }
                ),
            ]

            expect(search(items, 'fr', 'tree')).toEqual(['tree'])
            expect(search(items, 'fr', 'bus')).toEqual(['stop'])
            expect(search(items, 'fr', 'arret')).toEqual(['stop'])
        })

        it('ranks a label above a search term and keeps the catalog order on ties', () => {
            const items = [
                category('term', { a: 'b' }, { en: 'Tap' }, { en: 'watering' }),
                category('first', { a: 'c' }, { en: 'Water point' }),
                category('second', { a: 'd' }, { en: 'Water tanks' }),
            ]

            expect(search(items, 'en', 'water')).toEqual([
                'first',
                'second',
                'term',
            ])
        })

        // the catalog order put "École de danse" before the school
        it('ranks the shorter label first on ties', () => {
            const items = [
                category('long', { a: 'b' }, { fr: 'École de musique' }),
                category('short', { a: 'c' }, { fr: 'École de danse' }),
            ]

            expect(search(items, 'fr', 'ecole')).toEqual(['short', 'long'])
        })

        it('ranks a category found in another text too first on ties', () => {
            const items = [
                category('police', { a: 'b' }, { fr: 'Poste de police' }),
                category(
                    'post_office',
                    { a: 'c' },
                    { fr: 'Bureau de poste' },
                    { fr: 'poste' }
                ),
            ]

            expect(search(items, 'fr', 'poste')).toEqual([
                'post_office',
                'police',
            ])
        })

        it('ranks a term that names the category above a label prefix', () => {
            const items = [
                category(
                    'charge_point',
                    { a: 'b' },
                    { fr: 'Borne de recharge pour véhicules électriques' }
                ),
                category(
                    'charging_station',
                    { a: 'c' },
                    { fr: 'Station de recharge' },
                    { fr: 'station de recharge,borne de recharge' }
                ),
            ]

            expect(search(items, 'fr', 'borne de recharge')).toEqual([
                'charging_station',
                'charge_point',
            ])
        })

        it('matches a label without its qualifier exactly', () => {
            const items = [
                category(
                    'letter_box',
                    { a: 'b' },
                    { fr: 'Boîte aux lettres privée' },
                    { fr: 'boîte aux lettres' }
                ),
                category(
                    'post_box',
                    { a: 'c' },
                    { fr: 'Boîte aux lettres (envoi)' }
                ),
            ]

            expect(search(items, 'fr', 'boîte aux lettres')).toEqual([
                'post_box',
                'letter_box',
            ])
        })

        it('finds every word of the search, accents ignored', () => {
            const items = [
                category('tram', { a: 'b' }, { fr: 'Arrêt de bus et de tram' }),
                category('bus', { a: 'c' }, { fr: 'Arrêt de bus' }),
                category('station', { a: 'd' }, { fr: 'Gare routière' }),
                category(
                    'shelter',
                    { a: 'e' },
                    { fr: 'Abri de transport en commun', en: 'Shelter' },
                    { en: 'bus stop' }
                ),
            ]

            expect(search(items, 'fr', 'arret bus')).toEqual(['bus', 'tram'])
            expect(search(items, 'fr', 'abri bus')).toEqual(['shelter'])
            expect(search(items, 'fr', 'gare bus')).toEqual([])
        })

        it('does not match the JSON of the tags', () => {
            const items = [category('x', { amenity: 'bench' }, { en: 'Bench' })]

            expect(search(items, 'en', '"amenity"')).toEqual([])
            expect(search(items, 'en', ':')).toEqual([])
        })
    })

    describe('in the generated catalog', () => {
        const catalog = (
            require('../../assets/tagsAndPresets/tags.json') as {
                tags: Array<TagConfig & { searchable?: boolean }>
            }
        ).tags.filter(
            (tag) =>
                !tag.deprecated &&
                tag.searchable !== false &&
                !tag.excludeCountryCodes?.includes('FR') &&
                tag.geometry.includes('point')
        )
        const first = (query: string): TagConfig | undefined =>
            new FilterByTagsContentPipe().transform(
                catalog,
                ['fr', 'FR'],
                query
            )[0]

        it.each([
            ['boulangerie', 'shop/bakery'],
            ['banc', 'amenity/bench'],
            ['poubelle', 'amenity/waste_basket'],
            ['arrêt de bus', 'public_transport/platform/bus'],
            ['arret bus', 'public_transport/platform/bus'],
            ['abri bus', 'amenity/shelter/public_transport'],
            ['pharmacie', 'amenity/pharmacy'],
            ['toilettes', 'amenity/toilets'],
            ['parking vélo', 'amenity/bicycle_parking'],
            ['restaurant', 'amenity/restaurant'],
            ['eau potable', 'amenity/drinking_water'],
            ['arbre', 'natural/tree'],
            ['boîte aux lettres', 'amenity/post_box'],
            ['défibrillateur', 'emergency/defibrillator'],
            ['borne de recharge', 'amenity/charging_station'],
            ['école', 'education/school'],
            ['bar', 'amenity/bar'],
            ['poste', 'amenity/post_office'],
            ['verre', 'amenity/recycling_container'],
        ])('gives %s first: %s', (query, expected) => {
            expect(first(query)?.id).toBe(expected)
        })

        it('offers a bus stop that does not write tram=yes', () => {
            const busStop = first('arrêt de bus')
            expect(busStop?.lbl?.['fr']).toBe('Arrêt de bus')
            expect({
                ...busStop?.tags,
                ...busStop?.addTags,
            }).not.toHaveProperty('tram')
        })
    })

    it('returns all values for empty search text', () => {
        expect(
            new FilterByPresetsContentPipe().transform(
                presetOptions,
                ['en'],
                '   '
            )
        ).toBe(presetOptions)
        expect(
            new FilterByTagsContentPipe().transform(tagConfigs, ['en'], '')
        ).toBe(tagConfigs)
    })
})
