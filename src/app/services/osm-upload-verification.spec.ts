import type { OsmGoFeature } from '@osmgo/type'
import type { PersistedUploadSubmission } from '@services/osm-state'
import {
    matchUploadAgainstChangeset,
    parseChangesetDownload,
} from './osm-upload-verification'

const submission = (
    operation: 'Create' | 'Update' | 'Delete',
    id: number,
    options: {
        type?: 'node' | 'way' | 'relation'
        version?: number
        coordinates?: number[]
        tags?: Record<string, string>
    } = {}
): PersistedUploadSubmission => {
    const type = options.type ?? 'node'
    return {
        oldId: `${type}/${id}`,
        operation,
        feature: {
            type: 'Feature',
            id: `${type}/${id}`,
            geometry: {
                type: 'Point',
                coordinates: options.coordinates ?? [2.35, 48.85],
            },
            properties: {
                id,
                type,
                changeType: operation,
                tags: options.tags ?? { amenity: 'bench' },
                primaryTag: { key: 'amenity', value: 'bench' },
                meta: { version: options.version ?? 3 },
            },
        } as unknown as OsmGoFeature,
    }
}

const document = (...blocks: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?><osmChange version="0.6" generator="OpenStreetMap server">${blocks.join('')}</osmChange>`

describe('upload verification against a changeset download', () => {
    it('recognises a created node by position and tags and gives its new identity', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<create><node id="901" version="1" lat="48.8500000" lon="2.3500000"><tag k="amenity" v="bench"/></node></create>'
            ),
            [submission('Create', -1)]
        )

        expect(result).toEqual({
            kind: 'applied',
            receipt: [
                {
                    type: 'node',
                    old_id: '-1',
                    osmgoOldId: 'node/-1',
                    new_id: '901',
                    new_version: 1,
                    osmgoNewId: 'node/901',
                },
            ],
        })
    })

    it('does not mistake another node at a different place for a creation', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<create><node id="901" version="1" lat="10" lon="10"><tag k="amenity" v="bench"/></node></create>'
            ),
            [submission('Create', -1)]
        )

        expect(result).toEqual({ kind: 'notFound' })
    })

    it('matches two creations one to one', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<create><node id="901" version="1" lat="48.85" lon="2.35"><tag k="amenity" v="bench"/></node><node id="902" version="1" lat="48.85" lon="2.35"><tag k="amenity" v="bench"/></node></create>'
            ),
            [submission('Create', -1), submission('Create', -2)]
        )

        expect(result.kind).toBe('applied')
        if (result.kind === 'applied') {
            expect(result.receipt.map((row) => row.new_id)).toEqual([
                '901',
                '902',
            ])
        }
    })

    it('does not take an object of a reused changeset with other tags for a creation', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<create><node id="111" version="1" lat="48.85" lon="2.35" changeset="9"><tag k="amenity" v="bench"/><tag k="name" v="Ancien"/></node></create>'
            ),
            [
                submission('Create', -1, {
                    tags: { amenity: 'bench', name: 'Nouveau' },
                }),
            ]
        )

        expect(result).toEqual({ kind: 'notFound' })
    })

    it('ignores an identical object this device already knows', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<create><node id="111" version="1" lat="48.85" lon="2.35"><tag k="amenity" v="bench"/></node></create>'
            ),
            [submission('Create', -1)],
            (id) => id === 'node/111'
        )

        expect(result).toEqual({ kind: 'notFound' })
    })

    it('does not decide between several identical unknown objects', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<create><node id="111" version="1" lat="48.85" lon="2.35"><tag k="amenity" v="bench"/></node><node id="112" version="1" lat="48.85" lon="2.35"><tag k="amenity" v="bench"/></node></create>'
            ),
            [submission('Create', -1)]
        )

        expect(result).toEqual({
            kind: 'partial',
            matched: [],
            missing: ['node/-1'],
        })
    })

    it('recognises modifications by identity and next version, in any block order', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<modify><way id="7" version="5"><nd ref="1"/><nd ref="2"/><tag k="highway" v="path"/></way></modify>',
                '<modify><node id="12" version="4" lat="1" lon="2"/></modify>',
                '<modify><relation id="3" version="2"><member type="way" ref="7" role=""/></relation></modify>'
            ),
            [
                submission('Update', 12, { version: 3 }),
                submission('Update', 7, { type: 'way', version: 4 }),
                submission('Update', 3, { type: 'relation', version: 1 }),
            ]
        )

        expect(result.kind).toBe('applied')
        if (result.kind === 'applied') {
            expect(result.receipt).toContainEqual({
                type: 'way',
                old_id: '7',
                osmgoOldId: 'way/7',
                new_id: '7',
                new_version: 5,
                osmgoNewId: 'way/7',
            })
        }
    })

    it('ignores an edit of the same object made at a different version', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<modify><node id="12" version="9" lat="1" lon="2"/></modify>'
            ),
            [submission('Update', 12, { version: 3 })]
        )

        expect(result).toEqual({ kind: 'notFound' })
    })

    it('recognises a deletion and a deletion sent as a tag removal', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<delete><node id="5" version="4" lat="1" lon="2"/></delete>',
                '<modify><node id="6" version="4" lat="1" lon="2"/></modify>'
            ),
            [
                submission('Delete', 5, { version: 3 }),
                submission('Update', 6, { version: 3 }),
            ]
        )

        expect(result).toEqual({
            kind: 'applied',
            receipt: [
                { type: 'node', old_id: '5', osmgoOldId: 'node/5' },
                {
                    type: 'node',
                    old_id: '6',
                    osmgoOldId: 'node/6',
                    new_id: '6',
                    new_version: 4,
                    osmgoNewId: 'node/6',
                },
            ],
        })
    })

    it('reports a partially visible upload', () => {
        const result = matchUploadAgainstChangeset(
            document(
                '<modify><node id="12" version="4" lat="1" lon="2"/></modify>'
            ),
            [
                submission('Update', 12, { version: 3 }),
                submission('Update', 13, { version: 3 }),
            ]
        )

        expect(result).toEqual({
            kind: 'partial',
            matched: ['node/12'],
            missing: ['node/13'],
        })
    })

    it('treats an empty changeset as not applied', () => {
        expect(
            matchUploadAgainstChangeset(document(), [submission('Update', 12)])
        ).toEqual({ kind: 'notFound' })
    })

    it.each([
        '',
        '<osmChange><create></osmChange>',
        '<html><body>Gateway timeout</body></html>',
    ])('refuses a document that is not an osmChange: %j', (xml) => {
        expect(() => parseChangesetDownload(xml)).toThrow()
    })
})
