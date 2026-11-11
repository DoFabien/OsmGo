import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { DataService, UploadInFlightError } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmAuthService } from '@services/osm-auth.service'
import { OverlayNavigationService } from '@services/overlay-navigation.service'
import { UploadCoordinatorService } from '@services/upload-coordinator.service'
import { of } from 'rxjs'
import { SettingsPage } from './settings'

describe('SettingsPage', () => {
    const state = {
        pending: 0,
        journal: false,
        quarantined: 0,
        backups: [] as unknown[],
        dataUploading: signal(false),
        coordinatorUploading: signal(false),
        isDevServer: false,
        dialogResult: true as unknown,
    }
    const clearCache = vi.fn()
    const openDialog = vi.fn()
    const snackBarOpen = vi.fn()
    const clearAllAuthentication = vi.fn()
    const switchOsmEnvironment = vi.fn()
    const cacheDelete = vi.fn()
    const toogleMesureFilter = vi.fn()

    const config = () => ({
        followPosition: false,
        lockMapHeading: false,
        centerWhenGpsIsReady: false,
        openObjectSheetAsPreview: false,
        oldTagsIcon: { display: false, year: 2 },
        displayFixmeIcon: false,
        filterWayByArea: false,
        filterWayByLength: false,
        isSelectableLine: false,
        isSelectablePolygon: false,
        checkedKey: 'survey:date',
        addSurveyDate: false,
        surveyCard: { display: 'never', year: 2 },
        limitFeatures: 1000,
        mapMarginBuffer: 10,
        languageUi: 'en',
        languageTags: 'en',
        countryTags: 'FR',
        isDevServer: state.isDevServer,
    })

    function configure(realTranslate = false): void {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: realTranslate
                ? [SettingsPage, TranslateModule.forRoot()]
                : [],
            providers: [
                {
                    provide: ConfigService,
                    useValue: {
                        config,
                        interfaceLanguages: [],
                        i18nConfig: { uiLanguages: [], language: [] },
                        countryConfig: [],
                        getSurveyCardYear: () => 2,
                        switchOsmEnvironment,
                        setFilterWayByArea: vi.fn(),
                        getFilterWayByArea: () => true,
                        setFilterWayByLength: vi.fn(),
                        getFilterWayByLength: () => true,
                    },
                },
                {
                    provide: MapService,
                    useValue: { map: {}, toogleMesureFilter },
                },
                {
                    provide: DataService,
                    useValue: {
                        changedFeatureCount: () => state.pending,
                        hasActiveUploadJournal: () => state.journal,
                        quarantinedCount: () => state.quarantined,
                        getStateBackups: async () => state.backups,
                        uploadInFlight: state.dataUploading,
                        clearCache,
                    },
                },
                {
                    provide: UploadCoordinatorService,
                    useValue: { inFlight: state.coordinatorUploading },
                },
                {
                    provide: OsmAuthService,
                    useValue: { clearAllAuthentication },
                },
                { provide: MatDialog, useValue: { open: openDialog } },
                { provide: MatSnackBar, useValue: { open: snackBarOpen } },
                ...(realTranslate
                    ? []
                    : [
                          {
                              provide: TranslateService,
                              useValue: {
                                  instant: (
                                      key: string,
                                      params?: { count?: number }
                                  ) =>
                                      params?.count
                                          ? `${key}:${params.count}`
                                          : key,
                              },
                          },
                      ]),
                { provide: OverlayNavigationService, useValue: {} },
            ],
        })
    }

    function createPage(): SettingsPage {
        configure()
        const page = TestBed.runInInjectionContext(() => new SettingsPage())
        vi.spyOn(
            page as unknown as { reloadApp: () => void },
            'reloadApp'
        ).mockImplementation(() => undefined)
        return page
    }

    const dialogData = () =>
        (openDialog.mock.calls[0][1] as { data: Record<string, unknown> }).data

    beforeEach(() => {
        state.pending = 0
        state.journal = false
        state.quarantined = 0
        state.backups = []
        state.dataUploading.set(false)
        state.coordinatorUploading.set(false)
        state.isDevServer = false
        state.dialogResult = true
        clearCache.mockReset().mockResolvedValue(undefined)
        clearAllAuthentication.mockReset().mockResolvedValue(undefined)
        switchOsmEnvironment.mockReset().mockResolvedValue(undefined)
        snackBarOpen.mockReset()
        cacheDelete.mockReset()
        openDialog.mockReset().mockImplementation(() => ({
            afterClosed: () => of(state.dialogResult),
        }))
        vi.stubGlobal('caches', {
            keys: async () => [
                'ngsw:/:db:control',
                'ngsw:/:1:assets:app:cache',
                'osmgo-runtime',
            ],
            delete: cacheDelete,
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    describe('deleting the whole cache', () => {
        it('asks for a destructive confirmation before wiping anything', async () => {
            const page = createPage()

            await page.deleteCache()

            expect(openDialog).toHaveBeenCalledOnce()
            expect(dialogData()).toMatchObject({
                title: 'SETTINGS.DELETE_CACHE_CONFIRM_TITLE',
                confirmLabel: 'SETTINGS.DELETE_CACHE_CONFIRM',
                destructive: true,
            })
            expect(clearCache).toHaveBeenCalledOnce()
        })

        it('keeps the service worker caches so the app still starts offline', async () => {
            const page = createPage()

            await page.deleteCache()

            expect(cacheDelete.mock.calls).toEqual([['osmgo-runtime']])
        })

        it('keeps everything when the confirmation is refused', async () => {
            state.dialogResult = false
            const page = createPage()

            await page.deleteCache()

            expect(clearCache).not.toHaveBeenCalled()
            expect(cacheDelete).not.toHaveBeenCalled()
        })

        it('keeps everything when the dialog is dismissed', async () => {
            state.dialogResult = undefined
            const page = createPage()

            await page.deleteCache()

            expect(clearCache).not.toHaveBeenCalled()
        })

        it('states how many changes have not been uploaded', async () => {
            state.pending = 4
            const page = createPage()

            await page.deleteCache()

            expect(dialogData()['message']).toContain(
                'SETTINGS.DELETE_CACHE_PENDING_MANY:4'
            )
        })

        it('uses the singular for one change', async () => {
            state.pending = 1
            const page = createPage()

            await page.deleteCache()

            expect(dialogData()['message']).toContain(
                'SETTINGS.DELETE_CACHE_PENDING_ONE'
            )
        })

        it('does not mention pending changes when there are none', async () => {
            const page = createPage()

            await page.deleteCache()

            expect(dialogData()['message']).not.toContain('PENDING')
        })

        it('warns about an unresolved upload record', async () => {
            state.journal = true
            const page = createPage()

            await page.deleteCache()

            expect(dialogData()['message']).toContain(
                'SETTINGS.DELETE_CACHE_UNRESOLVED_UPLOAD'
            )
        })

        it('warns that unreadable edits set aside are erased too', async () => {
            state.quarantined = 3
            const page = createPage()

            await page.deleteCache()

            expect(dialogData()['message']).toContain(
                'SEND_DATA.QUARANTINE_MESSAGE'
            )
        })

        it('warns that state backups are erased too', async () => {
            state.backups = [{ key: 'osmStateBackup:1' }]
            const page = createPage()

            await page.deleteCache()

            expect(dialogData()['message']).toContain(
                'SEND_DATA.STATE_BACKUP_MESSAGE'
            )
        })

        it('does not mention set-aside edits when there are none', async () => {
            const page = createPage()

            await page.deleteCache()

            expect(dialogData()['message']).not.toContain('QUARANTINE')
            expect(dialogData()['message']).not.toContain('STATE_BACKUP')
        })

        it('refuses while an upload is running', async () => {
            state.coordinatorUploading.set(true)
            const page = createPage()

            await page.deleteCache()

            expect(openDialog).not.toHaveBeenCalled()
            expect(clearCache).not.toHaveBeenCalled()
            expect(snackBarOpen).toHaveBeenCalledWith(
                'SETTINGS.UPLOAD_IN_PROGRESS',
                'SHARED.CLOSE',
                expect.anything()
            )
        })

        it('refuses while the data service reports a request in progress', async () => {
            state.dataUploading.set(true)
            const page = createPage()

            await page.deleteCache()

            expect(openDialog).not.toHaveBeenCalled()
            expect(clearCache).not.toHaveBeenCalled()
        })

        it('does not wipe if an upload starts while the dialog is open', async () => {
            const page = createPage()
            openDialog.mockImplementation(() => ({
                afterClosed: () => {
                    state.coordinatorUploading.set(true)
                    return of(true)
                },
            }))

            await page.deleteCache()

            expect(clearCache).not.toHaveBeenCalled()
        })

        it('does not reload when the data service refuses the wipe', async () => {
            clearCache.mockRejectedValue(new UploadInFlightError())
            const page = createPage()

            await page.deleteCache()

            expect(cacheDelete).not.toHaveBeenCalled()
            expect(snackBarOpen).toHaveBeenCalled()
        })

        it('disables the button and explains why while uploading', () => {
            state.coordinatorUploading.set(true)
            configure(true)
            const fixture = TestBed.createComponent(SettingsPage)
            fixture.detectChanges()

            const button = fixture.nativeElement.querySelector(
                '.danger-action'
            ) as HTMLButtonElement
            expect(button.disabled).toBe(true)
            expect(
                fixture.nativeElement.querySelector('.setting-warning')
            ).not.toBeNull()
        })
    })

    describe('development server switch', () => {
        const toggle = (checked: boolean) => ({
            checked,
            source: { checked },
        })

        it('puts the switch back when the confirmation is refused', async () => {
            state.dialogResult = false
            const page = createPage()
            const change = toggle(true)

            await page.changeIsDevServer(change as never)

            expect(change.source.checked).toBe(false)
            expect(switchOsmEnvironment).not.toHaveBeenCalled()
        })

        it('always confirms, even with nothing pending', async () => {
            const page = createPage()

            await page.changeIsDevServer(toggle(true) as never)

            expect(openDialog).toHaveBeenCalledOnce()
            expect(dialogData()).toMatchObject({
                message: 'SETTINGS.SWITCH_SERVER_MESSAGE_CLEAN',
                destructive: true,
            })
            expect(clearAllAuthentication).toHaveBeenCalledOnce()
            expect(switchOsmEnvironment).toHaveBeenCalledWith(true)
        })

        it('keeps the session and the server when the data cannot be backed up', async () => {
            switchOsmEnvironment.mockRejectedValueOnce(new Error('quota'))
            const page = createPage()
            const source = toggle(true)

            await page.changeIsDevServer(source as never)

            expect(clearAllAuthentication).not.toHaveBeenCalled()
            expect(snackBarOpen).toHaveBeenCalledWith(
                'SETTINGS.SWITCH_SERVER_FAILED',
                'SHARED.CLOSE',
                expect.anything()
            )
            expect(source.source.checked).toBe(false)
        })

        it('warns that pending edits will be deleted', async () => {
            state.pending = 2
            const page = createPage()

            await page.changeIsDevServer(toggle(true) as never)

            expect(dialogData()['message']).toBe(
                'SETTINGS.SWITCH_SERVER_MESSAGE'
            )
        })

        it('warns about an upload that is not reconciled yet', async () => {
            state.journal = true
            const page = createPage()

            await page.changeIsDevServer(toggle(true) as never)

            expect(dialogData()['message']).toBe(
                'SETTINGS.SWITCH_SERVER_MESSAGE_CLEAN\n\nSETTINGS.SWITCH_SERVER_UNRESOLVED_UPLOAD'
            )
        })

        it('does nothing when the value is unchanged', async () => {
            const page = createPage()

            await page.changeIsDevServer(toggle(false) as never)

            expect(openDialog).not.toHaveBeenCalled()
        })

        it('refuses and restores the switch while an upload is running', async () => {
            state.coordinatorUploading.set(true)
            const page = createPage()
            const change = toggle(true)

            await page.changeIsDevServer(change as never)

            expect(change.source.checked).toBe(false)
            expect(openDialog).not.toHaveBeenCalled()
            expect(switchOsmEnvironment).not.toHaveBeenCalled()
        })
    })

    it('applies the way filters to both the downloaded and the changed ways', () => {
        toogleMesureFilter.mockClear()
        const page = createPage()

        page.filterWayByArea(true)
        page.filterWayByLength(true)

        expect(toogleMesureFilter.mock.calls.map((call) => call[1])).toEqual([
            'way_fill',
            'way_fill_changed',
            'way_line',
            'way_line_changed',
        ])
    })
})
