import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { TranslateService } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmAuthService } from '@services/osm-auth.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { TagsService } from '@services/tags.service'
import {
    UploadCoordinatorService,
    type UploadFailure,
    type UploadFeature,
    type UploadState,
} from '@services/upload-coordinator.service'
import type { Geometry } from 'geojson'
import { of, throwError } from 'rxjs'

import {
    NATIVE_FILE_EXPORT,
    type NativeFileExport,
    PushDataToOsmPage,
    UPLOAD_SUCCESS_DELAY_MS,
} from './pushDataToOsm'

const queuedFeature = (
    changeType: 'Create' | 'Update' | 'Delete' = 'Create',
    id = -1
): UploadFeature => ({
    type: 'Feature',
    id: `node/${id}`,
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: {
        id,
        type: 'node',
        changeType,
        tags: { amenity: 'bench' },
        meta: {
            version: changeType === 'Create' ? 0 : 3,
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

const uploadFailure = (
    message: string,
    feature: UploadFeature | null = null,
    stage: 'connection' | 'upload' = 'upload'
): Extract<UploadState, { kind: 'failed' }> => ({
    kind: 'failed',
    stage,
    error: {
        status: 409,
        code: stage === 'connection' ? 'connection' : 'uploadUncertain',
        technicalMessage: message,
        feature,
        queuePreserved: true,
        canClose: true,
        canRetry: stage === 'connection',
        recoveryAction: stage === 'connection' ? 'reconnect' : 'inspectServer',
    },
})

interface PageHarnessOptions {
    features?: UploadFeature[]
    state?: UploadState
    start?: (comment: string) => Promise<UploadState>
    inFlight?: boolean
    dataService?: Record<string, unknown>
    mapService?: Record<string, unknown>
    configService?: Record<string, unknown>
    coordinator?: Record<string, unknown>
    login?: () => unknown
    confirm?: boolean
    close?: () => Promise<unknown>
    nativeFileExport?: NativeFileExport
}

const createPage = (options: PageHarnessOptions = {}) => {
    let features = options.features ?? []
    const stateSignal = signal<UploadState>(options.state ?? { kind: 'idle' })
    const inFlightSignal = signal(options.inFlight ?? false)
    const resetTerminalState = vi.fn(() => stateSignal.set({ kind: 'idle' }))
    const start = vi.fn(
        options.start ??
            (async () => {
                const state: UploadState = {
                    kind: 'succeeded',
                    summary: { Total: 0, Create: 0, Update: 0, Delete: 0 },
                }
                stateSignal.set(state)
                return state
            })
    )
    const changed = signal<UploadFeature[]>(features)
    const setFeatures = (next: UploadFeature[]) => {
        features = next
        changed.set(next)
    }
    const dataService = {
        changedFeatures: changed.asReadonly(),
        quarantinedCount: signal(0),
        externalStateChange: signal(false),
        getQuarantinedFeatures: vi.fn(async () => []),
        getStateBackups: vi.fn(async (): Promise<unknown[]> => []),
        clearQuarantine: vi.fn(async () => undefined),
        getGeojsonChanged: vi.fn(() => ({
            type: 'FeatureCollection',
            features,
        })),
        getGeojson: vi.fn(() => ({ type: 'FeatureCollection', features: [] })),
        getUploadJournal: vi.fn(() => undefined),
        cancelPendingChange: vi.fn(async (id: string) => {
            setFeatures(features.filter((feature) => feature.id !== id))
        }),
        cancelAllPendingChanges: vi.fn(async () => {
            setFeatures([])
        }),
        ...options.dataService,
    }
    const map = {
        getZoom: vi.fn(() => 16),
        setZoom: vi.fn(),
        setCenter: vi.fn(),
        fitBounds: vi.fn(),
    }
    const mapService = {
        map,
        focusOn: vi.fn(),
        redrawMarkers: vi.fn(),
        redrawChangedMarkers: vi.fn(),
        ...options.mapService,
    }
    const close = vi.fn(options.close ?? (async () => true))
    const coordinator = {
        state: stateSignal.asReadonly(),
        inFlight: inFlightSignal.asReadonly(),
        start,
        resetTerminalState,
        getUnsavedReceipt: vi.fn(() => undefined),
        verifyPreparedAttempt: vi.fn(async () => stateSignal()),
        rebasePendingFeature: vi.fn(async () => ({ kind: 'upToDate' })),
        markAcknowledgedAttemptAsApplied: vi.fn(async () => stateSignal()),
        markPartialAttemptAsApplied: vi.fn(async () => stateSignal()),
        discardPreparedAttemptAsNotApplied: vi.fn(async () => stateSignal()),
        ...options.coordinator,
    }
    const configService = {
        getChangeSetComment: vi.fn(() => ''),
        setChangeSetComment: vi.fn(),
        config: signal({ isDevServer: false }),
        userInfo: signal({ connected: true }),
        ...options.configService,
    }
    const dialogOpen = vi.fn(() => ({
        afterClosed: () => of(options.confirm ?? true),
    }))
    const snackBarOpen = vi.fn()
    const instant = vi.fn((key: string, _params?: unknown) => key)
    const osmAuth = {
        login: vi.fn(options.login ?? (() => of(undefined))),
    }

    TestBed.resetTestingModule()
    TestBed.configureTestingModule({
        providers: [
            { provide: DataService, useValue: dataService },
            { provide: MapService, useValue: mapService },
            { provide: TagsService, useValue: {} },
            { provide: ConfigService, useValue: configService },
            { provide: OsmAuthService, useValue: osmAuth },
            { provide: UploadCoordinatorService, useValue: coordinator },
            { provide: OverlayNavigationService, useValue: { close } },
            { provide: MatDialog, useValue: { open: dialogOpen } },
            { provide: MatSnackBar, useValue: { open: snackBarOpen } },
            {
                provide: TranslateService,
                useValue: { instant },
            },
            { provide: UPLOAD_SUCCESS_DELAY_MS, useValue: 0 },
            {
                provide: NATIVE_FILE_EXPORT,
                useValue: options.nativeFileExport ?? {
                    isNativePlatform: () => false,
                    filesystem: { writeFile: vi.fn() },
                    share: { share: vi.fn() },
                },
            },
        ],
    })
    const page = TestBed.runInInjectionContext(() => new PushDataToOsmPage())
    return {
        page,
        stateSignal,
        inFlightSignal,
        coordinator,
        dataService,
        mapService,
        configService,
        osmAuth,
        dialogOpen,
        snackBarOpen,
        instant,
        setFeatures,
        map,
        close,
    }
}

describe('PushDataToOsmPage', () => {
    it('summarizes and refreshes the pending queue', () => {
        const features = [
            queuedFeature('Create', -1),
            queuedFeature('Update', 2),
            queuedFeature('Delete', 3),
        ]
        const { page } = createPage({ features })

        expect(page.getSummary()).toEqual({
            Total: 3,
            Create: 1,
            Update: 1,
            Delete: 1,
        })
        expect(page.featuresChanges()).toEqual(features)
    })

    it('cannot close the overlay while the coordinator is active', () => {
        const { page, close } = createPage({ inFlight: true })

        page.back()

        expect(page.canCloseOverlay()).toBe(false)
        expect(close).not.toHaveBeenCalled()
    })

    it('closes without touching the pending queue when cancelled', () => {
        const { page, dataService, close } = createPage({
            features: [queuedFeature()],
        })

        page.back()

        expect(close).toHaveBeenCalledOnce()
        expect(dataService.cancelAllPendingChanges).not.toHaveBeenCalled()
    })

    it('delegates upload and closes exactly once after success', async () => {
        const feature = queuedFeature()
        const { page, stateSignal, coordinator, close } = createPage({
            features: [feature],
            start: async () => {
                const state: UploadState = {
                    kind: 'succeeded',
                    summary: { Total: 1, Create: 1, Update: 0, Delete: 0 },
                }
                stateSignal.set(state)
                return state
            },
        })

        await page.pushDataToOsm('Survey')
        page.back()

        expect(coordinator.start).toHaveBeenCalledWith('Survey')
        expect(page.uploadStatusVisible()).toBe(false)
        expect(page.uploadedOk()).toBe(true)
        expect(close).toHaveBeenCalledOnce()
    })

    it('does not cancel the coordinator or navigate after component destruction', async () => {
        let finishUpload!: (state: UploadState) => void
        const upload = new Promise<UploadState>((resolve) => {
            finishUpload = resolve
        })
        const { page, stateSignal, coordinator, close } = createPage({
            start: () => upload,
        })

        const pending = page.pushDataToOsm('Survey')
        page.ngOnDestroy()
        const succeeded: UploadState = {
            kind: 'succeeded',
            summary: { Total: 1, Create: 1, Update: 0, Delete: 0 },
        }
        stateSignal.set(succeeded)
        finishUpload(succeeded)
        await pending

        expect(coordinator.start).toHaveBeenCalledOnce()
        expect(close).not.toHaveBeenCalled()
    })

    it('shows a coordinator failure and marks its affected feature', async () => {
        const feature = queuedFeature('Update', 12)
        const failed = uploadFailure('Version conflict', feature)
        const { page, stateSignal } = createPage({
            features: [feature],
            start: async () => {
                stateSignal.set(failed)
                return failed
            },
        })

        await page.pushDataToOsm('Survey')

        expect(page.error()).toEqual(failed.error)
        expect(page.featuresChanges()[0]).toMatchObject({
            id: 'node/12',
            error: 'SEND_DATA.ERRORS.UPLOAD_UNCERTAIN',
        })
        expect(page.uploadStatusVisible()).toBe(false)
    })

    it('exposes connection failures separately to the view', () => {
        const failed = uploadFailure('Network unavailable', null, 'connection')
        const { page } = createPage({ state: failed })

        expect(page.connectionError()).toBe('SEND_DATA.ERRORS.CONNECTION')
        expect(page.error()).toEqual(failed.error)
    })

    it('exposes localized recovery action, queue, and changeset context', () => {
        const failed = uploadFailure('raw server diagnostic')
        failed.error.changesetId = '456'
        const { page } = createPage({
            features: [queuedFeature(), queuedFeature('Update', 2)],
            state: failed,
            dataService: {
                getUploadJournal: () => ({
                    changesetId: '456',
                    submittedIds: ['node/-1', 'node/2'],
                }),
            },
        })

        expect(page.failureMessageKey(failed.error.code)).toBe(
            'SEND_DATA.ERRORS.UPLOAD_UNCERTAIN'
        )
        expect(page.recoveryActionKey(failed.error.recoveryAction)).toBe(
            'SEND_DATA.RECOVERY.ACTIONS.INSPECT_SERVER'
        )
        expect(page.recoveryQueueCount()).toBe(2)
        expect(page.changesetInspectionUrl()).toBe(
            'https://www.openstreetmap.org/changeset/456'
        )
    })

    it('cancels one failed change atomically and refreshes both layers', async () => {
        const feature = queuedFeature()
        const { page, dataService, mapService, coordinator } = createPage({
            features: [feature],
            state: uploadFailure('Rejected', feature),
        })

        await page.cancelErrorFeature(feature)

        expect(dataService.cancelPendingChange).toHaveBeenCalledWith('node/-1')
        expect(page.featuresChanges()).toEqual([])
        expect(mapService.redrawMarkers).toHaveBeenCalledOnce()
        expect(mapService.redrawChangedMarkers).toHaveBeenCalledOnce()
        expect(coordinator.resetTerminalState).toHaveBeenCalledOnce()
    })

    it('cancels all pending changes before closing', async () => {
        const { page, dataService, coordinator, close } = createPage({
            features: [queuedFeature()],
        })

        await page.cancelAllFeatures()

        expect(dataService.cancelAllPendingChanges).toHaveBeenCalledOnce()
        expect(page.summary().Total).toBe(0)
        expect(coordinator.resetTerminalState).toHaveBeenCalledOnce()
        expect(close).toHaveBeenCalledOnce()
    })

    it('centers and zooms a point before closing', () => {
        const { page, mapService, close } = createPage()

        page.centerToElement({ type: 'Point', coordinates: [2.3, 48.8] })

        expect(mapService.focusOn).toHaveBeenCalledExactlyOnceWith({
            center: [2.3, 48.8],
            zoom: 18.5,
        })
        expect(close).toHaveBeenCalledOnce()
    })

    it('keeps a closer zoom when centering a point', () => {
        const { page, mapService, map } = createPage()
        map.getZoom.mockReturnValue(20)

        page.centerToElement({ type: 'Point', coordinates: [2.3, 48.8] })

        expect(mapService.focusOn).toHaveBeenCalledWith({
            center: [2.3, 48.8],
            zoom: 20,
        })
    })

    it.each([
        [
            'LineString',
            {
                type: 'LineString',
                coordinates: [
                    [2.1, 48.7],
                    [2.4, 48.9],
                    [2.2, 48.6],
                ],
            },
            [
                [2.1, 48.6],
                [2.4, 48.9],
            ],
        ],
        [
            'MultiPolygon',
            {
                type: 'MultiPolygon',
                coordinates: [
                    [
                        [
                            [1, 4],
                            [3, 2],
                            [1, 4],
                        ],
                    ],
                    [
                        [
                            [-1, 5],
                            [2, 1],
                            [-1, 5],
                        ],
                    ],
                ],
            },
            [
                [-1, 1],
                [3, 5],
            ],
        ],
    ])('fits the complete %s geometry', (_name, geometry, bounds) => {
        const { page, mapService, close } = createPage()

        page.centerToElement(geometry as Geometry)

        expect(mapService.focusOn).toHaveBeenCalledExactlyOnceWith({
            bounds,
            padding: 48,
        })
        expect(close).toHaveBeenCalledOnce()
    })

    it('tells how many objects deleting every change loses', async () => {
        const { page, dialogOpen, dataService, instant } = createPage({
            features: [
                queuedFeature('Create', -1),
                queuedFeature('Create', -2),
            ],
            confirm: false,
        })

        page.presentConfirm()
        await Promise.resolve()

        expect(instant).toHaveBeenCalledWith(
            'SEND_DATA.DELETE_CONFIRM_MESSAGE',
            { count: 2 }
        )
        const [, config] = dialogOpen.mock.calls[0] as unknown as [
            unknown,
            { data: Record<string, unknown> },
        ]
        expect(config.data).toMatchObject({
            message: 'SEND_DATA.DELETE_CONFIRM_MESSAGE',
            destructive: true,
        })
        expect(dataService.cancelAllPendingChanges).not.toHaveBeenCalled()
    })

    describe('reactive queue', () => {
        it('follows the pending queue without being asked to refresh', () => {
            const { page, setFeatures } = createPage({
                features: [queuedFeature('Create', -1)],
            })
            expect(page.featuresChanges()).toHaveLength(1)

            setFeatures([
                queuedFeature('Create', -1),
                queuedFeature('Update', 2),
            ])

            expect(page.featuresChanges()).toHaveLength(2)
            expect(page.summary()).toEqual({
                Total: 2,
                Create: 1,
                Update: 1,
                Delete: 0,
            })
        })

        it('recomputes the summary after cancelling a failed change', async () => {
            const feature = queuedFeature('Update', 12)
            const { page } = createPage({
                features: [feature, queuedFeature('Create', -1)],
                state: uploadFailure('Rejected', feature),
            })
            expect(page.summary().Total).toBe(2)

            await page.cancelErrorFeature(feature)

            expect(page.summary()).toEqual({
                Total: 1,
                Create: 1,
                Update: 0,
                Delete: 0,
            })
        })

        it('marks the invalid object of a rejected queue', async () => {
            const invalid = queuedFeature('Create', -2)
            const failed: Extract<UploadState, { kind: 'failed' }> = {
                kind: 'failed',
                stage: 'validation',
                error: {
                    status: 0,
                    code: 'invalidQueue',
                    technicalMessage: 'The local OSM upload queue is invalid',
                    feature: invalid,
                    queuePreserved: true,
                    canClose: true,
                    canRetry: true,
                    recoveryAction: 'editQueue',
                },
            }
            const { page, stateSignal } = createPage({
                features: [queuedFeature('Create', -1), invalid],
                start: async () => {
                    stateSignal.set(failed)
                    return failed
                },
            })

            await page.pushDataToOsm('Survey')

            expect(page.featuresChanges()[0]).toMatchObject({
                id: 'node/-2',
                error: 'SEND_DATA.ERRORS.INVALID_QUEUE',
            })
        })
    })

    describe('sign-in from the upload screen', () => {
        it('starts the sign-in flow of the menu', () => {
            const { page, osmAuth } = createPage()

            page.login()

            expect(osmAuth.login).toHaveBeenCalledOnce()
        })

        it('tells the user when the sign-in cannot start', () => {
            vi.spyOn(console, 'error').mockReturnValue(undefined)
            const { page, snackBarOpen } = createPage({
                login: () => throwError(() => new Error('browser unavailable')),
            })

            page.login()

            expect(snackBarOpen).toHaveBeenCalledWith(
                'SEND_DATA.ERRORS.LOGIN_FAILED',
                'SHARED.CLOSE',
                expect.anything()
            )
        })

        it('keeps the typed comment when the sign-in leaves the page', () => {
            const { page, configService } = createPage()
            page.commentChangeset.set('Typed before signing in')

            page.login()

            expect(configService.setChangeSetComment).toHaveBeenCalledWith(
                'Typed before signing in'
            )
        })
    })

    describe('changeset comment', () => {
        it('survives centering the map on an object', () => {
            const { page, configService } = createPage()
            page.commentChangeset.set('Survey of the market')

            page.centerToElement({ type: 'Point', coordinates: [2.3, 48.8] })

            expect(configService.setChangeSetComment).toHaveBeenCalledWith(
                'Survey of the market'
            )
        })

        it('is saved when the screen is closed without uploading', () => {
            const { page, configService } = createPage()
            page.commentChangeset.set('Draft')

            page.ngOnDestroy()

            expect(configService.setChangeSetComment).toHaveBeenCalledWith(
                'Draft'
            )
        })

        it('does not rewrite an unchanged comment', () => {
            const { page, configService } = createPage()

            page.ngOnDestroy()

            expect(configService.setChangeSetComment).not.toHaveBeenCalled()
        })

        it('limits the comment to what OpenStreetMap accepts', () => {
            const { page } = createPage()

            expect(page.maxCommentLength).toBe(255)
        })
    })

    describe('cancelling one change', () => {
        it.each([
            ['Create', 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_CREATED'],
            ['Delete', 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_DELETED'],
            ['Update', 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE'],
        ] as const)(
            'asks before discarding a %s',
            async (changeType, message) => {
                const feature = queuedFeature(
                    changeType,
                    changeType === 'Create' ? -1 : 5
                )
                const { page, dialogOpen, dataService } = createPage({
                    features: [feature],
                })

                page.confirmCancelErrorFeature(feature)
                await vi.waitFor(() =>
                    expect(dataService.cancelPendingChange).toHaveBeenCalled()
                )

                const [, config] = dialogOpen.mock.calls[0] as unknown as [
                    unknown,
                    { data: Record<string, unknown> },
                ]
                expect(config.data).toMatchObject({
                    title: 'MAIN.SELECTION.REVERT_LOCAL_TITLE',
                    message,
                    confirmLabel: 'MAIN.SELECTION.REVERT_LOCAL',
                    destructive: true,
                })
            }
        )

        it('keeps the change when the user backs out', async () => {
            const feature = queuedFeature('Update', 5)
            const { page, dialogOpen, dataService } = createPage({
                features: [feature],
                confirm: false,
            })

            page.confirmCancelErrorFeature(feature)
            await vi.waitFor(() => expect(dialogOpen).toHaveBeenCalled())
            await Promise.resolve()

            expect(dataService.cancelPendingChange).not.toHaveBeenCalled()
        })
    })

    describe('version conflicts', () => {
        const conflictFailure = (feature: UploadFeature) =>
            ({
                kind: 'failed',
                stage: 'upload',
                error: {
                    status: 409,
                    code: 'versionConflict',
                    technicalMessage: 'Version mismatch',
                    feature,
                    queuePreserved: true,
                    canClose: true,
                    canRetry: true,
                    recoveryAction: 'editQueue',
                },
            }) as const

        it('offers to reapply a modified object on the current version', () => {
            const feature = queuedFeature('Update', 12)
            const { page } = createPage({
                features: [feature],
                state: conflictFailure(feature),
            })

            expect(page.canRebase()).toBe(true)
        })

        it('does not offer it for a created object or another failure', () => {
            const created = queuedFeature('Create', -1)
            const { page } = createPage({
                features: [created],
                state: conflictFailure(created),
            })
            const other = createPage({
                features: [queuedFeature('Update', 12)],
                state: uploadFailure('Gateway', queuedFeature('Update', 12)),
            })

            expect(page.canRebase()).toBe(false)
            expect(other.page.canRebase()).toBe(false)
        })

        it('clears the error and invites a new upload once the change is rebased', async () => {
            const feature = queuedFeature('Update', 12)
            const { page, coordinator, snackBarOpen, mapService } = createPage({
                features: [feature],
                state: conflictFailure(feature),
                coordinator: {
                    rebasePendingFeature: vi.fn(async () => ({
                        kind: 'rebased',
                        feature,
                        adoptedRemoteKeys: [],
                    })),
                },
            })

            await page.rebaseErrorFeature(feature)

            expect(coordinator.rebasePendingFeature).toHaveBeenCalledWith(
                'node/12'
            )
            expect(coordinator.resetTerminalState).toHaveBeenCalledOnce()
            expect(mapService.redrawChangedMarkers).toHaveBeenCalled()
            expect(snackBarOpen).toHaveBeenCalledWith(
                'SEND_DATA.REBASE_DONE',
                'SHARED.CLOSE',
                expect.anything()
            )
            expect(page.rebaseConflict()).toBeUndefined()
        })

        it('lists the overlapping tags and keeps the error when it cannot merge', async () => {
            const feature = queuedFeature('Update', 12)
            const { page, coordinator } = createPage({
                features: [feature],
                state: conflictFailure(feature),
                coordinator: {
                    rebasePendingFeature: vi.fn(async () => ({
                        kind: 'conflict',
                        conflicts: [{ key: 'name' }, { key: 'phone' }],
                        position: true,
                        structure: false,
                    })),
                },
            })

            await page.rebaseErrorFeature(feature)

            expect(page.rebaseConflict()).toEqual({
                keys: ['name', 'phone'],
                position: true,
                structure: false,
            })
            expect(coordinator.resetTerminalState).not.toHaveBeenCalled()
            expect(page.rebasing()).toBe(false)
        })

        it('reports an object deleted on OpenStreetMap and a failed fetch', async () => {
            const feature = queuedFeature('Update', 12)
            const gone = createPage({
                features: [feature],
                coordinator: {
                    rebasePendingFeature: vi.fn(async () => ({ kind: 'gone' })),
                },
            })
            vi.spyOn(console, 'error').mockReturnValue(undefined)
            const failing = createPage({
                features: [feature],
                coordinator: {
                    rebasePendingFeature: vi.fn(async () => {
                        throw new Error('offline')
                    }),
                },
            })

            await gone.page.rebaseErrorFeature(feature)
            await failing.page.rebaseErrorFeature(feature)

            expect(gone.snackBarOpen).toHaveBeenCalledWith(
                'SEND_DATA.REBASE_GONE',
                'SHARED.CLOSE',
                expect.anything()
            )
            expect(failing.snackBarOpen).toHaveBeenCalledWith(
                'SEND_DATA.REBASE_FAILED',
                'SHARED.CLOSE',
                expect.anything()
            )
            expect(failing.page.rebasing()).toBe(false)
        })
    })

    describe('lost upload answers', () => {
        const preparedJournal = {
            phase: 'prepared',
            attemptId: 'attempt-1',
            changesetId: '456',
            submittedIds: ['node/-1'],
        }
        const recoveryFailure = (
            overrides: Partial<UploadFailure> = {}
        ): Extract<UploadState, { kind: 'failed' }> => {
            const base = uploadFailure('Timeout')
            return {
                ...base,
                error: {
                    ...base.error,
                    code: 'uploadUncertain',
                    status: 0,
                    ...overrides,
                },
            }
        }

        it('checks the changeset by itself after a restart', async () => {
            const { page, coordinator } = createPage({
                features: [queuedFeature('Create', -1)],
                state: recoveryFailure({ code: 'recoveryRequired' }),
                dataService: { getUploadJournal: () => preparedJournal },
            })

            page.ngAfterViewInit()
            await vi.waitFor(() =>
                expect(coordinator.verifyPreparedAttempt).toHaveBeenCalled()
            )

            expect(page.uploadStatusVisible()).toBe(false)
        })

        it('does not check twice, nor when a result is already known', () => {
            const known = createPage({
                features: [queuedFeature('Create', -1)],
                state: recoveryFailure({ verification: 'notFound' }),
                dataService: { getUploadJournal: () => preparedJournal },
            })
            const none = createPage({
                features: [queuedFeature('Create', -1)],
            })

            known.page.ngAfterViewInit()
            none.page.ngAfterViewInit()

            expect(
                known.coordinator.verifyPreparedAttempt
            ).not.toHaveBeenCalled()
            expect(
                none.coordinator.verifyPreparedAttempt
            ).not.toHaveBeenCalled()
        })

        it.each([
            [undefined, undefined, false],
            ['notFound', undefined, false],
            ['notFound', true, true],
            ['unavailable', undefined, false],
            ['partial', undefined, false],
        ] as const)(
            'offers "not applied" for a check result of %s (late check: %s): %s',
            (verification, notAppliedConfirmed, offered) => {
                const { page } = createPage({
                    state: recoveryFailure({
                        verification,
                        ...(notAppliedConfirmed ? { notAppliedConfirmed } : {}),
                    }),
                    dataService: { getUploadJournal: () => preparedJournal },
                })

                expect(page.canMarkNotApplied()).toBe(offered)
            }
        )

        it('counts down to the check that can confirm nothing was applied', async () => {
            vi.useFakeTimers({ now: new Date('2026-08-02T10:00:00.000Z') })
            try {
                const { page } = createPage({
                    state: recoveryFailure({
                        verification: 'notFound',
                        confirmationCheckAfter: '2026-08-02T10:01:30.000Z',
                    }),
                    dataService: { getUploadJournal: () => preparedJournal },
                })

                expect(page.confirmationCountdown()).toBe(90)
                expect(page.canVerifyAgain()).toBe(true)
                await vi.advanceTimersByTimeAsync(60_000)
                expect(page.confirmationCountdown()).toBe(30)
                await vi.advanceTimersByTimeAsync(31_000)
                expect(page.confirmationCountdown()).toBe(0)
                expect(page.canMarkNotApplied()).toBe(false)
            } finally {
                vi.useRealTimers()
            }
        })

        it('offers to consider a partly found attempt applied once exported', async () => {
            const { page, coordinator } = createPage({
                state: recoveryFailure({ verification: 'partial' }),
                dataService: { getUploadJournal: () => preparedJournal },
            })
            vi.stubGlobal('URL', {
                ...URL,
                createObjectURL: () => 'blob:test',
                revokeObjectURL: vi.fn(),
            })
            vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
                () => undefined
            )
            try {
                await page.exportRecoveryBundle()
            } finally {
                vi.unstubAllGlobals()
                vi.restoreAllMocks()
            }
            expect(page.canMarkApplied()).toBe(true)

            page.markAttemptAsApplied()

            await vi.waitFor(() =>
                expect(
                    coordinator.markPartialAttemptAsApplied
                ).toHaveBeenCalledOnce()
            )
            expect(
                coordinator.markAcknowledgedAttemptAsApplied
            ).not.toHaveBeenCalled()
        })

        it('never offers "not applied" when the server already answered', () => {
            const { page } = createPage({
                state: recoveryFailure({
                    code: 'receiptNotSaved',
                    verification: 'notFound',
                }),
                dataService: { getUploadJournal: () => preparedJournal },
            })

            expect(page.canMarkNotApplied()).toBe(false)
            expect(page.canVerifyAgain()).toBe(false)
        })
    })

    describe('unreconcilable acknowledged attempt', () => {
        const acknowledgedJournal = {
            phase: 'acknowledged',
            attemptId: 'attempt-1',
            changesetId: '456',
            submittedIds: ['node/-1'],
        }
        const failed = uploadFailure('Integrity')

        it('can only be removed from the queue once the recovery data was exported', async () => {
            const { page, coordinator, dialogOpen } = createPage({
                state: failed,
                dataService: { getUploadJournal: () => acknowledgedJournal },
            })
            expect(page.canMarkApplied()).toBe(true)

            page.markAttemptAsApplied()
            await Promise.resolve()

            expect(dialogOpen).not.toHaveBeenCalled()
            expect(
                coordinator.markAcknowledgedAttemptAsApplied
            ).not.toHaveBeenCalled()
        })

        it('asks for a destructive confirmation, then removes it', async () => {
            const { page, coordinator, dialogOpen, snackBarOpen } = createPage({
                state: failed,
                dataService: { getUploadJournal: () => acknowledgedJournal },
            })
            vi.stubGlobal('URL', {
                ...URL,
                createObjectURL: () => 'blob:test',
                revokeObjectURL: vi.fn(),
            })
            try {
                await page.exportRecoveryBundle()
            } finally {
                vi.unstubAllGlobals()
            }
            expect(page.recoveryExported()).toBe(true)

            page.markAttemptAsApplied()
            await vi.waitFor(() =>
                expect(
                    coordinator.markAcknowledgedAttemptAsApplied
                ).toHaveBeenCalled()
            )

            const [, config] = dialogOpen.mock.calls[0] as unknown as [
                unknown,
                { data: Record<string, unknown> },
            ]
            expect(config.data).toMatchObject({
                title: 'SEND_DATA.MARK_APPLIED_CONFIRM_HEADER',
                destructive: true,
            })
            await vi.waitFor(() =>
                expect(snackBarOpen).toHaveBeenCalledWith(
                    'SEND_DATA.ATTEMPT_ABANDONED',
                    'SHARED.CLOSE',
                    expect.anything()
                )
            )
        })

        it('is not offered for a prepared attempt', () => {
            const { page } = createPage({
                state: failed,
                dataService: {
                    getUploadJournal: () => ({
                        ...acknowledgedJournal,
                        phase: 'prepared',
                    }),
                },
            })

            expect(page.canMarkApplied()).toBe(false)
        })
    })

    describe('exporting recovery data', () => {
        const journal = {
            phase: 'prepared',
            attemptId: 'attempt-1',
            changesetId: '456',
            submittedIds: ['node/-1'],
        }

        afterEach(() => {
            vi.useRealTimers()
            vi.unstubAllGlobals()
            vi.restoreAllMocks()
        })

        it('shares the file where the platform can share files', async () => {
            const share = vi.fn().mockResolvedValue(undefined)
            vi.stubGlobal('navigator', {
                ...navigator,
                share,
                canShare: () => true,
            })
            const { page } = createPage({
                dataService: { getUploadJournal: () => journal },
            })

            await page.exportRecoveryBundle()

            expect(share).toHaveBeenCalledOnce()
            const [{ files }] = share.mock.calls[0]
            expect(files[0].name).toBe('osmgo-upload-recovery-attempt-1.json')
            expect(page.recoveryExported()).toBe(true)
        })

        it('does not count a cancelled share sheet as an export', async () => {
            vi.stubGlobal('navigator', {
                ...navigator,
                share: vi
                    .fn()
                    .mockRejectedValue(new DOMException('', 'AbortError')),
                canShare: () => true,
            })
            const { page } = createPage({
                dataService: { getUploadJournal: () => journal },
            })

            await page.exportRecoveryBundle()

            expect(page.recoveryExported()).toBe(false)
        })

        it('falls back to a download link whose blob outlives the click', async () => {
            vi.useFakeTimers()
            const createObjectURL = vi.fn(() => 'blob:recovery')
            const revokeObjectURL = vi.fn()
            vi.stubGlobal('URL', {
                ...URL,
                createObjectURL,
                revokeObjectURL,
            })
            vi.stubGlobal('navigator', {
                ...navigator,
                share: undefined,
                canShare: undefined,
            })
            const click = vi
                .spyOn(HTMLAnchorElement.prototype, 'click')
                .mockImplementation(() => undefined)
            const { page } = createPage({
                dataService: { getUploadJournal: () => journal },
            })

            await page.exportRecoveryBundle()

            expect(click).toHaveBeenCalledOnce()
            expect(revokeObjectURL).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(61_000)
            expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery')
            expect(page.recoveryExported()).toBe(true)
        })

        it('falls back to the download when sharing fails for another reason', async () => {
            vi.spyOn(console, 'warn').mockReturnValue(undefined)
            vi.stubGlobal('navigator', {
                ...navigator,
                share: vi.fn().mockRejectedValue(new Error('not allowed')),
                canShare: () => true,
            })
            vi.stubGlobal('URL', {
                ...URL,
                createObjectURL: () => 'blob:recovery',
                revokeObjectURL: vi.fn(),
            })
            const click = vi
                .spyOn(HTMLAnchorElement.prototype, 'click')
                .mockImplementation(() => undefined)
            const { page } = createPage({
                dataService: { getUploadJournal: () => journal },
            })

            await page.exportRecoveryBundle()

            expect(click).toHaveBeenCalledOnce()
        })

        it('includes the server answer that could not be saved', async () => {
            const share = vi.fn().mockResolvedValue(undefined)
            vi.stubGlobal('navigator', {
                ...navigator,
                share,
                canShare: () => true,
            })
            const { page } = createPage({
                dataService: { getUploadJournal: () => journal },
                coordinator: {
                    getUnsavedReceipt: () => ({
                        attemptId: 'attempt-1',
                        rawReceipt: '<diffResult/>',
                    }),
                },
            })

            await page.exportRecoveryBundle()

            const [{ files }] = share.mock.calls[0]
            const content = JSON.parse(await files[0].text())
            expect(content.unsavedServerAnswer).toEqual({
                attemptId: 'attempt-1',
                rawReceipt: '<diffResult/>',
            })
        })

        describe('in the Android application', () => {
            const nativeExport = (
                share: () => Promise<{
                    activityType?: string
                }> = async () => ({}),
                writeFile: () => Promise<{ uri: string }> = async () => ({
                    uri: 'file:///cache/osmgo-upload-recovery-attempt-1.json',
                })
            ) => ({
                isNativePlatform: () => true,
                filesystem: { writeFile: vi.fn(writeFile) },
                share: { share: vi.fn(share) },
            })

            it('writes the file to the cache and shares it', async () => {
                const plugins = nativeExport()
                const webShare = vi.fn()
                vi.stubGlobal('navigator', {
                    ...navigator,
                    share: webShare,
                    canShare: () => true,
                })
                const { page } = createPage({
                    dataService: { getUploadJournal: () => journal },
                    nativeFileExport: plugins,
                })

                await page.exportRecoveryBundle()

                expect(plugins.filesystem.writeFile).toHaveBeenCalledWith(
                    expect.objectContaining({
                        path: 'osmgo-upload-recovery-attempt-1.json',
                        directory: 'CACHE',
                        encoding: 'utf8',
                    })
                )
                const [options] = plugins.filesystem.writeFile.mock
                    .calls[0] as unknown as [{ data: string }]
                expect(JSON.parse(options.data).journal).toEqual(journal)
                expect(plugins.share.share).toHaveBeenCalledWith(
                    expect.objectContaining({
                        files: [
                            'file:///cache/osmgo-upload-recovery-attempt-1.json',
                        ],
                    })
                )
                expect(webShare).not.toHaveBeenCalled()
                expect(page.recoveryExported()).toBe(true)
            })

            it('does not count a closed share sheet as an export', async () => {
                vi.spyOn(console, 'warn').mockReturnValue(undefined)
                const plugins = nativeExport(async () => {
                    throw new Error('Share canceled')
                })
                const { page } = createPage({
                    dataService: { getUploadJournal: () => journal },
                    nativeFileExport: plugins,
                })

                await page.exportRecoveryBundle()

                expect(page.recoveryExported()).toBe(false)
            })

            it('reports a file that cannot be written, without any fallback', async () => {
                vi.spyOn(console, 'error').mockReturnValue(undefined)
                const click = vi
                    .spyOn(HTMLAnchorElement.prototype, 'click')
                    .mockImplementation(() => undefined)
                const plugins = nativeExport(undefined, async () => {
                    throw new Error('No space left')
                })
                const { page, snackBarOpen } = createPage({
                    dataService: { getUploadJournal: () => journal },
                    nativeFileExport: plugins,
                })

                await page.exportRecoveryBundle()

                expect(page.recoveryExported()).toBe(false)
                expect(plugins.share.share).not.toHaveBeenCalled()
                expect(click).not.toHaveBeenCalled()
                expect(snackBarOpen).toHaveBeenCalledWith(
                    'SEND_DATA.EXPORT_FAILED',
                    'SHARED.CLOSE',
                    expect.anything()
                )
            })

            it('shares the unreadable objects the same way', async () => {
                const plugins = nativeExport()
                const { page } = createPage({ nativeFileExport: plugins })

                await page.exportQuarantine()

                expect(plugins.filesystem.writeFile).toHaveBeenCalledWith(
                    expect.objectContaining({
                        path: 'osmgo-unreadable-objects.json',
                    })
                )
                expect(plugins.share.share).toHaveBeenCalledOnce()
            })
        })
    })

    describe('unreadable objects set aside', () => {
        it('exports every set-aside object', async () => {
            const share = vi.fn().mockResolvedValue(undefined)
            vi.stubGlobal('navigator', {
                ...navigator,
                share,
                canShare: () => true,
            })
            const entry = {
                store: 'pending',
                id: 'node/21',
                value: {},
                reason: 'x',
            }
            const { page } = createPage({
                dataService: { getQuarantinedFeatures: async () => [entry] },
            })

            try {
                await page.exportQuarantine()
            } finally {
                vi.unstubAllGlobals()
            }

            const [{ files }] = share.mock.calls[0]
            expect(files[0].name).toBe('osmgo-unreadable-objects.json')
            expect(JSON.parse(await files[0].text()).features).toEqual([entry])
        })

        it('offers to export the local data set aside by a reset', async () => {
            const backup = {
                key: 'osmStateBackup:1',
                backedUpAt: '2026-11-08',
                entries: { osmState: { pendingById: {} } },
            }
            const share = vi.fn().mockResolvedValue(undefined)
            vi.stubGlobal('navigator', {
                ...navigator,
                share,
                canShare: () => true,
            })
            const { page } = createPage({
                dataService: { getStateBackups: vi.fn(async () => [backup]) },
            })
            try {
                page.ngAfterViewInit()
                await vi.waitFor(() => expect(page.stateBackupCount()).toBe(1))

                await page.exportStateBackups()
            } finally {
                vi.unstubAllGlobals()
            }

            const [{ files }] = share.mock.calls[0]
            expect(files[0].name).toBe('osmgo-local-data-backups.json')
            expect(JSON.parse(await files[0].text()).backups).toEqual([backup])
        })

        it('deletes them only after a destructive confirmation', async () => {
            const { page, dataService, dialogOpen } = createPage()

            page.dismissQuarantine()
            await vi.waitFor(() =>
                expect(dataService.clearQuarantine).toHaveBeenCalled()
            )

            expect(dialogOpen).toHaveBeenCalledOnce()
        })

        it('keeps them when the confirmation is declined', async () => {
            const { page, dataService, dialogOpen } = createPage({
                confirm: false,
            })

            page.dismissQuarantine()
            await vi.waitFor(() => expect(dialogOpen).toHaveBeenCalled())
            await Promise.resolve()

            expect(dataService.clearQuarantine).not.toHaveBeenCalled()
        })
    })

    describe('leaving during an upload', () => {
        it('asks the browser for confirmation while uploading', () => {
            const { page } = createPage({ inFlight: true })
            const event = new Event('beforeunload', {
                cancelable: true,
            }) as BeforeUnloadEvent

            page.warnBeforeLeaving(event)

            expect(event.defaultPrevented).toBe(true)
        })

        it('lets the browser leave when nothing is uploading', () => {
            const { page } = createPage()
            const event = new Event('beforeunload', {
                cancelable: true,
            }) as BeforeUnloadEvent

            page.warnBeforeLeaving(event)

            expect(event.defaultPrevented).toBe(false)
        })
    })
})
