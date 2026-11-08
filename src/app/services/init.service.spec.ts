import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { TranslateService } from '@ngx-translate/core'
import { AlertService } from '@services/alert.service'
import { type Config, ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { OsmAuthService } from '@services/osm-auth.service'
import { TagsService } from '@services/tags.service'
import { UploadCoordinatorService } from '@services/upload-coordinator.service'
import { firstValueFrom, of, Subject, throwError, timer } from 'rxjs'
import { map, tap } from 'rxjs/operators'
import { InitService } from './init.service'
import { OsmApiService } from './osmApi.service'

describe('InitService', () => {
    const emptyCollection = { type: 'FeatureCollection', features: [] }
    const config = {
        languageUi: 'fr',
        isDevServer: true,
        lastView: { lng: 2, lat: 48, zoom: 18, bearing: 0 },
        centerWhenGpsIsReady: true,
    }

    function configure(coordinateResult = of({ lon: 5.744, lat: 45.186 })) {
        let configLoaded = false
        const configService = {
            getI18nConfig$: vi.fn(() => of({ language: ['fr'] })),
            loadConfig$: vi.fn(() =>
                timer(1).pipe(
                    map(() => {
                        configLoaded = true
                        return structuredClone(config)
                    })
                )
            ),
            getCountryConfig$: vi.fn(() => of([])),
            loadUserInfo$: vi.fn(() => of(undefined)),
            loadChangeSet$: vi.fn(() => of(undefined)),
            applyUiLanguage: vi.fn(),
            protectUnreadableStoredConfig: vi.fn(),
            config: vi.fn(() => config),
            lastView: vi.fn(() => config.lastView),
            userInfo: vi.fn(() => ({
                uid: '',
                display_name: '',
                connected: false,
            })),
            getChangeset: vi.fn(() => ({
                id: '',
                last_changeset_activity: 0,
                created_at: 0,
                comment: '',
            })),
        }
        const tagsService = {
            loadSavedFields$: vi.fn(() => of([])),
            loadJsonSprites$: vi.fn(() => of({})),
            loadPresets$: vi.fn(() => of({})),
            loadTags$: vi.fn(() => of([])),
            loadBookMarksIds$: vi.fn(() => of([])),
            loadLastTagsUsedIds$: vi.fn(() => of([])),
            loadHiddenTagsIds$: vi.fn(() => of([])),
        }
        const dataService = {
            resetStoredOsmState: vi.fn(async () => undefined),
            hasActiveUploadJournal: signal(false),
            newlyQuarantinedCount: signal(0),
            loadOsmState$: vi.fn(() =>
                of({
                    schemaVersion: 2,
                    revision: 0,
                    officialById: {},
                    pendingById: {},
                    bbox: emptyCollection,
                    nextTemporaryId: -1,
                })
            ),
        }
        const osmApi = {
            getFirstCoordFromIdObject$: vi.fn(() => {
                expect(configLoaded).toBe(true)
                return coordinateResult
            }),
        }
        const osmAuth = {
            loadToken: vi.fn(async () => {
                expect(configLoaded).toBe(true)
                return 'dev-token'
            }),
        }
        const uploadState = signal<{ kind: string }>({ kind: 'idle' })
        const uploadCoordinator = {
            state: uploadState.asReadonly(),
            recoverJournal: vi.fn(async () => ({ kind: 'idle' })),
        }
        const translate = {
            use: vi.fn(),
            instant: vi.fn((key: string) => key),
        }
        const alertService = { showAlert: vi.fn() }

        TestBed.configureTestingModule({
            providers: [
                InitService,
                { provide: ConfigService, useValue: configService },
                { provide: TagsService, useValue: tagsService },
                { provide: DataService, useValue: dataService },
                { provide: OsmAuthService, useValue: osmAuth },
                { provide: OsmApiService, useValue: osmApi },
                {
                    provide: UploadCoordinatorService,
                    useValue: uploadCoordinator,
                },
                { provide: AlertService, useValue: alertService },
                { provide: TranslateService, useValue: translate },
            ],
        })

        return {
            service: TestBed.inject(InitService),
            configService,
            tagsService,
            dataService,
            osmAuth,
            osmApi,
            uploadCoordinator,
            uploadState,
            alertService,
            translate,
        }
    }

    it('loads the selected API environment before resolving a linked object', async () => {
        const { service, configService, osmAuth, osmApi, uploadCoordinator } =
            configure()

        const result = await firstValueFrom(
            service.initLoadData$(undefined, undefined, 'node/4330907486')
        )

        expect(configService.loadConfig$).toHaveBeenCalledOnce()
        expect(osmAuth.loadToken).toHaveBeenCalledOnce()
        expect(result.token).toBe('dev-token')
        expect(osmApi.getFirstCoordFromIdObject$).toHaveBeenCalledWith(
            'node/4330907486'
        )
        expect(uploadCoordinator.recoverJournal).toHaveBeenCalledOnce()
        expect(result.config.lastView).toMatchObject({
            lng: 5.744,
            lat: 45.186,
            zoom: 20,
        })
    })

    it('still initializes the app when a linked object has no coordinates', async () => {
        const { service } = configure(
            throwError(() => new Error('No coordinates found'))
        )

        const result = await firstValueFrom(
            service.initLoadData$(undefined, undefined, 'node/missing')
        )

        expect(result.objectOnStartCoords).toBeUndefined()
        expect(result.config.lastView).toMatchObject({ lng: 2, lat: 48 })
        expect(service.isLoaded).toBe(true)
    })

    it('uses isolated fallbacks when optional startup resources fail', async () => {
        const { service, configService, tagsService } = configure()
        configService.getCountryConfig$.mockReturnValue(
            throwError(() => new Error('country unavailable'))
        )
        configService.loadUserInfo$.mockReturnValue(
            throwError(() => new Error('storage unavailable'))
        )
        tagsService.loadJsonSprites$.mockReturnValue(
            throwError(() => new Error('sprites unavailable'))
        )
        tagsService.loadBookMarksIds$.mockReturnValue(
            throwError(() => new Error('bookmarks unavailable'))
        )

        const result = await firstValueFrom(service.initLoadData$())

        expect(result.country).toEqual([])
        expect(result.jsonSprites).toEqual({})
        expect(result.bookMarksIds).toEqual([])
        expect(service.isLoaded).toBe(true)
        expect(service.loading()).toBe(false)
        expect(service.fatalError()).toBeNull()
        expect(service.recoverableIssues()).toEqual([
            'country',
            'userInfo',
            'jsonSprites',
            'bookMarksIds',
        ])
    })

    it('stops on a missing required tag catalog and finalizes loading', async () => {
        const { service, tagsService, uploadCoordinator } = configure()
        tagsService.loadTags$.mockReturnValue(
            throwError(() => new Error('tags unavailable'))
        )

        await expect(firstValueFrom(service.initLoadData$())).rejects.toThrow(
            'Could not load required startup resource: tags.'
        )

        expect(service.isLoaded).toBe(false)
        expect(service.loading()).toBe(false)
        expect(service.fatalError()).toEqual({
            resource: 'tags',
            canResetLocalData: false,
            messageKey: 'MAIN.STARTUP.REQUIRED_RESOURCE_FAILED',
        })
        expect(uploadCoordinator.recoverJournal).not.toHaveBeenCalled()
    })

    it('offers a targeted reset when the persisted OSM state is unreadable', async () => {
        const { service, dataService } = configure()
        dataService.loadOsmState$.mockReturnValue(
            throwError(() => new Error('invalid persisted state'))
        )

        await expect(firstValueFrom(service.initLoadData$())).rejects.toThrow(
            'Could not load required startup resource: osmState.'
        )

        expect(service.fatalError()).toMatchObject({
            resource: 'osmState',
            canResetLocalData: true,
            messageKey: 'MAIN.STARTUP.CORRUPTED_STORAGE',
        })

        await expect(service.resetFatalResource()).resolves.toBe(true)
        expect(dataService.resetStoredOsmState).toHaveBeenCalledOnce()
    })

    it('reports a reset that kept the data because no backup was written', async () => {
        const { service, dataService } = configure()
        dataService.loadOsmState$.mockReturnValue(
            throwError(() => new Error('invalid persisted state'))
        )
        dataService.resetStoredOsmState.mockRejectedValue(
            new Error('could not be backed up')
        )
        vi.spyOn(console, 'error').mockReturnValue(undefined)
        await expect(firstValueFrom(service.initLoadData$())).rejects.toThrow()

        await expect(service.resetFatalResource()).resolves.toBe(false)
    })

    it('does not reset anything unless the failure is a resettable one', async () => {
        const { service, dataService } = configure()

        await service.resetFatalResource()

        expect(dataService.resetStoredOsmState).not.toHaveBeenCalled()
    })

    it('recovers the upload journal before marking startup as loaded', async () => {
        const { service, uploadCoordinator } = configure()
        uploadCoordinator.recoverJournal.mockImplementation(async () => {
            expect(service.isLoaded).toBe(false)
            return { kind: 'idle' }
        })

        await firstValueFrom(service.initLoadData$())

        expect(uploadCoordinator.recoverJournal).toHaveBeenCalledOnce()
        expect(service.isLoaded).toBe(true)
    })

    it('reads the saved changeset comment only once the configuration is loaded', async () => {
        const { service, configService } = configure()
        const loadConfig = configService.loadConfig$.getMockImplementation()
        let configEmitted = false
        configService.loadConfig$.mockImplementation(() =>
            (loadConfig?.() ?? of(config)).pipe(
                tap(() => {
                    configEmitted = true
                })
            )
        )
        configService.loadChangeSet$.mockImplementation(() => {
            expect(configEmitted).toBe(true)
            return of(undefined)
        })

        await firstValueFrom(service.initLoadData$())

        expect(configService.loadChangeSet$).toHaveBeenCalledOnce()
    })

    it('protects the stored configuration when only defaults could be used', async () => {
        const { service, configService, osmAuth } = configure()
        osmAuth.loadToken.mockResolvedValue('token')
        configService.loadConfig$.mockReturnValue(
            throwError(() => new Error('storage unavailable'))
        )

        await firstValueFrom(service.initLoadData$())

        expect(
            configService.protectUnreadableStoredConfig
        ).toHaveBeenCalledOnce()
        expect(service.recoverableIssues()).toContain('config')
    })

    it('does not protect the configuration when it loaded normally', async () => {
        const { service, configService } = configure()

        await firstValueFrom(service.initLoadData$())

        expect(
            configService.protectUnreadableStoredConfig
        ).not.toHaveBeenCalled()
    })

    describe('linked object', () => {
        afterEach(() => vi.useRealTimers())

        it('starts the map without waiting for a slow linked object', async () => {
            vi.useFakeTimers()
            const { service, osmApi } = configure()
            const coordinates$ = new Subject<{ lon: number; lat: number }>()
            osmApi.getFirstCoordFromIdObject$.mockReturnValue(coordinates$)
            let result:
                | { objectOnStartCoords?: unknown; config: Config }
                | undefined
            service
                .initLoadData$(undefined, undefined, 'relation/1')
                .subscribe((value) => {
                    result = value as typeof result
                })

            await vi.advanceTimersByTimeAsync(3000)
            expect(result).toBeUndefined()
            await vi.advanceTimersByTimeAsync(1500)

            expect(result?.objectOnStartCoords).toBeUndefined()
            expect(service.isLoaded).toBe(true)
            expect(osmApi.getFirstCoordFromIdObject$).toHaveBeenCalledOnce()

            coordinates$.next({ lon: 5, lat: 45 })
            expect(service.lateLinkedObjectCoords()).toEqual({
                lon: 5,
                lat: 45,
            })
        })

        it('does not announce a late position when the object arrived in time', async () => {
            const { service } = configure()

            await firstValueFrom(
                service.initLoadData$(undefined, undefined, 'node/1')
            )

            expect(service.lateLinkedObjectCoords()).toBeUndefined()
        })
    })

    describe('upload recovery', () => {
        it('exposes a failed recovery instead of treating it as a success', async () => {
            const { service, uploadCoordinator, uploadState } = configure()
            uploadCoordinator.recoverJournal.mockImplementation(async () => {
                const failed = { kind: 'failed' }
                uploadState.set(failed)
                return failed
            })

            await firstValueFrom(service.initLoadData$())

            expect(service.isLoaded).toBe(true)
            expect(service.uploadNeedsAttention()).toBe(true)
        })

        it('flags an unresolved journal and stays quiet otherwise', async () => {
            const { service, dataService } = configure()
            await firstValueFrom(service.initLoadData$())
            expect(service.uploadNeedsAttention()).toBe(false)

            dataService.hasActiveUploadJournal.set(true)

            expect(service.uploadNeedsAttention()).toBe(true)
        })
    })

    describe('objects set aside while loading', () => {
        it('tells the user once when the load quarantined something', async () => {
            const { service, dataService, alertService, translate } =
                configure()
            dataService.newlyQuarantinedCount.set(3)

            await firstValueFrom(service.initLoadData$())

            expect(translate.instant).toHaveBeenCalledWith(
                'MAIN.STARTUP.QUARANTINE_NOTICE',
                { count: 3 }
            )
            expect(alertService.showAlert).toHaveBeenCalledOnce()
        })

        it('stays silent when nothing was set aside', async () => {
            const { service, alertService } = configure()

            await firstValueFrom(service.initLoadData$())

            expect(alertService.showAlert).not.toHaveBeenCalled()
        })
    })
})
