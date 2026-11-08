import { computed, inject, Service, signal } from '@angular/core'
import { type ChangesetBbox, featuresBbox } from '@app/utils/changeset-bbox'
import { cloneDeep } from '@app/utils/clone'
import {
    MAX_CHANGESET_COMMENT_LENGTH,
    osmTextLength,
} from '@app/utils/osm-tags'
import { tryAcquireWebLock } from '@app/utils/web-lock'
import type { OsmGoChangeType, OsmGoFeature } from '@osmgo/type'
import { addAttributesToFeature } from '@scripts/osmToOsmgo/index.js'
import { ConfigService, type User } from '@services/config.service'
import {
    DataService,
    UploadQueueChangedError,
    type UploadReceiptEntry,
} from '@services/data.service'
import { MapService } from '@services/map.service'
import {
    OsmStateConflictError,
    type PersistedUploadJournal,
    type PersistedUploadSummary,
} from '@services/osm-state'
import {
    UploadValidationError,
    validateOsmUploadFeature,
} from '@services/osm-upload-validation'
import { matchUploadAgainstChangeset } from '@services/osm-upload-verification'
import {
    type OsmApiObject,
    OsmApiService,
    type OsmDiffResult,
} from '@services/osmApi.service'
import { TagsService } from '@services/tags.service'
import { firstValueFrom, type Observable } from 'rxjs'
import { take } from 'rxjs/operators'
import { type RebaseOutcome, rebaseOnRemote } from './osm-rebase'

export type UploadSummary = PersistedUploadSummary

export type UploadFeature = OsmGoFeature & { error?: string }

export type UploadFailureStage =
    | 'validation'
    | 'connection'
    | 'changeset'
    | 'journal'
    | 'upload'
    | 'reconciliation'

export type UploadRecoveryAction =
    | 'editQueue'
    | 'reconnect'
    | 'reauthenticate'
    | 'checkAccount'
    | 'createChangeset'
    | 'inspectServer'
    | 'resumeReconciliation'
    | 'reload'
    | 'retry'

export type UploadFailureCode =
    | 'emptyQueue'
    | 'invalidQueue'
    | 'commentTooLong'
    | 'connection'
    | 'authentication'
    | 'forbidden'
    | 'changesetClosed'
    | 'changeset'
    | 'journal'
    | 'uploadRejected'
    | 'versionConflict'
    | 'nodeStillReferenced'
    | 'uploadUncertain'
    | 'uploadElsewhere'
    | 'staleState'
    | 'receiptNotSaved'
    | 'reconciliation'
    | 'recoveryRequired'
    | 'legacyJournal'
    | 'integrity'
    | 'localChange'
    | 'unknown'

/**
 * What the changeset download said about an upload whose answer was lost:
 * `notFound` (no trace of it), `partial` (inconsistent, inspect manually) or
 * `unavailable` (the check itself could not be made).
 */
export type UploadVerificationStatus = 'notFound' | 'partial' | 'unavailable'

/**
 * OpenStreetMap can still apply a request whose answer was lost: only a check
 * made this long after the failure may call the attempt "not applied".
 */
export const NOT_APPLIED_CONFIRMATION_DELAY_MS = 90_000

export interface UploadFailure {
    status: number
    code: UploadFailureCode
    /** Technical diagnostic; never display this value directly. */
    technicalMessage: string
    changesetId?: string
    feature: UploadFeature | null
    queuePreserved: true
    canClose: true
    canRetry: boolean
    recoveryAction: UploadRecoveryAction
    verification?: UploadVerificationStatus
    /** A `notFound` check made late enough to rule out a delayed commit. */
    notAppliedConfirmed?: boolean
    /** When `notFound` is not confirmed yet: the earliest useful new check. */
    confirmationCheckAfter?: string
}

class CodedUploadError extends Error {
    constructor(
        readonly code: UploadFailureCode,
        message: string,
        readonly featureId?: string
    ) {
        super(message)
    }
}

/** A destructive recovery action was refused: another window is uploading. */
export class UploadBusyElsewhereError extends Error {
    readonly name = 'UploadBusyElsewhereError'

    constructor() {
        super('Another window is uploading these changes.')
    }
}

export type UploadState =
    | { kind: 'idle' }
    | { kind: 'validating' }
    | { kind: 'creatingChangeset' }
    | { kind: 'uploading'; attemptId: string }
    | { kind: 'verifying'; attemptId: string }
    | { kind: 'receiptReceived'; attemptId: string }
    | { kind: 'reconciling'; attemptId: string }
    | { kind: 'succeeded'; summary: UploadSummary }
    | {
          kind: 'failed'
          stage: UploadFailureStage
          error: UploadFailure
      }

type FailedState = Extract<UploadState, { kind: 'failed' }>
type PreparedJournal = Extract<PersistedUploadJournal, { phase: 'prepared' }>
type ReconcilableJournal = Exclude<
    PersistedUploadJournal,
    { phase: 'prepared' }
>

interface OsmRequestError {
    status?: unknown
    error?: unknown
    message?: unknown
}

interface SubmittedUpload {
    feature: UploadFeature
    operation: OsmGoChangeType
}

interface NodeReferences {
    ways: string[]
    relations: string[]
}

export interface UploadCoordinatorDependencies {
    getPendingFeatures(): UploadFeature[]
    getUserDetail$(): Observable<unknown>
    getValidChangeset(comment: string, bbox?: ChangesetBbox): Observable<string>
    serializeDiff(features: UploadFeature[], changesetId: string): string
    /** Emits the server answer: raw text (preferred) or parsed rows. */
    uploadDiff(diff: string, changesetId: string): Observable<unknown>
    /** Reads the raw answer of `uploadDiff` when it is text. */
    parseReceipt?(text: string): unknown
    /** The osmChange document of a changeset, to check a lost answer. */
    downloadChangeset?(changesetId: string): Observable<string>
    /** True for an OSM id (`node/111`) already held locally. */
    isKnownFeatureId?(id: string): boolean
    getUploadJournal(): PersistedUploadJournal | undefined
    beginUploadAttempt(journal: PreparedJournal): Promise<void>
    acknowledgeUploadAttempt(
        attemptId: string,
        rawReceipt: unknown,
        acknowledgedAt: string
    ): Promise<void>
    applyAcknowledgedReceipt(
        attemptId: string,
        receipt: UploadReceiptEntry[],
        appliedAt: string
    ): Promise<void>
    clearAppliedUploadAttempt(attemptId: string): Promise<void>
    discardPreparedUploadAttempt(attemptId: string): Promise<void>
    abandonUploadAttempt?(
        attemptId: string,
        options?: { prepared?: boolean }
    ): Promise<void>
    /** Sends a deletion as a tag removal once OSM says the node is in use. */
    markNodeReferenced?(
        id: string,
        references: NodeReferences
    ): Promise<unknown>
    /** Resolves to a release function, or `null` if another window uploads. */
    acquireUploadLock?(): Promise<(() => void) | null>
    wait?(milliseconds: number): Promise<void>
    getUserInfo(): User
    setChangesetComment(comment: string): void
    updateChangesetLastActivity(): void
    invalidateChangeset(): void
    styleFeature(feature: OsmGoFeature): OsmGoFeature
    setProcessing(processing: boolean): void
    redraw(): void
    createAttemptId(): string
    hashPayload(payload: string): Promise<string>
    now(): Date
    onTransition?(state: UploadState): void
}

const createAttemptId = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`

export const hashUploadPayload = async (payload: string): Promise<string> => {
    if (!globalThis.crypto?.subtle) {
        throw new Error('Secure payload hashing is unavailable.')
    }
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(payload)
    )
    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('')
}

const emptySummary = (): UploadSummary => ({
    Total: 0,
    Create: 0,
    Update: 0,
    Delete: 0,
})

const ACKNOWLEDGEMENT_ATTEMPTS = 3
const ACKNOWLEDGEMENT_RETRY_DELAY_MS = 400

interface RunContext {
    stage: UploadFailureStage
    changesetId: string
    attemptId: string
    journal?: PreparedJournal
}

type VerificationOutcome =
    | { kind: 'succeeded'; state: UploadState }
    | { kind: 'failed'; state: FailedState }
    | { kind: UploadVerificationStatus }

export class UploadCoordinator {
    private readonly stateSignal = signal<UploadState>({ kind: 'idle' })
    readonly state = this.stateSignal.asReadonly()
    readonly inFlight = computed(() =>
        [
            'validating',
            'creatingChangeset',
            'uploading',
            'verifying',
            'receiptReceived',
            'reconciling',
        ].includes(this.stateSignal().kind)
    )
    private activeAttempt?: Promise<UploadState>
    private unsavedReceipt?: { attemptId: string; rawReceipt: unknown }
    /** When this session saw the answer of an attempt get lost. */
    private lostAnswer?: { attemptId: string; at: number }

    constructor(private readonly dependencies: UploadCoordinatorDependencies) {}

    /**
     * The server answer of an attempt that could not be written to the journal.
     * It lives in memory only: export it before closing the application.
     */
    getUnsavedReceipt():
        | { attemptId: string; rawReceipt: unknown }
        | undefined {
        return this.unsavedReceipt ? { ...this.unsavedReceipt } : undefined
    }

    start(comment: string): Promise<UploadState> {
        if (this.activeAttempt) return this.activeAttempt
        const current = this.stateSignal()
        if (current.kind === 'failed' && !current.error.canRetry) {
            return Promise.resolve(current)
        }
        return this.track(this.run(comment))
    }

    recoverJournal(): Promise<UploadState> {
        if (this.activeAttempt) return this.activeAttempt
        if (this.stateSignal().kind !== 'idle') {
            return Promise.resolve(this.stateSignal())
        }
        const journal = this.dependencies.getUploadJournal()
        if (!journal) return Promise.resolve(this.stateSignal())
        if (journal.phase === 'prepared') {
            const failed = this.createFailure(
                'upload',
                new CodedUploadError(
                    'recoveryRequired',
                    'A previous upload may have reached OpenStreetMap. Inspect the server before continuing.'
                ),
                journal.changesetId
            )
            this.transition(failed)
            return Promise.resolve(failed)
        }

        if (journal.phase === 'acknowledged' && journal.journalVersion === 1) {
            const failed = this.createFailure(
                'upload',
                new CodedUploadError(
                    'legacyJournal',
                    'This legacy upload journal has no immutable snapshot. Inspect OpenStreetMap before resolving it.'
                ),
                journal.changesetId
            )
            this.transition(failed)
            return Promise.resolve(failed)
        }

        return this.startRecovery(journal)
    }

    resumeReconciliation(): Promise<UploadState> {
        if (this.activeAttempt) return this.activeAttempt
        const journal = this.dependencies.getUploadJournal()
        if (!journal) return Promise.resolve(this.stateSignal())
        if (journal.phase === 'prepared') {
            if (this.unsavedReceipt?.attemptId !== journal.attemptId) {
                return Promise.resolve(this.stateSignal())
            }
            return this.track(
                this.underUploadLockForState(() => {
                    this.resetFailedState()
                    return this.runUnsavedReceiptRecovery(journal)
                })
            )
        }
        if (journal.phase === 'acknowledged' && journal.journalVersion === 1) {
            return Promise.resolve(this.stateSignal())
        }
        return this.track(
            this.underUploadLockForState(() => {
                this.resetFailedState()
                return this.stateSignal().kind === 'idle'
                    ? this.runRecovery(journal)
                    : Promise.resolve(this.stateSignal())
            })
        )
    }

    /**
     * Asks OpenStreetMap whether a prepared attempt (whose answer was lost)
     * reached the server, by comparing the changeset with the journal snapshot.
     * An applied attempt is reconciled; otherwise the failure records what the
     * check found so the interface can decide what to offer.
     */
    verifyPreparedAttempt(): Promise<UploadState> {
        if (this.activeAttempt) return this.activeAttempt
        const journal = this.dependencies.getUploadJournal()
        if (
            journal?.phase !== 'prepared' ||
            this.unsavedReceipt?.attemptId === journal.attemptId
        ) {
            return Promise.resolve(this.stateSignal())
        }
        return this.track(
            this.underUploadLockForState(() => this.runVerification(journal))
        )
    }

    async discardPreparedAttemptAsNotApplied(): Promise<UploadState> {
        if (this.activeAttempt) return this.activeAttempt
        const journal = this.dependencies.getUploadJournal()
        if (
            journal?.phase !== 'prepared' ||
            this.unsavedReceipt?.attemptId === journal.attemptId
        ) {
            return this.stateSignal()
        }
        const discarded = await this.underUploadLock(
            async () => {
                const current = this.stateSignal()
                if (
                    current.kind !== 'failed' ||
                    current.error.verification !== 'notFound' ||
                    !current.error.notAppliedConfirmed
                ) {
                    return false
                }
                await this.dependencies.discardPreparedUploadAttempt(
                    journal.attemptId
                )
                return true
            },
            () => {
                throw new UploadBusyElsewhereError()
            }
        )
        if (discarded) this.resetFailedState()
        return this.stateSignal()
    }

    /**
     * Last resort for an acknowledged attempt that cannot be reconciled: its
     * objects leave the queue (they stay in the quarantine) and the journal is
     * dropped. OpenStreetMap already holds the changes.
     */
    async markAcknowledgedAttemptAsApplied(): Promise<UploadState> {
        if (this.activeAttempt) return this.activeAttempt
        const journal = this.dependencies.getUploadJournal()
        if (!journal || journal.phase === 'prepared') {
            return this.stateSignal()
        }
        if (!this.dependencies.abandonUploadAttempt) {
            throw new Error('Abandoning an upload attempt is not supported.')
        }
        const abandon = this.dependencies.abandonUploadAttempt
        await this.underUploadLock(
            () => abandon(journal.attemptId),
            () => {
                throw new UploadBusyElsewhereError()
            }
        )
        this.dependencies.redraw()
        this.resetFailedState()
        return this.stateSignal()
    }

    /**
     * Way out of a `partial` check: an osmChange upload is applied as a whole,
     * so a changeset holding part of the attempt means the rest could not be
     * recognised. The objects leave the queue (they stay in the quarantine).
     */
    async markPartialAttemptAsApplied(): Promise<UploadState> {
        if (this.activeAttempt) return this.activeAttempt
        const journal = this.dependencies.getUploadJournal()
        const current = this.stateSignal()
        if (
            journal?.phase !== 'prepared' ||
            current.kind !== 'failed' ||
            current.error.verification !== 'partial' ||
            this.unsavedReceipt?.attemptId === journal.attemptId
        ) {
            return current
        }
        if (!this.dependencies.abandonUploadAttempt) {
            throw new Error('Abandoning an upload attempt is not supported.')
        }
        const abandon = this.dependencies.abandonUploadAttempt
        await this.underUploadLock(
            () => abandon(journal.attemptId, { prepared: true }),
            () => {
                throw new UploadBusyElsewhereError()
            }
        )
        this.dependencies.redraw()
        this.resetFailedState()
        return this.stateSignal()
    }

    resetTerminalState(): void {
        const current = this.stateSignal().kind
        if (current === 'succeeded' || current === 'failed') {
            this.transition({ kind: 'idle' })
        }
    }

    private track(attempt: Promise<UploadState>): Promise<UploadState> {
        this.activeAttempt = attempt.finally(() => {
            this.activeAttempt = undefined
        })
        return this.activeAttempt
    }

    private resetFailedState(): void {
        if (this.stateSignal().kind === 'failed') {
            this.transition({ kind: 'idle' })
        }
    }

    private startRecovery(journal: ReconcilableJournal): Promise<UploadState> {
        return this.track(
            this.underUploadLockForState(() => this.runRecovery(journal))
        )
    }

    /** Runs `task` unless another window is uploading (nothing then changes). */
    private async underUploadLockForState(
        task: () => Promise<UploadState>
    ): Promise<UploadState> {
        return this.underUploadLock(task, () => this.stateSignal())
    }

    private async underUploadLock<Result>(
        task: () => Promise<Result>,
        whenBusy: () => Result
    ): Promise<Result> {
        const release = this.dependencies.acquireUploadLock
            ? await this.dependencies.acquireUploadLock()
            : () => undefined
        if (release === null) return whenBusy()
        try {
            return await task()
        } finally {
            release()
        }
    }

    private async run(comment: string): Promise<UploadState> {
        const context: RunContext = {
            stage: 'validation',
            changesetId: '',
            attemptId: '',
        }
        let release: (() => void) | undefined
        this.transition({ kind: 'validating' })
        this.dependencies.setProcessing(true)

        try {
            const lock = this.dependencies.acquireUploadLock
                ? await this.dependencies.acquireUploadLock()
                : () => undefined
            if (lock === null) {
                throw new CodedUploadError(
                    'uploadElsewhere',
                    'Another window is already uploading.'
                )
            }
            release = lock
            if (osmTextLength(comment) > MAX_CHANGESET_COMMENT_LENGTH) {
                throw new CodedUploadError(
                    'commentTooLong',
                    `The changeset comment is longer than ${MAX_CHANGESET_COMMENT_LENGTH} characters.`
                )
            }
            this.validateQueue(
                cloneDeep(this.dependencies.getPendingFeatures())
            )
            this.dependencies.setChangesetComment(comment)

            context.stage = 'connection'
            await firstValueFrom(
                this.dependencies.getUserDetail$().pipe(take(1))
            )

            const { prepared, rawReceipt } = await this.prepareAndUpload(
                comment,
                context
            )

            context.stage = 'reconciliation'
            const acknowledged = await this.persistAcknowledgement(
                prepared,
                rawReceipt
            )
            this.transition({
                kind: 'receiptReceived',
                attemptId: prepared.attemptId,
            })
            this.dependencies.updateChangesetLastActivity()
            return await this.reconcileJournal(acknowledged)
        } catch (cause) {
            return await this.failUpload(context, cause)
        } finally {
            release?.()
            this.dependencies.setProcessing(false)
        }
    }

    /**
     * Creates (or reuses) the changeset, writes the journal and sends the diff.
     * A changeset that OpenStreetMap closed meanwhile is replaced once: a
     * rejected request changed nothing, so sending again is safe.
     */
    private async prepareAndUpload(
        comment: string,
        context: RunContext
    ): Promise<{ prepared: PreparedJournal; rawReceipt: unknown }> {
        for (let attempt = 0; ; attempt++) {
            context.stage = 'changeset'
            this.transition({ kind: 'creatingChangeset' })
            context.changesetId = await firstValueFrom(
                this.dependencies
                    .getValidChangeset(
                        comment,
                        featuresBbox(this.dependencies.getPendingFeatures())
                    )
                    .pipe(take(1))
            )

            // Read the queue only now: edits made during the network calls
            // above are part of this attempt instead of being lost to it.
            const features = cloneDeep(this.dependencies.getPendingFeatures())
            const submissions = this.validateQueue(features)
            const summary = this.getSummary(features)
            const diff = this.dependencies.serializeDiff(
                features,
                context.changesetId
            )
            context.attemptId = this.dependencies.createAttemptId()

            context.stage = 'journal'
            const prepared: PreparedJournal = {
                journalVersion: 2,
                attemptId: context.attemptId,
                payload: diff,
                payloadHash: await this.dependencies.hashPayload(diff),
                changesetId: context.changesetId,
                submittedIds: [...submissions.keys()],
                submissions: Array.from(submissions, ([oldId, submission]) => ({
                    oldId,
                    operation: submission.operation,
                    feature: cloneDeep(submission.feature),
                })),
                summary,
                startedAt: this.dependencies.now().toISOString(),
                phase: 'prepared',
            }
            try {
                await this.dependencies.beginUploadAttempt(prepared)
            } catch (cause) {
                if (cause instanceof UploadQueueChangedError) {
                    throw new CodedUploadError(
                        'localChange',
                        cause.message,
                        cause.changedIds[0]
                    )
                }
                throw cause
            }
            context.journal = prepared

            context.stage = 'upload'
            this.transition({ kind: 'uploading', attemptId: context.attemptId })
            try {
                const rawReceipt = await firstValueFrom(
                    this.dependencies
                        .uploadDiff(diff, context.changesetId)
                        .pipe(take(1))
                )
                return { prepared, rawReceipt }
            } catch (cause) {
                if (
                    attempt === 0 &&
                    this.isClosedChangesetError(
                        this.getOsmRequestError(cause),
                        context.changesetId
                    )
                ) {
                    await this.dependencies.discardPreparedUploadAttempt(
                        context.attemptId
                    )
                    this.dependencies.invalidateChangeset()
                    context.journal = undefined
                    context.attemptId = ''
                    continue
                }
                throw cause
            }
        }
    }

    /**
     * Writes the server answer to the journal before anything interprets it.
     * The answer is kept in memory when storage keeps failing: the server
     * already applied the changes, so the attempt must never be called "not
     * applied" nor sent again.
     */
    private async persistAcknowledgement(
        prepared: PreparedJournal,
        rawReceipt: unknown
    ): Promise<Extract<ReconcilableJournal, { phase: 'acknowledged' }>> {
        const acknowledgedAt = this.dependencies.now().toISOString()
        let lastError: unknown
        for (let attempt = 0; attempt < ACKNOWLEDGEMENT_ATTEMPTS; attempt++) {
            try {
                await this.dependencies.acknowledgeUploadAttempt(
                    prepared.attemptId,
                    rawReceipt,
                    acknowledgedAt
                )
                if (this.unsavedReceipt?.attemptId === prepared.attemptId) {
                    this.unsavedReceipt = undefined
                }
                return {
                    ...prepared,
                    phase: 'acknowledged',
                    rawReceipt,
                    acknowledgedAt,
                } as Extract<ReconcilableJournal, { phase: 'acknowledged' }>
            } catch (error) {
                lastError = error
                if (error instanceof OsmStateConflictError) break
                if (attempt < ACKNOWLEDGEMENT_ATTEMPTS - 1) {
                    await this.wait(
                        ACKNOWLEDGEMENT_RETRY_DELAY_MS * 2 ** attempt
                    )
                }
            }
        }
        this.unsavedReceipt = { attemptId: prepared.attemptId, rawReceipt }
        throw new CodedUploadError(
            'receiptNotSaved',
            this.getOsmErrorMessage(lastError)
        )
    }

    private wait(milliseconds: number): Promise<void> {
        return this.dependencies.wait
            ? this.dependencies.wait(milliseconds)
            : new Promise((resolve) => setTimeout(resolve, milliseconds))
    }

    private async failUpload(
        context: RunContext,
        cause: unknown
    ): Promise<UploadState> {
        let failureCause = cause
        const extras: FailureExtras = {}
        if (
            context.stage === 'upload' &&
            context.attemptId &&
            context.journal
        ) {
            if (this.isDefinitiveUploadRejection(cause)) {
                try {
                    await this.dependencies.discardPreparedUploadAttempt(
                        context.attemptId
                    )
                    extras.nodeReferenced =
                        await this.sendNodeAsTagRemoval(cause)
                } catch (discardError) {
                    failureCause = discardError
                }
            } else {
                this.lostAnswer = {
                    attemptId: context.attemptId,
                    at: this.dependencies.now().getTime(),
                }
                const outcome = await this.verifyPreparedJournal(
                    context.journal
                )
                if (outcome.kind === 'succeeded' || outcome.kind === 'failed') {
                    return outcome.state
                }
                Object.assign(
                    extras,
                    this.verificationExtras(context.journal, outcome.kind)
                )
            }
        }
        const failed = this.createFailure(
            context.stage,
            failureCause,
            context.changesetId,
            extras
        )
        this.transition(failed)
        return failed
    }

    /**
     * OpenStreetMap refuses to delete a node that ways or relations still use
     * (HTTP 412). The local data was stale: record the references so the
     * deletion is sent again as a removal of the node's tags.
     */
    private async sendNodeAsTagRemoval(cause: unknown): Promise<boolean> {
        const details = this.getOsmRequestError(cause)
        if (details.status !== 412 || !this.dependencies.markNodeReferenced) {
            return false
        }
        const match = this.getOsmErrorMessage(cause).match(
            /Node (\d+) is still used by (ways|relations) ([\d,\s]+)/i
        )
        if (!match) return false
        const ids = match[3]
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        const references: NodeReferences =
            match[2].toLowerCase() === 'ways'
                ? { ways: ids.map((id) => `way/${id}`), relations: [] }
                : { ways: [], relations: ids.map((id) => `relation/${id}`) }
        try {
            await this.dependencies.markNodeReferenced(
                `node/${match[1]}`,
                references
            )
            return true
        } catch {
            return false
        }
    }

    private async runVerification(
        journal: PreparedJournal
    ): Promise<UploadState> {
        const previous = this.stateSignal()
        this.dependencies.setProcessing(true)
        try {
            const outcome = await this.verifyPreparedJournal(journal)
            if (outcome.kind === 'succeeded' || outcome.kind === 'failed') {
                return outcome.state
            }
            const failed = this.createFailure(
                'upload',
                new CodedUploadError(
                    previous.kind === 'failed'
                        ? previous.error.code
                        : 'recoveryRequired',
                    previous.kind === 'failed'
                        ? previous.error.technicalMessage
                        : 'A previous upload may have reached OpenStreetMap.'
                ),
                journal.changesetId,
                this.verificationExtras(journal, outcome.kind)
            )
            if (previous.kind === 'failed') {
                failed.error.status = previous.error.status
            }
            this.transition(failed)
            return failed
        } finally {
            this.dependencies.setProcessing(false)
        }
    }

    /**
     * A `notFound` check confirms the attempt was not applied only when it was
     * made long enough after the failure seen in this session, or after the
     * start of an attempt left by a previous session.
     */
    private verificationExtras(
        journal: PreparedJournal,
        verification: UploadVerificationStatus
    ): FailureExtras {
        if (verification !== 'notFound') return { verification }
        const checkedAt = this.dependencies.now().getTime()
        const failedAt =
            this.lostAnswer?.attemptId === journal.attemptId
                ? this.lostAnswer.at
                : Date.parse(journal.startedAt)
        const confirmableAt =
            (Number.isFinite(failedAt) ? failedAt : checkedAt) +
            NOT_APPLIED_CONFIRMATION_DELAY_MS
        return checkedAt >= confirmableAt
            ? { verification, notAppliedConfirmed: true }
            : {
                  verification,
                  confirmationCheckAfter: new Date(confirmableAt).toISOString(),
              }
    }

    private async verifyPreparedJournal(
        journal: PreparedJournal
    ): Promise<VerificationOutcome> {
        this.transition({ kind: 'verifying', attemptId: journal.attemptId })
        if (
            journal.journalVersion !== 2 ||
            !this.dependencies.downloadChangeset
        ) {
            return { kind: 'unavailable' }
        }
        let verification: ReturnType<typeof matchUploadAgainstChangeset>
        try {
            const document = await firstValueFrom(
                this.dependencies
                    .downloadChangeset(journal.changesetId)
                    .pipe(take(1))
            )
            verification = matchUploadAgainstChangeset(
                document,
                journal.submissions,
                (id) => this.dependencies.isKnownFeatureId?.(id) ?? false
            )
        } catch {
            return { kind: 'unavailable' }
        }
        if (verification.kind !== 'applied') {
            return { kind: verification.kind }
        }

        try {
            const acknowledged = await this.persistAcknowledgement(
                journal,
                verification.receipt
            )
            this.transition({
                kind: 'receiptReceived',
                attemptId: journal.attemptId,
            })
            return {
                kind: 'succeeded',
                state: await this.reconcileJournal(acknowledged),
            }
        } catch (cause) {
            const failed = this.createFailure(
                'reconciliation',
                cause,
                journal.changesetId
            )
            this.transition(failed)
            return { kind: 'failed', state: failed }
        }
    }

    private async runUnsavedReceiptRecovery(
        journal: PreparedJournal
    ): Promise<UploadState> {
        this.dependencies.setProcessing(true)
        try {
            const acknowledged = await this.persistAcknowledgement(
                journal,
                this.unsavedReceipt?.rawReceipt
            )
            this.transition({
                kind: 'receiptReceived',
                attemptId: journal.attemptId,
            })
            this.dependencies.updateChangesetLastActivity()
            return await this.reconcileJournal(acknowledged)
        } catch (cause) {
            const failed = this.createFailure(
                'reconciliation',
                cause,
                journal.changesetId
            )
            this.transition(failed)
            return failed
        } finally {
            this.dependencies.setProcessing(false)
        }
    }

    private async runRecovery(
        journal: ReconcilableJournal
    ): Promise<UploadState> {
        this.dependencies.setProcessing(true)
        this.transition({
            kind: 'receiptReceived',
            attemptId: journal.attemptId,
        })
        try {
            return await this.reconcileJournal(journal)
        } catch (cause) {
            const failed = this.createFailure(
                'reconciliation',
                cause,
                journal.changesetId
            )
            if (
                this.getOsmErrorMessage(cause).includes('integrity check') ||
                this.getOsmErrorMessage(cause).includes('immutable snapshot')
            ) {
                failed.error.recoveryAction = 'inspectServer'
                failed.error.canRetry = false
            }
            this.transition(failed)
            return failed
        } finally {
            this.dependencies.setProcessing(false)
        }
    }

    /**
     * Applies an acknowledged journal to the local data, then closes it. The
     * rebuilt queue comes from the journal snapshot, never from the live queue.
     */
    private async reconcileJournal(
        journal: ReconcilableJournal
    ): Promise<UploadState> {
        this.transition({
            kind: 'reconciling',
            attemptId: journal.attemptId,
        })
        if (journal.phase === 'acknowledged') {
            if (journal.journalVersion !== 2) {
                throw new CodedUploadError(
                    'legacyJournal',
                    'The upload journal does not contain an immutable snapshot.'
                )
            }
            const actualHash = await this.dependencies.hashPayload(
                journal.payload
            )
            if (actualHash !== journal.payloadHash) {
                throw new CodedUploadError(
                    'integrity',
                    'The persisted upload payload failed its integrity check.'
                )
            }
            const features = journal.submissions.map((submission) =>
                cloneDeep(submission.feature)
            )
            const submissions = this.validateQueue(features, {
                trustedOperations: new Map(
                    journal.submissions.map((submission) => [
                        submission.oldId,
                        submission.operation,
                    ])
                ),
            })
            for (const persisted of journal.submissions) {
                if (
                    submissions.get(persisted.oldId)?.operation !==
                    persisted.operation
                ) {
                    throw new CodedUploadError(
                        'integrity',
                        'The persisted upload submissions are inconsistent.'
                    )
                }
            }
            const receipt = this.prepareReceipt(
                this.readReceiptRows(journal.rawReceipt),
                submissions,
                journal.changesetId
            )
            await this.dependencies.applyAcknowledgedReceipt(
                journal.attemptId,
                receipt,
                this.dependencies.now().toISOString()
            )
        }
        this.dependencies.redraw()
        await this.dependencies.clearAppliedUploadAttempt(journal.attemptId)
        const succeeded: UploadState = {
            kind: 'succeeded',
            summary: journal.summary,
        }
        this.transition(succeeded)
        return succeeded
    }

    /** The journal stores the answer as text; older ones stored parsed rows. */
    private readReceiptRows(rawReceipt: unknown): unknown {
        if (typeof rawReceipt !== 'string') return rawReceipt
        if (!this.dependencies.parseReceipt) {
            throw new Error('The upload answer cannot be interpreted.')
        }
        return this.dependencies.parseReceipt(rawReceipt)
    }

    private validateQueue(
        features: UploadFeature[],
        options: { trustedOperations?: Map<string, OsmGoChangeType> } = {}
    ): Map<string, SubmittedUpload> {
        if (features.length === 0) {
            throw new Error('There are no local changes to upload.')
        }
        const submittedById = new Map<string, SubmittedUpload>()
        for (const feature of features) {
            const validated = validateOsmUploadFeature(feature)
            if (submittedById.has(validated.id)) {
                throw new UploadValidationError(validated.id, 'duplicate entry')
            }
            // A journal written by an older version may have classified a
            // deletion differently: its recorded operation is authoritative.
            const recorded = options.trustedOperations?.get(validated.id)
            const operation =
                recorded &&
                feature.properties.changeType === 'Delete' &&
                (recorded === 'Delete' || recorded === 'Update')
                    ? recorded
                    : validated.operation
            submittedById.set(validated.id, { feature, operation })
        }
        return submittedById
    }

    private prepareReceipt(
        diffResults: unknown,
        submittedById: Map<string, SubmittedUpload>,
        changesetId: string
    ): UploadReceiptEntry[] {
        if (
            !Array.isArray(diffResults) ||
            diffResults.length !== submittedById.size
        ) {
            throw new Error('OpenStreetMap returned an invalid upload result.')
        }

        const preparedResults: UploadReceiptEntry[] = []
        const processedIds = new Set<string>()
        for (const result of diffResults) {
            if (!result || typeof result !== 'object') {
                throw new Error(
                    'OpenStreetMap returned an invalid upload result.'
                )
            }
            const diff = result as OsmDiffResult
            const oldId = diff.osmgoOldId
            const submission = submittedById.get(oldId)
            if (
                typeof oldId !== 'string' ||
                !submission ||
                processedIds.has(oldId)
            ) {
                throw new Error(
                    'The OSM upload result does not match local data.'
                )
            }
            const validated = this.validateUploadReceipt(diff, submission)
            processedIds.add(oldId)

            const currentFeature = submission.feature
            if (currentFeature.properties.changeType === 'Delete') {
                preparedResults.push({ oldId })
                continue
            }

            if (validated.kind !== 'upsert') {
                throw new Error('OpenStreetMap returned an incomplete result.')
            }
            let newFeature = cloneDeep(currentFeature)
            newFeature.id = validated.newOsmId
            newFeature.properties.id = validated.newId
            newFeature.properties.meta.version = validated.newVersion
            const user = this.dependencies.getUserInfo()
            newFeature.properties.meta.user = user.display_name
            newFeature.properties.meta.uid = user.uid
            newFeature.properties.meta.changeset = changesetId
            const now = this.dependencies.now()
            newFeature.properties.meta.timestamp = now.toISOString()
            newFeature.properties.time = now.getTime()
            if (newFeature.properties.tags.fixme) {
                newFeature.properties.fixme = true
            } else {
                delete newFeature.properties.fixme
            }

            delete newFeature.properties.deprecated
            delete newFeature.properties.changeType
            delete newFeature.properties.originalData
            newFeature = this.dependencies.styleFeature(newFeature)
            addAttributesToFeature(newFeature)

            const hasTags = Object.keys(newFeature.properties.tags).length > 0
            preparedResults.push({
                oldId,
                feature:
                    currentFeature.properties.changeType === 'Create' || hasTags
                        ? newFeature
                        : undefined,
            })
        }

        if (processedIds.size !== submittedById.size) {
            throw new Error('OpenStreetMap returned an incomplete result.')
        }
        return preparedResults
    }

    private validateUploadReceipt(
        diff: OsmDiffResult,
        submission: SubmittedUpload
    ):
        | { kind: 'delete' }
        | {
              kind: 'upsert'
              newId: number
              newVersion: number
              newOsmId: string
          } {
        const feature = submission.feature
        const type = feature.properties.type
        const oldId = String(feature.properties.id)
        if (
            diff.type !== type ||
            diff.old_id !== oldId ||
            diff.osmgoOldId !== `${type}/${oldId}`
        ) {
            throw new Error('The OSM upload result does not match local data.')
        }

        if (submission.operation === 'Delete') {
            if (
                diff.new_id !== undefined ||
                diff.new_version !== undefined ||
                diff.osmgoNewId !== undefined
            ) {
                throw new Error(
                    'The OSM upload result does not match the submitted operation.'
                )
            }
            return { kind: 'delete' }
        }

        const newId = Number(diff.new_id)
        if (
            typeof diff.new_id !== 'string' ||
            !/^[1-9]\d*$/.test(diff.new_id) ||
            !Number.isSafeInteger(newId) ||
            typeof diff.new_version !== 'number' ||
            !Number.isInteger(diff.new_version) ||
            diff.new_version < 1 ||
            diff.osmgoNewId !== `${type}/${diff.new_id}`
        ) {
            throw new Error('OpenStreetMap returned an incomplete result.')
        }

        if (submission.operation === 'Create') {
            if (feature.properties.id >= 0 || diff.new_version !== 1) {
                throw new Error(
                    'The OSM upload result does not match the submitted operation.'
                )
            }
        } else if (
            feature.properties.id < 1 ||
            newId !== feature.properties.id ||
            diff.new_version !== feature.properties.meta.version + 1
        ) {
            throw new Error(
                'The OSM upload result does not match the submitted operation.'
            )
        }

        return {
            kind: 'upsert',
            newId,
            newVersion: diff.new_version,
            newOsmId: diff.osmgoNewId,
        }
    }

    private createFailure(
        stage: UploadFailureStage,
        cause: unknown,
        changesetId: string,
        extras: FailureExtras = {}
    ): FailedState {
        const details = this.getOsmRequestError(cause)
        const status = typeof details.status === 'number' ? details.status : 0
        const message = this.getOsmErrorMessage(cause)
        let code = this.getFailureCode(stage, status, cause)
        let recoveryAction = this.getRecoveryAction(stage, status, cause)
        if (this.isClosedChangesetError(details, changesetId)) {
            this.dependencies.invalidateChangeset()
            code = 'changesetClosed'
            recoveryAction = 'createChangeset'
        }
        if (extras.nodeReferenced) {
            code = 'nodeStillReferenced'
            recoveryAction = 'retry'
        }
        const feature = this.getFailedFeature(stage, status, message, cause)
        const canRetry =
            recoveryAction !== 'inspectServer' &&
            recoveryAction !== 'resumeReconciliation' &&
            recoveryAction !== 'reload'
        return {
            kind: 'failed',
            stage,
            error: {
                status,
                code,
                technicalMessage: message,
                ...(changesetId ? { changesetId } : {}),
                feature,
                queuePreserved: true,
                canClose: true,
                canRetry,
                recoveryAction,
                ...(extras.verification
                    ? { verification: extras.verification }
                    : {}),
                ...(extras.notAppliedConfirmed
                    ? { notAppliedConfirmed: true as const }
                    : {}),
                ...(extras.confirmationCheckAfter
                    ? { confirmationCheckAfter: extras.confirmationCheckAfter }
                    : {}),
            },
        }
    }

    private getFailureCode(
        stage: UploadFailureStage,
        status: number,
        cause: unknown
    ): UploadFailureCode {
        if (cause instanceof CodedUploadError) return cause.code
        if (cause instanceof OsmStateConflictError) return 'staleState'
        if (cause instanceof UploadValidationError) return 'invalidQueue'
        if (status === 401) return 'authentication'
        if (status === 403) return 'forbidden'
        if (stage === 'validation') {
            return this.getOsmErrorMessage(cause).includes('no local changes')
                ? 'emptyQueue'
                : 'invalidQueue'
        }
        if (stage === 'connection') return 'connection'
        if (stage === 'changeset') return 'changeset'
        if (stage === 'journal') return 'journal'
        if (stage === 'upload') {
            if (!this.isDefinitiveUploadRejection(cause)) {
                return 'uploadUncertain'
            }
            return status === 409 &&
                /Version mismatch/.test(this.getOsmErrorMessage(cause))
                ? 'versionConflict'
                : 'uploadRejected'
        }
        if (stage === 'reconciliation') return 'reconciliation'
        return 'unknown'
    }

    private getRecoveryAction(
        stage: UploadFailureStage,
        status: number,
        cause: unknown
    ): UploadRecoveryAction {
        if (cause instanceof OsmStateConflictError) return 'reload'
        if (cause instanceof CodedUploadError) {
            switch (cause.code) {
                case 'receiptNotSaved':
                    return 'resumeReconciliation'
                case 'commentTooLong':
                case 'uploadElsewhere':
                case 'localChange':
                    return 'retry'
                default:
                    break
            }
        }
        if (status === 401) return 'reauthenticate'
        if (status === 403) return 'checkAccount'
        if (stage === 'validation') return 'editQueue'
        if (stage === 'connection') return 'reconnect'
        if (stage === 'upload') {
            return this.isDefinitiveUploadRejection(cause)
                ? 'editQueue'
                : 'inspectServer'
        }
        if (stage === 'reconciliation') return 'resumeReconciliation'
        return 'retry'
    }

    private getFailedFeature(
        stage: UploadFailureStage,
        status: number,
        message: string,
        cause: unknown
    ): UploadFeature | null {
        let resultId: string | undefined
        if (cause instanceof UploadValidationError) {
            resultId = cause.featureId
        } else if (cause instanceof CodedUploadError) {
            resultId = cause.featureId
        } else if (stage === 'upload') {
            resultId = this.getObjectIdFromErrorMessage(status, message)
        }
        return resultId
            ? (this.dependencies
                  .getPendingFeatures()
                  .find((feature) => feature.id === resultId) ?? null)
            : null
    }

    /** The object an OSM rejection is about, as `type/id`. */
    private getObjectIdFromErrorMessage(
        status: number,
        message: string
    ): string | undefined {
        if (status === 410) {
            const result = message.match(
                /(node|way|relation)\swith\sthe\sid\s(-?\d+)/i
            )
            return result
                ? `${result[1].toLowerCase()}/${result[2]}`
                : undefined
        }
        if (
            status === 409 ||
            status === 400 ||
            status === 404 ||
            status === 412
        ) {
            const patterns = [
                /of (Node|Way|Relation) (-?\d+)\b/i,
                /\b(Node|Way|Relation) (-?\d+)\b/i,
                /\b(node|way|relation)\/(-?\d+)\b/i,
            ]
            for (const pattern of patterns) {
                const result = message.match(pattern)
                if (result) return `${result[1].toLowerCase()}/${result[2]}`
            }
        }
        return undefined
    }

    private getSummary(features: UploadFeature[]): UploadSummary {
        const summary = emptySummary()
        for (const feature of features) {
            const changeType = feature.properties.changeType
            if (
                changeType === 'Create' ||
                changeType === 'Update' ||
                changeType === 'Delete'
            ) {
                summary[changeType]++
            }
            summary.Total++
        }
        return summary
    }

    private getOsmRequestError(error: unknown): OsmRequestError {
        return typeof error === 'object' && error !== null
            ? (error as OsmRequestError)
            : {}
    }

    private getOsmErrorMessage(error: unknown): string {
        const details = this.getOsmRequestError(error)
        if (typeof error === 'string' && error.trim()) return error
        if (typeof details.error === 'string' && details.error.trim()) {
            return details.error
        }
        if (typeof details.message === 'string' && details.message.trim()) {
            return details.message
        }
        if (error instanceof Error && error.message.trim()) return error.message
        return 'OpenStreetMap could not process the request.'
    }

    private isClosedChangesetError(
        details: OsmRequestError,
        changesetId: string
    ): boolean {
        if (details.status !== 409 || typeof details.error !== 'string') {
            return false
        }
        const match = details.error
            .trim()
            .match(/^The changeset (\d+) was closed at .+\.?$/)
        return match?.[1] === changesetId
    }

    /**
     * A request OpenStreetMap answered with an error it explains is known not
     * to have changed anything: the upload is transactional. A bare status, an
     * empty body or an HTML page (a proxy, a gateway) proves nothing.
     */
    private isDefinitiveUploadRejection(error: unknown): boolean {
        const details = this.getOsmRequestError(error)
        if (details.status === 401 || details.status === 403) return true
        if (typeof details.error !== 'string') return false
        const message = details.error.trim()
        if (details.status === 409) {
            return (
                /^The changeset \d+ was closed at .+\.?$/.test(message) ||
                /Version mismatch: .+ of (Node|Way|Relation) \d+$/.test(message)
            )
        }
        if (details.status === 410) {
            return /(node|way|relation) with the id \d+/i.test(message)
        }
        if (
            details.status === 400 ||
            details.status === 404 ||
            details.status === 412
        ) {
            return (
                message !== '' &&
                !/^\s*<(!doctype|html|head|body)/i.test(message)
            )
        }
        return false
    }

    private transition(next: UploadState): void {
        const current = this.stateSignal().kind
        const allowed: Record<UploadState['kind'], UploadState['kind'][]> = {
            idle: ['validating', 'receiptReceived', 'verifying', 'failed'],
            validating: ['creatingChangeset', 'failed'],
            creatingChangeset: ['uploading', 'failed'],
            uploading: [
                'creatingChangeset',
                'verifying',
                'receiptReceived',
                'failed',
            ],
            verifying: ['receiptReceived', 'failed'],
            receiptReceived: ['reconciling', 'failed'],
            reconciling: ['succeeded', 'failed'],
            succeeded: ['idle', 'validating'],
            failed: ['idle', 'validating', 'verifying'],
        }
        if (!allowed[current].includes(next.kind)) {
            throw new Error(
                `Invalid upload transition: ${current} -> ${next.kind}`
            )
        }
        this.stateSignal.set(next)
        this.dependencies.onTransition?.(next)
    }
}

interface FailureExtras {
    verification?: UploadVerificationStatus
    notAppliedConfirmed?: boolean
    confirmationCheckAfter?: string
    nodeReferenced?: boolean
}

@Service()
export class UploadCoordinatorService {
    private readonly dataService = inject(DataService)
    private readonly osmApi = inject(OsmApiService)
    private readonly configService = inject(ConfigService)
    private readonly mapService = inject(MapService)
    private readonly tagsService = inject(TagsService)
    private readonly coordinator = new UploadCoordinator({
        getPendingFeatures: () => this.dataService.getGeojsonChanged().features,
        getUserDetail$: () => this.osmApi.getUserDetail$(true),
        getValidChangeset: (comment, bbox) =>
            this.osmApi.getValidChangeset(comment, bbox),
        serializeDiff: (features, changesetId) =>
            this.osmApi.osmGoFeaturesToOsmDiffFile(features, changesetId),
        uploadDiff: (diff, changesetId) =>
            this.osmApi.apiOsmSendOsmDiffFileRaw$(diff, changesetId),
        parseReceipt: (text) => this.osmApi.convertDiffFileResult(text),
        downloadChangeset: (changesetId) =>
            this.osmApi.downloadChangeset$(changesetId),
        isKnownFeatureId: (id) => this.dataService.isKnownFeatureId(id),
        getUploadJournal: () => this.dataService.getUploadJournal(),
        beginUploadAttempt: (journal) =>
            this.dataService.beginUploadAttempt(journal),
        acknowledgeUploadAttempt: (attemptId, rawReceipt, acknowledgedAt) =>
            this.dataService.acknowledgeUploadAttempt(
                attemptId,
                rawReceipt,
                acknowledgedAt
            ),
        applyAcknowledgedReceipt: (attemptId, receipt, appliedAt) =>
            this.dataService.applyAcknowledgedUploadReceipt(
                attemptId,
                receipt,
                appliedAt
            ),
        clearAppliedUploadAttempt: (attemptId) =>
            this.dataService.clearAppliedUploadAttempt(attemptId),
        discardPreparedUploadAttempt: (attemptId) =>
            this.dataService.discardPreparedUploadAttempt(attemptId),
        abandonUploadAttempt: (attemptId, options) =>
            this.dataService.abandonUploadAttempt(attemptId, options),
        markNodeReferenced: (id, references) =>
            this.dataService.markPendingNodeReferenced(id, references),
        acquireUploadLock: () => tryAcquireWebLock('osmgo-upload'),
        getUserInfo: () => this.configService.getUserInfo(),
        setChangesetComment: (comment) =>
            this.configService.setChangeSetComment(comment),
        updateChangesetLastActivity: () =>
            this.configService.updateChangesetLastActivity(),
        invalidateChangeset: () => this.configService.invalidateChangeset(),
        styleFeature: (feature) => this.mapService.getIconStyle(feature),
        setProcessing: (processing) => {
            this.mapService.setIsProcessing(processing)
            this.dataService.setUploadInFlight(processing)
        },
        redraw: () => {
            this.mapService.redrawMarkers(this.dataService.getGeojson())
            this.mapService.redrawChangedMarkers(
                this.dataService.getGeojsonChanged()
            )
        },
        createAttemptId,
        hashPayload: hashUploadPayload,
        now: () => new Date(),
    })

    readonly state = this.coordinator.state
    readonly inFlight = this.coordinator.inFlight

    start(comment: string): Promise<UploadState> {
        return this.coordinator.start(comment)
    }

    recoverJournal(): Promise<UploadState> {
        return this.coordinator.recoverJournal()
    }

    resumeReconciliation(): Promise<UploadState> {
        return this.coordinator.resumeReconciliation()
    }

    /** Checks on OpenStreetMap whether a prepared attempt was applied. */
    verifyPreparedAttempt(): Promise<UploadState> {
        return this.coordinator.verifyPreparedAttempt()
    }

    discardPreparedAttemptAsNotApplied(): Promise<UploadState> {
        return this.coordinator.discardPreparedAttemptAsNotApplied()
    }

    /** Drops an acknowledged attempt that cannot be reconciled. */
    markAcknowledgedAttemptAsApplied(): Promise<UploadState> {
        return this.coordinator.markAcknowledgedAttemptAsApplied()
    }

    /** Drops a prepared attempt that the changeset holds only in part. */
    markPartialAttemptAsApplied(): Promise<UploadState> {
        return this.coordinator.markPartialAttemptAsApplied()
    }

    getUnsavedReceipt():
        | { attemptId: string; rawReceipt: unknown }
        | undefined {
        return this.coordinator.getUnsavedReceipt()
    }

    resetTerminalState(): void {
        this.coordinator.resetTerminalState()
    }

    /**
     * Re-applies a pending edit that lost a version conflict on top of the
     * current OpenStreetMap version. Nothing is changed when tags or position
     * overlap, or when the nodes or members of the object changed.
     */
    async rebasePendingFeature(id: string): Promise<RebaseOutcome> {
        const pending = this.dataService.getFeatureById(id, 'data_changed')
        if (!pending) return { kind: 'unsupported' }
        let remote: OsmApiObject
        try {
            remote = await firstValueFrom(this.osmApi.getOsmObjectById$(id))
        } catch (error) {
            if ((error as { status?: unknown })?.status === 410) {
                return { kind: 'gone' }
            }
            throw error
        }
        const outcome = rebaseOnRemote(pending, remote, (feature) =>
            this.refreshDerivedData(feature)
        )
        if (outcome.kind === 'rebased') {
            await this.dataService.rebasePendingFeature(id, outcome.feature)
            this.redrawMarkers()
        }
        return outcome
    }

    private redrawMarkers(): void {
        this.mapService.redrawMarkers(this.dataService.getGeojson())
        this.mapService.redrawChangedMarkers(
            this.dataService.getGeojsonChanged()
        )
    }

    private refreshDerivedData(feature: OsmGoFeature): OsmGoFeature {
        const tags = feature.properties.tags
        const primary = feature.properties.primaryTag
        if (tags[primary.key] !== undefined) {
            primary.value = tags[primary.key]
        } else {
            const key = this.tagsService
                .primaryKeys()
                .find((candidate) => tags[candidate] !== undefined)
            if (key) feature.properties.primaryTag = { key, value: tags[key] }
        }
        addAttributesToFeature(feature)
        return this.mapService.getIconStyle(feature)
    }
}
