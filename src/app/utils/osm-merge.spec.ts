import { mergeNodePosition, mergeOsmTags } from './osm-merge'

describe('OSM three-way tag merge', () => {
    it('takes remote changes on keys the user did not touch', () => {
        const result = mergeOsmTags(
            { name: 'Cafe', phone: '1' },
            { name: 'Cafe', phone: '1', website: 'https://a.example' },
            { name: 'Cafe du Port', phone: '1' }
        )

        expect(result.conflicts).toEqual([])
        expect(result.tags).toEqual({
            name: 'Cafe du Port',
            phone: '1',
            website: 'https://a.example',
        })
        expect(result.adoptedRemoteKeys).toEqual(['name'])
    })

    it('keeps local changes on keys nobody else touched, including removals', () => {
        const result = mergeOsmTags(
            { name: 'Cafe', fixme: 'check' },
            { name: 'Cafe Neuf' },
            { name: 'Cafe', fixme: 'check', phone: '2' }
        )

        expect(result.conflicts).toEqual([])
        expect(result.tags).toEqual({ name: 'Cafe Neuf', phone: '2' })
    })

    it('accepts an identical change made on both sides', () => {
        const result = mergeOsmTags(
            { opening_hours: 'Mo-Fr' },
            { opening_hours: 'Mo-Sa' },
            { opening_hours: 'Mo-Sa' }
        )

        expect(result.conflicts).toEqual([])
        expect(result.tags).toEqual({ opening_hours: 'Mo-Sa' })
    })

    it('reports a key changed differently on both sides', () => {
        const result = mergeOsmTags(
            { name: 'Cafe' },
            { name: 'Cafe A' },
            { name: 'Cafe B' }
        )

        expect(result.conflicts).toEqual([
            { key: 'name', base: 'Cafe', mine: 'Cafe A', theirs: 'Cafe B' },
        ])
        expect(result.tags).toEqual({ name: 'Cafe A' })
    })

    it('reports a local edit of a key removed remotely', () => {
        const result = mergeOsmTags({ phone: '1' }, { phone: '2' }, {})

        expect(result.conflicts).toEqual([
            { key: 'phone', base: '1', mine: '2', theirs: undefined },
        ])
    })
})

describe('OSM node position merge', () => {
    it('follows whichever side moved', () => {
        expect(mergeNodePosition([1, 1], [1, 1], [2, 2])).toEqual({
            position: [2, 2],
            conflict: false,
        })
        expect(mergeNodePosition([1, 1], [3, 3], [1, 1])).toEqual({
            position: [3, 3],
            conflict: false,
        })
    })

    it('reports a node moved differently on both sides', () => {
        expect(mergeNodePosition([1, 1], [3, 3], [2, 2]).conflict).toBe(true)
    })
})
