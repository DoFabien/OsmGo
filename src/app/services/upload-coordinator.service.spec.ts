import {
    UploadQueueChangedError,
    type UploadReceiptEntry,
} from '@services/data.service'
import {
    OsmStateConflictError,
    type PersistedUploadJournal,
} from '@services/osm-state'
import { validateOsmUploadFeature } from '@services/osm-upload-validation'
import {
    hashUploadPayload,
    UploadBusyElsewhereError,
    UploadCoordinator,
    type UploadCoordinatorDependencies,
    type UploadFeature,
    type UploadState,
} from '@services/upload-coordinator.service'
import {
    defer,
    type Observable,
    of,
    Subject,
    TimeoutError,
    throwError,
} from 'rxjs'

const queuedFeature = (
    changeType: 'Create' | 'Update' | 'Delete',
    id: number,
    type: 'node' | 'way' | 'relation' = 'node',
    version = changeType === 'Create' ? 0 : 3
): UploadFeature => ({
    type: 'Feature',
    id: `${type}/${id}`,
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: {
        id,
        type,
        changeType,
        tags: { amenity: 'bench' },
        meta: {
            version,
            changeset: '',
            timestamp: '',
            uid: '',
            user: '',
        },
        hexColor: '#000000',
        icon: 'bench',
        marker: 'bench',
        primaryTag: { key: 'amenity', value: 'bench' },
    },
})

const receiptFor = (feature: UploadFeature): Record<string, unknown> => {
    const type = feature.properties.type
    const oldId = String(feature.properties.id)
    const receipt: Record<string, unknown> = {
        type,
        old_id: oldId,
        osmgoOldId: `${type}/${oldId}`,
    }
    if (feature.properties.changeType !== 'Delete') {
        const newId = feature.properties.changeType === 'Create' ? '101' : oldId
        receipt['new_id'] = newId
        receipt['new_version'] = feature.properties.meta.version + 1
        receipt['osmgoNewId'] = `${type}/${newId}`
    }
    return receipt
}

const journalBase = (feature: UploadFeature) => ({
    journalVersion: 2 as const,
    attemptId: 'attempt-1',
    payload: '<osmChange/>',
    payloadHash: 'payload-hash',
    changesetId: '123',
    submittedIds: [String(feature.id)],
    submissions: [
        {
            oldId: String(feature.id),
            operation: feature.properties.changeType!,
            feature: structuredClone(feature),
        },
    ],
    summary: { Total: 1, Create: 1, Update: 0, Delete: 0 },
    startedAt: '2026-08-02T09:59:00.000Z',
})

const acknowledgedJournal = (
    feature: UploadFeature
): PersistedUploadJournal => ({
    ...journalBase(feature),
    phase: 'acknowledged',
    rawReceipt: [receiptFor(feature)],
    acknowledgedAt: '2026-08-02T10:00:00.000Z',
})

interface HarnessOptions {
    features?: UploadFeature[]
    connection$?: Observable<unknown>
    changeset$?: Observable<string>
    upload$?: Observable<unknown>
    journal?: PersistedUploadJournal
    beginUploadAttempt?: UploadCoordinatorDependencies['beginUploadAttempt']
    acknowledgeUploadAttempt?: UploadCoordinatorDependencies['acknowledgeUploadAttempt']
    applyReceipt?: (receipt: UploadReceiptEntry[]) => Promise<void>
    clearAppliedUploadAttempt?: UploadCoordinatorDependencies['clearAppliedUploadAttempt']
    discardPreparedUploadAttempt?: UploadCoordinatorDependencies['discardPreparedUploadAttempt']
    downloadChangeset$?: Observable<string>
    markNodeReferenced?: UploadCoordinatorDependencies['markNodeReferenced']
    acquireUploadLock?: UploadCoordinatorDependencies['acquireUploadLock']
    parseReceipt?: UploadCoordinatorDependencies['parseReceipt']
    isKnownFeatureId?: UploadCoordinatorDependencies['isKnownFeatureId']
}

const changesetDocument = (...blocks: string[]): string =>
    `<osmChange version="0.6">${blocks.join('')}</osmChange>`

const createdBench = `<create><node id="101" version="1" changeset="123" lat="2" lon="1"><tag k="amenity" v="bench"/></node></create>`

const createHarness = (options: HarnessOptions = {}) => {
    const features = options.features ?? [queuedFeature('Create', -1)]
    const transitions: UploadState[] = []
    const processing: boolean[] = []
    const applyReceipt = vi.fn(
        options.applyReceipt ?? (async () => Promise.resolve())
    )
    const beginUploadAttempt = vi.fn(
        options.beginUploadAttempt ?? (async () => Promise.resolve())
    )
    const acknowledgeUploadAttempt = vi.fn(
        options.acknowledgeUploadAttempt ?? (async () => Promise.resolve())
    )
    const clearAppliedUploadAttempt = vi.fn(
        options.clearAppliedUploadAttempt ?? (async () => Promise.resolve())
    )
    const discardPreparedUploadAttempt = vi.fn(
        options.discardPreparedUploadAttempt ?? (async () => Promise.resolve())
    )
    const uploadDiff = vi.fn(() =>
        options.upload$ ? options.upload$ : of(features.map(receiptFor))
    )
    const downloadChangeset = vi.fn(
        () =>
            options.downloadChangeset$ ??
            throwError(() => ({ status: 0, error: 'offline' }))
    )
    const abandonUploadAttempt = vi.fn(async () => Promise.resolve())
    const dependencies = {
        getPendingFeatures: vi.fn(() => features),
        getUserDetail$: vi.fn(() => options.connection$ ?? of({})),
        getValidChangeset: vi.fn(() => options.changeset$ ?? of('123')),
        serializeDiff: vi.fn(() => '<osmChange/>'),
        uploadDiff,
        parseReceipt: options.parseReceipt,
        downloadChangeset,
        isKnownFeatureId: options.isKnownFeatureId,
        markNodeReferenced: options.markNodeReferenced,
        acquireUploadLock: options.acquireUploadLock,
        abandonUploadAttempt,
        wait: vi.fn(async () => Promise.resolve()),
        getUploadJournal: vi.fn(() => options.journal),
        beginUploadAttempt,
        acknowledgeUploadAttempt,
        applyAcknowledgedReceipt: vi.fn(async (_attemptId, receipt) =>
            applyReceipt(receipt)
        ),
        clearAppliedUploadAttempt,
        discardPreparedUploadAttempt,
        getUserInfo: vi.fn(() => ({
            uid: '7',
            display_name: 'Mapper',
            connected: true,
        })),
        setChangesetComment: vi.fn(),
        updateChangesetLastActivity: vi.fn(),
        invalidateChangeset: vi.fn(),
        styleFeature: vi.fn((feature: UploadFeature) => feature),
        setProcessing: vi.fn((value: boolean) => processing.push(value)),
        redraw: vi.fn(),
        createAttemptId: vi.fn(() => 'attempt-1'),
        hashPayload: vi.fn(async () => 'payload-hash'),
        now: vi.fn(() => new Date('2026-08-02T10:00:00.000Z')),
        onTransition: (state: UploadState) => transitions.push(state),
    } satisfies UploadCoordinatorDependencies
    return {
        coordinator: new UploadCoordinator(dependencies),
        dependencies,
        transitions,
        processing,
        features,
    }
}

describe('UploadCoordinator', () => {
    it('records payloads with a deterministic SHA-256 hash', async () => {
        await expect(hashUploadPayload('abc')).resolves.toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        )
    })

    it('executes the complete upload state machine and reconciles once', async () => {
        const harness = createHarness()

        const state = await harness.coordinator.start('Survey')

        expect(
            harness.transitions.map((transition) => transition.kind)
        ).toEqual([
            'validating',
            'creatingChangeset',
            'uploading',
            'receiptReceived',
            'reconciling',
            'succeeded',
        ])
        expect(state).toEqual({
            kind: 'succeeded',
            summary: { Total: 1, Create: 1, Update: 0, Delete: 0 },
        })
        expect(harness.processing).toEqual([true, false])
        expect(harness.dependencies.uploadDiff).toHaveBeenCalledOnce()
        expect(harness.dependencies.beginUploadAttempt).toHaveBeenCalledWith({
            journalVersion: 2,
            attemptId: 'attempt-1',
            payload: '<osmChange/>',
            payloadHash: 'payload-hash',
            changesetId: '123',
            submittedIds: ['node/-1'],
            submissions: [
                {
                    oldId: 'node/-1',
                    operation: 'Create',
                    feature: harness.features[0],
                },
            ],
            summary: { Total: 1, Create: 1, Update: 0, Delete: 0 },
            startedAt: '2026-08-02T10:00:00.000Z',
            phase: 'prepared',
        })
        expect(
            harness.dependencies.acknowledgeUploadAttempt
        ).toHaveBeenCalledOnce()
        expect(
            harness.dependencies.applyAcknowledgedReceipt
        ).toHaveBeenCalledOnce()
        expect(
            harness.dependencies.clearAppliedUploadAttempt
        ).toHaveBeenCalledWith('attempt-1')
        expect(
            harness.dependencies.beginUploadAttempt.mock.invocationCallOrder[0]
        ).toBeLessThan(
            harness.dependencies.uploadDiff.mock.invocationCallOrder[0]
        )
        expect(
            harness.dependencies.acknowledgeUploadAttempt.mock
                .invocationCallOrder[0]
        ).toBeLessThan(
            harness.dependencies.applyAcknowledgedReceipt.mock
                .invocationCallOrder[0]
        )
        expect(
            harness.dependencies.applyAcknowledgedReceipt.mock
                .invocationCallOrder[0]
        ).toBeLessThan(
            harness.dependencies.clearAppliedUploadAttempt.mock
                .invocationCallOrder[0]
        )
        expect(harness.dependencies.redraw).toHaveBeenCalledOnce()
        expect(
            harness.dependencies.updateChangesetLastActivity
        ).toHaveBeenCalledOnce()
        const applied =
            harness.dependencies.applyAcknowledgedReceipt.mock.lastCall?.[1]
        expect(applied?.[0]).toMatchObject({
            oldId: 'node/-1',
            feature: {
                id: 'node/101',
                properties: {
                    id: 101,
                    meta: {
                        changeset: '123',
                        timestamp: '2026-08-02T10:00:00.000Z',
                        uid: '7',
                        user: 'Mapper',
                        version: 1,
                    },
                },
            },
        })
        expect(applied?.[0].feature?.properties.changeType).toBeUndefined()
    })

    it('asks for a changeset covering the area of the queued objects', async () => {
        const far = queuedFeature('Create', -2)
        far.geometry = { type: 'Point', coordinates: [1.3, 2.4] }
        const harness = createHarness({
            features: [queuedFeature('Create', -1), far],
        })

        await harness.coordinator.start('Survey')

        expect(harness.dependencies.getValidChangeset).toHaveBeenCalledWith(
            'Survey',
            [1, 2, 1.3, 2.4]
        )
    })

    it('shares one active attempt between concurrent callers', async () => {
        const upload$ = new Subject<unknown>()
        const harness = createHarness({ upload$ })

        const first = harness.coordinator.start('Survey')
        const second = harness.coordinator.start('Ignored duplicate')
        expect(first).toBe(second)
        await vi.waitFor(() =>
            expect(harness.coordinator.state()).toEqual({
                kind: 'uploading',
                attemptId: 'attempt-1',
            })
        )

        upload$.next(harness.features.map(receiptFor))
        upload$.complete()
        await Promise.all([first, second])

        expect(harness.dependencies.uploadDiff).toHaveBeenCalledOnce()
        expect(harness.processing).toEqual([true, false])
    })

    it('rejects an invalid local queue before any network request', async () => {
        const feature = queuedFeature('Create', -1)
        feature.id = 'node/0'
        const harness = createHarness({ features: [feature] })

        const state = await harness.coordinator.start('Survey')

        expect(state).toMatchObject({
            kind: 'failed',
            stage: 'validation',
            error: {
                code: 'invalidQueue',
                queuePreserved: true,
                canClose: true,
                canRetry: true,
                recoveryAction: 'editQueue',
            },
        })
        expect(harness.dependencies.getUserDetail$).not.toHaveBeenCalled()
        expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
        expect(harness.processing).toEqual([true, false])
    })

    it.each([
        {
            name: 'positive creation ID',
            feature: queuedFeature('Create', 1),
        },
        {
            name: 'negative update ID',
            feature: queuedFeature('Update', -1),
        },
        {
            name: 'invalid update version',
            feature: queuedFeature('Update', 1, 'node', 0),
        },
        {
            name: 'out-of-range coordinates',
            feature: {
                ...queuedFeature('Create', -1),
                geometry: { type: 'Point' as const, coordinates: [181, 2] },
            },
        },
        {
            name: 'unsupported way creation',
            feature: queuedFeature('Create', -1, 'way'),
        },
    ])('rejects $name before creating a changeset', async ({ feature }) => {
        const harness = createHarness({ features: [feature] })

        const state = await harness.coordinator.start('Survey')

        expect(state).toMatchObject({
            kind: 'failed',
            stage: 'validation',
        })
        expect(harness.dependencies.getUserDetail$).not.toHaveBeenCalled()
        expect(harness.dependencies.getValidChangeset).not.toHaveBeenCalled()
    })

    it('reports an offline connection as retryable without creating a changeset', async () => {
        const harness = createHarness({
            connection$: throwError(() => new TimeoutError()),
        })

        const state = await harness.coordinator.start('Survey')

        expect(state).toMatchObject({
            kind: 'failed',
            stage: 'connection',
            error: {
                code: 'connection',
                recoveryAction: 'reconnect',
                canRetry: true,
                queuePreserved: true,
            },
        })
        expect(harness.dependencies.getValidChangeset).not.toHaveBeenCalled()
    })

    it('routes an expired token to reauthentication', async () => {
        const harness = createHarness({
            connection$: throwError(() => ({
                status: 401,
                error: 'Authentication failed',
            })),
        })

        const state = await harness.coordinator.start('Survey')

        expect(state).toMatchObject({
            kind: 'failed',
            stage: 'connection',
            error: {
                status: 401,
                code: 'authentication',
                technicalMessage: 'Authentication failed',
                recoveryAction: 'reauthenticate',
            },
        })
    })

    it('makes changeset creation failures safely retryable', async () => {
        const harness = createHarness({
            changeset$: throwError(() => ({
                status: 429,
                error: 'Too many requests',
            })),
        })

        const state = await harness.coordinator.start('Survey')

        expect(state).toMatchObject({
            kind: 'failed',
            stage: 'changeset',
            error: { recoveryAction: 'retry', canRetry: true },
        })
        expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
    })

    it('retries once with a fresh changeset when the reused one was closed', async () => {
        const closed = {
            status: 409,
            error: 'The changeset 123 was closed at 2026-08-01T13:00:00Z.',
        }
        let uploads = 0
        const harness = createHarness({
            upload$: defer(() => {
                uploads++
                return uploads === 1
                    ? throwError(() => closed)
                    : of([receiptFor(queuedFeature('Create', -1))])
            }),
        })
        harness.dependencies.getValidChangeset
            .mockReturnValueOnce(of('123'))
            .mockReturnValueOnce(of('124'))

        const state = await harness.coordinator.start('Survey')

        expect(state.kind).toBe('succeeded')
        expect(harness.dependencies.invalidateChangeset).toHaveBeenCalledOnce()
        expect(
            harness.dependencies.discardPreparedUploadAttempt
        ).toHaveBeenCalledOnce()
        expect(harness.dependencies.uploadDiff).toHaveBeenCalledTimes(2)
        expect(harness.dependencies.serializeDiff).toHaveBeenLastCalledWith(
            expect.anything(),
            '124'
        )
        expect(
            harness.dependencies.beginUploadAttempt.mock.calls.map(
                ([journal]) => journal.changesetId
            )
        ).toEqual(['123', '124'])
    })

    it('surfaces a second closed changeset instead of looping', async () => {
        const harness = createHarness({
            upload$: throwError(() => ({
                status: 409,
                error: 'The changeset 123 was closed at 2026-08-01T13:00:00Z.',
            })),
        })

        const state = await harness.coordinator.start('Survey')

        expect(state).toMatchObject({
            kind: 'failed',
            stage: 'upload',
            error: {
                code: 'changesetClosed',
                recoveryAction: 'createChangeset',
                canRetry: true,
            },
        })
        expect(harness.dependencies.uploadDiff).toHaveBeenCalledTimes(2)
        expect(harness.dependencies.invalidateChangeset).toHaveBeenCalledTimes(
            2
        )
    })

    it('does not resend automatically after an ambiguous upload response', async () => {
        const harness = createHarness({
            upload$: throwError(() => new TimeoutError()),
        })

        const first = await harness.coordinator.start('Survey')
        const second = await harness.coordinator.start('Survey again')

        expect(first).toMatchObject({
            kind: 'failed',
            stage: 'upload',
            error: {
                code: 'uploadUncertain',
                recoveryAction: 'inspectServer',
                canRetry: false,
                queuePreserved: true,
            },
        })
        expect(second).toBe(first)
        expect(harness.dependencies.uploadDiff).toHaveBeenCalledOnce()
    })

    it.each([408, 429])(
        'keeps the journal for an ambiguous HTTP %s response',
        async (status) => {
            const harness = createHarness({
                upload$: throwError(() => ({
                    status,
                    error: 'Gateway response',
                })),
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                error: {
                    recoveryAction: 'inspectServer',
                    canRetry: false,
                },
            })
            expect(
                harness.dependencies.discardPreparedUploadAttempt
            ).not.toHaveBeenCalled()
        }
    )

    it('identifies the queued feature involved in a version conflict', async () => {
        const feature = queuedFeature('Update', 12)
        const harness = createHarness({
            features: [feature],
            upload$: throwError(() => ({
                status: 409,
                error: 'Version mismatch: Provided 3, server had: 4 of Node 12',
            })),
        })

        const state = await harness.coordinator.start('Survey')

        expect(state).toMatchObject({
            kind: 'failed',
            stage: 'upload',
            error: {
                code: 'versionConflict',
                status: 409,
                feature: { id: 'node/12' },
                recoveryAction: 'editQueue',
                canRetry: true,
            },
        })
        expect(
            harness.dependencies.discardPreparedUploadAttempt
        ).toHaveBeenCalledWith('attempt-1')
    })

    it.each([
        ['truncated', []],
        [
            'duplicated',
            [
                receiptFor(queuedFeature('Create', -1)),
                receiptFor(queuedFeature('Create', -1)),
            ],
        ],
        [
            'wrong type',
            [
                {
                    ...receiptFor(queuedFeature('Create', -1)),
                    type: 'way',
                },
            ],
        ],
        [
            'wrong creation version',
            [
                {
                    ...receiptFor(queuedFeature('Create', -1)),
                    new_version: 2,
                },
            ],
        ],
    ])('preserves the queue for a %s receipt', async (_name, result) => {
        const harness = createHarness({ upload$: of(result) })

        const state = await harness.coordinator.start('Survey')

        expect(state).toMatchObject({
            kind: 'failed',
            stage: 'reconciliation',
            error: {
                recoveryAction: 'resumeReconciliation',
                canRetry: false,
                queuePreserved: true,
            },
        })
        expect(
            harness.dependencies.applyAcknowledgedReceipt
        ).not.toHaveBeenCalled()
        expect(harness.dependencies.uploadDiff).toHaveBeenCalledOnce()
    })

    it('never resends after storage fails following the server acknowledgement', async () => {
        const harness = createHarness({
            applyReceipt: async () => {
                throw new Error('IndexedDB write failed')
            },
        })

        const first = await harness.coordinator.start('Survey')
        const second = await harness.coordinator.start('Survey again')

        expect(
            harness.transitions.map((transition) => transition.kind)
        ).toEqual([
            'validating',
            'creatingChangeset',
            'uploading',
            'receiptReceived',
            'reconciling',
            'failed',
        ])
        expect(first).toMatchObject({
            kind: 'failed',
            stage: 'reconciliation',
            error: {
                technicalMessage: 'IndexedDB write failed',
                recoveryAction: 'resumeReconciliation',
                canRetry: false,
            },
        })
        expect(second).toBe(first)
        expect(harness.dependencies.uploadDiff).toHaveBeenCalledOnce()
        expect(
            harness.dependencies.applyAcknowledgedReceipt
        ).toHaveBeenCalledOnce()
        expect(
            harness.dependencies.updateChangesetLastActivity
        ).toHaveBeenCalledOnce()
        expect(harness.processing).toEqual([true, false])
    })

    it('treats a prepared journal after restart as server-ambiguous', async () => {
        const feature = queuedFeature('Create', -1)
        const harness = createHarness({
            features: [feature],
            journal: { ...journalBase(feature), phase: 'prepared' },
        })

        const state = await harness.coordinator.recoverJournal()

        expect(state).toMatchObject({
            kind: 'failed',
            stage: 'upload',
            error: {
                code: 'recoveryRequired',
                recoveryAction: 'inspectServer',
                canRetry: false,
                queuePreserved: true,
            },
        })
        expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
        expect(
            harness.dependencies.clearAppliedUploadAttempt
        ).not.toHaveBeenCalled()
    })

    it('reconciles an acknowledged journal after restart without resending', async () => {
        const feature = queuedFeature('Create', -1)
        const harness = createHarness({
            features: [feature],
            journal: acknowledgedJournal(feature),
        })

        const state = await harness.coordinator.recoverJournal()

        expect(
            harness.transitions.map((transition) => transition.kind)
        ).toEqual(['receiptReceived', 'reconciling', 'succeeded'])
        expect(state).toMatchObject({ kind: 'succeeded' })
        expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
        expect(
            harness.dependencies.applyAcknowledgedReceipt
        ).toHaveBeenCalledOnce()
        expect(
            harness.dependencies.clearAppliedUploadAttempt
        ).toHaveBeenCalledWith('attempt-1')
        expect(harness.processing).toEqual([true, false])
    })

    it('reconciles from the immutable snapshot instead of the current queue', async () => {
        const submitted = queuedFeature('Create', -1)
        submitted.properties.tags.name = 'Submitted name'
        const current = structuredClone(submitted)
        current.properties.tags.name = 'Later local name'
        const harness = createHarness({
            features: [current],
            journal: acknowledgedJournal(submitted),
        })

        const state = await harness.coordinator.recoverJournal()

        expect(state.kind).toBe('succeeded')
        const applied =
            harness.dependencies.applyAcknowledgedReceipt.mock.lastCall?.[1]
        expect(applied?.[0].feature?.properties.tags.name).toBe(
            'Submitted name'
        )
    })

    it('resumes reconciliation in the same session after a local failure', async () => {
        const feature = queuedFeature('Create', -1)
        let attempts = 0
        const harness = createHarness({
            features: [feature],
            journal: acknowledgedJournal(feature),
            applyReceipt: async () => {
                attempts++
                if (attempts === 1) throw new Error('IndexedDB unavailable')
            },
        })

        const failed = await harness.coordinator.recoverJournal()
        const recovered = await harness.coordinator.resumeReconciliation()

        expect(failed).toMatchObject({
            kind: 'failed',
            error: { recoveryAction: 'resumeReconciliation' },
        })
        expect(recovered.kind).toBe('succeeded')
        expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
        expect(
            harness.dependencies.applyAcknowledgedReceipt
        ).toHaveBeenCalledTimes(2)
    })

    it('refuses recovery when the persisted payload hash is inconsistent', async () => {
        const feature = queuedFeature('Create', -1)
        const journal = acknowledgedJournal(feature)
        journal.payloadHash = 'different-hash'
        const harness = createHarness({ features: [feature], journal })

        const state = await harness.coordinator.recoverJournal()

        expect(state).toMatchObject({
            kind: 'failed',
            error: {
                recoveryAction: 'inspectServer',
                canRetry: false,
            },
        })
        expect(
            harness.dependencies.applyAcknowledgedReceipt
        ).not.toHaveBeenCalled()
    })

    it('discards a prepared attempt only through the explicit recovery command', async () => {
        const feature = queuedFeature('Create', -1)
        const harness = createHarness({
            features: [feature],
            journal: { ...journalBase(feature), phase: 'prepared' },
            downloadChangeset$: of(changesetDocument()),
        })
        await harness.coordinator.recoverJournal()
        harness.dependencies.now.mockReturnValue(
            new Date('2026-08-02T10:00:30.000Z')
        )
        await harness.coordinator.verifyPreparedAttempt()

        const state =
            await harness.coordinator.discardPreparedAttemptAsNotApplied()

        expect(state).toEqual({ kind: 'idle' })
        expect(
            harness.dependencies.discardPreparedUploadAttempt
        ).toHaveBeenCalledWith('attempt-1')
    })

    it('only clears an already-applied journal after restart', async () => {
        const feature = queuedFeature('Create', -1)
        const acknowledged = acknowledgedJournal(feature)
        if (acknowledged.phase !== 'acknowledged') {
            throw new Error('Invalid acknowledged journal fixture.')
        }
        const journal: PersistedUploadJournal = {
            ...acknowledged,
            phase: 'applied',
            appliedAt: '2026-08-02T10:00:01.000Z',
        }
        const harness = createHarness({ features: [], journal })

        const state = await harness.coordinator.recoverJournal()

        expect(state).toMatchObject({ kind: 'succeeded' })
        expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
        expect(
            harness.dependencies.applyAcknowledgedReceipt
        ).not.toHaveBeenCalled()
        expect(
            harness.dependencies.clearAppliedUploadAttempt
        ).toHaveBeenCalledWith('attempt-1')
    })

    describe('release restart recovery matrix', () => {
        const feature = queuedFeature('Create', -1)
        const acknowledged = acknowledgedJournal(feature)
        if (acknowledged.phase !== 'acknowledged') {
            throw new Error('Invalid acknowledged journal fixture.')
        }
        const applied: PersistedUploadJournal = {
            ...acknowledged,
            phase: 'applied',
            appliedAt: '2026-08-02T10:00:01.000Z',
        }

        it.each([
            {
                phase: 'none',
                journal: undefined,
                expectedState: 'idle',
                applyCount: 0,
                clearCount: 0,
            },
            {
                phase: 'prepared',
                journal: {
                    ...journalBase(feature),
                    phase: 'prepared',
                } as const,
                expectedState: 'failed',
                applyCount: 0,
                clearCount: 0,
            },
            {
                phase: 'acknowledged',
                journal: acknowledged,
                expectedState: 'succeeded',
                applyCount: 1,
                clearCount: 1,
            },
            {
                phase: 'applied',
                journal: applied,
                expectedState: 'succeeded',
                applyCount: 0,
                clearCount: 1,
            },
        ])(
            'recovers $phase without resubmitting',
            async ({ journal, expectedState, applyCount, clearCount }) => {
                const harness = createHarness({
                    features: journal?.phase === 'applied' ? [] : [feature],
                    journal,
                })

                const state = await harness.coordinator.recoverJournal()

                expect(state.kind).toBe(expectedState)
                expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
                expect(
                    harness.dependencies.applyAcknowledgedReceipt
                ).toHaveBeenCalledTimes(applyCount)
                expect(
                    harness.dependencies.clearAppliedUploadAttempt
                ).toHaveBeenCalledTimes(clearCount)
            }
        )
    })

    describe('server answer that cannot be saved', () => {
        const preparedJournal = (feature: UploadFeature) =>
            ({
                ...journalBase(feature),
                phase: 'prepared',
            }) as PersistedUploadJournal

        it('keeps the answer in memory and forbids both resubmission and "not applied"', async () => {
            const feature = queuedFeature('Create', -1)
            const harness = createHarness({
                features: [feature],
                journal: preparedJournal(feature),
                acknowledgeUploadAttempt: async () => {
                    throw new Error('IndexedDB write failed')
                },
            })

            const first = await harness.coordinator.start('Survey')
            const second = await harness.coordinator.start('Survey again')
            await harness.coordinator.discardPreparedAttemptAsNotApplied()

            expect(first).toMatchObject({
                kind: 'failed',
                stage: 'reconciliation',
                error: {
                    code: 'receiptNotSaved',
                    technicalMessage: 'IndexedDB write failed',
                    recoveryAction: 'resumeReconciliation',
                    canRetry: false,
                },
            })
            expect(second).toBe(first)
            expect(
                harness.dependencies.acknowledgeUploadAttempt
            ).toHaveBeenCalledTimes(3)
            expect(harness.dependencies.uploadDiff).toHaveBeenCalledOnce()
            expect(
                harness.dependencies.discardPreparedUploadAttempt
            ).not.toHaveBeenCalled()
            expect(
                harness.dependencies.applyAcknowledgedReceipt
            ).not.toHaveBeenCalled()
            expect(harness.coordinator.getUnsavedReceipt()).toMatchObject({
                attemptId: 'attempt-1',
            })
        })

        it('saves the remembered answer later and reconciles without resending', async () => {
            const feature = queuedFeature('Create', -1)
            let failures = 3
            const harness = createHarness({
                features: [feature],
                journal: preparedJournal(feature),
                acknowledgeUploadAttempt: async () => {
                    if (failures-- > 0) throw new Error('quota exceeded')
                },
            })
            await harness.coordinator.start('Survey')

            const resumed = await harness.coordinator.resumeReconciliation()

            expect(resumed.kind).toBe('succeeded')
            expect(harness.dependencies.uploadDiff).toHaveBeenCalledOnce()
            expect(
                harness.dependencies.applyAcknowledgedReceipt
            ).toHaveBeenCalledOnce()
            expect(harness.coordinator.getUnsavedReceipt()).toBeUndefined()
        })

        it('retries a transient write failure before giving up', async () => {
            let failures = 1
            const harness = createHarness({
                acknowledgeUploadAttempt: async () => {
                    if (failures-- > 0) throw new Error('transient')
                },
            })

            const state = await harness.coordinator.start('Survey')

            expect(state.kind).toBe('succeeded')
            expect(
                harness.dependencies.acknowledgeUploadAttempt
            ).toHaveBeenCalledTimes(2)
        })

        it('persists the raw server text before parsing it', async () => {
            const rawText =
                '<diffResult><node old_id="-1" new_id="101" new_version="1"/></diffResult>'
            const parseReceipt = vi.fn(() => {
                throw new Error(
                    'OpenStreetMap returned an invalid XML response.'
                )
            })
            const harness = createHarness({
                upload$: of(rawText),
                parseReceipt,
            })

            const state = await harness.coordinator.start('Survey')

            expect(
                harness.dependencies.acknowledgeUploadAttempt
            ).toHaveBeenCalledWith('attempt-1', rawText, expect.any(String))
            expect(
                harness.dependencies.acknowledgeUploadAttempt.mock
                    .invocationCallOrder[0]
            ).toBeLessThan(parseReceipt.mock.invocationCallOrder[0])
            expect(state).toMatchObject({
                kind: 'failed',
                stage: 'reconciliation',
                error: { recoveryAction: 'resumeReconciliation' },
            })
        })

        it('stops on a state changed by another window and asks for a reload', async () => {
            const harness = createHarness({
                beginUploadAttempt: async () => {
                    throw new OsmStateConflictError(3, 4)
                },
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                stage: 'journal',
                error: {
                    code: 'staleState',
                    recoveryAction: 'reload',
                    canRetry: false,
                },
            })
            expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
        })
    })

    describe('definitive rejections carrying an OSM explanation', () => {
        it.each([
            [
                412,
                'Precondition failed: Way 77 requires the nodes with id in 5, which either do not exist, or are not visible.',
                'way/77',
            ],
            [
                400,
                'Cannot parse valid node from xml string for node 12',
                'node/12',
            ],
            [404, 'The relation 9 does not exist', 'relation/9'],
        ])(
            'treats HTTP %s as rejected and names the object',
            async (status, error, objectId) => {
                const feature = queuedFeature(
                    'Update',
                    Number(objectId.split('/')[1]),
                    objectId.split('/')[0] as 'node' | 'way' | 'relation'
                )
                if (feature.properties.type === 'way') {
                    feature.ndRefs = [1, 2]
                } else if (feature.properties.type === 'relation') {
                    feature.members = []
                }
                const harness = createHarness({
                    features: [feature],
                    upload$: throwError(() => ({ status, error })),
                })

                const state = await harness.coordinator.start('Survey')

                expect(state).toMatchObject({
                    kind: 'failed',
                    stage: 'upload',
                    error: {
                        code: 'uploadRejected',
                        status,
                        recoveryAction: 'editQueue',
                        canRetry: true,
                        feature: { id: objectId },
                    },
                })
                expect(
                    harness.dependencies.discardPreparedUploadAttempt
                ).toHaveBeenCalledWith('attempt-1')
                expect(
                    harness.dependencies.downloadChangeset
                ).not.toHaveBeenCalled()
            }
        )

        it.each([
            [404, '<html><body>Not Found</body></html>'],
            [400, ''],
            [502, 'Bad gateway'],
        ])(
            'keeps HTTP %s without an OSM explanation uncertain',
            async (status, error) => {
                const harness = createHarness({
                    upload$: throwError(() => ({ status, error })),
                })

                const state = await harness.coordinator.start('Survey')

                expect(state).toMatchObject({
                    kind: 'failed',
                    error: {
                        code: 'uploadUncertain',
                        recoveryAction: 'inspectServer',
                    },
                })
                expect(
                    harness.dependencies.discardPreparedUploadAttempt
                ).not.toHaveBeenCalled()
            }
        )

        it('sends a node still used by a relation as a tag removal on retry', async () => {
            const feature = queuedFeature('Delete', 5)
            const markNodeReferenced = vi.fn(async () => Promise.resolve())
            const harness = createHarness({
                features: [feature],
                markNodeReferenced,
                upload$: throwError(() => ({
                    status: 412,
                    error: 'Precondition failed: Node 5 is still used by relations 9,10.',
                })),
            })

            const state = await harness.coordinator.start('Survey')

            expect(markNodeReferenced).toHaveBeenCalledWith('node/5', {
                ways: [],
                relations: ['relation/9', 'relation/10'],
            })
            expect(state).toMatchObject({
                kind: 'failed',
                error: {
                    code: 'nodeStillReferenced',
                    recoveryAction: 'retry',
                    canRetry: true,
                    feature: { id: 'node/5' },
                },
            })
            expect(
                harness.dependencies.discardPreparedUploadAttempt
            ).toHaveBeenCalledOnce()
        })

        it('falls back to editing the queue when the stale node cannot be updated', async () => {
            const feature = queuedFeature('Delete', 5)
            const harness = createHarness({
                features: [feature],
                markNodeReferenced: async () => {
                    throw new Error('locked')
                },
                upload$: throwError(() => ({
                    status: 412,
                    error: 'Precondition failed: Node 5 is still used by ways 6.',
                })),
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                error: {
                    code: 'uploadRejected',
                    recoveryAction: 'editQueue',
                    feature: { id: 'node/5' },
                },
            })
        })

        it('uploads a node used by a relation as a modification', async () => {
            const feature = queuedFeature('Delete', 5)
            feature.properties.relations = [
                { rel: 'relation/9', reltags: {}, role: '' },
            ]

            expect(validateOsmUploadFeature(feature)).toEqual({
                id: 'node/5',
                operation: 'Update',
            })
        })

        describe('receipt of a deletion sent as a tag removal', () => {
            const referencedDeletion = () => {
                const feature = queuedFeature('Delete', 5)
                feature.properties.relations = [
                    { rel: 'relation/9', reltags: {}, role: '' },
                ]
                return feature
            }
            const modifyReceipt = (newVersion: number) => [
                {
                    type: 'node',
                    old_id: '5',
                    new_id: '5',
                    new_version: newVersion,
                    osmgoOldId: 'node/5',
                    osmgoNewId: 'node/5',
                },
            ]

            it('accepts the modification OSM answers and removes the object locally', async () => {
                const feature = referencedDeletion()
                const harness = createHarness({
                    features: [feature],
                    upload$: of(modifyReceipt(4)),
                })

                const state = await harness.coordinator.start('Survey')

                expect(state.kind).toBe('succeeded')
                const journal = harness.dependencies.beginUploadAttempt.mock
                    .calls[0][0] as { submissions: unknown[] }
                expect(journal.submissions[0]).toMatchObject({
                    oldId: 'node/5',
                    operation: 'Update',
                })
                expect(
                    harness.dependencies.applyAcknowledgedReceipt
                ).toHaveBeenCalledWith(
                    'attempt-1',
                    [{ oldId: 'node/5' }],
                    expect.any(String)
                )
            })

            it('refuses a receipt that deletes what was sent as a modification', async () => {
                const feature = referencedDeletion()
                const harness = createHarness({
                    features: [feature],
                    upload$: of([
                        { type: 'node', old_id: '5', osmgoOldId: 'node/5' },
                    ]),
                })

                const state = await harness.coordinator.start('Survey')

                expect(state).toMatchObject({
                    kind: 'failed',
                    stage: 'reconciliation',
                })
                expect(
                    harness.dependencies.applyAcknowledgedReceipt
                ).not.toHaveBeenCalled()
            })

            it('refuses a modification with an unexpected version', async () => {
                const harness = createHarness({
                    features: [referencedDeletion()],
                    upload$: of(modifyReceipt(9)),
                })

                const state = await harness.coordinator.start('Survey')

                expect(state).toMatchObject({
                    kind: 'failed',
                    stage: 'reconciliation',
                })
            })
        })

        it('routes a forbidden account to an account check, not a queue edit', async () => {
            const harness = createHarness({
                upload$: throwError(() => ({
                    status: 403,
                    error: 'You have been blocked from editing',
                })),
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                stage: 'upload',
                error: {
                    code: 'forbidden',
                    recoveryAction: 'checkAccount',
                    canRetry: true,
                },
            })
        })

        it('gives a forbidden changeset creation the same guidance', async () => {
            const harness = createHarness({
                changeset$: throwError(() => ({
                    status: 403,
                    error: 'Forbidden',
                })),
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                stage: 'changeset',
                error: { code: 'forbidden', recoveryAction: 'checkAccount' },
            })
        })
    })

    describe('verification of an upload whose answer was lost', () => {
        it('reconciles an upload found in the changeset without resending it', async () => {
            const harness = createHarness({
                upload$: throwError(() => new TimeoutError()),
                downloadChangeset$: of(changesetDocument(createdBench)),
            })

            const state = await harness.coordinator.start('Survey')

            expect(state.kind).toBe('succeeded')
            expect(
                harness.transitions.map((transition) => transition.kind)
            ).toEqual([
                'validating',
                'creatingChangeset',
                'uploading',
                'verifying',
                'receiptReceived',
                'reconciling',
                'succeeded',
            ])
            expect(harness.dependencies.uploadDiff).toHaveBeenCalledOnce()
            expect(
                harness.dependencies.acknowledgeUploadAttempt
            ).toHaveBeenCalledWith(
                'attempt-1',
                [
                    {
                        type: 'node',
                        old_id: '-1',
                        osmgoOldId: 'node/-1',
                        new_id: '101',
                        new_version: 1,
                        osmgoNewId: 'node/101',
                    },
                ],
                expect.any(String)
            )
            expect(
                harness.dependencies.applyAcknowledgedReceipt
            ).toHaveBeenCalledOnce()
            expect(harness.processing).toEqual([true, false])
        })

        it('recognises an edit by its next version', async () => {
            const feature = queuedFeature('Update', 12)
            const harness = createHarness({
                features: [feature],
                upload$: throwError(() => ({ status: 504, error: 'Timeout' })),
                downloadChangeset$: of(
                    changesetDocument(
                        '<modify><node id="12" version="4" lat="2" lon="1"><tag k="amenity" v="bench"/></node></modify>'
                    )
                ),
            })

            const state = await harness.coordinator.start('Survey')

            expect(state.kind).toBe('succeeded')
        })

        it('reports that nothing was found and leaves the decision to the user', async () => {
            const harness = createHarness({
                upload$: throwError(() => new TimeoutError()),
                downloadChangeset$: of(changesetDocument()),
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                error: {
                    code: 'uploadUncertain',
                    recoveryAction: 'inspectServer',
                    canRetry: false,
                    verification: 'notFound',
                },
            })
            expect(
                harness.dependencies.discardPreparedUploadAttempt
            ).not.toHaveBeenCalled()
        })

        it('flags an inconsistent changeset as partial', async () => {
            const second = queuedFeature('Create', -2)
            second.geometry = { type: 'Point', coordinates: [5, 6] }
            const harness = createHarness({
                features: [queuedFeature('Create', -1), second],
                upload$: throwError(() => new TimeoutError()),
                downloadChangeset$: of(changesetDocument(createdBench)),
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                error: { verification: 'partial' },
            })
        })

        it('reports an unavailable check when the changeset cannot be read', async () => {
            const harness = createHarness({
                upload$: throwError(() => new TimeoutError()),
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                error: { verification: 'unavailable' },
            })
        })

        it('does not take an identical object it already knows for the creation', async () => {
            const harness = createHarness({
                upload$: throwError(() => new TimeoutError()),
                downloadChangeset$: of(changesetDocument(createdBench)),
                isKnownFeatureId: (id) => id === 'node/101',
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                error: { verification: 'notFound' },
            })
            expect(
                harness.dependencies.applyAcknowledgedReceipt
            ).not.toHaveBeenCalled()
        })

        describe('"not applied" after a lost answer', () => {
            const at = (time: string) => new Date(`2026-08-02T${time}.000Z`)
            const keepPreparedJournal = (
                harness: ReturnType<typeof createHarness>
            ) => {
                const [prepared] =
                    harness.dependencies.beginUploadAttempt.mock.calls[0]
                harness.dependencies.getUploadJournal.mockReturnValue(prepared)
            }

            it('waits for a check made 90 s after the failure', async () => {
                const harness = createHarness({
                    upload$: throwError(() => new TimeoutError()),
                    downloadChangeset$: of(changesetDocument()),
                })

                const first = await harness.coordinator.start('Survey')
                keepPreparedJournal(harness)
                harness.dependencies.now.mockReturnValue(at('10:01:00'))
                const early = await harness.coordinator.verifyPreparedAttempt()
                const refused =
                    await harness.coordinator.discardPreparedAttemptAsNotApplied()
                harness.dependencies.now.mockReturnValue(at('10:01:30'))
                const late = await harness.coordinator.verifyPreparedAttempt()

                expect(first).toMatchObject({
                    error: {
                        verification: 'notFound',
                        confirmationCheckAfter: '2026-08-02T10:01:30.000Z',
                    },
                })
                expect(
                    first.kind === 'failed' && first.error
                ).not.toHaveProperty('notAppliedConfirmed')
                expect(early).toMatchObject({
                    error: {
                        verification: 'notFound',
                        confirmationCheckAfter: '2026-08-02T10:01:30.000Z',
                    },
                })
                expect(refused.kind).toBe('failed')
                expect(
                    harness.dependencies.discardPreparedUploadAttempt
                ).not.toHaveBeenCalled()
                expect(late).toMatchObject({
                    error: {
                        verification: 'notFound',
                        notAppliedConfirmed: true,
                    },
                })
                await expect(
                    harness.coordinator.discardPreparedAttemptAsNotApplied()
                ).resolves.toEqual({ kind: 'idle' })
                expect(
                    harness.dependencies.discardPreparedUploadAttempt
                ).toHaveBeenCalledWith('attempt-1')
            })

            it('counts the delay from the start of an attempt left by a previous session', async () => {
                const feature = queuedFeature('Create', -1)
                const harness = createHarness({
                    features: [feature],
                    journal: { ...journalBase(feature), phase: 'prepared' },
                    downloadChangeset$: of(changesetDocument()),
                })
                await harness.coordinator.recoverJournal()

                const early = await harness.coordinator.verifyPreparedAttempt()
                harness.dependencies.now.mockReturnValue(at('10:00:30'))
                const late = await harness.coordinator.verifyPreparedAttempt()

                expect(early).toMatchObject({
                    error: {
                        confirmationCheckAfter: '2026-08-02T10:00:30.000Z',
                    },
                })
                expect(late).toMatchObject({
                    error: { notAppliedConfirmed: true },
                })
            })

            it('never confirms an unavailable or partial check', async () => {
                const second = queuedFeature('Create', -2)
                second.geometry = { type: 'Point', coordinates: [5, 6] }
                for (const options of [
                    {},
                    {
                        features: [queuedFeature('Create', -1), second],
                        downloadChangeset$: of(changesetDocument(createdBench)),
                    },
                ]) {
                    const harness = createHarness({
                        ...options,
                        upload$: throwError(() => new TimeoutError()),
                    })
                    await harness.coordinator.start('Survey')
                    keepPreparedJournal(harness)
                    harness.dependencies.now.mockReturnValue(at('10:05:00'))
                    const state =
                        await harness.coordinator.verifyPreparedAttempt()

                    expect(
                        state.kind === 'failed' && state.error
                    ).toMatchObject({
                        verification:
                            expect.stringMatching(/unavailable|partial/),
                    })
                    expect(
                        state.kind === 'failed' && state.error
                    ).not.toHaveProperty('notAppliedConfirmed')
                    await harness.coordinator.discardPreparedAttemptAsNotApplied()
                    expect(
                        harness.dependencies.discardPreparedUploadAttempt
                    ).not.toHaveBeenCalled()
                }
            })
        })

        it('lets the user consider an attempt found in part as applied', async () => {
            const second = queuedFeature('Create', -2)
            second.geometry = { type: 'Point', coordinates: [5, 6] }
            const harness = createHarness({
                features: [queuedFeature('Create', -1), second],
                upload$: throwError(() => new TimeoutError()),
                downloadChangeset$: of(changesetDocument(createdBench)),
            })
            await harness.coordinator.start('Survey')
            const [prepared] =
                harness.dependencies.beginUploadAttempt.mock.calls[0]
            harness.dependencies.getUploadJournal.mockReturnValue(prepared)

            const state =
                await harness.coordinator.markPartialAttemptAsApplied()

            expect(state).toEqual({ kind: 'idle' })
            expect(
                harness.dependencies.abandonUploadAttempt
            ).toHaveBeenCalledWith('attempt-1', { prepared: true })
        })

        it('does not consider a prepared attempt applied without a partial check', async () => {
            const harness = createHarness({
                upload$: throwError(() => new TimeoutError()),
                downloadChangeset$: of(changesetDocument()),
            })
            await harness.coordinator.start('Survey')
            const [prepared] =
                harness.dependencies.beginUploadAttempt.mock.calls[0]
            harness.dependencies.getUploadJournal.mockReturnValue(prepared)

            await harness.coordinator.markPartialAttemptAsApplied()

            expect(
                harness.dependencies.abandonUploadAttempt
            ).not.toHaveBeenCalled()
        })

        it('verifies a prepared journal left by a previous session', async () => {
            const feature = queuedFeature('Create', -1)
            const harness = createHarness({
                features: [feature],
                journal: { ...journalBase(feature), phase: 'prepared' },
                downloadChangeset$: of(changesetDocument(createdBench)),
            })
            const restarted = await harness.coordinator.recoverJournal()

            const verified = await harness.coordinator.verifyPreparedAttempt()

            expect(restarted).toMatchObject({
                kind: 'failed',
                error: { code: 'recoveryRequired' },
            })
            expect(verified.kind).toBe('succeeded')
            expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
        })

        it('keeps the recovery guidance and records the verification result', async () => {
            const feature = queuedFeature('Create', -1)
            const harness = createHarness({
                features: [feature],
                journal: { ...journalBase(feature), phase: 'prepared' },
                downloadChangeset$: of(changesetDocument()),
            })
            await harness.coordinator.recoverJournal()

            const verified = await harness.coordinator.verifyPreparedAttempt()

            expect(verified).toMatchObject({
                kind: 'failed',
                error: {
                    code: 'recoveryRequired',
                    recoveryAction: 'inspectServer',
                    verification: 'notFound',
                },
            })
        })
    })

    describe('queue integrity and preconditions', () => {
        it('refuses a changeset comment longer than 255 characters before any request', async () => {
            const harness = createHarness()

            const state = await harness.coordinator.start('é'.repeat(256))

            expect(state).toMatchObject({
                kind: 'failed',
                stage: 'validation',
                error: { code: 'commentTooLong', recoveryAction: 'retry' },
            })
            expect(harness.dependencies.getUserDetail$).not.toHaveBeenCalled()
            expect(
                harness.dependencies.getValidChangeset
            ).not.toHaveBeenCalled()
        })

        it('accepts a comment of 255 code points made of surrogate pairs', async () => {
            const harness = createHarness()

            const state = await harness.coordinator.start('😀'.repeat(255))

            expect(state.kind).toBe('succeeded')
        })

        it('names the invalid object of the queue', async () => {
            const valid = queuedFeature('Create', -1)
            const invalid = queuedFeature('Create', -2)
            invalid.properties.tags = { 'payment:': 'cash' }
            const harness = createHarness({ features: [valid, invalid] })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                stage: 'validation',
                error: {
                    code: 'invalidQueue',
                    recoveryAction: 'editQueue',
                    feature: { id: 'node/-2' },
                },
            })
            expect(harness.dependencies.getUserDetail$).not.toHaveBeenCalled()
        })

        it('does not start while another window is uploading', async () => {
            const harness = createHarness({
                acquireUploadLock: async () => null,
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                error: { code: 'uploadElsewhere', recoveryAction: 'retry' },
            })
            expect(harness.dependencies.getUserDetail$).not.toHaveBeenCalled()
        })

        it('holds the upload lock for the whole attempt and releases it afterwards', async () => {
            const release = vi.fn()
            const upload$ = new Subject<unknown>()
            const harness = createHarness({
                acquireUploadLock: async () => release,
                upload$,
            })

            const running = harness.coordinator.start('Survey')
            await vi.waitFor(() =>
                expect(harness.coordinator.state().kind).toBe('uploading')
            )
            expect(release).not.toHaveBeenCalled()
            upload$.next(harness.features.map(receiptFor))
            upload$.complete()
            await running

            expect(release).toHaveBeenCalledOnce()
        })

        it('sends edits made while the changeset was being prepared', async () => {
            const initial = queuedFeature('Create', -1)
            const late = queuedFeature('Create', -2)
            const queue = [initial]
            const harness = createHarness({
                features: queue,
                changeset$: defer(() => {
                    queue.push(late)
                    return of('123')
                }),
            })

            await harness.coordinator.start('Survey')

            expect(
                harness.dependencies.beginUploadAttempt.mock.calls[0][0]
                    .submittedIds
            ).toEqual(['node/-1', 'node/-2'])
        })

        it('stops before the network when the queue changed under the journal', async () => {
            const harness = createHarness({
                beginUploadAttempt: async () => {
                    throw new UploadQueueChangedError(['node/-1'])
                },
            })

            const state = await harness.coordinator.start('Survey')

            expect(state).toMatchObject({
                kind: 'failed',
                stage: 'journal',
                error: {
                    code: 'localChange',
                    recoveryAction: 'retry',
                    feature: { id: 'node/-1' },
                },
            })
            expect(harness.dependencies.uploadDiff).not.toHaveBeenCalled()
        })
    })

    describe('recovery while another window uploads', () => {
        const busy = async () => null

        it('does not discard a prepared attempt another window may be sending', async () => {
            const feature = queuedFeature('Create', -1)
            const harness = createHarness({
                features: [feature],
                journal: { ...journalBase(feature), phase: 'prepared' },
                acquireUploadLock: busy,
            })

            await expect(
                harness.coordinator.discardPreparedAttemptAsNotApplied()
            ).rejects.toBeInstanceOf(UploadBusyElsewhereError)
            expect(
                harness.dependencies.discardPreparedUploadAttempt
            ).not.toHaveBeenCalled()
        })

        it('does not abandon an acknowledged attempt either', async () => {
            const feature = queuedFeature('Create', -1)
            const harness = createHarness({
                features: [feature],
                journal: acknowledgedJournal(feature),
                acquireUploadLock: busy,
            })

            await expect(
                harness.coordinator.markAcknowledgedAttemptAsApplied()
            ).rejects.toBeInstanceOf(UploadBusyElsewhereError)
            expect(
                harness.dependencies.abandonUploadAttempt
            ).not.toHaveBeenCalled()
        })

        it('leaves reconciliation and verification to the window that uploads', async () => {
            const feature = queuedFeature('Create', -1)
            const acknowledged = createHarness({
                features: [feature],
                journal: acknowledgedJournal(feature),
                acquireUploadLock: busy,
            })
            const prepared = createHarness({
                features: [feature],
                journal: { ...journalBase(feature), phase: 'prepared' },
                acquireUploadLock: busy,
            })

            const recovered = await acknowledged.coordinator.recoverJournal()
            const verified = await prepared.coordinator.verifyPreparedAttempt()

            expect(recovered).toEqual({ kind: 'idle' })
            expect(verified).toEqual({ kind: 'idle' })
            expect(
                acknowledged.dependencies.applyAcknowledgedReceipt
            ).not.toHaveBeenCalled()
            expect(
                prepared.dependencies.downloadChangeset
            ).not.toHaveBeenCalled()
        })

        it('releases the lock after a recovery', async () => {
            const release = vi.fn()
            const feature = queuedFeature('Create', -1)
            const harness = createHarness({
                features: [feature],
                journal: acknowledgedJournal(feature),
                acquireUploadLock: async () => release,
            })

            await harness.coordinator.recoverJournal()

            expect(release).toHaveBeenCalledOnce()
        })
    })

    describe('escape from an unreconcilable journal', () => {
        it('drops an acknowledged attempt the user declared applied', async () => {
            const feature = queuedFeature('Create', -1)
            const journal = acknowledgedJournal(feature)
            if (journal.phase !== 'acknowledged') throw new Error('fixture')
            const harness = createHarness({
                features: [feature],
                journal: { ...journal, payloadHash: 'corrupted' },
            })
            const failed = await harness.coordinator.recoverJournal()

            const state =
                await harness.coordinator.markAcknowledgedAttemptAsApplied()

            expect(failed).toMatchObject({
                kind: 'failed',
                error: { code: 'integrity', canRetry: false },
            })
            expect(state).toEqual({ kind: 'idle' })
            expect(
                harness.dependencies.abandonUploadAttempt
            ).toHaveBeenCalledWith('attempt-1')
            expect(harness.dependencies.redraw).toHaveBeenCalled()
        })

        it('never abandons a prepared attempt', async () => {
            const feature = queuedFeature('Create', -1)
            const harness = createHarness({
                features: [feature],
                journal: { ...journalBase(feature), phase: 'prepared' },
            })

            await harness.coordinator.markAcknowledgedAttemptAsApplied()

            expect(
                harness.dependencies.abandonUploadAttempt
            ).not.toHaveBeenCalled()
        })

        it('reconciles a journal whose deletion was classified by an older version', async () => {
            const feature = queuedFeature('Delete', 5)
            feature.properties.relations = [
                { rel: 'relation/9', reltags: {}, role: '' },
            ]
            const journal = acknowledgedJournal(feature)
            if (
                journal.phase !== 'acknowledged' ||
                journal.journalVersion !== 2
            ) {
                throw new Error('fixture')
            }
            journal.submissions[0].operation = 'Delete'
            journal.rawReceipt = [
                { type: 'node', old_id: '5', osmgoOldId: 'node/5' },
            ]
            const harness = createHarness({ features: [], journal })

            const state = await harness.coordinator.recoverJournal()

            expect(state.kind).toBe('succeeded')
            expect(
                harness.dependencies.applyAcknowledgedReceipt
            ).toHaveBeenCalledWith(
                'attempt-1',
                [{ oldId: 'node/5' }],
                expect.any(String)
            )
        })
    })
})
