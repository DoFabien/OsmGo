import type { OsmGoFeature, OsmGoFeatureCollection } from '@osmgo/type'
import {
    createEmptyOsmState,
    migrateLegacyOsmState,
    migrateLegacyOsmStateWithQuarantine,
    migratePersistedOsmState,
    recoverPersistedOsmState,
} from './osm-state'

const feature = (
    id: number,
    changeType?: 'Create' | 'Update' | 'Delete'
): OsmGoFeature => ({
    type: 'Feature',
    id: `node/${id}`,
    geometry: { type: 'Point', coordinates: [2, 48] },
    properties: {
        changeType,
        hexColor: '',
        icon: '',
        id,
        marker: '',
        meta: {
            changeset: '',
            timestamp: '',
            uid: '',
            user: '',
            version: changeType === 'Create' ? 0 : 1,
        },
        primaryTag: { key: 'amenity', value: 'bench' },
        tags: { amenity: 'bench' },
        type: 'node',
        originalData:
            changeType && changeType !== 'Create' ? feature(id) : undefined,
    },
})

const collection = (features: OsmGoFeature[]): OsmGoFeatureCollection => ({
    type: 'FeatureCollection',
    features,
})

describe('OsmState migrations', () => {
    it('creates an empty versioned state for a fresh installation', () => {
        expect(createEmptyOsmState()).toEqual({
            schemaVersion: 2,
            revision: 0,
            officialById: {},
            pendingById: {},
            bbox: { type: 'FeatureCollection', features: [] },
            nextTemporaryId: -1,
        })
    })

    it('migrates all legacy collections without mutating them', () => {
        const official = feature(10)
        const existingPending = feature(-7, 'Create')
        const zeroPending = feature(0, 'Create')
        const updatedPending = feature(12, 'Update')
        const deletedPending = feature(13, 'Delete')
        const legacy = {
            geojson: collection([official]),
            geojsonChanged: collection([
                zeroPending,
                existingPending,
                updatedPending,
                deletedPending,
            ]),
            geojsonBbox: collection([]),
        }
        const original = structuredClone(legacy)

        const state = migrateLegacyOsmState(legacy)

        expect(state.schemaVersion).toBe(2)
        expect(state.officialById['node/10']).toEqual(official)
        expect(Object.keys(state.pendingById).sort()).toEqual([
            'node/-7',
            'node/-8',
            'node/12',
            'node/13',
        ])
        expect(state.pendingById['node/-8'].properties.id).toBe(-8)
        expect(state.pendingById['node/12'].properties.changeType).toBe(
            'Update'
        )
        expect(state.pendingById['node/13'].properties.changeType).toBe(
            'Delete'
        )
        expect(state.nextTemporaryId).toBe(-9)
        expect(legacy).toEqual(original)
    })

    it('migrates a V1 snapshot and preserves its journal and revision', () => {
        const state = migratePersistedOsmState({
            schemaVersion: 1,
            revision: 4,
            geojson: collection([feature(10)]),
            geojsonChanged: collection([feature(-1, 'Create')]),
            geojsonBbox: collection([]),
            uploadJournal: {
                journalVersion: 1,
                attemptId: 'attempt-1',
                payloadHash: 'payload-hash',
                changesetId: '123',
                submittedIds: ['node/-1'],
                summary: {
                    Total: 1,
                    Create: 1,
                    Update: 0,
                    Delete: 0,
                },
                startedAt: '2026-08-02T10:00:00.000Z',
                phase: 'acknowledged',
                rawReceipt: [{ osmgoOldId: 'node/-1' }],
                acknowledgedAt: '2026-08-02T10:00:01.000Z',
            },
        })

        expect(state).toMatchObject({
            schemaVersion: 2,
            revision: 4,
            nextTemporaryId: -2,
            uploadJournal: {
                attemptId: 'attempt-1',
                phase: 'acknowledged',
                submittedIds: ['node/-1'],
            },
        })
    })

    it('validates and clones an existing V2 snapshot', () => {
        const official = feature(10)
        const persisted = {
            schemaVersion: 2,
            revision: 5,
            officialById: { 'node/10': official },
            pendingById: {},
            bbox: collection([]),
            nextTemporaryId: -1,
        }

        const state = migratePersistedOsmState(persisted)
        state.officialById['node/10'].properties.tags.name = 'Changed clone'

        expect(state.revision).toBe(5)
        expect(official.properties.tags.name).toBeUndefined()
    })

    it.each([
        [{ schemaVersion: 3 }, 'version'],
        [
            {
                schemaVersion: 2,
                revision: -1,
                officialById: {},
                pendingById: {},
                bbox: collection([]),
                nextTemporaryId: -1,
            },
            'revision',
        ],
        [
            {
                schemaVersion: 2,
                revision: 0,
                officialById: { 'node/other': feature(10) },
                pendingById: {},
                bbox: collection([]),
                nextTemporaryId: -1,
            },
            'inconsistent ID',
        ],
        [
            {
                schemaVersion: 2,
                revision: 0,
                officialById: {},
                pendingById: {},
                bbox: collection([]),
                nextTemporaryId: -1,
                uploadJournal: 'corrupted',
            },
            'upload journal',
        ],
    ])('rejects a persisted state with an invalid %s', (state, message) => {
        expect(() => migratePersistedOsmState(state)).toThrow(message)
    })

    it.each([
        {
            source: 'fresh',
            persisted: undefined,
            expectedRevision: 0,
            expectedNextId: -1,
        },
        {
            source: 'V1',
            persisted: {
                schemaVersion: 1,
                revision: 3,
                geojson: collection([feature(10)]),
                geojsonChanged: collection([feature(-4, 'Create')]),
                geojsonBbox: collection([]),
            },
            expectedRevision: 3,
            expectedNextId: -5,
        },
        {
            source: 'V2',
            persisted: {
                schemaVersion: 2,
                revision: 7,
                officialById: { 'node/10': feature(10) },
                pendingById: { 'node/-8': feature(-8, 'Create') },
                bbox: collection([]),
                nextTemporaryId: -9,
            },
            expectedRevision: 7,
            expectedNextId: -9,
        },
    ])(
        'loads the $source release migration fixture idempotently',
        ({ persisted, expectedRevision, expectedNextId }) => {
            const first = persisted
                ? migratePersistedOsmState(persisted)
                : createEmptyOsmState()
            const second = migratePersistedOsmState(first)

            expect(second).toEqual(first)
            expect(second.revision).toBe(expectedRevision)
            expect(second.nextTemporaryId).toBe(expectedNextId)
        }
    )

    describe('legacy migration with per-object quarantine', () => {
        const brokenGeometry = (id: number, changeType?: 'Update') => {
            const broken = feature(id, changeType)
            broken.geometry = {
                type: 'Point',
                coordinates: [Number.POSITIVE_INFINITY, 48],
            }
            return broken
        }

        it('keeps valid V1 objects when others are invalid', () => {
            const legacy = {
                geojson: collection([
                    feature(10),
                    brokenGeometry(11),
                    feature(12),
                ]),
                geojsonChanged: collection([
                    feature(20, 'Update'),
                    brokenGeometry(21, 'Update'),
                    feature(0, 'Create'),
                ]),
                geojsonBbox: collection([]),
            }
            const original = structuredClone(legacy)

            const { state, quarantined } =
                migrateLegacyOsmStateWithQuarantine(legacy)

            expect(() => migrateLegacyOsmState(legacy)).toThrow()
            expect(Object.keys(state.officialById)).toEqual([
                'node/10',
                'node/12',
            ])
            expect(Object.keys(state.pendingById).sort()).toEqual([
                'node/-1',
                'node/20',
            ])
            expect(state.nextTemporaryId).toBe(-2)
            expect(
                quarantined.map(({ store, id }) => `${store}:${id}`).sort()
            ).toEqual(['official:node/11', 'pending:node/21'])
            expect(quarantined[0].value).toEqual(legacy.geojson.features[1])
            expect(legacy).toEqual(original)
        })

        it('sets aside a value that is not a feature collection', () => {
            const { state, quarantined } = migrateLegacyOsmStateWithQuarantine({
                geojson: 'corrupted' as never,
                geojsonChanged: collection([feature(5, 'Update')]),
                geojsonBbox: { type: 'FeatureCollection' } as never,
            })

            expect(state.officialById).toEqual({})
            expect(Object.keys(state.pendingById)).toEqual(['node/5'])
            expect(state.bbox).toEqual(collection([]))
            expect(quarantined.map(({ store }) => store).sort()).toEqual([
                'bbox',
                'official',
            ])
        })

        it('isolates objects without an ID and duplicate pending objects', () => {
            const withoutId = feature(30, 'Update') as unknown as Record<
                string,
                unknown
            >
            delete withoutId['id']

            const { state, quarantined } = migrateLegacyOsmStateWithQuarantine({
                geojsonChanged: collection([
                    feature(31, 'Update'),
                    withoutId as unknown as OsmGoFeature,
                    feature(31, 'Update'),
                ]),
            })

            expect(Object.keys(state.pendingById)).toEqual(['node/31'])
            expect(quarantined).toHaveLength(2)
        })

        it('drops an official copy of an object that is also pending', () => {
            const { state, quarantined } = migrateLegacyOsmStateWithQuarantine({
                geojson: collection([feature(40)]),
                geojsonChanged: collection([feature(40, 'Update')]),
            })

            expect(state.officialById).toEqual({})
            expect(Object.keys(state.pendingById)).toEqual(['node/40'])
            expect(quarantined).toEqual([])
        })

        it('migrates a persisted V1 snapshot with quarantine and a new revision', () => {
            const { state, quarantined } = recoverPersistedOsmState({
                schemaVersion: 1,
                revision: 4,
                geojson: collection([feature(10), brokenGeometry(11)]),
                geojsonChanged: collection([feature(-1, 'Create')]),
                geojsonBbox: collection([]),
            })

            expect(state.revision).toBe(5)
            expect(Object.keys(state.officialById)).toEqual(['node/10'])
            expect(quarantined).toHaveLength(1)
        })

        it('drops unreadable downloaded areas instead of failing', () => {
            vi.spyOn(console, 'warn').mockReturnValue(undefined)
            const { state } = recoverPersistedOsmState({
                schemaVersion: 2,
                revision: 3,
                officialById: { 'node/10': feature(10) },
                pendingById: { 'node/-1': feature(-1, 'Create') },
                bbox: { type: 'FeatureCollection', features: 'broken' },
                nextTemporaryId: -2,
            })

            expect(state.bbox).toEqual(collection([]))
            expect(Object.keys(state.officialById)).toEqual(['node/10'])
            expect(Object.keys(state.pendingById)).toEqual(['node/-1'])
        })

        it('does not share objects with the stored value', () => {
            const stored = {
                schemaVersion: 2,
                revision: 3,
                officialById: { 'node/10': feature(10) },
                pendingById: {},
                bbox: collection([]),
                nextTemporaryId: -1,
            }

            const { state } = recoverPersistedOsmState(stored)
            state.officialById['node/10'].properties.tags['name'] = 'Changed'

            expect(stored.officialById['node/10'].properties.tags).toEqual({
                amenity: 'bench',
            })
        })
    })
})
