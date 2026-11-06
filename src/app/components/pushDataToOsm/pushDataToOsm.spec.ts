import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { TranslateService } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { TagsService } from '@services/tags.service'
import {
    UploadCoordinatorService,
    type UploadFeature,
    type UploadState,
} from '@services/upload-coordinator.service'
import type { Geometry } from 'geojson'

import { PushDataToOsmPage, UPLOAD_SUCCESS_DELAY_MS } from './pushDataToOsm'

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
    close?: () => Promise<unknown>
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
    const dataService = {
        getGeojsonChanged: vi.fn(() => ({
            type: 'FeatureCollection',
            features,
        })),
        getGeojson: vi.fn(() => ({ type: 'FeatureCollection', features: [] })),
        getUploadJournal: vi.fn(() => undefined),
        cancelPendingChange: vi.fn(async (id: string) => {
            features = features.filter((feature) => feature.id !== id)
        }),
        cancelAllPendingChanges: vi.fn(async () => {
            features = []
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
    }

    TestBed.resetTestingModule()
    TestBed.configureTestingModule({
        providers: [
            { provide: DataService, useValue: dataService },
            { provide: MapService, useValue: mapService },
            { provide: TagsService, useValue: {} },
            {
                provide: ConfigService,
                useValue: {
                    getChangeSetComment: () => '',
                    config: signal({ isDevServer: false }),
                    userInfo: signal({ connected: true }),
                },
            },
            { provide: UploadCoordinatorService, useValue: coordinator },
            { provide: OverlayNavigationService, useValue: { close } },
            { provide: MatDialog, useValue: {} },
            { provide: MatSnackBar, useValue: {} },
            {
                provide: TranslateService,
                useValue: { instant: (key: string) => key },
            },
            { provide: UPLOAD_SUCCESS_DELAY_MS, useValue: 0 },
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
        const { page, map, close } = createPage()

        page.centerToElement({ type: 'Point', coordinates: [2.3, 48.8] })

        expect(map.setZoom).toHaveBeenCalledWith(18.5)
        expect(map.setCenter).toHaveBeenCalledWith([2.3, 48.8])
        expect(map.fitBounds).not.toHaveBeenCalled()
        expect(close).toHaveBeenCalledOnce()
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
        const { page, map, close } = createPage()

        page.centerToElement(geometry as Geometry)

        expect(map.fitBounds).toHaveBeenCalledWith(bounds, {
            maxZoom: 18.5,
            padding: 48,
        })
        expect(map.setCenter).not.toHaveBeenCalled()
        expect(close).toHaveBeenCalledOnce()
    })
})
