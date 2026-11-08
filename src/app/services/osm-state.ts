import type { OsmGoFeature, OsmGoFeatureCollection } from '@osmgo/type'
import {
    requireGeometryFeatureCollection,
    requireOsmGoFeature,
} from '@services/osm-data-validation'

export const OSM_STATE_STORAGE_KEY = 'osmState'
export const OSM_STATE_SCHEMA_VERSION = 2
/**
 * Stored layout since schema 3: the `osmState` key only holds the head (the
 * pending queue, the upload journal and the few official objects changed
 * since the last download), and the downloaded official data lives in one of
 * two slots. A download fills the slot the head does not use, then the head
 * switches to it in a single write, so a crash never mixes two downloads.
 */
export const OSM_STATE_HEAD_SCHEMA_VERSION = 3
export const OSM_OFFICIAL_SLOT_KEYS = {
    a: 'osmStateOfficial:a',
    b: 'osmStateOfficial:b',
} as const
export type OsmOfficialSlot = keyof typeof OSM_OFFICIAL_SLOT_KEYS
/** Every key that holds part of the OSM state. */
export const OSM_STATE_STORAGE_KEYS = [
    OSM_STATE_STORAGE_KEY,
    OSM_OFFICIAL_SLOT_KEYS.a,
    OSM_OFFICIAL_SLOT_KEYS.b,
]

export interface PersistedUploadSummary {
    Total: number
    Create: number
    Update: number
    Delete: number
}

interface PersistedUploadJournalBase {
    attemptId: string
    payloadHash: string
    changesetId: string
    submittedIds: string[]
    summary: PersistedUploadSummary
    startedAt: string
}

interface PersistedUploadJournalV1Base extends PersistedUploadJournalBase {
    journalVersion: 1
}

export interface PersistedUploadSubmission {
    oldId: string
    operation: 'Create' | 'Update' | 'Delete'
    feature: OsmGoFeature
}

interface PersistedUploadJournalV2Base extends PersistedUploadJournalBase {
    journalVersion: 2
    payload: string
    submissions: PersistedUploadSubmission[]
}

type PersistedUploadJournalPhase<Base> = Base &
    (
        | { phase: 'prepared' }
        | {
              phase: 'acknowledged'
              rawReceipt: unknown
              acknowledgedAt: string
          }
        | {
              phase: 'applied'
              rawReceipt: unknown
              acknowledgedAt: string
              appliedAt: string
          }
    )

export type PersistedUploadJournal =
    | PersistedUploadJournalPhase<PersistedUploadJournalV1Base>
    | PersistedUploadJournalPhase<PersistedUploadJournalV2Base>

export interface PersistedOsmStateV2 {
    schemaVersion: 2
    revision: number
    officialById: Record<string, OsmGoFeature>
    pendingById: Record<string, OsmGoFeature>
    bbox: OsmGoFeatureCollection
    nextTemporaryId: number
    uploadJournal?: PersistedUploadJournal
}

/** Official objects changed since the slot was written; `null` removes one. */
export type PersistedOfficialDelta = Record<string, OsmGoFeature | null>

export interface PersistedOfficialReference {
    /** `null` while nothing was downloaded: the official base is empty. */
    slot: OsmOfficialSlot | null
    revision: number
    delta: PersistedOfficialDelta
}

export interface PersistedOsmStateHead {
    schemaVersion: 3
    revision: number
    pendingById: Record<string, OsmGoFeature>
    nextTemporaryId: number
    uploadJournal?: PersistedUploadJournal
    official: PersistedOfficialReference
}

export interface PersistedOfficialData {
    schemaVersion: 3
    /** Must equal `official.revision` of the head that references it. */
    revision: number
    officialById: Record<string, OsmGoFeature>
    bbox: OsmGoFeatureCollection
}

export interface PersistedOsmStateV1 {
    schemaVersion: 1
    revision?: number
    geojson?: OsmGoFeatureCollection
    geojsonChanged?: OsmGoFeatureCollection
    geojsonBbox?: OsmGoFeatureCollection
    nextFeatureId?: number
    uploadJournal?: PersistedUploadJournal
}

export class OsmStateConflictError extends Error {
    readonly name = 'OsmStateConflictError'

    constructor(
        readonly localRevision: number,
        readonly storedRevision: number | undefined
    ) {
        super(
            'The OSM state was changed by another window. Reload the application before editing.'
        )
    }
}

export class OsmStatePersistenceError extends Error {
    readonly name = 'OsmStatePersistenceError'

    constructor(
        readonly operation: string,
        readonly revision: number,
        options: ErrorOptions
    ) {
        super(
            `Could not persist OSM state revision ${revision} (${operation}).`,
            options
        )
    }
}

export interface LegacyOsmState {
    geojson?: OsmGoFeatureCollection | null
    geojsonChanged?: OsmGoFeatureCollection | null
    geojsonBbox?: OsmGoFeatureCollection | null
}

const emptyFeatureCollection = (): OsmGoFeatureCollection => ({
    type: 'FeatureCollection',
    features: [],
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const requireNonEmptyString = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`The persisted ${label} is invalid.`)
    }
    return value
}

const requireUploadSummary = (value: unknown): PersistedUploadSummary => {
    if (!isRecord(value)) {
        throw new Error('The persisted upload journal summary is invalid.')
    }
    const counts = [
        value['Total'],
        value['Create'],
        value['Update'],
        value['Delete'],
    ]
    if (
        counts.some(
            (count) =>
                typeof count !== 'number' ||
                !Number.isInteger(count) ||
                count < 0
        )
    ) {
        throw new Error('The persisted upload journal summary is invalid.')
    }
    const summary: PersistedUploadSummary = {
        Total: value['Total'] as number,
        Create: value['Create'] as number,
        Update: value['Update'] as number,
        Delete: value['Delete'] as number,
    }
    if (summary.Total !== summary.Create + summary.Update + summary.Delete) {
        throw new Error('The persisted upload journal summary is invalid.')
    }
    return summary
}

const requireUploadJournal = (value: unknown): PersistedUploadJournal => {
    if (
        !isRecord(value) ||
        (value['journalVersion'] !== 1 && value['journalVersion'] !== 2)
    ) {
        throw new Error('The persisted upload journal is invalid.')
    }
    const submittedIds = value['submittedIds']
    if (
        !Array.isArray(submittedIds) ||
        submittedIds.length === 0 ||
        submittedIds.some((id) => typeof id !== 'string' || id.trim() === '') ||
        new Set(submittedIds).size !== submittedIds.length
    ) {
        throw new Error('The persisted upload journal IDs are invalid.')
    }
    const commonBase: PersistedUploadJournalBase = {
        attemptId: requireNonEmptyString(
            value['attemptId'],
            'upload attempt ID'
        ),
        payloadHash: requireNonEmptyString(
            value['payloadHash'],
            'upload payload hash'
        ),
        changesetId: requireNonEmptyString(
            value['changesetId'],
            'upload changeset ID'
        ),
        submittedIds: [...submittedIds],
        summary: requireUploadSummary(value['summary']),
        startedAt: requireNonEmptyString(
            value['startedAt'],
            'upload start timestamp'
        ),
    }
    const base: PersistedUploadJournalV1Base | PersistedUploadJournalV2Base =
        value['journalVersion'] === 1
            ? { ...commonBase, journalVersion: 1 }
            : requireUploadJournalV2Base(value, commonBase)
    if (value['phase'] === 'prepared') {
        return { ...base, phase: 'prepared' }
    }
    const acknowledgedAt = requireNonEmptyString(
        value['acknowledgedAt'],
        'upload acknowledgement timestamp'
    )
    if (value['phase'] === 'acknowledged') {
        return {
            ...base,
            phase: 'acknowledged',
            rawReceipt: structuredClone(value['rawReceipt']),
            acknowledgedAt,
        }
    }
    if (value['phase'] === 'applied') {
        return {
            ...base,
            phase: 'applied',
            rawReceipt: structuredClone(value['rawReceipt']),
            acknowledgedAt,
            appliedAt: requireNonEmptyString(
                value['appliedAt'],
                'upload application timestamp'
            ),
        }
    }
    throw new Error('The persisted upload journal phase is invalid.')
}

const requireUploadJournalV2Base = (
    value: Record<string, unknown>,
    commonBase: PersistedUploadJournalBase
): PersistedUploadJournalV2Base => {
    const payload = requireNonEmptyString(value['payload'], 'upload payload')
    const sourceSubmissions = value['submissions']
    if (!Array.isArray(sourceSubmissions) || sourceSubmissions.length === 0) {
        throw new Error('The persisted upload journal submissions are invalid.')
    }

    const submissions: PersistedUploadSubmission[] = sourceSubmissions.map(
        (sourceSubmission) => {
            if (!isRecord(sourceSubmission)) {
                throw new Error(
                    'The persisted upload journal submissions are invalid.'
                )
            }
            const oldId = requireNonEmptyString(
                sourceSubmission['oldId'],
                'upload submission ID'
            )
            const operation = sourceSubmission['operation']
            const feature = sourceSubmission['feature']
            if (
                !['Create', 'Update', 'Delete'].includes(String(operation)) ||
                !isRecord(feature) ||
                feature['type'] !== 'Feature' ||
                String(feature['id']) !== oldId
            ) {
                throw new Error(
                    'The persisted upload journal submissions are invalid.'
                )
            }
            return {
                oldId,
                operation: operation as PersistedUploadSubmission['operation'],
                feature: structuredClone(feature) as unknown as OsmGoFeature,
            }
        }
    )
    if (
        new Set(submissions.map(({ oldId }) => oldId)).size !==
            submissions.length ||
        submissions.length !== commonBase.submittedIds.length ||
        submissions.some(
            ({ oldId }, index) => oldId !== commonBase.submittedIds[index]
        )
    ) {
        throw new Error('The persisted upload journal submissions are invalid.')
    }
    if (commonBase.summary.Total !== submissions.length) {
        throw new Error('The persisted upload journal summary is invalid.')
    }
    return {
        ...commonBase,
        journalVersion: 2,
        payload,
        submissions,
    }
}

const requireFeatureCollection = (
    value: unknown,
    label: string
): OsmGoFeatureCollection => {
    if (
        !isRecord(value) ||
        value['type'] !== 'FeatureCollection' ||
        !Array.isArray(value['features'])
    ) {
        throw new Error(`The persisted ${label} is not a feature collection.`)
    }
    return structuredClone(value) as unknown as OsmGoFeatureCollection
}

const requireFeatureId = (feature: unknown, label: string): string => {
    if (!isRecord(feature) || feature['type'] !== 'Feature') {
        throw new Error(`The persisted ${label} contains an invalid feature.`)
    }
    const rawId = feature['id']
    if (rawId === undefined || rawId === null || String(rawId).trim() === '') {
        throw new Error(`The persisted ${label} contains a feature without ID.`)
    }
    return String(rawId)
}

const collectionToRecord = (
    collection: OsmGoFeatureCollection,
    label: string
): Record<string, OsmGoFeature> => {
    const featuresById: Record<string, OsmGoFeature> = {}
    for (const sourceFeature of collection.features) {
        const feature = structuredClone(sourceFeature)
        const id = requireFeatureId(feature, label)
        if (featuresById[id]) {
            throw new Error(`The persisted ${label} contains duplicate IDs.`)
        }
        feature.id = id
        featuresById[id] = feature
    }
    return featuresById
}

const requireFeatureRecord = (
    value: unknown,
    label: string,
    state: 'official' | 'pending'
): Record<string, OsmGoFeature> => {
    if (!isRecord(value)) {
        throw new Error(`The persisted ${label} is not an ID record.`)
    }
    const featuresById: Record<string, OsmGoFeature> = {}
    for (const [id, sourceFeature] of Object.entries(value)) {
        const feature = requireOsmGoFeature(
            sourceFeature,
            `${label} ${id}`,
            state
        )
        if (String(feature.id) !== id) {
            throw new Error(`The persisted ${label} has an inconsistent ID.`)
        }
        featuresById[id] = feature
    }
    return featuresById
}

const normalizeLegacyPendingIds = (
    pendingById: Record<string, OsmGoFeature>
): { pendingById: Record<string, OsmGoFeature>; nextTemporaryId: number } => {
    const negativeIds = Object.values(pendingById)
        .map((feature) => feature.properties?.id)
        .filter((id) => Number.isInteger(id) && id < 0)
    let nextTemporaryId =
        negativeIds.length > 0 ? Math.min(...negativeIds) - 1 : -1
    const normalized: Record<string, OsmGoFeature> = {}

    for (const sourceFeature of Object.values(pendingById)) {
        const feature = structuredClone(sourceFeature)
        let id = String(feature.id)
        if (
            feature.properties?.changeType === 'Create' &&
            (!Number.isInteger(feature.properties.id) ||
                feature.properties.id >= 0)
        ) {
            feature.properties.id = nextTemporaryId--
            id = `${feature.properties.type}/${feature.properties.id}`
            feature.id = id
        }
        if (normalized[id]) {
            throw new Error(
                'The persisted pending data contains duplicate IDs.'
            )
        }
        normalized[id] = feature
    }
    return { pendingById: normalized, nextTemporaryId }
}

export const createEmptyOsmState = (): PersistedOsmStateV2 => ({
    schemaVersion: OSM_STATE_SCHEMA_VERSION,
    revision: 0,
    officialById: {},
    pendingById: {},
    bbox: emptyFeatureCollection(),
    nextTemporaryId: -1,
})

export const migrateLegacyOsmState = (
    legacy: LegacyOsmState
): PersistedOsmStateV2 => {
    const official = requireFeatureCollection(
        legacy.geojson ?? emptyFeatureCollection(),
        'official data'
    )
    const pending = requireFeatureCollection(
        legacy.geojsonChanged ?? emptyFeatureCollection(),
        'pending data'
    )
    const bbox = requireFeatureCollection(
        legacy.geojsonBbox ?? emptyFeatureCollection(),
        'bbox data'
    )
    const normalizedPending = normalizeLegacyPendingIds(
        collectionToRecord(pending, 'pending data')
    )
    const officialById = requireFeatureRecord(
        collectionToRecord(official, 'official data'),
        'official data',
        'official'
    )
    const pendingById = requireFeatureRecord(
        normalizedPending.pendingById,
        'pending data',
        'pending'
    )
    return {
        schemaVersion: OSM_STATE_SCHEMA_VERSION,
        revision: 0,
        officialById,
        pendingById,
        bbox: requireGeometryFeatureCollection(bbox, 'persisted bbox data'),
        nextTemporaryId: normalizedPending.nextTemporaryId,
    }
}

const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

const readLegacyId = (value: unknown): string => {
    if (isRecord(value) && value['id'] !== undefined && value['id'] !== null) {
        return String(value['id'])
    }
    return '(no id)'
}

/**
 * Migrates V1 collections one object at a time: an object that cannot be
 * validated is set aside, with its raw value, instead of failing the whole
 * migration. Ignored official objects are re-downloadable; invalid pending
 * objects are the user's own edits and must stay exportable.
 */
export const migrateLegacyOsmStateWithQuarantine = (
    legacy: LegacyOsmState
): { state: PersistedOsmStateV2; quarantined: QuarantinedOsmFeature[] } => {
    const quarantined: QuarantinedOsmFeature[] = []
    const readFeatures = (
        value: unknown,
        store: 'official' | 'pending'
    ): unknown[] => {
        if (value === null || value === undefined) return []
        if (
            !isRecord(value) ||
            value['type'] !== 'FeatureCollection' ||
            !Array.isArray(value['features'])
        ) {
            quarantined.push({
                store,
                id: '(collection)',
                value: structuredClone(value),
                reason: `The persisted ${store} data is not a feature collection.`,
            })
            return []
        }
        return value['features']
    }

    const officialById: Record<string, OsmGoFeature> = {}
    for (const raw of readFeatures(legacy.geojson, 'official')) {
        try {
            const feature = structuredClone(raw) as OsmGoFeature
            const id = requireFeatureId(feature, 'official data')
            if (officialById[id]) {
                throw new Error(
                    'The persisted official data has duplicate IDs.'
                )
            }
            feature.id = id
            officialById[id] = requireOsmGoFeature(
                feature,
                `official data ${id}`,
                'official'
            )
        } catch (error) {
            quarantined.push({
                store: 'official',
                id: readLegacyId(raw),
                value: structuredClone(raw),
                reason: describeError(error),
            })
        }
    }

    const pendingCandidates = readFeatures(legacy.geojsonChanged, 'pending')
    const negativeIds = pendingCandidates
        .map((feature) =>
            isRecord(feature) && isRecord(feature['properties'])
                ? feature['properties']['id']
                : undefined
        )
        .filter((id): id is number => Number.isInteger(id) && Number(id) < 0)
    let nextTemporaryId =
        negativeIds.length > 0 ? Math.min(...negativeIds) - 1 : -1
    const pendingById: Record<string, OsmGoFeature> = {}
    for (const raw of pendingCandidates) {
        try {
            const feature = structuredClone(raw) as OsmGoFeature
            let id = requireFeatureId(feature, 'pending data')
            if (
                feature.properties?.changeType === 'Create' &&
                (!Number.isInteger(feature.properties.id) ||
                    feature.properties.id >= 0)
            ) {
                feature.properties.id = nextTemporaryId--
                id = `${feature.properties.type}/${feature.properties.id}`
            }
            if (pendingById[id]) {
                throw new Error('The persisted pending data has duplicate IDs.')
            }
            feature.id = id
            pendingById[id] = requireOsmGoFeature(
                feature,
                `pending data ${id}`,
                'pending'
            )
        } catch (error) {
            quarantined.push({
                store: 'pending',
                id: readLegacyId(raw),
                value: structuredClone(raw),
                reason: describeError(error),
            })
        }
    }
    for (const id of Object.keys(pendingById)) delete officialById[id]

    let bbox: OsmGoFeatureCollection = emptyFeatureCollection()
    if (legacy.geojsonBbox !== null && legacy.geojsonBbox !== undefined) {
        try {
            bbox = requireGeometryFeatureCollection(
                requireFeatureCollection(legacy.geojsonBbox, 'bbox data'),
                'persisted bbox data'
            )
        } catch (error) {
            quarantined.push({
                store: 'bbox',
                id: '(bbox)',
                value: structuredClone(legacy.geojsonBbox),
                reason: describeError(error),
            })
        }
    }

    return {
        state: {
            schemaVersion: OSM_STATE_SCHEMA_VERSION,
            revision: 0,
            officialById,
            pendingById,
            bbox,
            nextTemporaryId,
        },
        quarantined,
    }
}

export const migratePersistedOsmState = (
    value: unknown
): PersistedOsmStateV2 => {
    if (!isRecord(value)) {
        throw new Error('The persisted OSM state is invalid.')
    }
    if (value['schemaVersion'] === 1) {
        const state = value as unknown as PersistedOsmStateV1
        const migrated = migrateLegacyOsmState({
            geojson: state.geojson,
            geojsonChanged: state.geojsonChanged,
            geojsonBbox: state.geojsonBbox,
        })
        migrated.revision =
            Number.isInteger(state.revision) && Number(state.revision) >= 0
                ? Number(state.revision)
                : 0
        if (state.uploadJournal) {
            migrated.uploadJournal = requireUploadJournal(state.uploadJournal)
        }
        return migrated
    }
    if (value['schemaVersion'] !== OSM_STATE_SCHEMA_VERSION) {
        throw new Error('The persisted OSM state version is not supported.')
    }

    const revision = value['revision']
    const nextTemporaryId = value['nextTemporaryId']
    if (!Number.isInteger(revision) || Number(revision) < 0) {
        throw new Error('The persisted OSM state revision is invalid.')
    }
    if (!Number.isInteger(nextTemporaryId) || Number(nextTemporaryId) >= 0) {
        throw new Error('The persisted temporary ID allocator is invalid.')
    }
    const state: PersistedOsmStateV2 = {
        schemaVersion: OSM_STATE_SCHEMA_VERSION,
        revision: Number(revision),
        officialById: requireFeatureRecord(
            value['officialById'],
            'official data',
            'official'
        ),
        pendingById: requireFeatureRecord(
            value['pendingById'],
            'pending data',
            'pending'
        ),
        bbox: requireGeometryFeatureCollection(
            value['bbox'],
            'persisted bbox data'
        ),
        nextTemporaryId: Number(nextTemporaryId),
    }
    if (value['uploadJournal'] !== undefined) {
        state.uploadJournal = requireUploadJournal(value['uploadJournal'])
    }
    const overlappingId = Object.keys(state.pendingById).find(
        (id) => state.officialById[id]
    )
    if (overlappingId) {
        throw new Error(
            `The persisted official and pending data overlap at ${overlappingId}.`
        )
    }
    return state
}

export interface QuarantinedOsmFeature {
    store: 'official' | 'pending' | 'bbox'
    id: string
    value: unknown
    reason: string
    quarantinedAt?: string
    source?: 'v1-migration' | 'persisted-state' | 'upload'
}

export interface RecoveredPersistedOsmState {
    state: PersistedOsmStateV2
    quarantined: QuarantinedOsmFeature[]
}

export const recoverPersistedOsmState = (
    value: unknown
): RecoveredPersistedOsmState => {
    if (isRecord(value) && value['schemaVersion'] === 1) {
        const v1 = value as unknown as PersistedOsmStateV1
        const { state, quarantined } = migrateLegacyOsmStateWithQuarantine({
            geojson: v1.geojson,
            geojsonChanged: v1.geojsonChanged,
            geojsonBbox: v1.geojsonBbox,
        })
        state.revision =
            Number.isInteger(v1.revision) && Number(v1.revision) >= 0
                ? Number(v1.revision)
                : 0
        if (v1.uploadJournal) {
            state.uploadJournal = requireUploadJournal(v1.uploadJournal)
            const lockedIds = new Set(state.uploadJournal.submittedIds)
            if (
                quarantined.some(
                    (entry) =>
                        entry.store === 'pending' && lockedIds.has(entry.id)
                )
            ) {
                throw new Error(
                    'A pending object locked by an upload journal is invalid.'
                )
            }
        }
        if (quarantined.length > 0) state.revision++
        return { state, quarantined }
    }
    if (!isRecord(value) || value['schemaVersion'] !== 2) {
        return { state: migratePersistedOsmState(value), quarantined: [] }
    }
    // Every part read below is validated into a new object: no deep copy.
    const shallowState: Record<string, unknown> = { ...value }
    const journal =
        shallowState['uploadJournal'] === undefined
            ? undefined
            : requireUploadJournal(shallowState['uploadJournal'])
    const lockedIds = new Set(journal?.submittedIds ?? [])
    const quarantined: QuarantinedOsmFeature[] = []
    const recoverRecord = (
        source: unknown,
        store: 'official' | 'pending'
    ): Record<string, OsmGoFeature> => {
        if (!isRecord(source)) {
            throw new Error(`The persisted ${store} data is not an ID record.`)
        }
        const recovered: Record<string, OsmGoFeature> = {}
        for (const [id, feature] of Object.entries(source)) {
            try {
                const validated = requireOsmGoFeature(
                    feature,
                    `persisted ${store} data ${id}`,
                    store
                )
                if (String(validated.id) !== id) {
                    throw new Error('The record key does not match its ID.')
                }
                recovered[id] = validated
            } catch (error) {
                if (store === 'pending' && lockedIds.has(id)) throw error
                quarantined.push({
                    store,
                    id,
                    value: structuredClone(feature),
                    reason:
                        error instanceof Error ? error.message : String(error),
                })
            }
        }
        return recovered
    }
    const officialById = recoverRecord(shallowState['officialById'], 'official')
    const pendingById = recoverRecord(shallowState['pendingById'], 'pending')
    for (const id of Object.keys(pendingById)) {
        if (!officialById[id]) continue
        quarantined.push({
            store: 'official',
            id,
            value: structuredClone(officialById[id]),
            reason: 'Official data duplicated a pending feature.',
        })
        delete officialById[id]
    }
    let bbox = shallowState['bbox']
    try {
        requireGeometryFeatureCollection(bbox, 'persisted bbox data')
    } catch (error) {
        // Only tells which areas were downloaded: the next download rebuilds it.
        console.warn('The saved downloaded areas were unreadable.', error)
        bbox = emptyFeatureCollection()
    }
    const repaired = {
        ...shallowState,
        officialById,
        pendingById,
        bbox,
    }
    const state = migratePersistedOsmState(repaired)
    if (quarantined.length > 0) state.revision++
    return { state, quarantined }
}

export const isPersistedOsmStateHead = (value: unknown): boolean =>
    isRecord(value) && value['schemaVersion'] === OSM_STATE_HEAD_SCHEMA_VERSION

export const readOfficialReference = (
    head: unknown
): PersistedOfficialReference => {
    const official = isRecord(head) ? head['official'] : undefined
    if (
        !isRecord(official) ||
        (official['slot'] !== null &&
            !Object.hasOwn(OSM_OFFICIAL_SLOT_KEYS, String(official['slot']))) ||
        !Number.isInteger(official['revision']) ||
        !isRecord(official['delta'])
    ) {
        throw new Error('The persisted official data reference is invalid.')
    }
    return {
        slot: official['slot'] as OsmOfficialSlot | null,
        revision: Number(official['revision']),
        delta: official['delta'] as PersistedOfficialDelta,
    }
}

/**
 * Rebuilds the single-record shape from a head and the official slot it
 * references. A slot that is missing or belongs to another revision (a crash
 * between two writes) is dropped: official data can be downloaded again,
 * while the pending queue and the journal are always read from the head.
 */
export const composePersistedOsmState = (
    head: unknown,
    officialData: unknown
): { value: Record<string, unknown>; officialDropped: boolean } => {
    if (!isPersistedOsmStateHead(head)) {
        throw new Error('The persisted OSM state is invalid.')
    }
    const source = head as Record<string, unknown>
    const reference = readOfficialReference(source)
    const slotMatches =
        isRecord(officialData) &&
        officialData['revision'] === reference.revision &&
        isRecord(officialData['officialById'])
    const officialDropped = reference.slot !== null && !slotMatches
    const officialById: Record<string, unknown> =
        reference.slot !== null && slotMatches
            ? {
                  ...(officialData['officialById'] as Record<string, unknown>),
              }
            : {}
    for (const [id, feature] of Object.entries(reference.delta)) {
        if (feature === null) {
            delete officialById[id]
        } else {
            officialById[id] = feature
        }
    }
    const value: Record<string, unknown> = {
        schemaVersion: OSM_STATE_SCHEMA_VERSION,
        revision: source['revision'],
        officialById,
        pendingById: source['pendingById'],
        bbox:
            reference.slot !== null && slotMatches
                ? officialData['bbox']
                : emptyFeatureCollection(),
        nextTemporaryId: source['nextTemporaryId'],
    }
    if (source['uploadJournal'] !== undefined) {
        value['uploadJournal'] = source['uploadJournal']
    }
    return { value, officialDropped }
}
