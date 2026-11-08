import { computed, inject, Service, signal } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { AlertService } from '@services/alert.service'
import type { Config } from '@services/config.service'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { OsmAuthService } from '@services/osm-auth.service'
import { TagsService } from '@services/tags.service'
import { UploadCoordinatorService } from '@services/upload-coordinator.service'
import { defer, forkJoin, from, type Observable, of, throwError } from 'rxjs'
import {
    catchError,
    finalize,
    map,
    shareReplay,
    switchMap,
    tap,
    timeout,
} from 'rxjs/operators'
import { OsmApiService } from './osmApi.service'

/** How long the map waits for a linked object before it starts without it. */
const LINKED_OBJECT_WAIT_MS = 4000

type StartupResource =
    | 'config'
    | 'country'
    | 'userInfo'
    | 'changeSet'
    | 'savedFields'
    | 'jsonSprites'
    | 'presets'
    | 'tags'
    | 'bookMarksIds'
    | 'lastTagsUsedIds'
    | 'hiddenTagsIds'
    | 'osmState'
    | 'uploadJournal'

export interface StartupFatalError {
    resource: 'tags' | 'osmState' | 'uploadJournal'
    canResetLocalData: boolean
    messageKey: string
}

class RequiredStartupResourceError extends Error {
    constructor(
        readonly resource: StartupFatalError['resource'],
        options: ErrorOptions
    ) {
        super(`Could not load required startup resource: ${resource}.`, options)
    }
}

@Service()
export class InitService {
    readonly configService = inject(ConfigService)
    readonly tagsService = inject(TagsService)
    readonly dataService = inject(DataService)
    private readonly alertService = inject(AlertService)
    private readonly translate = inject(TranslateService)
    private readonly osmAuth = inject(OsmAuthService)
    private readonly osmApi = inject(OsmApiService)
    private readonly uploadCoordinator = inject(UploadCoordinatorService)

    isLoaded = false
    private readonly loadingState = signal(false)
    readonly loading = this.loadingState.asReadonly()
    private readonly recoverableIssuesState = signal<StartupResource[]>([])
    readonly recoverableIssues = this.recoverableIssuesState.asReadonly()
    private readonly fatalErrorState = signal<StartupFatalError | null>(null)
    readonly fatalError = this.fatalErrorState.asReadonly()
    private readonly lateLinkedObjectCoordsState = signal<
        { lon: number; lat: number } | undefined
    >(undefined)
    /**
     * Position of the linked object (`?id=node/123`) when it was found after
     * the map had already started: the map should move there.
     */
    readonly lateLinkedObjectCoords =
        this.lateLinkedObjectCoordsState.asReadonly()
    /**
     * True while an upload attempt needs the user's attention: an unresolved
     * journal or a failed recovery. The upload screen explains what to do.
     */
    readonly uploadNeedsAttention = computed(
        () =>
            this.dataService.hasActiveUploadJournal() ||
            this.uploadCoordinator.state().kind === 'failed'
    )

    private recover<T>(
        resource: StartupResource,
        source: Observable<T>,
        fallback: T,
        onFallback?: () => void
    ): Observable<T> {
        return source.pipe(
            catchError((error) => {
                console.warn(
                    `Using the startup fallback for ${resource}.`,
                    error
                )
                this.recoverableIssuesState.update((issues) =>
                    issues.includes(resource) ? issues : [...issues, resource]
                )
                onFallback?.()
                return of(fallback)
            })
        )
    }

    private required<T>(
        resource: StartupFatalError['resource'],
        source: Observable<T>
    ): Observable<T> {
        return source.pipe(
            catchError((cause) =>
                throwError(
                    () => new RequiredStartupResourceError(resource, { cause })
                )
            )
        )
    }

    /**
     * Sets the unreadable OSM data aside (copied under another name first, V1
     * collections included) so the next start can begin from a clean state.
     * Resolves to false when nothing was reset, the data being kept because
     * no copy could be written.
     */
    async resetFatalResource(): Promise<boolean> {
        if (!this.fatalError()?.canResetLocalData) return false
        try {
            await this.dataService.resetStoredOsmState()
            return true
        } catch (error) {
            console.error('The local OSM data could not be reset.', error)
            return false
        }
    }

    /** The coordinates of a linked object, without holding the map back. */
    private resolveLinkedObject$(
        objectId: string
    ): Observable<{ lon: number; lat: number } | undefined> {
        const coordinates$ = this.osmApi
            .getFirstCoordFromIdObject$(objectId)
            .pipe(shareReplay({ bufferSize: 1, refCount: false }))
        let startedWithoutIt = false
        coordinates$.subscribe({
            next: (coordinates) => {
                if (startedWithoutIt) {
                    this.lateLinkedObjectCoordsState.set(coordinates)
                }
            },
            error: () => undefined,
        })
        return coordinates$.pipe(
            timeout(LINKED_OBJECT_WAIT_MS),
            catchError(() => {
                startedWithoutIt = true
                return of(undefined)
            })
        )
    }

    /**
     * Load config, tags, etc...
     */
    initLoadData$(
        centerOnStart?: number[],
        zoomOnStart?: number,
        idOsmObjectOnStart?: string
    ) {
        return defer(() => {
            this.isLoaded = false
            this.loadingState.set(true)
            this.fatalErrorState.set(null)
            this.recoverableIssuesState.set([])
            this.lateLinkedObjectCoordsState.set(undefined)

            const config$ = this.recover(
                'config',
                this.configService
                    .getI18nConfig$()
                    .pipe(
                        switchMap((i18nConfig) =>
                            this.configService.loadConfig$(i18nConfig)
                        )
                    ),
                {
                    ...this.configService.config(),
                    lastView: this.configService.lastView(),
                },
                () => this.configService.protectUnreadableStoredConfig()
            ).pipe(shareReplay({ bufferSize: 1, refCount: true }))

            return forkJoin({
                config: config$,
                token: config$.pipe(
                    switchMap(() => from(this.osmAuth.loadToken()))
                ),
                country: this.recover(
                    'country',
                    this.configService.getCountryConfig$(),
                    []
                ),
                userInfo: this.recover(
                    'userInfo',
                    this.configService.loadUserInfo$(),
                    this.configService.userInfo()
                ),
                changeSet: this.recover(
                    'changeSet',
                    // The saved comment comes from the configuration.
                    config$.pipe(
                        switchMap(() => this.configService.loadChangeSet$())
                    ),
                    this.configService.getChangeset()
                ),
                savedFields: this.recover(
                    'savedFields',
                    this.tagsService.loadSavedFields$(),
                    {}
                ),

                jsonSprites: this.recover(
                    'jsonSprites',
                    this.tagsService.loadJsonSprites$(),
                    {}
                ),
                presets: this.recover(
                    'presets',
                    this.tagsService.loadPresets$(),
                    {}
                ),
                tags: this.required('tags', this.tagsService.loadTags$()),

                bookMarksIds: this.recover(
                    'bookMarksIds',
                    this.tagsService.loadBookMarksIds$(),
                    []
                ),
                lastTagsUsedIds: this.recover(
                    'lastTagsUsedIds',
                    this.tagsService.loadLastTagsUsedIds$(),
                    []
                ),
                hiddenTagsIds: this.recover(
                    'hiddenTagsIds',
                    this.tagsService.loadHiddenTagsIds$(),
                    []
                ),

                osmState: this.required(
                    'osmState',
                    this.dataService.loadOsmState$()
                ),
                objectOnStartCoords: idOsmObjectOnStart
                    ? config$.pipe(
                          switchMap(() =>
                              this.resolveLinkedObject$(idOsmObjectOnStart)
                          ),
                          catchError(() => of(undefined))
                      )
                    : of(undefined),
            }).pipe(
                map((d) => {
                    const config: Config = {
                        ...d.config,
                        lastView: { ...d.config.lastView },
                    }
                    if (d.objectOnStartCoords) {
                        centerOnStart = [
                            d.objectOnStartCoords.lon,
                            d.objectOnStartCoords.lat,
                        ]
                        config.lastView.zoom = 20
                        config.centerWhenGpsIsReady = false
                    }

                    if (centerOnStart) {
                        config.lastView.lng = centerOnStart[0]
                        config.lastView.lat = centerOnStart[1]
                        config.lastView.zoom = 20
                        config.centerWhenGpsIsReady = false
                    }

                    if (zoomOnStart) {
                        config.lastView.zoom = zoomOnStart
                    }

                    return { ...d, config }
                }),
                switchMap((data) =>
                    this.required(
                        'uploadJournal',
                        from(this.uploadCoordinator.recoverJournal())
                    ).pipe(map(() => data))
                ),
                tap(() => {
                    this.isLoaded = true
                    this.configService.applyUiLanguage(
                        this.configService.config().languageUi
                    )
                    this.announceQuarantinedObjects()
                }),
                catchError((error: unknown) => {
                    const resource =
                        error instanceof RequiredStartupResourceError
                            ? error.resource
                            : 'tags'
                    this.fatalErrorState.set({
                        resource,
                        canResetLocalData:
                            resource === 'osmState' ||
                            resource === 'uploadJournal',
                        messageKey:
                            resource === 'osmState'
                                ? 'MAIN.STARTUP.CORRUPTED_STORAGE'
                                : 'MAIN.STARTUP.REQUIRED_RESOURCE_FAILED',
                    })
                    return throwError(() => error)
                }),
                finalize(() => this.loadingState.set(false))
            )
        })
    }

    private announceQuarantinedObjects(): void {
        const count = this.dataService.newlyQuarantinedCount()
        if (count > 0) {
            this.alertService.showAlert(
                this.translate.instant('MAIN.STARTUP.QUARANTINE_NOTICE', {
                    count,
                })
            )
        }
    }
}
