import { TestBed } from '@angular/core/testing'
import type {
    OsmGoChangeType,
    OsmGoFeature,
    OsmGoFeatureCollection,
} from '@osmgo/type'
import { AppStorage } from '@services/app-storage.service'
import {
    DataService,
    type OsmDownload,
    UploadInFlightError,
    UploadQueueChangedError,
    UploadQueueLockedError,
} from '@services/data.service'
import {
    composePersistedOsmState,
    OsmStateConflictError,
    OsmStatePersistenceError,
    type PersistedOfficialData,
    type PersistedOsmStateHead,
    type PersistedOsmStateV2,
    type PersistedUploadJournal,
} from '@services/osm-state'
import { featureCollection, point } from '@turf/helpers'
import { firstValueFrom } from 'rxjs'

type StorageSpy = {
    get: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    keys: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
}

const emptyCollection = (): OsmGoFeatureCollection =>
    featureCollection([]) as OsmGoFeatureCollection

function osmFeature(
    id: number,
    changeType?: OsmGoChangeType,
    originalData?: OsmGoFeature | null
): OsmGoFeature {
    return {
        ...point(
            [2, 48],
            {
                changeType,
                hexColor: '#000000',
                icon: 'bench',
                id,
                marker: 'circle-gray-bench',
                meta: {
                    changeset: '',
                    timestamp: '',
                    uid: '',
                    user: '',
                    version: changeType === 'Create' ? 0 : 1,
                },
                originalData,
                primaryTag: { key: 'amenity', value: 'bench' },
                tags: { amenity: 'bench' },
                type: 'node',
            },
            { id: `node/${id}` }
        ),
    } as OsmGoFeature
}

const collection = (features: OsmGoFeature[]): OsmGoFeatureCollection =>
    featureCollection(features) as OsmGoFeatureCollection

const download = (
    features: OsmGoFeature[],
    geojsonBbox = emptyCollection()
): OsmDownload => ({ geojson: collection(features), geojsonBbox })

/** What a restart would read back: the last head and the slot it uses. */
const storedOsmState = (spy: StorageSpy): PersistedOsmStateV2 => {
    const written = new Map<string, unknown>(
        spy.set.mock.calls.map(([key, value]) => [key as string, value])
    )
    const head = written.get('osmState') as PersistedOsmStateHead
    const slot = head.official.slot
    return composePersistedOsmState(
        head,
        slot ? written.get(`osmStateOfficial:${slot}`) : null
    ).value as unknown as PersistedOsmStateV2
}

describe('DataService', () => {
    let service: DataService
    let storageSpy: StorageSpy

    beforeEach(() => {
        storageSpy = {
            get: vi.fn().mockName('Storage.get').mockResolvedValue(null),
            set: vi
                .fn()
                .mockName('Storage.set')
                .mockImplementation((_key: string, value: unknown) =>
                    Promise.resolve(value)
                ),
            keys: vi.fn().mockName('Storage.keys'),
            remove: vi.fn().mockName('Storage.remove'),
            clear: vi.fn().mockName('Storage.clear'),
        }
        TestBed.configureTestingModule({
            providers: [{ provide: AppStorage, useValue: storageSpy }],
        })
        service = TestBed.inject(DataService)
    })

    it('notifies Angular after a pending command is durably committed', async () => {
        expect(service.changedFeatureCount()).toBe(0)

        const created = await service.createPendingFeature(osmFeature(99))

        expect(created.id).toBe('node/-1')
        expect(service.changedFeatureCount()).toBe(1)

        await service.cancelPendingChange('node/-1')

        expect(service.changedFeatureCount()).toBe(0)
    })

    describe('state loading and migration', () => {
        it('migrates legacy keys and removes stale rollback data', async () => {
            const official = osmFeature(10)
            const legacyCreate = osmFeature(0, 'Create')
            const empty = emptyCollection()
            storageSpy.get.mockImplementation((key: string) => {
                if (key === 'osmState') return Promise.resolve(null)
                if (key === 'geojson') {
                    return Promise.resolve(collection([official]))
                }
                if (key === 'geojsonChanged') {
                    return Promise.resolve(collection([legacyCreate]))
                }
                if (key === 'geojsonBbox') return Promise.resolve(empty)
                return Promise.resolve(null)
            })

            const state = await firstValueFrom(service.loadOsmState$())

            expect(state).toMatchObject({
                schemaVersion: 2,
                revision: 0,
                nextTemporaryId: -2,
            })
            expect(Object.keys(state.officialById)).toEqual(['node/10'])
            expect(Object.keys(state.pendingById)).toEqual(['node/-1'])
            expect(service.getGeojsonChanged().features[0].id).toBe('node/-1')
            expect(storedOsmState(storageSpy)).toEqual(state)
            expect(storageSpy.remove).toHaveBeenCalledTimes(3)
            expect(storageSpy.remove).toHaveBeenCalledWith('geojson')
            expect(storageSpy.remove).toHaveBeenCalledWith('geojsonChanged')
            expect(storageSpy.remove).toHaveBeenCalledWith('geojsonBbox')
        })

        it('loads V2 directly and resumes its temporary ID allocator', async () => {
            const official = osmFeature(10)
            const persisted: PersistedOsmStateV2 = {
                schemaVersion: 2,
                revision: 7,
                officialById: { 'node/10': official },
                pendingById: {},
                bbox: emptyCollection(),
                nextTemporaryId: -4,
            }
            storageSpy.get.mockResolvedValue(persisted)

            await firstValueFrom(service.loadOsmState$())
            const created = await service.createPendingFeature(osmFeature(99))

            // V2 data is read directly: the V1 collections are never touched.
            expect(
                storageSpy.get.mock.calls.filter(([key]) => key === 'osmState')
            ).toHaveLength(1)
            for (const legacyKey of [
                'geojson',
                'geojsonChanged',
                'geojsonBbox',
            ]) {
                expect(storageSpy.get).not.toHaveBeenCalledWith(legacyKey)
            }
            expect(created.id).toBe('node/-4')
            expect(service.getGeojson().features).toEqual([official])
        })

        it('quarantines invalid persisted features individually', async () => {
            const official = osmFeature(10)
            const corrupted = osmFeature(11)
            corrupted.geometry = {
                type: 'Point',
                coordinates: [Number.POSITIVE_INFINITY, 48],
            }
            const persisted: PersistedOsmStateV2 = {
                schemaVersion: 2,
                revision: 7,
                officialById: {
                    'node/10': official,
                    'node/11': corrupted,
                },
                pendingById: {},
                bbox: emptyCollection(),
                nextTemporaryId: -1,
            }
            storageSpy.get.mockResolvedValue(persisted)

            const state = await firstValueFrom(service.loadOsmState$())

            expect(state.revision).toBe(8)
            expect(Object.keys(state.officialById)).toEqual(['node/10'])
            expect(storageSpy.set).toHaveBeenCalledWith(
                'osmStateQuarantinedFeatures',
                expect.objectContaining({
                    sourceRevision: 7,
                    features: [
                        expect.objectContaining({
                            store: 'official',
                            id: 'node/11',
                        }),
                    ],
                })
            )
            expect(storedOsmState(storageSpy)).toEqual(state)
        })

        it('does not quarantine a corrupted feature locked by an upload journal', async () => {
            const pending = osmFeature(-1, 'Create')
            ;(pending.properties as unknown as Record<string, unknown>)[
                'tags'
            ] = null
            const persisted: PersistedOsmStateV2 = {
                schemaVersion: 2,
                revision: 7,
                officialById: {},
                pendingById: { 'node/-1': pending },
                bbox: emptyCollection(),
                nextTemporaryId: -2,
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
                    startedAt: '2026-08-04T08:00:00.000Z',
                    phase: 'prepared',
                },
            }
            storageSpy.get.mockResolvedValue(persisted)

            await expect(
                firstValueFrom(service.loadOsmState$())
            ).rejects.toThrow('invalid tags')
            expect(storageSpy.set).not.toHaveBeenCalledWith(
                'osmStateQuarantinedFeatures',
                expect.anything()
            )
        })
    })

    describe('serialized persistence', () => {
        it('persists one revision at a time and publishes only acknowledged state', async () => {
            let resolveFirstWrite!: (value: unknown) => void
            const firstWrite = new Promise((resolve) => {
                resolveFirstWrite = resolve
            })
            const writes: Array<[string, unknown]> = []
            storageSpy.set.mockImplementation((key: string, value: unknown) => {
                writes.push([key, structuredClone(value)])
                return writes.length === 1 ? firstWrite : Promise.resolve(value)
            })
            const firstFeature = osmFeature(1)
            const secondFeature = osmFeature(2)

            const firstMutation = service.applyDownload(
                download([firstFeature])
            )
            const secondMutation = service.applyDownload(
                download([secondFeature])
            )
            await Promise.resolve()

            expect(storageSpy.set).toHaveBeenCalledTimes(1)
            expect(service.getGeojson().features).toEqual([])

            resolveFirstWrite(undefined)
            await Promise.all([firstMutation, secondMutation])

            const heads = writes
                .filter(([key]) => key === 'osmState')
                .map(([, value]) => value as PersistedOsmStateHead)
            const slots = writes
                .filter(([key]) => key.startsWith('osmStateOfficial:'))
                .map(([, value]) => value as PersistedOfficialData)
            expect(heads.map((head) => head.revision)).toEqual([1, 2])
            expect(slots.map((slot) => slot.revision)).toEqual([1, 2])
            expect(Object.keys(slots[0].officialById)).toEqual(['node/1'])
            expect(Object.keys(slots[1].officialById)).toEqual(['node/2'])
            expect(service.getGeojson().features).toEqual([secondFeature])
        })

        it('keeps memory unchanged, exposes the cause and continues after failure', async () => {
            const failedCause = new Error('IndexedDB unavailable')
            storageSpy.set
                .mockRejectedValueOnce(failedCause)
                .mockImplementation(
                    (_key: string, state: PersistedOsmStateV2) =>
                        Promise.resolve(state)
                )

            await expect(
                service.applyDownload(download([osmFeature(1)]))
            ).rejects.toMatchObject({
                name: 'OsmStatePersistenceError',
                operation: 'apply download',
                revision: 1,
                cause: failedCause,
            } satisfies Partial<OsmStatePersistenceError>)
            expect(service.getGeojson().features).toEqual([])

            await service.applyDownload(download([osmFeature(2)]))

            expect(service.getGeojson().features).toEqual([osmFeature(2)])
            expect(storageSpy.set).toHaveBeenLastCalledWith(
                'osmState',
                expect.objectContaining({ revision: 1 })
            )
        })
    })

    describe('atomic commands', () => {
        it('applies a download and its bbox in one cloned snapshot', async () => {
            const official = osmFeature(10)
            const bbox = collection([osmFeature(999)])

            await service.applyDownload(download([official], bbox))
            official.properties.tags.name = 'mutated input'
            bbox.features.length = 0

            // The official data and the head that switches to it.
            expect(storageSpy.set.mock.calls.map(([key]) => key)).toEqual([
                'osmStateOfficial:a',
                'osmState',
            ])
            expect(service.getGeojson().features[0].properties.tags.name).toBe(
                undefined
            )
            expect(service.getGeojsonBbox().features).toHaveLength(1)
        })

        it('rejects duplicate downloaded IDs before scheduling persistence', () => {
            const duplicate = osmFeature(1)

            expect(() =>
                service.applyDownload(download([duplicate, duplicate]))
            ).toThrow('duplicate feature IDs')
            expect(storageSpy.set).not.toHaveBeenCalled()
        })

        it('rejects an inconsistent canonical feature ID', () => {
            const inconsistent = osmFeature(1)
            inconsistent.id = 'way/1'

            expect(() =>
                service.applyDownload(download([inconsistent]))
            ).toThrow('inconsistent OSM identity')
            expect(storageSpy.set).not.toHaveBeenCalled()
        })

        it('allocates temporary IDs inside the create command', async () => {
            const first = await service.createPendingFeature(osmFeature(99))
            const second = await service.createPendingFeature(osmFeature(99))
            const third = await service.createPendingFeature(osmFeature(99))

            expect([first.id, second.id, third.id]).toEqual([
                'node/-1',
                'node/-2',
                'node/-3',
            ])
            expect(
                service
                    .getGeojsonChanged()
                    .features.map((feature) => feature.properties.id)
            ).toEqual([-1, -2, -3])
        })

        it('moves an official feature to pending in one write', async () => {
            const original = osmFeature(10)
            await service.applyDownload(download([original]))
            storageSpy.set.mockClear()
            const patch = osmFeature(10)
            patch.properties.tags.name = 'Edited bench'

            const changed = await service.moveOfficialToPending(
                'node/10',
                patch
            )

            expect(storageSpy.set).toHaveBeenCalledTimes(1)
            expect(service.getGeojson().features).toEqual([])
            expect(changed.properties.changeType).toBe('Update')
            expect(changed.properties.originalData).toEqual(original)
            expect(service.getGeojsonChanged().features).toEqual([changed])
        })

        it('leaves official and pending data unchanged if an atomic move fails', async () => {
            const original = osmFeature(10)
            await service.applyDownload(download([original]))
            storageSpy.set.mockRejectedValueOnce(new Error('disk full'))

            await expect(
                service.moveOfficialToPending('node/10', osmFeature(10))
            ).rejects.toBeInstanceOf(OsmStatePersistenceError)

            expect(service.getGeojson().features).toEqual([original])
            expect(service.getGeojsonChanged().features).toEqual([])
        })

        it('updates pending content while preserving its transition metadata', async () => {
            const original = osmFeature(10)
            await service.applyDownload(download([original]))
            await service.moveOfficialToPending('node/10', osmFeature(10))
            const patch = osmFeature(999)
            patch.properties.tags.name = 'Second edit'

            const updated = await service.updatePendingFeature('node/10', patch)

            expect(updated.id).toBe('node/10')
            expect(updated.properties.id).toBe(10)
            expect(updated.properties.changeType).toBe('Update')
            expect(updated.properties.originalData).toEqual(original)
            expect(updated.properties.tags.name).toBe('Second edit')
        })

        it('deleting a local creation cancels it atomically', async () => {
            const created = await service.createPendingFeature(osmFeature(99))

            const result = await service.markPendingDeleted(String(created.id))

            expect(result).toBeUndefined()
            expect(service.getGeojsonChanged().features).toEqual([])
        })

        it('marks an official feature deleted and cancellation restores it', async () => {
            const original = osmFeature(10)
            await service.applyDownload(download([original]))

            const deleted = await service.markPendingDeleted('node/10')

            expect(service.getGeojson().features).toEqual([])
            expect(deleted?.properties.changeType).toBe('Delete')
            expect(deleted?.properties.originalData).toEqual(original)

            await service.cancelPendingChange('node/10')

            expect(service.getGeojsonChanged().features).toEqual([])
            expect(service.getGeojson().features).toEqual([original])
        })

        it('rejects cancellation when an update has lost its original data', async () => {
            const invalid = osmFeature(10, 'Update', null)
            await service.replacePendingFeatures(collection([invalid]))

            await expect(
                service.cancelPendingChange('node/10')
            ).rejects.toThrow('original feature data is missing')
            expect(service.getGeojsonChanged().features).toEqual([invalid])
        })

        it('cancels every pending transition in one durable write', async () => {
            const first = osmFeature(10)
            const second = osmFeature(11)
            await service.applyDownload(download([first, second]))
            await service.moveOfficialToPending('node/10', osmFeature(10))
            await service.markPendingDeleted('node/11')
            await service.createPendingFeature(osmFeature(99))
            storageSpy.set.mockClear()

            await service.cancelAllPendingChanges()

            expect(storageSpy.set).toHaveBeenCalledTimes(1)
            expect(service.getGeojsonChanged().features).toEqual([])
            expect(
                service
                    .getGeojson()
                    .features.map((feature) => feature.id)
                    .sort()
            ).toEqual(['node/10', 'node/11'])
            const created = await service.createPendingFeature(osmFeature(99))
            expect(created.id).toBe('node/-1')
        })

        it('resets downloaded data without discarding pending edits', async () => {
            await service.applyDownload(download([osmFeature(10)]))
            const created = await service.createPendingFeature(osmFeature(99))

            const empty = await service.resetDownloadedData()

            expect(empty.geojson.features).toEqual([])
            expect(empty.geojsonBbox.features).toEqual([])
            expect(service.getGeojson().features).toEqual([])
            expect(service.getGeojsonChanged().features).toEqual([created])
        })

        it('resets every OSM collection and restarts allocation', async () => {
            await service.applyDownload(download([osmFeature(10)]))
            await service.createPendingFeature(osmFeature(99))

            await service.resetAllData()
            const created = await service.createPendingFeature(osmFeature(99))

            expect(service.getGeojson().features).toEqual([])
            expect(service.getGeojsonBbox().features).toEqual([])
            expect(service.getGeojsonChanged().features).toEqual([created])
            expect(created.id).toBe('node/-1')
        })
    })

    describe('upload receipt', () => {
        it('locks submitted IDs while allowing unrelated queue edits', async () => {
            const submitted = osmFeature(-1, 'Create')
            const unrelated = osmFeature(-2, 'Create')
            await service.replacePendingFeatures(
                collection([submitted, unrelated])
            )
            await service.beginUploadAttempt({
                journalVersion: 1,
                attemptId: 'attempt-1',
                payloadHash: 'legacy-payload-hash',
                changesetId: '123',
                submittedIds: ['node/-1'],
                summary: {
                    Total: 1,
                    Create: 1,
                    Update: 0,
                    Delete: 0,
                },
                startedAt: '2026-08-02T10:00:00.000Z',
                phase: 'prepared',
            })

            await expect(
                service.updatePendingFeature('node/-1', submitted)
            ).rejects.toBeInstanceOf(UploadQueueLockedError)
            await expect(
                service.cancelPendingChange('node/-1')
            ).rejects.toBeInstanceOf(UploadQueueLockedError)
            await expect(
                service.cancelAllPendingChanges()
            ).rejects.toBeInstanceOf(UploadQueueLockedError)

            const updatedUnrelated = structuredClone(unrelated)
            updatedUnrelated.properties.tags.name = 'Allowed edit'
            await expect(
                service.updatePendingFeature('node/-2', updatedUnrelated)
            ).resolves.toMatchObject({
                properties: { tags: { name: 'Allowed edit' } },
            })
        })

        it('persists every journal phase around one atomic reconciliation', async () => {
            const pending = osmFeature(-1, 'Create')
            await service.replacePendingFeatures(collection([pending]))
            storageSpy.set.mockClear()
            const prepared = {
                journalVersion: 1 as const,
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
                phase: 'prepared' as const,
            }

            await service.beginUploadAttempt(prepared)
            await service.acknowledgeUploadAttempt(
                'attempt-1',
                [{ osmgoOldId: 'node/-1' }],
                '2026-08-02T10:00:01.000Z'
            )
            await service.applyAcknowledgedUploadReceipt(
                'attempt-1',
                [{ oldId: 'node/-1', feature: osmFeature(101) }],
                '2026-08-02T10:00:02.000Z'
            )

            expect(service.getUploadJournal()).toMatchObject({
                phase: 'applied',
                attemptId: 'attempt-1',
                appliedAt: '2026-08-02T10:00:02.000Z',
            })
            expect(service.getGeojsonChanged().features).toEqual([])
            expect(service.getGeojson().features).toEqual([osmFeature(101)])

            await service.clearAppliedUploadAttempt('attempt-1')

            const snapshots = storageSpy.set.mock.calls.map(
                (call) => call[1] as PersistedOsmStateV2
            )
            expect(
                snapshots.map((state) => state.uploadJournal?.phase)
            ).toEqual(['prepared', 'acknowledged', 'applied', undefined])
            expect(service.getUploadJournal()).toBeUndefined()
        })

        it('keeps an acknowledged journal when local reconciliation fails', async () => {
            const first = osmFeature(-1, 'Create')
            const second = osmFeature(-2, 'Create')
            await service.replacePendingFeatures(collection([first, second]))
            await service.beginUploadAttempt({
                journalVersion: 1,
                attemptId: 'attempt-1',
                payloadHash: 'payload-hash',
                changesetId: '123',
                submittedIds: ['node/-1', 'node/-2'],
                summary: {
                    Total: 2,
                    Create: 2,
                    Update: 0,
                    Delete: 0,
                },
                startedAt: '2026-08-02T10:00:00.000Z',
                phase: 'prepared',
            })
            await service.acknowledgeUploadAttempt(
                'attempt-1',
                [{ osmgoOldId: 'node/-1' }, { osmgoOldId: 'node/-2' }],
                '2026-08-02T10:00:01.000Z'
            )

            await expect(
                service.applyAcknowledgedUploadReceipt(
                    'attempt-1',
                    [{ oldId: 'node/-1', feature: osmFeature(101) }],
                    '2026-08-02T10:00:02.000Z'
                )
            ).rejects.toThrow('does not match local data')

            expect(service.getUploadJournal()?.phase).toBe('acknowledged')
            expect(service.getGeojsonChanged().features).toEqual([
                first,
                second,
            ])
        })

        it('reconciles one hundred creations in one write', async () => {
            const pending = Array.from({ length: 100 }, (_value, index) =>
                osmFeature(-(index + 1), 'Create')
            )
            await service.replacePendingFeatures(collection(pending))
            storageSpy.set.mockClear()

            await service.applyUploadReceipt(
                pending.map((feature, index) => ({
                    oldId: String(feature.id),
                    feature: osmFeature(index + 1),
                }))
            )

            expect(storageSpy.set).toHaveBeenCalledTimes(1)
            expect(service.getGeojsonChanged().features).toEqual([])
            expect(service.getGeojson().features).toHaveLength(100)
        })

        it('rejects receipts that omit pending entries', async () => {
            const first = osmFeature(-1, 'Create')
            const second = osmFeature(-2, 'Create')
            await service.replacePendingFeatures(collection([first, second]))

            await expect(
                service.applyUploadReceipt([
                    { oldId: 'node/-1', feature: osmFeature(101) },
                ])
            ).rejects.toThrow('does not match local data')

            expect(service.getGeojsonChanged().features).toEqual([
                first,
                second,
            ])
            expect(service.getGeojson().features).toEqual([])
        })

        it('rejects duplicate or unknown receipt IDs without changing state', async () => {
            const pending = osmFeature(-1, 'Create')
            await service.replacePendingFeatures(collection([pending]))

            await expect(
                service.applyUploadReceipt([
                    { oldId: 'node/-1', feature: osmFeature(101) },
                    { oldId: 'node/-999', feature: osmFeature(102) },
                ])
            ).rejects.toThrow('does not match local data')

            expect(service.getGeojsonChanged().features).toEqual([pending])
            expect(service.getGeojson().features).toEqual([])
        })

        it('keeps memory unchanged if receipt persistence fails', async () => {
            const pending = osmFeature(-1, 'Create')
            const official = osmFeature(50)
            await service.applyDownload(download([official]))
            await service.replacePendingFeatures(collection([pending]))
            storageSpy.set.mockRejectedValueOnce(new Error('disk full'))

            await expect(
                service.applyUploadReceipt([
                    { oldId: 'node/-1', feature: osmFeature(101) },
                ])
            ).rejects.toBeInstanceOf(OsmStatePersistenceError)

            expect(service.getGeojsonChanged().features).toEqual([pending])
            expect(service.getGeojson().features).toEqual([official])
        })
    })

    describe('immutable reads', () => {
        it('keeps official and pending IDs disjoint after queue replacement', async () => {
            const official = osmFeature(10)
            const pending = osmFeature(10, 'Update', official)
            await service.applyDownload(download([official]))

            await service.replacePendingFeatures(collection([pending]))

            expect(service.getGeojson().features).toEqual([])
            expect(service.getGeojsonChanged().features).toEqual([pending])
        })

        it('keeps official and pending IDs disjoint after a download', async () => {
            const pending = osmFeature(10, 'Update', osmFeature(10))
            await service.replacePendingFeatures(collection([pending]))

            await service.applyDownload(
                download([osmFeature(10), osmFeature(11)])
            )

            expect(service.getGeojson().features.map(({ id }) => id)).toEqual([
                'node/11',
            ])
            expect(service.getGeojsonChanged().features).toEqual([pending])
        })

        it('looks up records directly and returns detached snapshots', async () => {
            const official = osmFeature(1)
            const pending = osmFeature(-1, 'Create')
            await service.applyDownload(download([official]))
            await service.replacePendingFeatures(collection([pending]))

            const officialRead = service.getFeatureById('node/1', 'data')
            const pendingRead = service.getFeatureById(
                'node/-1',
                'data_changed'
            )
            if (!officialRead || !pendingRead) {
                throw new Error('Expected seeded features to be readable.')
            }
            officialRead.properties.tags.name = 'mutated read'
            pendingRead.properties.tags.name = 'mutated read'

            expect(
                service.getFeatureById('node/missing', 'data')
            ).toBeUndefined()
            expect(service.getFeatureById('node/1', 'data')).toEqual(official)
            expect(service.getFeatureById('node/-1', 'data_changed')).toEqual(
                pending
            )
        })

        it('shares the stored objects instead of cloning them for each redraw', async () => {
            await service.applyDownload(download([osmFeature(1)]))
            await service.createPendingFeature(osmFeature(99))

            expect(service.getGeojson().features[0]).toBe(
                service.getGeojson().features[0]
            )
            expect(service.getGeojsonChanged().features[0]).toBe(
                service.getGeojsonChanged().features[0]
            )
        })

        it('does not expose mutable collections or bbox state', async () => {
            const bbox = collection([osmFeature(999)])
            await service.applyDownload(download([osmFeature(1)], bbox))

            service.getGeojson().features.length = 0
            service.getGeojsonBbox().features.length = 0

            expect(service.getGeojson().features).toHaveLength(1)
            expect(service.getGeojsonBbox().features).toHaveLength(1)
        })
    })

    describe('cache helpers', () => {
        it('writes and reads icon cache entries', async () => {
            await service.addIconCache('foobar', 'foo:bar')
            storageSpy.get.mockResolvedValue('foo:bar')

            expect(await service.getIconCache('foobar')).toBe('foo:bar')
            expect(storageSpy.set).toHaveBeenCalledWith('foobar', 'foo:bar')
        })

        it('reports icon cache persistence failures', async () => {
            storageSpy.set.mockRejectedValueOnce(new Error('disk full'))

            await expect(
                service.addIconCache('foobar', 'foo:bar')
            ).rejects.toThrow('disk full')
        })

        it('filters and clears icon cache keys', async () => {
            storageSpy.keys.mockResolvedValue([
                'abc',
                'circle_abc',
                'square_def',
                'penta_ghi',
            ])

            expect(await service.clearIconCache()).toBe(3)
            expect(storageSpy.remove).toHaveBeenCalledTimes(3)
        })

        it('clears the configured store without deleting a wrongly named database', async () => {
            const indexedDbDescriptor = Object.getOwnPropertyDescriptor(
                window,
                'indexedDB'
            )
            const deleteDatabase = vi.fn()
            Object.defineProperty(window, 'indexedDB', {
                configurable: true,
                value: { deleteDatabase },
            })
            try {
                await service.clearCache()
            } finally {
                if (indexedDbDescriptor) {
                    Object.defineProperty(
                        window,
                        'indexedDB',
                        indexedDbDescriptor
                    )
                } else {
                    Reflect.deleteProperty(window, 'indexedDB')
                }
            }

            expect(storageSpy.clear).toHaveBeenCalledOnce()
            expect(deleteDatabase).not.toHaveBeenCalled()
        })
    })

    describe('V1 migration with unreadable objects', () => {
        const v1Dump = () => {
            const brokenOfficial = osmFeature(11)
            brokenOfficial.geometry = {
                type: 'Point',
                coordinates: [Number.POSITIVE_INFINITY, 48],
            }
            const brokenPending = osmFeature(21, 'Update', osmFeature(21))
            ;(brokenPending.properties as unknown as Record<string, unknown>)[
                'tags'
            ] = null
            return {
                geojson: collection([osmFeature(10), brokenOfficial]),
                geojsonChanged: collection([
                    osmFeature(20, 'Update', osmFeature(20)),
                    brokenPending,
                    osmFeature(0, 'Create'),
                ]),
                geojsonBbox: emptyCollection(),
            }
        }
        const serveV1 = (dump: ReturnType<typeof v1Dump>, extra = {}) => {
            storageSpy.get.mockImplementation((key: string) =>
                Promise.resolve(
                    (
                        { ...dump, osmState: null, ...extra } as Record<
                            string,
                            unknown
                        >
                    )[key] ?? null
                )
            )
        }

        it('starts with the valid objects and sets the others aside', async () => {
            serveV1(v1Dump())

            const state = await firstValueFrom(service.loadOsmState$())

            expect(Object.keys(state.officialById)).toEqual(['node/10'])
            expect(Object.keys(state.pendingById).sort()).toEqual([
                'node/-1',
                'node/20',
            ])
            expect(service.quarantinedCount()).toBe(2)
            expect(service.quarantinedPendingCount()).toBe(1)
            const quarantine = storageSpy.set.mock.calls.find(
                ([key]) => key === 'osmStateQuarantinedFeatures'
            )?.[1] as { features: Array<Record<string, unknown>> }
            expect(
                quarantine.features.map(({ store, id, source }) => [
                    store,
                    id,
                    source,
                ])
            ).toEqual([
                ['official', 'node/11', 'v1-migration'],
                ['pending', 'node/21', 'v1-migration'],
            ])
        })

        it('keeps the V1 collections until the new state and the quarantine are saved', async () => {
            serveV1(v1Dump())
            const order: string[] = []
            storageSpy.set.mockImplementation((key: string, value: unknown) => {
                order.push(`set:${key}`)
                return Promise.resolve(value)
            })
            storageSpy.remove.mockImplementation((key: string) => {
                order.push(`remove:${key}`)
                return Promise.resolve()
            })

            await firstValueFrom(service.loadOsmState$())

            expect(
                order.indexOf('set:osmStateQuarantinedFeatures')
            ).toBeLessThan(order.indexOf('set:osmState'))
            expect(order.indexOf('set:osmState')).toBeLessThan(
                order.indexOf('remove:geojson')
            )
        })

        it('keeps the V1 collections when the new state cannot be saved', async () => {
            serveV1(v1Dump())
            storageSpy.set.mockImplementation((key: string, value: unknown) =>
                key === 'osmState'
                    ? Promise.reject(new Error('quota'))
                    : Promise.resolve(value)
            )

            await expect(
                firstValueFrom(service.loadOsmState$())
            ).rejects.toThrow('quota')

            expect(storageSpy.remove).not.toHaveBeenCalled()
        })

        it('adds to an earlier quarantine instead of replacing it', async () => {
            const earlier = {
                quarantinedAt: '2026-01-01T00:00:00.000Z',
                sourceRevision: 3,
                features: [
                    {
                        store: 'official',
                        id: 'node/1',
                        value: { kept: true },
                        reason: 'old',
                    },
                ],
            }
            serveV1(v1Dump(), { osmStateQuarantinedFeatures: earlier })

            await firstValueFrom(service.loadOsmState$())

            const written = storageSpy.set.mock.calls.find(
                ([key]) => key === 'osmStateQuarantinedFeatures'
            )?.[1] as { features: Array<{ id: string }> }
            expect(written.features.map(({ id }) => id)).toEqual([
                'node/1',
                'node/11',
                'node/21',
            ])
            expect(service.quarantinedCount()).toBe(3)
            await expect(
                service.getQuarantinedFeatures()
            ).resolves.toBeDefined()
        })

        it('does not duplicate entries when the same migration runs twice', async () => {
            serveV1(v1Dump())
            await firstValueFrom(service.loadOsmState$())
            const firstWrite = storageSpy.set.mock.calls.find(
                ([key]) => key === 'osmStateQuarantinedFeatures'
            )?.[1]
            serveV1(v1Dump(), { osmStateQuarantinedFeatures: firstWrite })
            storageSpy.set.mockClear()

            await firstValueFrom(service.loadOsmState$())

            expect(storageSpy.set).not.toHaveBeenCalledWith(
                'osmStateQuarantinedFeatures',
                expect.anything()
            )
        })

        it('clears the quarantine on request', async () => {
            serveV1(v1Dump())
            await firstValueFrom(service.loadOsmState$())

            await service.clearQuarantine()

            expect(storageSpy.remove).toHaveBeenCalledWith(
                'osmStateQuarantinedFeatures'
            )
            expect(service.quarantinedCount()).toBe(0)
        })
    })

    describe('resetting unreadable local data', () => {
        it('copies the unified state and V1 keys under another name before removing them', async () => {
            const values: Record<string, unknown> = {
                osmState: { corrupted: true },
                geojson: collection([osmFeature(10)]),
                geojsonChanged: collection([osmFeature(20, 'Update')]),
            }
            storageSpy.get.mockImplementation((key: string) =>
                Promise.resolve(values[key] ?? null)
            )
            storageSpy.keys.mockResolvedValue([])
            const order: string[] = []
            storageSpy.set.mockImplementation((key: string, value: unknown) => {
                order.push(`set:${key.split(':')[0]}`)
                return Promise.resolve(value)
            })
            storageSpy.remove.mockImplementation((key: string) => {
                order.push(`remove:${key}`)
                return Promise.resolve()
            })

            const backupKey = await service.resetStoredOsmState()

            expect(backupKey).toMatch(/^osmStateBackup:/)
            expect(storageSpy.set).toHaveBeenCalledWith(
                backupKey,
                expect.objectContaining({
                    entries: {
                        osmState: { corrupted: true },
                        geojson: values['geojson'],
                        geojsonChanged: values['geojsonChanged'],
                    },
                })
            )
            expect(order[0]).toBe('set:osmStateBackup')
            expect(order).toEqual(
                expect.arrayContaining([
                    'remove:osmState',
                    'remove:geojson',
                    'remove:geojsonChanged',
                    'remove:geojsonBbox',
                ])
            )
        })

        it('keeps the state and the V1 collections when no backup could be written', async () => {
            storageSpy.get.mockImplementation((key: string) =>
                Promise.resolve(
                    key === 'geojsonChanged' || key === 'osmState'
                        ? collection([osmFeature(20, 'Update')])
                        : null
                )
            )
            storageSpy.set.mockRejectedValue(new Error('quota'))
            vi.spyOn(console, 'error').mockReturnValue(undefined)

            await expect(service.resetStoredOsmState()).rejects.toThrow(
                'could not be backed up'
            )

            expect(storageSpy.set).toHaveBeenCalledTimes(2)
            expect(storageSpy.remove).toHaveBeenCalledWith('osmStateOfficial:a')
            expect(storageSpy.remove).not.toHaveBeenCalledWith('osmState')
            expect(storageSpy.remove).not.toHaveBeenCalledWith('geojsonChanged')
        })

        it('backs up the pending queue but not the downloaded data', async () => {
            const values: Record<string, unknown> = {
                osmState: { corrupted: true },
                'osmStateOfficial:a': { officialById: { huge: true } },
                osmStateQuarantinedFeatures: { features: [] },
            }
            storageSpy.get.mockImplementation((key: string) =>
                Promise.resolve(values[key] ?? null)
            )
            storageSpy.keys.mockResolvedValue([])

            const backupKey = await service.resetStoredOsmState()

            expect(storageSpy.set).toHaveBeenCalledWith(backupKey, {
                backedUpAt: expect.any(String),
                entries: { osmState: { corrupted: true } },
            })
            expect(storageSpy.remove).toHaveBeenCalledWith('osmStateOfficial:a')
            expect(storageSpy.remove).not.toHaveBeenCalledWith(
                'osmStateQuarantinedFeatures'
            )
        })

        it('sets the quarantine aside too when asked, and lists the backups', async () => {
            const values: Record<string, unknown> = {
                osmStateQuarantinedFeatures: { features: [] },
            }
            storageSpy.get.mockImplementation((key: string) =>
                Promise.resolve(values[key] ?? null)
            )
            storageSpy.set.mockImplementation((key: string, value: unknown) => {
                values[key] = value
                return Promise.resolve(value)
            })
            storageSpy.keys.mockImplementation(() =>
                Promise.resolve(Object.keys(values))
            )

            const backupKey = await service.resetStoredOsmState({
                includeQuarantine: true,
            })

            expect(storageSpy.remove).toHaveBeenCalledWith(
                'osmStateQuarantinedFeatures'
            )
            await expect(service.getStateBackups()).resolves.toEqual([
                {
                    key: backupKey,
                    backedUpAt: expect.any(String),
                    entries: {
                        osmStateQuarantinedFeatures: { features: [] },
                    },
                },
            ])
        })

        it('blocks later saves until the application reloads', async () => {
            await service.resetStoredOsmState()

            await expect(
                service.createPendingFeature(osmFeature(1))
            ).rejects.toThrow('cleared')
        })

        it('keeps only the three most recent backups', async () => {
            storageSpy.get.mockImplementation((key: string) =>
                Promise.resolve(key === 'osmState' ? { corrupted: true } : null)
            )
            storageSpy.keys.mockResolvedValue([
                'osmStateBackup:2026-01-01',
                'osmStateBackup:2026-01-02',
                'osmStateBackup:2026-01-03',
                'osmStateBackup:2026-01-04',
                'config',
            ])

            await service.resetStoredOsmState()

            expect(storageSpy.remove).toHaveBeenCalledWith(
                'osmStateBackup:2026-01-01'
            )
            expect(storageSpy.remove).not.toHaveBeenCalledWith(
                'osmStateBackup:2026-01-02'
            )
        })

        it('does nothing destructive when there is no stored state', async () => {
            const backupKey = await service.resetStoredOsmState()

            expect(backupKey).toBeUndefined()
            expect(storageSpy.set).not.toHaveBeenCalled()
        })
    })

    describe('pending work and cache clearing', () => {
        const journal = (
            features: OsmGoFeature[]
        ): Extract<PersistedUploadJournal, { phase: 'prepared' }> => ({
            journalVersion: 2,
            attemptId: 'attempt-1',
            payload: '<osmChange/>',
            payloadHash: 'hash',
            changesetId: '123',
            submittedIds: features.map((feature) => String(feature.id)),
            submissions: features.map((feature) => ({
                oldId: String(feature.id),
                operation: feature.properties.changeType ?? 'Create',
                feature,
            })),
            summary: {
                Total: features.length,
                Create: features.length,
                Update: 0,
                Delete: 0,
            },
            startedAt: '2026-08-02T10:00:00.000Z',
            phase: 'prepared',
        })

        it('reports pending changes and an unresolved upload as pending work', async () => {
            expect(service.hasPendingWork()).toBe(false)

            const created = await service.createPendingFeature(osmFeature(99))
            expect(service.hasPendingWork()).toBe(true)
            expect(service.hasActiveUploadJournal()).toBe(false)
            expect(service.changedFeatures()).toEqual([created])

            await service.beginUploadAttempt(journal([created]))
            expect(service.hasActiveUploadJournal()).toBe(true)

            await service.discardPreparedUploadAttempt('attempt-1')
            await service.cancelPendingChange('node/-1')
            expect(service.hasPendingWork()).toBe(false)
        })

        it('counts an unresolved journal even when the queue is empty', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt(journal([created]))
            await service.acknowledgeUploadAttempt('attempt-1', [], 'now')
            await service.applyAcknowledgedUploadReceipt(
                'attempt-1',
                [{ oldId: 'node/-1' }],
                'now'
            )

            expect(service.changedFeatureCount()).toBe(0)
            expect(service.hasPendingWork()).toBe(true)
        })

        it('refuses to clear the cache while an upload is running', async () => {
            service.setUploadInFlight(true)

            await expect(service.clearCache()).rejects.toBeInstanceOf(
                UploadInFlightError
            )
            expect(storageSpy.clear).not.toHaveBeenCalled()

            service.setUploadInFlight(false)
            await service.clearCache()
            expect(storageSpy.clear).toHaveBeenCalledOnce()
        })

        it('waits for a running commit and blocks later ones once cleared', async () => {
            let finishWrite!: () => void
            storageSpy.set.mockImplementation(
                (_key: string, value: unknown) =>
                    new Promise((resolve) => {
                        finishWrite = () => resolve(value)
                    })
            )
            const running = service.createPendingFeature(osmFeature(99))
            await vi.waitFor(() => expect(storageSpy.set).toHaveBeenCalled())

            const clearing = service.clearCache()
            await Promise.resolve()
            expect(storageSpy.clear).not.toHaveBeenCalled()
            finishWrite()
            await running
            await clearing

            expect(storageSpy.clear).toHaveBeenCalledOnce()
            await expect(
                service.createPendingFeature(osmFeature(98))
            ).rejects.toThrow('cleared')
        })
    })

    describe('several application windows', () => {
        const MARKER = 'osmgo:osmStateRevision'
        afterEach(() => window.localStorage.removeItem(MARKER))

        it('refuses to overwrite a state saved by another window', async () => {
            await service.createPendingFeature(osmFeature(1))
            storageSpy.set.mockClear()
            window.localStorage.setItem(MARKER, '40')

            await expect(
                service.createPendingFeature(osmFeature(2))
            ).rejects.toBeInstanceOf(OsmStateConflictError)

            expect(storageSpy.set).not.toHaveBeenCalled()
            expect(service.externalStateChange()).toBe(true)
            expect(service.getGeojsonChanged().features).toHaveLength(1)
        })

        it('refuses every later save until the state is reloaded', async () => {
            await service.createPendingFeature(osmFeature(1))
            window.localStorage.setItem(MARKER, '40')
            await expect(
                service.createPendingFeature(osmFeature(2))
            ).rejects.toBeInstanceOf(OsmStateConflictError)

            await expect(
                service.createPendingFeature(osmFeature(3))
            ).rejects.toBeInstanceOf(OsmStateConflictError)
        })

        it('does not see a conflict when the marker cannot be written', async () => {
            await service.createPendingFeature(osmFeature(1))
            const setItem = vi
                .spyOn(Storage.prototype, 'setItem')
                .mockImplementation(() => {
                    throw new DOMException('Full', 'QuotaExceededError')
                })
            try {
                await service.createPendingFeature(osmFeature(2))

                await expect(
                    service.createPendingFeature(osmFeature(3))
                ).resolves.toBeDefined()
            } finally {
                setItem.mockRestore()
            }
            expect(service.externalStateChange()).toBe(false)
        })

        it('notices a change announced by another window', async () => {
            await service.createPendingFeature(osmFeature(1))
            window.dispatchEvent(
                new StorageEvent('storage', { key: MARKER, newValue: '9' })
            )

            expect(service.externalStateChange()).toBe(true)
        })

        it('accepts its own writes and a reload after a conflict', async () => {
            await service.createPendingFeature(osmFeature(1))
            await service.createPendingFeature(osmFeature(2))
            expect(window.localStorage.getItem(MARKER)).toBe('2')

            window.localStorage.setItem(MARKER, '40')
            storageSpy.get.mockResolvedValue({
                schemaVersion: 2,
                revision: 40,
                officialById: {},
                pendingById: {},
                bbox: emptyCollection(),
                nextTemporaryId: -1,
            })
            await firstValueFrom(service.loadOsmState$())

            expect(service.externalStateChange()).toBe(false)
            await expect(
                service.createPendingFeature(osmFeature(3))
            ).resolves.toBeDefined()
            expect(window.localStorage.getItem(MARKER)).toBe('41')
        })

        it('rolls the marker back when the write fails', async () => {
            await service.createPendingFeature(osmFeature(1))
            storageSpy.set.mockRejectedValueOnce(new Error('disk full'))

            await expect(
                service.createPendingFeature(osmFeature(2))
            ).rejects.toBeInstanceOf(OsmStatePersistenceError)

            expect(window.localStorage.getItem(MARKER)).toBe('1')
            await expect(
                service.createPendingFeature(osmFeature(2))
            ).resolves.toBeDefined()
        })

        it('serialises commits through the Web Locks API when available', async () => {
            const held: string[] = []
            const request = vi.fn(
                async (name: string, task: () => Promise<unknown>) => {
                    held.push(`start:${name}`)
                    const result = await task()
                    held.push(`end:${name}`)
                    return result
                }
            )
            vi.stubGlobal('navigator', { ...navigator, locks: { request } })
            try {
                await service.createPendingFeature(osmFeature(1))
            } finally {
                vi.unstubAllGlobals()
            }

            expect(held).toEqual([
                'start:osmgo-osm-state',
                'end:osmgo-osm-state',
            ])
        })
    })

    describe('upload attempts and concurrent edits', () => {
        const journalFor = (
            features: OsmGoFeature[],
            phase: 'prepared' = 'prepared'
        ) =>
            ({
                journalVersion: 2,
                attemptId: 'attempt-1',
                payload: '<osmChange/>',
                payloadHash: 'hash',
                changesetId: '123',
                submittedIds: features.map((feature) => String(feature.id)),
                submissions: features.map((feature) => ({
                    oldId: String(feature.id),
                    operation: 'Create' as const,
                    feature: structuredClone(feature),
                })),
                summary: {
                    Total: features.length,
                    Create: features.length,
                    Update: 0,
                    Delete: 0,
                },
                startedAt: '2026-08-02T10:00:00.000Z',
                phase,
            }) satisfies PersistedUploadJournal

        it('refuses a journal prepared from a queue that has changed', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            const edited = structuredClone(created)
            edited.properties.tags.name = 'Edited meanwhile'
            await service.updatePendingFeature('node/-1', edited)

            await expect(
                service.beginUploadAttempt(journalFor([created]))
            ).rejects.toMatchObject({
                name: 'UploadQueueChangedError',
                changedIds: ['node/-1'],
            } satisfies Partial<UploadQueueChangedError>)
            expect(service.getUploadJournal()).toBeUndefined()
        })

        it('refuses a journal for an object that left the queue', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.cancelPendingChange('node/-1')

            await expect(
                service.beginUploadAttempt(journalFor([created]))
            ).rejects.toBeInstanceOf(UploadQueueChangedError)
        })

        it('keeps an object edited during the upload instead of dropping it silently', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt(journalFor([created]))
            await service.acknowledgeUploadAttempt('attempt-1', [], 'now')
            // A write that bypassed the journal lock (another window).
            const edited = structuredClone(created)
            edited.properties.tags.name = 'Edited meanwhile'
            const internals = service as unknown as {
                _geojsonChanged: Record<string, OsmGoFeature>
            }
            internals._geojsonChanged = { 'node/-1': edited }
            vi.spyOn(console, 'warn').mockReturnValue(undefined)

            await service.applyAcknowledgedUploadReceipt(
                'attempt-1',
                [{ oldId: 'node/-1', feature: osmFeature(101) }],
                'now'
            )

            expect(service.getGeojson().features).toEqual([osmFeature(101)])
            const quarantine = storageSpy.set.mock.calls.find(
                ([key]) => key === 'osmStateQuarantinedFeatures'
            )?.[1] as { features: Array<Record<string, unknown>> }
            expect(quarantine.features).toEqual([
                expect.objectContaining({
                    store: 'pending',
                    id: 'node/-1',
                    source: 'upload',
                    value: edited,
                }),
            ])
        })

        it('does not set anything aside when the queue was untouched', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt(journalFor([created]))
            await service.acknowledgeUploadAttempt('attempt-1', [], 'now')

            await service.applyAcknowledgedUploadReceipt(
                'attempt-1',
                [{ oldId: 'node/-1', feature: osmFeature(101) }],
                'now'
            )

            expect(storageSpy.set).not.toHaveBeenCalledWith(
                'osmStateQuarantinedFeatures',
                expect.anything()
            )
        })

        it('abandons an unreconcilable attempt and keeps its objects exportable', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt(journalFor([created]))
            await service.acknowledgeUploadAttempt(
                'attempt-1',
                'garbage',
                'now'
            )

            await service.abandonUploadAttempt('attempt-1')

            expect(service.getUploadJournal()).toBeUndefined()
            expect(service.getGeojsonChanged().features).toEqual([])
            const quarantine = storageSpy.set.mock.calls.find(
                ([key]) => key === 'osmStateQuarantinedFeatures'
            )?.[1] as { features: Array<Record<string, unknown>> }
            expect(quarantine.features[0]).toMatchObject({
                store: 'pending',
                id: 'node/-1',
                source: 'upload',
            })
        })

        it('never abandons a prepared attempt', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt(journalFor([created]))

            await expect(
                service.abandonUploadAttempt('attempt-1')
            ).rejects.toThrow('cannot be abandoned')
            expect(service.getGeojsonChanged().features).toHaveLength(1)
        })

        it('abandons a prepared attempt found in part in the changeset on request', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt(journalFor([created]))

            await service.abandonUploadAttempt('attempt-1', { prepared: true })

            expect(service.getUploadJournal()).toBeUndefined()
            expect(service.getGeojsonChanged().features).toEqual([])
        })

        it('records who still uses a node whose deletion OSM refused', async () => {
            await service.replacePendingFeatures(
                collection([osmFeature(5, 'Delete', osmFeature(5))])
            )

            const updated = await service.markPendingNodeReferenced('node/5', {
                ways: [],
                relations: ['relation/9'],
            })

            expect(updated.properties.usedByWays).toBe(true)
            expect(updated.properties.relations).toEqual([
                { rel: 'relation/9', reltags: {}, role: '' },
            ])
            expect(service.getFeatureById('node/5', 'data_changed')).toEqual(
                updated
            )
        })

        it('rebases a pending edit onto a new base version', async () => {
            const base = osmFeature(12)
            await service.applyDownload(download([base]))
            const edited = structuredClone(base)
            edited.properties.tags.name = 'Mine'
            await service.moveOfficialToPending('node/12', edited)
            const rebased = structuredClone(
                service.getFeatureById('node/12', 'data_changed')
            ) as OsmGoFeature
            const newBase = structuredClone(base)
            newBase.properties.meta.version = 5
            newBase.properties.tags.phone = '1'
            rebased.properties.originalData = newBase
            rebased.properties.meta.version = 5
            rebased.properties.tags.phone = '1'

            await service.rebasePendingFeature('node/12', rebased)

            const stored = service.getFeatureById('node/12', 'data_changed')
            expect(stored?.properties.meta.version).toBe(5)
            expect(
                stored?.properties.originalData?.properties.meta.version
            ).toBe(5)
            expect(stored?.properties.changeType).toBe('Update')
            await service.cancelPendingChange('node/12')
            expect(service.getFeatureById('node/12', 'data')).toEqual(newBase)
        })

        it('refuses to rebase an edit that is part of an upload', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt(journalFor([created]))

            await expect(
                service.rebasePendingFeature('node/-1', created)
            ).rejects.toBeInstanceOf(UploadQueueLockedError)
        })
    })

    describe('split persistence of pending and official data', () => {
        let stored: Map<string, unknown>
        let failingKey: string | undefined

        const useMapStorage = () => {
            stored = new Map()
            failingKey = undefined
            storageSpy.get.mockImplementation((key: string) =>
                Promise.resolve(
                    stored.has(key) ? structuredClone(stored.get(key)) : null
                )
            )
            storageSpy.set.mockImplementation((key: string, value: unknown) => {
                if (key === failingKey) {
                    return Promise.reject(new Error('killed'))
                }
                stored.set(key, structuredClone(value))
                return Promise.resolve(value)
            })
            storageSpy.remove.mockImplementation((key: string) => {
                stored.delete(key)
                return Promise.resolve()
            })
        }
        const restart = async (): Promise<DataService> => {
            window.localStorage.removeItem('osmgo:osmStateRevision')
            const restarted = TestBed.runInInjectionContext(
                () => new DataService()
            )
            await firstValueFrom(restarted.loadOsmState$())
            return restarted
        }
        const writtenBytes = () =>
            storageSpy.set.mock.calls.reduce(
                (total, [, value]) => total + JSON.stringify(value).length,
                0
            )
        afterEach(() =>
            window.localStorage.removeItem('osmgo:osmStateRevision')
        )

        it('writes only the head for an edit, a tiny part of the full state', async () => {
            const officials = Array.from({ length: 1000 }, (_value, index) =>
                osmFeature(index + 1)
            )
            await service.applyDownload(download(officials))
            // Before the split, every command rewrote this whole record.
            const fullStateBytes = JSON.stringify(
                storedOsmState(storageSpy)
            ).length
            storageSpy.set.mockClear()
            const patch = osmFeature(10)
            patch.properties.tags.name = 'Edited bench'

            await service.moveOfficialToPending('node/10', patch)

            expect(storageSpy.set.mock.calls.map(([key]) => key)).toEqual([
                'osmState',
            ])
            expect(writtenBytes() * 50).toBeLessThan(fullStateBytes)
            expect(storedOsmState(storageSpy).officialById['node/10']).toBe(
                undefined
            )
        })

        it('fills the unused slot, switches the head to it, then drops the old one', async () => {
            const order: string[] = []
            storageSpy.set.mockImplementation((key: string, value: unknown) => {
                order.push(`set:${key}`)
                return Promise.resolve(value)
            })
            storageSpy.remove.mockImplementation((key: string) => {
                order.push(`remove:${key}`)
                return Promise.resolve()
            })

            await service.applyDownload(download([osmFeature(1)]))
            await service.applyDownload(download([osmFeature(2)]))

            expect(order).toEqual([
                'set:osmStateOfficial:a',
                'set:osmState',
                'set:osmStateOfficial:b',
                'set:osmState',
                'remove:osmStateOfficial:a',
            ])
        })

        it('reads back the same state after edits, cancellations and an upload', async () => {
            useMapStorage()
            await service.applyDownload(
                download([osmFeature(1), osmFeature(2), osmFeature(3)])
            )
            await service.moveOfficialToPending('node/1', osmFeature(1))
            await service.markPendingDeleted('node/2')
            await service.cancelPendingChange('node/2')
            const created = await service.createPendingFeature(osmFeature(99))
            await service.replacePendingFeatures(
                collection([
                    service.getFeatureById('node/1', 'data_changed'),
                    created,
                ] as OsmGoFeature[])
            )
            await service.applyUploadReceipt([
                { oldId: 'node/1', feature: osmFeature(1) },
                { oldId: 'node/-1', feature: osmFeature(100) },
            ])
            await service.markPendingDeleted('node/3')

            const restarted = await restart()

            const byId = (features: OsmGoFeatureCollection) =>
                Object.fromEntries(
                    features.features.map((feature) => [feature.id, feature])
                )
            expect(byId(restarted.getGeojson())).toEqual(
                byId(service.getGeojson())
            )
            expect(byId(restarted.getGeojsonChanged())).toEqual(
                byId(service.getGeojsonChanged())
            )
            expect(
                restarted
                    .getGeojson()
                    .features.map(({ id }) => id)
                    .sort()
            ).toEqual(['node/1', 'node/100', 'node/2'])
            expect(restarted.getGeojsonChanged().features[0].id).toBe('node/3')
        })

        it('keeps the previous download and every edit when a crash interrupts the next one', async () => {
            useMapStorage()
            await service.applyDownload(download([osmFeature(1)]))
            const created = await service.createPendingFeature(osmFeature(99))
            failingKey = 'osmState'

            await expect(
                service.applyDownload(download([osmFeature(2)]))
            ).rejects.toBeInstanceOf(OsmStatePersistenceError)

            expect(stored.has('osmStateOfficial:b')).toBe(true)
            failingKey = undefined
            const restarted = await restart()
            expect(restarted.getGeojson().features).toEqual([osmFeature(1)])
            expect(restarted.getGeojsonChanged().features).toEqual([created])
        })

        it('drops an official slot that belongs to another revision but keeps the queue', async () => {
            useMapStorage()
            const pending = osmFeature(5, 'Update', osmFeature(5))
            stored.set('osmState', {
                schemaVersion: 3,
                revision: 9,
                pendingById: { 'node/5': pending },
                nextTemporaryId: -1,
                official: { slot: 'a', revision: 8, delta: {} },
            })
            stored.set('osmStateOfficial:a', {
                schemaVersion: 3,
                revision: 7,
                officialById: { 'node/1': osmFeature(1) },
                bbox: emptyCollection(),
            })
            vi.spyOn(console, 'warn').mockReturnValue(undefined)

            const state = await firstValueFrom(service.loadOsmState$())

            expect(state.officialById).toEqual({})
            expect(state.pendingById).toEqual({ 'node/5': pending })
            expect(stored.has('osmStateOfficial:a')).toBe(false)
            expect(stored.get('osmState')).toMatchObject({
                revision: 9,
                official: { slot: 'b', revision: 9, delta: {} },
            })
        })

        it('migrates the former single osmState record', async () => {
            useMapStorage()
            const pending = osmFeature(5, 'Update', osmFeature(5))
            const legacy: PersistedOsmStateV2 = {
                schemaVersion: 2,
                revision: 12,
                officialById: { 'node/1': osmFeature(1) },
                pendingById: { 'node/5': pending },
                bbox: emptyCollection(),
                nextTemporaryId: -3,
            }
            stored.set('osmState', legacy)

            await firstValueFrom(service.loadOsmState$())

            expect(stored.get('osmState')).toMatchObject({
                schemaVersion: 3,
                revision: 12,
                official: { slot: 'a', revision: 12 },
            })
            expect(stored.get('osmState')).not.toHaveProperty('officialById')
            const restarted = await restart()
            expect(restarted.getGeojson().features).toEqual([osmFeature(1)])
            expect(restarted.getGeojsonChanged().features).toEqual([pending])
            const next = await restarted.createPendingFeature(osmFeature(99))
            expect(next.id).toBe('node/-3')
        })

        it('rewrites the official slot once too many objects changed', async () => {
            const officials = Array.from({ length: 300 }, (_value, index) =>
                osmFeature(index + 1)
            )
            await service.applyDownload(download(officials))
            storageSpy.set.mockClear()

            await service.replacePendingFeatures(
                collection(
                    officials.map((feature) =>
                        osmFeature(
                            feature.properties.id,
                            'Delete',
                            structuredClone(feature)
                        )
                    )
                )
            )

            expect(storageSpy.set.mock.calls.map(([key]) => key)).toEqual([
                'osmStateOfficial:b',
                'osmState',
            ])
            expect(
                (storageSpy.set.mock.calls[1][1] as PersistedOsmStateHead)
                    .official.delta
            ).toEqual({})
        })
    })

    describe('objects set aside by a command', () => {
        const preparedJournal = (
            feature: OsmGoFeature
        ): Extract<PersistedUploadJournal, { phase: 'prepared' }> => ({
            journalVersion: 2,
            attemptId: 'attempt-1',
            payload: '<osmChange/>',
            payloadHash: 'hash',
            changesetId: '123',
            submittedIds: [String(feature.id)],
            submissions: [
                {
                    oldId: String(feature.id),
                    operation: 'Create',
                    feature: structuredClone(feature),
                },
            ],
            summary: { Total: 1, Create: 1, Update: 0, Delete: 0 },
            startedAt: '2026-08-02T10:00:00.000Z',
            phase: 'prepared',
        })

        it('saves them before the commit that removes them from the queue', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt(preparedJournal(created))
            await service.acknowledgeUploadAttempt('attempt-1', 'x', 'now')
            storageSpy.set.mockClear()

            await service.abandonUploadAttempt('attempt-1')

            expect(storageSpy.set.mock.calls.map(([key]) => key)).toEqual([
                'osmStateQuarantinedFeatures',
                'osmState',
            ])
        })

        it('keeps them in the queue when they cannot be saved', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt(preparedJournal(created))
            await service.acknowledgeUploadAttempt('attempt-1', 'x', 'now')
            storageSpy.set.mockClear()
            storageSpy.set.mockImplementation((key: string, value: unknown) =>
                key === 'osmStateQuarantinedFeatures'
                    ? Promise.reject(new Error('quota'))
                    : Promise.resolve(value)
            )

            await expect(
                service.abandonUploadAttempt('attempt-1')
            ).rejects.toBeInstanceOf(OsmStatePersistenceError)

            expect(service.getGeojsonChanged().features).toEqual([created])
            expect(service.getUploadJournal()?.phase).toBe('acknowledged')
            expect(storageSpy.set).not.toHaveBeenCalledWith(
                'osmState',
                expect.anything()
            )
        })
    })

    describe('downloads racing an upload', () => {
        it('never replaces a newer official version by an older download', async () => {
            const newer = osmFeature(10)
            newer.properties.meta.version = 4
            await service.applyDownload(download([newer]))
            const stale = osmFeature(10)
            stale.properties.meta.version = 3

            await service.applyDownload(download([stale, osmFeature(11)]))

            expect(
                service.getFeatureById('node/10', 'data')?.properties.meta
                    .version
            ).toBe(4)
            expect(service.getFeatureById('node/11', 'data')).toBeDefined()
        })

        it('keeps an object an upload just created for one download only', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.beginUploadAttempt({
                journalVersion: 2,
                attemptId: 'attempt-1',
                payload: '<osmChange/>',
                payloadHash: 'hash',
                changesetId: '123',
                submittedIds: ['node/-1'],
                submissions: [
                    {
                        oldId: 'node/-1',
                        operation: 'Create',
                        feature: structuredClone(created),
                    },
                ],
                summary: { Total: 1, Create: 1, Update: 0, Delete: 0 },
                startedAt: '2026-08-02T10:00:00.000Z',
                phase: 'prepared',
            })
            await service.acknowledgeUploadAttempt('attempt-1', [], 'now')
            await service.applyAcknowledgedUploadReceipt(
                'attempt-1',
                [{ oldId: 'node/-1', feature: osmFeature(101) }],
                'now'
            )

            await service.applyDownload(download([osmFeature(50)]))
            expect(service.getFeatureById('node/101', 'data')).toBeDefined()

            await service.applyDownload(download([osmFeature(50)]))
            expect(service.getFeatureById('node/101', 'data')).toBeUndefined()
        })

        it('keeps an object whose change was cancelled while a download was converted', async () => {
            await service.replacePendingFeatures(
                collection([osmFeature(5, 'Update', osmFeature(5))])
            )
            // The conversion left out node/5, which was still pending.
            const converted = download([osmFeature(50)])

            await service.cancelPendingChange('node/5')
            await service.applyDownload(converted)

            expect(service.getFeatureById('node/5', 'data')).toBeDefined()
        })

        it('keeps what a legacy receipt created when the download predates it', async () => {
            const created = await service.createPendingFeature(osmFeature(99))
            await service.replacePendingFeatures(collection([created]))
            await service.applyUploadReceipt([
                { oldId: 'node/-1', feature: osmFeature(101) },
            ])

            await service.applyDownload(download([osmFeature(50)]))

            expect(service.getFeatureById('node/101', 'data')).toBeDefined()
            expect(service.getFeatureById('node/50', 'data')).toBeDefined()
        })
    })
})
