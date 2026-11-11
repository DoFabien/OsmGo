import { HttpClient } from '@angular/common/http'
import { TestBed } from '@angular/core/testing'
import { TranslateService } from '@ngx-translate/core'
import { AppStorage } from '@services/app-storage.service'
import { DataService } from '@services/data.service'
import { firstValueFrom } from 'rxjs'

import {
    ConfigService,
    defaultCountryFromLocale,
    resolveUiLanguage,
} from './config.service'

describe('ConfigService', () => {
    it('merges stored configuration with current defaults', async () => {
        const storage = {
            get: vi.fn().mockResolvedValue({ limitFeatures: 250 }),
            set: vi.fn().mockName('Storage.set'),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)
        const defaultLanguage = service.config().languageTags

        const config = await firstValueFrom(service.loadConfig$(undefined))

        expect(config.limitFeatures).toBe(250)
        expect(config.languageTags).toBe(defaultLanguage)
        expect(config).toEqual({
            ...service.config(),
            lastView: service.lastView(),
        })
    })

    it('migrates unavailable interface languages to English', async () => {
        const storage = {
            get: vi.fn().mockResolvedValue({ languageUi: 'da' }),
            set: vi.fn().mockName('Storage.set'),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)

        const config = await firstValueFrom(
            service.loadConfig$({ uiLanguages: ['en', 'fr'], language: [] })
        )

        expect(config.languageUi).toBe('en')
        expect(storage.set).toHaveBeenCalledWith('config', service.config())
    })

    it('migrates the stale maximum zoom of a stored Bing basemap', async () => {
        const storedBasemap = {
            id: 'Bing',
            name: 'Bing Maps Aerial',
            tiles: ['https://example.test/{quadkey}.jpeg'],
            max_zoom: 22,
        }
        const storage = {
            get: vi.fn().mockResolvedValue({ basemap: storedBasemap }),
            set: vi.fn().mockName('Storage.set'),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)

        const config = await firstValueFrom(service.loadConfig$(undefined))

        expect(config.basemap.max_zoom).toBe(19)
        expect(storage.set).toHaveBeenCalledWith('config', service.config())
    })

    it('migrates a stored BDOrtho basemap away from the retired IGN host', async () => {
        const storage = {
            get: vi.fn().mockResolvedValue({
                basemap: {
                    id: 'fr.ign.bdortho',
                    name: 'BDOrtho IGN',
                    tiles: [
                        'https://wxs.ign.fr/pratique/geoportail/wmts?TILEMATRIX={z}&TILECOL={x}&TILEROW={y}',
                    ],
                    max_zoom: 19,
                },
            }),
            set: vi.fn().mockName('Storage.set'),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)

        const config = await firstValueFrom(service.loadConfig$(undefined))

        expect(config.basemap).toEqual(
            expect.objectContaining({
                max_zoom: 19,
                tiles: [
                    'https://data.geopf.fr/tms/1.0.0/ORTHOIMAGERY.ORTHOPHOTOS/{z}/{x}/{y}.jpeg',
                ],
            })
        )
        expect(storage.set).toHaveBeenCalledWith('config', service.config())
    })

    it('replaces and persists configuration updates', () => {
        const storage = {
            set: vi.fn().mockName('Storage.set'),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)
        const initialConfig = service.config()

        service.setOldTagsIcon(false, 8)

        expect(service.config()).not.toBe(initialConfig)
        expect(service.config().oldTagsIcon).toEqual({
            display: false,
            year: 8,
        })
        expect(storage.set).toHaveBeenCalledWith('config', service.config())
    })

    it('keeps the translation service and document language in sync', () => {
        const storage = { set: vi.fn() }
        const translate = { use: vi.fn() }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: translate },
            ],
        })
        const service = TestBed.inject(ConfigService)

        service.setUiLanguage('fr')

        expect(document.documentElement.lang).toBe('fr')
        expect(translate.use).toHaveBeenCalledWith('fr')
        expect(storage.set).toHaveBeenCalledWith(
            'config',
            expect.objectContaining({ languageUi: 'fr' })
        )
    })

    it.each([
        ['ar', 'rtl'],
        ['he', 'rtl'],
        ['ar-AA', 'rtl'],
        ['fr', 'ltr'],
        ['en', 'ltr'],
    ])('sets the document direction for %s to %s', (lang, direction) => {
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: { set: vi.fn() } },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: { use: vi.fn() } },
            ],
        })
        const service = TestBed.inject(ConfigService)

        service.applyUiLanguage(lang)

        expect(document.documentElement.dir).toBe(direction)
        document.documentElement.dir = 'ltr'
    })

    it('keeps a changeset comment draft per server', async () => {
        const stored = new Map<string, unknown>([
            ['changeSetComment:dev', 'Dev test'],
        ])
        const storage = {
            get: vi.fn(async (key: string) => stored.get(key) ?? null),
            set: vi.fn(async (key: string, value: unknown) => {
                stored.set(key, value)
            }),
            remove: vi.fn().mockResolvedValue(undefined),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
                {
                    provide: DataService,
                    useValue: { resetStoredOsmState: vi.fn() },
                },
            ],
        })
        const service = TestBed.inject(ConfigService)
        service.setChangeSetComment('Survey in Guérande')

        await service.setIsDevServer(true)
        expect(service.getChangeSetComment()).toBe('Dev test')

        await service.setIsDevServer(false)
        expect(service.getChangeSetComment()).toBe('Survey in Guérande')
    })

    it('sets the OSM data aside through DataService when switching servers', async () => {
        const storage = {
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined),
            remove: vi.fn().mockResolvedValue(undefined),
        }
        const order: string[] = []
        const dataService = {
            resetStoredOsmState: vi.fn(async () => {
                order.push('reset')
                return 'osmStateBackup:1'
            }),
        }
        storage.set.mockImplementation(async (key: string) => {
            order.push(`set:${key}`)
        })
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
                { provide: DataService, useValue: dataService },
            ],
        })
        const service = TestBed.inject(ConfigService)

        await service.setIsDevServer(true)

        expect(dataService.resetStoredOsmState).toHaveBeenCalledWith({
            includeQuarantine: true,
        })
        expect(order[0]).toBe('reset')
        expect(service.config().isDevServer).toBe(true)
        expect(storage.remove.mock.calls.map(([key]) => key)).toEqual([
            'user_info',
            'changeset',
            'osmToken',
            'osmToken:prod',
            'osmToken:dev',
            'osmOAuthTransaction:prod',
            'osmOAuthTransaction:dev',
        ])
    })

    it('stays on the current server when its data cannot be backed up', async () => {
        const storage = {
            set: vi.fn().mockResolvedValue(undefined),
            remove: vi.fn().mockResolvedValue(undefined),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
                {
                    provide: DataService,
                    useValue: {
                        resetStoredOsmState: vi
                            .fn()
                            .mockRejectedValue(new Error('backup')),
                    },
                },
            ],
        })
        const service = TestBed.inject(ConfigService)

        await expect(service.setIsDevServer(true)).rejects.toThrow('backup')

        expect(service.config().isDevServer).toBe(false)
        expect(storage.remove).not.toHaveBeenCalled()
    })

    it('exposes the application version as read-only state', async () => {
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: {} },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)

        await service.loadAppVersion()

        expect(service.appVersion().appVersionNumber).toBeTruthy()
    })

    it('exposes user updates as read-only state', () => {
        const storage = {
            set: vi.fn().mockName('Storage.set'),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)
        const user = {
            uid: '42',
            display_name: 'Mapper',
            connected: true,
        }

        service.setUserInfo(user)

        expect(service.userInfo()).toEqual(user)
        expect(service.getUserInfo()).toEqual(user)
        expect(storage.set).toHaveBeenCalledWith('user_info', user)
    })

    it('exposes the current zoom as read-only state', () => {
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: {} },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)

        expect(service.currentZoom()).toBeUndefined()

        service.setCurrentZoom(16)

        expect(service.currentZoom()).toBe(16)
    })

    it('invalidates only the changeset id', () => {
        const storage = {
            set: vi.fn().mockName('Storage.set'),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)
        service.changeset = {
            id: '123',
            created_at: 100,
            last_changeset_activity: 200,
            comment: 'Survey',
        }

        service.invalidateChangeset()

        expect(service.changeset).toEqual({
            id: '',
            created_at: 100,
            last_changeset_activity: 200,
            comment: 'Survey',
        })
        expect(storage.set).toHaveBeenCalledTimes(1)
        expect(storage.set).toHaveBeenCalledWith('changeset', service.changeset)
    })

    it('persists changeset activity in the complete changeset object', () => {
        const storage = { set: vi.fn().mockName('Storage.set') }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)
        service.changeset = {
            id: '123',
            created_at: 100,
            last_changeset_activity: 200,
            comment: 'Survey',
        }

        service.updateChangesetLastActivity(300)

        expect(service.changeset).toEqual({
            id: '123',
            created_at: 100,
            last_changeset_activity: 300,
            comment: 'Survey',
        })
        expect(storage.set).toHaveBeenCalledWith('changeset', service.changeset)
        expect(storage.set).not.toHaveBeenCalledWith(
            'last_changeset_activity',
            expect.anything()
        )
    })

    it('resets every changeset lifecycle field', () => {
        const storage = { set: vi.fn().mockName('Storage.set') }
        TestBed.configureTestingModule({
            providers: [
                { provide: AppStorage, useValue: storage },
                { provide: HttpClient, useValue: {} },
                { provide: TranslateService, useValue: {} },
            ],
        })
        const service = TestBed.inject(ConfigService)
        service.changeset = {
            id: '123',
            created_at: 100,
            last_changeset_activity: 200,
            comment: 'Survey',
        }

        service.resetChangeset()

        expect(service.changeset).toEqual({
            id: '',
            created_at: 0,
            last_changeset_activity: 0,
            comment: '',
        })
        expect(storage.set).toHaveBeenCalledWith('changeset', service.changeset)
    })

    describe('startup defaults and storage', () => {
        const createService = (stored: unknown = null) => {
            const storage = {
                get: vi.fn().mockResolvedValue(stored),
                set: vi.fn().mockResolvedValue(undefined),
            }
            TestBed.resetTestingModule()
            TestBed.configureTestingModule({
                providers: [
                    { provide: AppStorage, useValue: storage },
                    { provide: HttpClient, useValue: {} },
                    { provide: TranslateService, useValue: {} },
                ],
            })
            return { service: TestBed.inject(ConfigService), storage }
        }

        it('dates a surveyed object with check_date on a new installation', () => {
            const { service } = createService()

            expect(service.config().checkedKey).toBe('check_date')
        })

        it('keeps the survey date key a V2 user chose', async () => {
            const { service } = createService({
                checkedKey: 'survey:date',
                openObjectSheetAsPreview: false,
            })

            const config = await firstValueFrom(service.loadConfig$(undefined))

            expect(config.checkedKey).toBe('survey:date')
        })

        it('moves a V1 configuration from its survey:date default to check_date once', async () => {
            const { service, storage } = createService({
                checkedKey: 'survey:date',
                languageUi: 'en',
            })

            const config = await firstValueFrom(service.loadConfig$(undefined))

            expect(config.checkedKey).toBe('check_date')
            expect(storage.set).toHaveBeenCalledWith(
                'config',
                expect.objectContaining({
                    checkedKey: 'check_date',
                    openObjectSheetAsPreview: false,
                })
            )
        })

        it('keeps check_date chosen in V1', async () => {
            const { service } = createService({ checkedKey: 'check_date' })

            const config = await firstValueFrom(service.loadConfig$(undefined))

            expect(config.checkedKey).toBe('check_date')
        })

        it('writes a freshly created configuration once, not once per layer flag', async () => {
            const { service, storage } = createService(null)

            await firstValueFrom(service.loadConfig$(undefined))

            expect(storage.set).toHaveBeenCalledTimes(1)
        })

        it('does not rewrite a configuration it did not change', async () => {
            const { service, storage } = createService()
            storage.get.mockResolvedValue({
                languageUi: 'en',
                isSelectableLine: false,
                basemap: service.config().basemap,
                openObjectSheetAsPreview: false,
            })

            await firstValueFrom(
                service.loadConfig$({ uiLanguages: ['en'], language: [] })
            )

            expect(storage.set).not.toHaveBeenCalled()
            expect(service.selecableLayers).not.toContain('way_line')
        })

        it('still persists the selectable layer settings when the user changes them', () => {
            const { service, storage } = createService()

            service.setIsSelectablePolygon(true)

            expect(service.selecableLayers).toContain('way_fill')
            expect(storage.set).toHaveBeenCalledWith(
                'config',
                expect.objectContaining({ isSelectablePolygon: true })
            )
        })

        it('does not write defaults over a stored configuration it could not read', async () => {
            const { service, storage } = createService()
            service.protectUnreadableStoredConfig()

            service.setLimitFeatures(500)

            expect(service.config().limitFeatures).toBe(500)
            expect(storage.set).not.toHaveBeenCalled()

            await firstValueFrom(service.loadConfig$(undefined))
            storage.set.mockClear()
            service.setLimitFeatures(600)

            expect(storage.set).toHaveBeenCalledWith(
                'config',
                expect.objectContaining({ limitFeatures: 600 })
            )
        })
    })

    describe('last map view', () => {
        const createService = (values: Record<string, unknown>) => {
            const storage = {
                get: vi.fn((key: string) =>
                    Promise.resolve(values[key] ?? null)
                ),
                set: vi.fn().mockResolvedValue(undefined),
            }
            TestBed.resetTestingModule()
            TestBed.configureTestingModule({
                providers: [
                    { provide: AppStorage, useValue: storage },
                    { provide: HttpClient, useValue: {} },
                    { provide: TranslateService, useValue: {} },
                ],
            })
            return { service: TestBed.inject(ConfigService), storage }
        }
        const view = { lng: 5.7, lat: 45.2, zoom: 17, bearing: 10 }

        it('saves a map move under its own key without touching the settings', () => {
            const { service, storage } = createService({})
            const settings = service.config()

            service.setLastView(view)
            service.setLastView({ ...view })

            expect(service.config()).toBe(settings)
            expect(service.lastView()).toEqual(view)
            expect(storage.set.mock.calls).toEqual([['lastView', view]])
        })

        it('moves a view stored in the settings to its own key first', async () => {
            const { service, storage } = createService({
                config: { limitFeatures: 250, lastView: view },
            })

            const config = await firstValueFrom(service.loadConfig$(undefined))

            expect(config.lastView).toEqual(view)
            expect(service.lastView()).toEqual(view)
            expect(service.config()).not.toHaveProperty('lastView')
            await vi.waitFor(() => expect(storage.set).toHaveBeenCalledTimes(2))
            expect(storage.set.mock.calls[0]).toEqual(['lastView', view])
            expect(storage.set.mock.calls[1][0]).toBe('config')
            expect(storage.set.mock.calls[1][1]).not.toHaveProperty('lastView')
            expect(storage.set.mock.calls[1][1]).toMatchObject({
                limitFeatures: 250,
            })
        })

        it('prefers the view key over an older copy in the settings', async () => {
            const { service } = createService({
                config: { lastView: { lng: 1, lat: 1, zoom: 3, bearing: 0 } },
                lastView: view,
            })

            const config = await firstValueFrom(service.loadConfig$(undefined))

            expect(config.lastView).toEqual(view)
        })
    })

    describe('interface language', () => {
        const offered = ['en', 'fr', 'de', 'zh-CN', 'zh-TW']
        it.each([
            ['fr', [], 'fr'],
            ['da', ['da-DK'], 'en'],
            ['zh', ['zh-TW'], 'zh-TW'],
            ['zh', ['zh-HK'], 'zh-TW'],
            ['zh', ['zh-CN'], 'zh-CN'],
            ['zh', ['zh-Hans-SG'], 'zh-CN'],
            ['zh', [], 'zh-CN'],
            ['zh', ['fr-FR'], 'zh-CN'],
        ])(
            'resolves %s preferred as %j to %s',
            (requested, preferred, expected) => {
                expect(resolveUiLanguage(requested, offered, preferred)).toBe(
                    expected
                )
            }
        )
    })

    describe('default country', () => {
        it.each([
            [['fr'], 'FR'],
            [['fr-BE', 'fr'], 'BE'],
            [['fr', 'en-US'], 'US'],
            [['de'], 'DE'],
            [['es'], 'ES'],
            [['pt-BR'], 'BR'],
            [['en-GB'], 'GB'],
            [[], 'GB'],
            [['not a locale'], 'GB'],
            [['es-419'], 'GB'],
            [['es-419', 'es-MX'], 'MX'],
        ])('derives the country of %j as %s', (languages, expected) => {
            expect(defaultCountryFromLocale(languages)).toBe(expected)
        })
    })
})
