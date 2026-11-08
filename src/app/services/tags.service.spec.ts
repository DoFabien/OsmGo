import { HttpClient } from '@angular/common/http'
import { TestBed } from '@angular/core/testing'
import type { OsmGoFeature } from '@osmgo/type'
import { AppStorage } from '@services/app-storage.service'
import { firstValueFrom, forkJoin, of } from 'rxjs'

import { TagsService } from './tags.service'

const createValidTag = () => ({
    id: 'amenity/cafe',
    icon: 'maki-cafe',
    markerColor: '#123456',
    presets: [],
    geometry: ['point'],
    tags: { amenity: 'cafe' },
})

const createValidPreset = () => ({
    key: 'amenity',
    lbl: { en: 'Amenity' },
    type: 'text',
})

describe('TagsService', () => {
    it('exposes loaded tag catalog data as read-only signals', async () => {
        const tagsConfig = {
            primaryKeys: ['amenity'],
            tags: [createValidTag()],
        }
        const presets = {
            cafe: createValidPreset(),
        }
        const http = {
            get: vi.fn((url: string) =>
                of(url.endsWith('tags.json') ? tagsConfig : presets)
            ),
        }
        const storage = { set: vi.fn(() => Promise.resolve()) }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: http },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)

        await firstValueFrom(service.getTagsConfig$())
        await firstValueFrom(service.loadPresets$())

        expect(service.primaryKeys()).toEqual(['amenity'])
        expect(service.presets()).toBe(presets)
        expect(storage.set).toHaveBeenCalledWith('catalogCache:v1:tags', {
            schemaVersion: 1,
            value: tagsConfig,
        })
        expect(storage.set).toHaveBeenCalledWith('catalogCache:v1:presets', {
            schemaVersion: 1,
            value: presets,
        })
    })

    it('loads and caches the separate brand catalog only on demand', async () => {
        const basePresets = {
            name: { key: 'name', lbl: { en: 'Name' }, type: 'text' },
        }
        const brandPresets = {
            'shop#books#brand': {
                key: 'brand',
                lbl: { en: 'Brand' },
                type: 'list',
                options: [],
            },
        }
        const http = {
            get: vi.fn((url: string) =>
                of(
                    url.endsWith('brandPresets.json')
                        ? brandPresets
                        : basePresets
                )
            ),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: http },
                {
                    provide: AppStorage,
                    useValue: { set: vi.fn(() => Promise.resolve()) },
                },
            ],
        })
        const service = TestBed.inject(TagsService)

        await firstValueFrom(service.loadPresets$())
        expect(service.presets()['shop#books#brand']).toBeUndefined()
        expect(service.brandPresetsLoaded()).toBe(false)

        await firstValueFrom(
            forkJoin([service.loadBrandPresets$(), service.loadBrandPresets$()])
        )

        expect(service.brandPresetsLoaded()).toBe(true)
        expect(service.presets()).toMatchObject({
            name: basePresets.name,
            'shop#books#brand': brandPresets['shop#books#brand'],
        })
        expect(
            http.get.mock.calls.filter(([url]) =>
                String(url).endsWith('brandPresets.json')
            )
        ).toHaveLength(1)

        await firstValueFrom(service.loadBrandPresets$())
        expect(http.get).toHaveBeenCalledTimes(2)
    })

    it('exposes tag list preferences as read-only signals', () => {
        const storage = {
            set: vi.fn().mockName('Storage.set'),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: {} },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)

        service.setBookMarksIds(['amenity/cafe'])
        service.setHiddenTagsIds(['highway/path'])
        service.setLastTagsUsedIds(['shop/bakery'])

        expect(service.bookmarksIds()).toEqual(['amenity/cafe'])
        expect(service.hiddenTagsIds()).toEqual(['highway/path'])
        expect(service.lastTagsUsedIds()).toEqual(['shop/bakery'])
        expect(storage.set).toHaveBeenCalledTimes(3)
    })

    it('checks every feature tag when finding the primary tag', async () => {
        const http = {
            get: vi.fn(() =>
                of({ primaryKeys: ['amenity'], tags: [createValidTag()] })
            ),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: http },
                {
                    provide: AppStorage,
                    useValue: { set: vi.fn(() => Promise.resolve()) },
                },
            ],
        })
        const service = TestBed.inject(TagsService)
        const feature: OsmGoFeature = {
            type: 'Feature',
            id: 'node/1',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: {
                hexColor: '',
                icon: '',
                id: 1,
                marker: '',
                meta: {
                    changeset: '',
                    timestamp: '',
                    uid: '',
                    user: '',
                    version: 1,
                },
                primaryTag: { key: 'amenity', value: 'cafe' },
                tags: { name: 'Corner Cafe', amenity: 'cafe' },
                type: 'node',
                originalData: null,
            },
        }

        await firstValueFrom(service.getTagsConfig$())

        expect(service.findPkey(feature)).toEqual({
            key: 'amenity',
            value: 'cafe',
        })
    })

    it('finds the primary tag by key priority, not by tag order', async () => {
        const healthcareTag = {
            ...createValidTag(),
            id: 'healthcare/pharmacy',
            tags: { healthcare: 'pharmacy' },
        }
        const http = {
            get: vi.fn(() =>
                of({
                    primaryKeys: ['shop', 'amenity', 'healthcare'],
                    tags: [createValidTag(), healthcareTag],
                })
            ),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: http },
                {
                    provide: AppStorage,
                    useValue: { set: vi.fn(() => Promise.resolve()) },
                },
            ],
        })
        const service = TestBed.inject(TagsService)

        await firstValueFrom(service.getTagsConfig$())

        expect(
            service.findPkey([
                { key: 'healthcare', value: 'pharmacy' },
                { key: 'name', value: 'Pharmacie' },
                { key: 'amenity', value: 'pharmacy' },
            ])
        ).toEqual({ key: 'amenity', value: 'pharmacy' })
        expect(
            service.findPkey([
                { key: 'amenity', value: '' },
                { key: 'healthcare', value: 'pharmacy' },
            ])
        ).toEqual({ key: 'healthcare', value: 'pharmacy' })
        expect(service.findPkey([{ key: 'amenity', value: '' }])).toEqual({
            key: 'amenity',
            value: '',
        })
        expect(service.findPkey([{ key: 'name', value: 'x' }])).toBeUndefined()
    })

    it('exposes a light catalog for the converter', async () => {
        const full = {
            ...createValidTag(),
            lbl: { en: 'Cafe', fr: 'Café' },
            terms: { en: 'coffee' },
            description: { en: 'A cafe' },
            presets: ['name', 'wheelchair'],
            moreFields: ['phone'],
            addTags: { amenity: 'cafe', cuisine: 'coffee_shop' },
            searchable: false,
            deprecated: true,
            replace: { amenity: 'restaurant' },
            matchScore: 0.5,
        }
        const http = {
            get: vi.fn(() => of({ primaryKeys: ['amenity'], tags: [full] })),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: http },
                {
                    provide: AppStorage,
                    useValue: {
                        set: vi.fn(() => Promise.resolve()),
                        get: vi.fn(() => Promise.resolve(null)),
                    },
                },
            ],
        })
        const service = TestBed.inject(TagsService)

        await firstValueFrom(service.loadTags$())

        const [light] = service.converterTags()
        expect(light).toEqual({
            id: 'amenity/cafe',
            tags: { amenity: 'cafe' },
            addTags: { amenity: 'cafe', cuisine: 'coffee_shop' },
            icon: 'maki-cafe',
            markerColor: '#123456',
            deprecated: true,
            replace: { amenity: 'restaurant' },
            searchable: false,
            matchScore: 0.5,
            presets: [],
            geometry: [],
        })
        expect(service.converterTags()).toBe(service.converterTags())
    })

    it('uses a versioned valid cache when the current catalog is malformed', async () => {
        const warning = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined)
        const cachedTags = {
            primaryKeys: ['amenity'],
            tags: [createValidTag()],
        }
        const storage = {
            get: vi.fn(() =>
                Promise.resolve({ schemaVersion: 1, value: cachedTags })
            ),
            set: vi.fn(() => Promise.resolve()),
        }
        const http = {
            get: vi.fn(() => of({ primaryKeys: ['amenity'], tags: [{}] })),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: http },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)

        const tags = await firstValueFrom(service.getTagsConfig$())

        expect(tags).toEqual(cachedTags)
        expect(storage.get).toHaveBeenCalledWith('catalogCache:v1:tags')
        expect(service.primaryKeys()).toEqual(['amenity'])
        expect(warning).toHaveBeenCalledWith(
            'Using the last valid tags catalog.',
            expect.any(Error)
        )
        warning.mockRestore()
    })

    it('removes a tag from hidden preferences when bookmarking it', () => {
        const storage = {
            set: vi.fn().mockName('Storage.set'),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: {} },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)
        const tag = {
            id: 'amenity/cafe',
            tags: { amenity: 'cafe' },
        } as any
        service.setHiddenTagsIds([tag.id])

        service.addBookMark(tag)

        expect(service.hiddenTagsIds()).toEqual([])
        expect(service.bookmarksIds()).toEqual([tag.id])
        expect(storage.set).toHaveBeenCalledWith('hiddenTagsIds', [])
        expect(storage.set).toHaveBeenCalledWith('bookmarksIds', [tag.id])
    })

    it.each([
        ['bookmarks first', true],
        ['hidden tags first', false],
    ])(
        'restores disjoint bookmark and hidden sets with %s',
        async (_, bookmarksFirst) => {
            const storage = {
                get: vi.fn((key: string) =>
                    Promise.resolve(
                        key === 'bookmarksIds'
                            ? ['amenity/cafe']
                            : ['amenity/cafe', 'highway/path']
                    )
                ),
                set: vi.fn(),
            }
            TestBed.configureTestingModule({
                providers: [
                    { provide: HttpClient, useValue: {} },
                    { provide: AppStorage, useValue: storage },
                ],
            })
            const service = TestBed.inject(TagsService)

            if (bookmarksFirst) {
                await firstValueFrom(service.loadBookMarksIds$())
                await firstValueFrom(service.loadHiddenTagsIds$())
            } else {
                await firstValueFrom(service.loadHiddenTagsIds$())
                await firstValueFrom(service.loadBookMarksIds$())
            }

            expect(service.bookmarksIds()).toEqual(['amenity/cafe'])
            expect(service.hiddenTagsIds()).toEqual(['highway/path'])
        }
    )

    it('clones a user tag before applying local defaults', () => {
        const storage = { set: vi.fn() }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: {} },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)
        const input = {
            id: 'amenity/custom',
            tags: { amenity: 'custom' },
            geometry: ['point'],
            icon: 'original-icon',
            markerColor: '#ffffff',
        } as any

        service.addUserTags(input)

        expect(input).toMatchObject({
            geometry: ['point'],
            icon: 'original-icon',
            markerColor: '#ffffff',
        })
        expect(service.userTags[0]).not.toBe(input)
        expect(service.userTags[0].tags).not.toBe(input.tags)
        expect(service.userTags[0]).toMatchObject({
            geometry: ['point', 'vertex', 'line', 'area'],
            icon: 'maki-circle-custom',
            markerColor: '#000000',
        })
    })

    it('creates a normalized custom tag with an unambiguous canonical ID', () => {
        const storage = { set: vi.fn() }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: {} },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)

        const customTag = service.addCustomTag(
            ' cuisine ',
            ' Cafe\u0301/restaurant '
        )

        expect(customTag).toMatchObject({
            id: 'cuisine/Caf%C3%A9%2Frestaurant',
            tags: { cuisine: 'Café/restaurant' },
            isUserTag: true,
        })
        expect(customTag.key).toBeUndefined()
        expect(service.tagsById()[customTag.id]).toBe(customTag)
        expect(storage.set).toHaveBeenCalledWith('userTags', [customTag])
    })

    it('reuses one exact catalog match instead of creating a duplicate', () => {
        const storage = { set: vi.fn() }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: {} },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)
        const existing = createValidTag()
        service.addUserTags(existing)
        storage.set.mockClear()

        const selected = service.addCustomTag('amenity', 'cafe')

        expect(selected.id).toBe(existing.id)
        expect(service.userTags).toHaveLength(1)
        expect(storage.set).not.toHaveBeenCalled()
    })

    it('quarantines malformed user tags and keeps startup recoverable', async () => {
        const corrupted = { id: 'not-an-array' }
        const storage = {
            get: vi.fn(() => Promise.resolve(corrupted)),
            set: vi.fn(() => Promise.resolve()),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: {} },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)

        await expect(firstValueFrom(service.loadUserTags$())).resolves.toEqual(
            []
        )
        expect(service.userTagsRecoveryWarning()).toBe(true)
        expect(storage.set).toHaveBeenCalledWith('userTagsCorrupted', corrupted)
        expect(storage.set).toHaveBeenCalledWith('userTags', [])
    })

    it('keeps built-in tag definitions authoritative when user IDs collide', async () => {
        const builtIn = {
            ...createValidTag(),
            icon: 'built-in',
        }
        const userDuplicate = {
            id: 'amenity/cafe',
            tags: { amenity: 'cafe' },
            icon: 'user',
        }
        const userOnly = {
            id: 'amenity/custom',
            tags: { amenity: 'custom' },
            icon: 'user-only',
        }
        const http = {
            get: vi.fn(() => of({ primaryKeys: ['amenity'], tags: [builtIn] })),
        }
        const storage = {
            get: vi.fn(() => Promise.resolve([userDuplicate, userOnly])),
            set: vi.fn(() => Promise.resolve()),
        }
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: http },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)

        const tags = await firstValueFrom(service.loadTags$())

        expect(tags).toEqual([builtIn, userOnly])
        expect(service.tags()).toEqual([builtIn, userOnly])
        expect(service.tagsById()).toEqual({
            'amenity/cafe': builtIn,
            'amenity/custom': userOnly,
        })
        expect(service.catalogMetrics().tags).toMatchObject({
            characters: expect.any(Number),
            downloadMs: expect.any(Number),
            parseMs: expect.any(Number),
            indexMs: expect.any(Number),
        })
    })

    it('warns in development when catalog parsing exceeds its budget', async () => {
        const tagsConfig = {
            primaryKeys: ['amenity'],
            tags: [createValidTag()],
        }
        const http = {
            get: vi.fn(() => of(JSON.stringify(tagsConfig))),
        }
        const storage = { set: vi.fn(() => Promise.resolve()) }
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(10)
            .mockReturnValueOnce(10)
            .mockReturnValueOnce(300)
        const consoleWarn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined)
        TestBed.configureTestingModule({
            providers: [
                { provide: HttpClient, useValue: http },
                { provide: AppStorage, useValue: storage },
            ],
        })
        const service = TestBed.inject(TagsService)

        await firstValueFrom(service.getTagsConfig$())

        expect(consoleWarn).toHaveBeenCalledWith(
            'Catalog tags parseMs exceeded its development budget.',
            { durationMs: 290, budgetMs: 250, characters: expect.any(Number) }
        )
    })
})
