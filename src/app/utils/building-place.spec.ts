import { buildingTagsWithoutPlace } from './building-place'

describe('buildingTagsWithoutPlace', () => {
    it('keeps the building and its address when the bank goes', () => {
        expect(
            buildingTagsWithoutPlace(
                'way',
                {
                    amenity: 'bank',
                    name: 'Crédit Agricole',
                    opening_hours: 'Mo-Fr 09:00-17:00',
                    building: 'yes',
                    'building:levels': 2,
                    'roof:shape': 'gabled',
                    'addr:housenumber': '3',
                    'addr:street': 'Rue du Port',
                    source: 'cadastre-dgi-fr',
                    check_date: '2020-01-01',
                },
                'amenity'
            )
        ).toEqual({
            building: 'yes',
            'building:levels': '2',
            'roof:shape': 'gabled',
            'addr:housenumber': '3',
            'addr:street': 'Rue du Port',
            source: 'cadastre-dgi-fr',
        })
    })

    it('applies to a place on a building relation', () => {
        expect(
            buildingTagsWithoutPlace(
                'relation',
                { type: 'multipolygon', shop: 'bakery', building: 'retail' },
                'shop'
            )
        ).toEqual({ type: 'multipolygon', building: 'retail' })
    })

    it('leaves points, plain buildings and other outlines out', () => {
        expect(
            buildingTagsWithoutPlace(
                'node',
                { amenity: 'bank', building: 'yes' },
                'amenity'
            )
        ).toBeUndefined()
        expect(
            buildingTagsWithoutPlace(
                'way',
                { building: 'house', name: 'Ker Anna' },
                'building'
            )
        ).toBeUndefined()
        expect(
            buildingTagsWithoutPlace('way', { amenity: 'parking' }, 'amenity')
        ).toBeUndefined()
        expect(
            buildingTagsWithoutPlace(
                'way',
                { amenity: 'parking', building: 'no' },
                'amenity'
            )
        ).toBeUndefined()
    })
})
