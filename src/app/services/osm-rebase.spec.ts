import type { OsmGoFeature } from '@osmgo/type'
import { currentVersionOf, rebaseOnRemote } from './osm-rebase'

const node = (
    tags: Record<string, string>,
    version: number,
    coordinates = [2, 48]
): OsmGoFeature =>
    ({
        type: 'Feature',
        id: 'node/12',
        geometry: { type: 'Point', coordinates },
        properties: {
            id: 12,
            type: 'node',
            tags,
            primaryTag: { key: 'amenity', value: 'cafe' },
            meta: {
                version,
                changeset: '1',
                timestamp: '2026-01-01T00:00:00Z',
                user: 'old',
                uid: '1',
            },
        },
    }) as unknown as OsmGoFeature

const pendingUpdate = (
    base: OsmGoFeature,
    tags: Record<string, string>,
    coordinates?: number[]
): OsmGoFeature => {
    const pending = structuredClone(base)
    pending.properties.tags = tags
    pending.properties.changeType = 'Update'
    pending.properties.originalData = base
    if (coordinates) {
        pending.geometry = { type: 'Point', coordinates }
    }
    return pending
}

const remoteNode = (
    tags: Record<string, string>,
    version: number,
    extra: Record<string, unknown> = {}
) => ({
    type: 'node' as const,
    id: 12,
    version,
    lat: 48,
    lon: 2,
    changeset: 99,
    timestamp: '2026-06-01T00:00:00Z',
    user: 'other',
    uid: 7,
    tags,
    ...extra,
})

const identity = (feature: OsmGoFeature) => feature

describe('rebasing a pending edit on the current OSM version', () => {
    const base = node({ amenity: 'cafe', name: 'Cafe' }, 3)

    it('re-applies the local tags on a remote change that does not overlap', () => {
        const pending = pendingUpdate(base, {
            amenity: 'cafe',
            name: 'Cafe',
            website: 'https://cafe.example',
        })

        const outcome = rebaseOnRemote(
            pending,
            remoteNode({ amenity: 'cafe', name: 'Cafe', phone: '1' }, 4),
            identity
        )

        expect(outcome.kind).toBe('rebased')
        if (outcome.kind !== 'rebased') return
        const { properties } = outcome.feature
        expect(properties.tags).toEqual({
            amenity: 'cafe',
            name: 'Cafe',
            website: 'https://cafe.example',
            phone: '1',
        })
        expect(properties.meta).toMatchObject({
            version: 4,
            changeset: '99',
            user: 'other',
            uid: '7',
        })
        expect(properties.changeType).toBe('Update')
        expect(properties.originalData?.properties.tags).toEqual({
            amenity: 'cafe',
            name: 'Cafe',
            phone: '1',
        })
        expect(properties.originalData?.properties.meta.version).toBe(4)
    })

    it('reports the tags edited differently on both sides and changes nothing', () => {
        const pending = pendingUpdate(base, { amenity: 'cafe', name: 'Mine' })

        const outcome = rebaseOnRemote(
            pending,
            remoteNode({ amenity: 'cafe', name: 'Theirs' }, 4),
            identity
        )

        expect(outcome).toEqual({
            kind: 'conflict',
            conflicts: [
                { key: 'name', base: 'Cafe', mine: 'Mine', theirs: 'Theirs' },
            ],
            position: false,
            structure: false,
            differences: [
                {
                    key: 'name',
                    mine: 'Mine',
                    theirs: 'Theirs',
                    origin: 'conflict',
                },
            ],
        })
    })

    it('lists each differing tag with the side its value comes from', () => {
        const pending = pendingUpdate(base, {
            amenity: 'cafe',
            name: 'Mine',
            website: 'https://cafe.example',
        })

        const outcome = rebaseOnRemote(
            pending,
            remoteNode({ amenity: 'cafe', name: 'Theirs', phone: '1' }, 4),
            identity
        )

        expect(
            outcome.kind === 'conflict' &&
                outcome.differences.map(({ key, origin }) => [key, origin])
        ).toEqual([
            ['name', 'conflict'],
            ['phone', 'remote'],
            ['website', 'local'],
        ])
    })

    it('applies the value chosen for each overlapping tag', () => {
        const pending = pendingUpdate(base, { amenity: 'bench' })

        const outcome = rebaseOnRemote(
            pending,
            remoteNode({ amenity: 'cafe', name: 'Theirs' }, 4),
            identity,
            { tags: { amenity: 'mine', name: 'theirs' } }
        )

        expect(outcome.kind).toBe('rebased')
        expect(
            outcome.kind === 'rebased' && outcome.feature.properties.tags
        ).toEqual({ amenity: 'bench', name: 'Theirs' })
    })

    it('removes a tag when the chosen OpenStreetMap side has none', () => {
        const pending = pendingUpdate(base, { amenity: 'cafe', name: 'Mine' })

        const outcome = rebaseOnRemote(
            pending,
            remoteNode({ amenity: 'cafe' }, 4),
            identity,
            { tags: { name: 'theirs' } }
        )

        expect(
            outcome.kind === 'rebased' && outcome.feature.properties.tags
        ).toEqual({ amenity: 'cafe' })
    })

    it('keeps the overlaps that were not chosen yet', () => {
        const pending = pendingUpdate(base, { amenity: 'bar', name: 'Mine' })

        const outcome = rebaseOnRemote(
            pending,
            remoteNode({ amenity: 'pub', name: 'Theirs' }, 4),
            identity,
            { tags: { name: 'mine' } }
        )

        expect(
            outcome.kind === 'conflict' &&
                outcome.conflicts.map(({ key }) => key)
        ).toEqual(['amenity'])
    })

    it('follows a node moved remotely and keeps a node moved locally', () => {
        const remoteMoved = rebaseOnRemote(
            pendingUpdate(base, { amenity: 'cafe', name: 'Bar' }),
            remoteNode({ amenity: 'cafe', name: 'Cafe' }, 4, { lat: 49 }),
            identity
        )
        const localMoved = rebaseOnRemote(
            pendingUpdate(
                base,
                base.properties.tags as Record<string, string>,
                [3, 48]
            ),
            remoteNode({ amenity: 'cafe', name: 'Cafe', phone: '1' }, 4),
            identity
        )

        expect(
            remoteMoved.kind === 'rebased' && remoteMoved.feature.geometry
        ).toEqual({ type: 'Point', coordinates: [2, 49] })
        expect(
            localMoved.kind === 'rebased' && localMoved.feature.geometry
        ).toEqual({ type: 'Point', coordinates: [3, 48] })
    })

    it('reports a node moved to two different places', () => {
        const outcome = rebaseOnRemote(
            pendingUpdate(
                base,
                base.properties.tags as Record<string, string>,
                [3, 48]
            ),
            remoteNode({ amenity: 'cafe', name: 'Cafe' }, 4, { lat: 49 }),
            identity
        )

        expect(outcome).toMatchObject({ kind: 'conflict', position: true })
    })

    it('uses the position chosen for a node moved on both sides', () => {
        const pending = pendingUpdate(
            base,
            base.properties.tags as Record<string, string>,
            [3, 48]
        )
        const remote = remoteNode({ amenity: 'cafe', name: 'Cafe' }, 4, {
            lat: 49,
        })

        const theirs = rebaseOnRemote(pending, remote, identity, {
            position: 'theirs',
        })
        const mine = rebaseOnRemote(pending, remote, identity, {
            position: 'mine',
        })

        expect(theirs.kind === 'rebased' && theirs.feature.geometry).toEqual({
            type: 'Point',
            coordinates: [2, 49],
        })
        expect(mine.kind === 'rebased' && mine.feature.geometry).toEqual({
            type: 'Point',
            coordinates: [3, 48],
        })
    })

    it('does nothing when the base is already the current version', () => {
        const outcome = rebaseOnRemote(
            pendingUpdate(base, { amenity: 'cafe' }),
            remoteNode({ amenity: 'cafe', name: 'Cafe' }, 3),
            identity
        )

        expect(outcome).toEqual({ kind: 'upToDate' })
    })

    it('leaves a way whose nodes changed remotely to the user', () => {
        const wayBase = {
            ...node({ highway: 'path' }, 2),
            id: 'way/7',
            ndRefs: [1, 2, 3],
        } as unknown as OsmGoFeature
        wayBase.properties.id = 7
        wayBase.properties.type = 'way'
        const pending = pendingUpdate(wayBase, { highway: 'footway' })

        const outcome = rebaseOnRemote(
            pending,
            {
                type: 'way',
                id: 7,
                version: 3,
                nodes: [1, 2, 3, 4],
                tags: { highway: 'path' },
            },
            identity
        )

        expect(outcome).toMatchObject({ kind: 'conflict', structure: true })
    })

    it('rebases a way whose nodes are unchanged', () => {
        const wayBase = {
            ...node({ highway: 'path' }, 2),
            id: 'way/7',
            ndRefs: [1, 2, 3],
        } as unknown as OsmGoFeature
        wayBase.properties.id = 7
        wayBase.properties.type = 'way'
        const pending = pendingUpdate(wayBase, { highway: 'footway' })

        const outcome = rebaseOnRemote(
            pending,
            {
                type: 'way',
                id: 7,
                version: 3,
                nodes: [1, 2, 3],
                tags: { highway: 'path', surface: 'gravel' },
            },
            identity
        )

        expect(
            outcome.kind === 'rebased' && outcome.feature.properties.tags
        ).toEqual({ highway: 'footway', surface: 'gravel' })
    })

    it.each([
        ['unchanged', 'outer', 'rebased'],
        ['changed', 'inner', 'conflict'],
    ])(
        'handles a relation whose members are %s remotely',
        (_label, remoteRole, kind) => {
            const relationBase = {
                ...node({ type: 'multipolygon', leisure: 'park' }, 2),
                id: 'relation/9',
                members: [{ type: 'way', ref: 7, role: 'outer' }],
            } as unknown as OsmGoFeature
            relationBase.properties.id = 9
            relationBase.properties.type = 'relation'
            const pending = pendingUpdate(relationBase, {
                type: 'multipolygon',
                leisure: 'park',
                name: 'Parc',
            })

            const outcome = rebaseOnRemote(
                pending,
                {
                    type: 'relation',
                    id: 9,
                    version: 3,
                    members: [{ type: 'way', ref: 7, role: remoteRole }],
                    tags: {
                        type: 'multipolygon',
                        leisure: 'park',
                        access: 'yes',
                    },
                },
                identity
            )

            expect(outcome.kind).toBe(kind)
        }
    )

    it('rebuilds the current OpenStreetMap version of a dropped edit', () => {
        const pending = pendingUpdate(base, { amenity: 'cafe', name: 'Mine' })

        const current = currentVersionOf(
            pending,
            remoteNode({ amenity: 'cafe', name: 'Theirs' }, 4, { lat: 49 }),
            identity
        )

        expect(current?.properties.tags).toEqual({
            amenity: 'cafe',
            name: 'Theirs',
        })
        expect(current?.properties.meta.version).toBe(4)
        expect(current?.geometry).toEqual({
            type: 'Point',
            coordinates: [2, 49],
        })
        expect(current?.properties.changeType).toBeUndefined()
        expect(current?.properties.originalData).toBeUndefined()
    })

    it('cannot rebuild a deleted object or a way whose nodes changed', () => {
        const wayBase = {
            ...node({ highway: 'path' }, 2),
            id: 'way/7',
            ndRefs: [1, 2, 3],
        } as unknown as OsmGoFeature
        wayBase.properties.type = 'way'

        expect(
            currentVersionOf(
                pendingUpdate(base, { amenity: 'bar' }),
                remoteNode({}, 4, { visible: false }),
                identity
            )
        ).toBeUndefined()
        expect(
            currentVersionOf(
                pendingUpdate(wayBase, { highway: 'footway' }),
                { type: 'way', id: 7, version: 3, nodes: [1, 2, 4] },
                identity
            )
        ).toBeUndefined()
    })

    it('only rebases pending modifications', () => {
        const created = node({ amenity: 'cafe' }, 0)
        created.properties.changeType = 'Create'

        expect(rebaseOnRemote(created, remoteNode({}, 1), identity)).toEqual({
            kind: 'unsupported',
        })
    })
})
