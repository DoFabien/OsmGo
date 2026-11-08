import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { By } from '@angular/platform-browser'
import { TranslateModule } from '@ngx-translate/core'
import type { Preset, TagConfig } from '@osmgo/type'
import { ConfigService } from '@services/config.service'
import { DataService, UploadQueueLockedError } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmApiService } from '@services/osmApi.service'
import { TagsService } from '@services/tags.service'
import { of, Subject, throwError } from 'rxjs'
import { EditOtherTag } from './components/edit/OtherTag.component'
import { MultiSelectComponent } from './components/multi-select/multi-select.component'
import { SemiComboComponent } from './components/semi-combo/semi-combo.component'
import { ObjectEditorContentComponent } from './modal'

const catalogPresets: Record<
    string,
    Preset
> = require('../../../assets/tagsAndPresets/presets.json')
for (const [id, preset] of Object.entries(catalogPresets)) {
    preset._id = id
}
const catalogTags: {
    primaryKeys: string[]
    tags: TagConfig[]
} = require('../../../assets/tagsAndPresets/tags.json')

describe('ObjectEditorContentComponent', () => {
    const genderPreset = {
        type: 'select',
        iDtype: 'radio',
        lbl: { en: 'Gender' },
        keys: ['male', 'female', 'unisex'],
        options: [{ v: 'male' }, { v: 'female' }, { v: 'unisex' }],
    } as any
    const tagConfig = {
        id: 'amenity/toilets',
        lbl: { en: 'Toilets' },
        tags: { amenity: 'toilets' },
        presets: ['gender'],
    }

    function featureWith(id: number, tags: Record<string, string | number>) {
        return {
            type: 'Feature',
            id: `node/${id}`,
            geometry: { type: 'Point', coordinates: [1, 2] },
            properties: {
                type: 'node',
                id,
                tags,
                meta: {
                    changeset: '1',
                    timestamp: 0,
                    uid: '1',
                    user: 'mapper',
                    version: 1,
                },
            },
        }
    }

    function createPage(
        tags: Record<string, string | number>,
        type: 'Create' | 'Update' = 'Update',
        options: {
            tagsService?: Record<string, unknown>
            dialogResult?: unknown
            dataService?: Record<string, unknown>
            geometry?: unknown
            changeType?: 'Create' | 'Update' | 'Delete'
            osmApi?: Record<string, any>
        } = {}
    ) {
        const feature = featureWith(1, tags)
        if (options.geometry) {
            feature.geometry = options.geometry as typeof feature.geometry
        }
        if (options.changeType) {
            Object.assign(feature.properties, {
                changeType: options.changeType,
            })
        }
        const savedFields: Record<string, { tags: any[] }> = {}
        const tagsService = {
            presets: () => ({ gender: genderPreset }),
            tags: () => [tagConfig],
            jsonSprites: () => ({}),
            bookmarksIds: () => [],
            primaryKeys: () => [],
            savedFields,
            findPkey: () => ({ key: 'amenity', value: 'toilets' }),
            addTagTolastTagsUsed: vi.fn(),
            addSavedField: vi.fn((tagId: string, fields: any[]) => {
                savedFields[tagId] = { tags: fields }
            }),
            ...options.tagsService,
        }
        const osmApi: Record<string, any> = {
            createOsmNode: vi.fn((createdFeature) => of(createdFeature)),
            ...options.osmApi,
        }
        const mapService = {
            isProcessing: () => false,
            setIsProcessing: vi.fn(),
        }
        const nestedDialogRef = {
            componentRef: { setInput: vi.fn() },
            afterClosed: () => of(options.dialogResult),
        }
        const dialog = { open: vi.fn(() => nestedDialogRef) }
        const snackBar = { open: vi.fn() }

        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: [ObjectEditorContentComponent, TranslateModule.forRoot()],
            providers: [
                { provide: OsmApiService, useValue: osmApi },
                { provide: TagsService, useValue: tagsService },
                {
                    provide: MapService,
                    useValue: mapService,
                },
                { provide: DataService, useValue: options.dataService ?? {} },
                {
                    provide: ConfigService,
                    useValue: {
                        config: () => ({
                            checkedKey: 'survey:date',
                            countryTags: 'US',
                            languageTags: 'en',
                            languageUi: 'en',
                        }),
                        getDisplaySurveyCard: () => 'never',
                        getSurveyCardYear: () => 1,
                        getUiLanguage: () => 'en',
                        getAddSurveyDate: () => false,
                    },
                },
                { provide: MatDialog, useValue: dialog },
                { provide: MatSnackBar, useValue: snackBar },
            ],
        })
        const fixture = TestBed.createComponent(ObjectEditorContentComponent)
        fixture.componentRef.setInput('data', feature)
        fixture.componentRef.setInput('type', type)
        fixture.componentRef.setInput('origineData', 'data')
        fixture.detectChanges()
        const page = fixture.componentInstance
        return {
            page,
            fixture,
            dialog,
            mapService,
            osmApi,
            snackBar,
            tagsService,
            nestedDialogRef,
        }
    }

    it('creates an empty editable field without an undefined key', () => {
        const { page } = createPage({ amenity: 'toilets' })

        page.initComponent(tagConfig as any)

        const genderTag = page.tags.find((tag) => tag.preset === genderPreset)
        expect(genderTag).toEqual({
            key: '',
            value: '',
            preset: genderPreset,
        })
    })

    it('keeps an existing multi-key value and serializes valid tags only', () => {
        const { page } = createPage({
            amenity: 'toilets',
            unisex: 'yes',
        })
        page.initComponent(tagConfig as any)
        page.tags.push({ key: undefined, value: 'unisex' } as any)

        page.pushTagsToFeature()

        expect(page.feature.properties.tags).toEqual({
            amenity: 'toilets',
            unisex: 'yes',
        })
    })

    it('normalizes numeric values to strings without dropping zero', () => {
        const { page } = createPage({
            amenity: 'toilets',
            level: 0,
            name: '  Ground floor  ',
        })

        page.pushTagsToFeature()

        expect(page.feature.properties.tags).toEqual({
            amenity: 'toilets',
            level: '0',
            name: 'Ground floor',
        })
    })

    it('does not report a change when tags are only reordered', () => {
        const { page } = createPage({
            amenity: 'toilets',
            name: 'Public toilets',
            level: 0,
        })

        page.tags.reverse()

        expect(page.dataIsChanged()).toBe(false)
        expect(page.changedFieldCount()).toBe(0)
    })

    it('merges a multi-key collision and keeps preset metadata', () => {
        const { page } = createPage({
            amenity: 'toilets',
            unisex: 'yes',
            male: 'yes',
        })
        page.initComponent(tagConfig as any)
        const source = page.tags.find((tag) => tag.preset === genderPreset)
        if (!source) throw new Error('Missing gender fixture.')

        page.applyTagSelection({
            source,
            tag: { ...source, key: 'male', value: 'yes' },
        })

        const genderTags = page.tags.filter((tag) => tag.key === 'male')
        expect(genderTags).toHaveLength(1)
        expect(genderTags[0]).toMatchObject({
            value: 'yes',
            preset: genderPreset,
        })
    })

    it('updates survey tags with a new signal value', () => {
        const { page } = createPage({ amenity: 'toilets' })
        const previousTags = page.tags

        page.addSurveyDate()

        expect(page.tags).not.toBe(previousTags)
        expect(page.tags).toContainEqual({
            key: 'survey:date',
            value: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        })
    })

    it('keeps and refreshes the other survey date key when saving', () => {
        const { page } = createPage({
            amenity: 'toilets',
            check_date: '2021-05-04',
        })

        page.addSurveyDate()

        const dates = page.tags.filter(
            (tag) => tag.key === 'survey:date' || tag.key === 'check_date'
        )
        expect(dates.map((tag) => tag.key).sort()).toEqual([
            'check_date',
            'survey:date',
        ])
        for (const tag of dates) {
            expect(tag.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
            expect(tag.value).not.toBe('2021-05-04')
        }
    })

    it('remembers only reusable attributes for the current category', () => {
        const { page, tagsService } = createPage(
            {
                amenity: 'toilets',
                name: 'Unique name',
                male: 'yes',
                material: 'wood',
                level: 0,
                'survey:date': '2026-08-03',
            },
            'Create'
        )

        page.rememberFields(tagConfig as any, page.tags)

        expect(tagsService.addSavedField).toHaveBeenCalledWith(
            'amenity/toilets',
            expect.arrayContaining([
                { key: 'male', value: 'yes' },
                { key: 'material', value: 'wood' },
                { key: 'level', value: '0' },
            ])
        )
        const remembered = tagsService.addSavedField.mock.calls[0][1]
        const rememberedKeys = remembered.map((tag) => tag.key)
        expect(rememberedKeys).not.toContain('amenity')
        expect(rememberedKeys).not.toContain('name')
        expect(rememberedKeys).not.toContain('survey:date')
        expect(page.hasSavedFields).toBe(true)
    })

    it('restores the previous attributes without replacing unique fields', () => {
        const { page, tagsService } = createPage(
            { amenity: 'toilets', name: 'New object' },
            'Create'
        )
        tagsService.savedFields['amenity/toilets'] = {
            tags: [
                { key: 'amenity', value: 'toilets' },
                { key: 'name', value: 'Old object' },
                { key: 'survey:date', value: '2025-01-01' },
                { key: 'material', value: 'wood' },
            ],
        }
        page.initComponent(tagConfig as any)

        page.restoreFields(page.tagId, page.tags)

        expect(page.tags).toContainEqual({ key: 'material', value: 'wood' })
        expect(page.findElement(page.tags, { key: 'name' }).value).toBe(
            'New object'
        )
        expect(page.tags.some((tag) => tag.key === 'survey:date')).toBe(false)
    })

    it('automatically remembers attributes after a successful creation', () => {
        const { page, osmApi, tagsService } = createPage(
            {
                amenity: 'toilets',
                material: 'brick',
                wheelchair: 'yes',
            },
            'Create'
        )

        page.createOsmElement(tagConfig as any)

        expect(osmApi.createOsmNode).toHaveBeenCalledOnce()
        expect(tagsService.addSavedField).toHaveBeenCalledWith(
            'amenity/toilets',
            expect.arrayContaining([
                { key: 'material', value: 'brick' },
                { key: 'wheelchair', value: 'yes' },
            ])
        )
    })

    it('emits its result to the unified object sheet', () => {
        const { page } = createPage({ amenity: 'toilets' })
        const result = { redraw: true }
        const dismissed = vi.fn()
        page.dismissed.subscribe(dismissed)

        page.dismiss(result)

        expect(dismissed).toHaveBeenCalledWith(result)
    })

    it('asks the unified sheet to select a category', () => {
        const { page, dialog } = createPage({ amenity: 'toilets' }, 'Update')
        const categoryRequested = vi.fn()
        page.categoryRequested.subscribe(categoryRequested)

        page.openPrimaryTagModal()

        expect(categoryRequested).toHaveBeenCalledOnce()
        expect(dialog.open).not.toHaveBeenCalled()
    })

    it('shows feedback through the Material snackbar', () => {
        const { page, snackBar } = createPage({ amenity: 'toilets' })

        page.presentToast('Unable to save changes.')

        expect(snackBar.open).toHaveBeenCalledWith(
            'Unable to save changes.',
            'SHARED.CLOSE',
            { duration: 4000 }
        )
    })

    it('resynchronizes cloned and original tags when the editor input changes', () => {
        const { page, fixture } = createPage(
            { amenity: 'toilets', name: 'Object A' },
            'Update'
        )

        fixture.componentRef.setInput(
            'data',
            featureWith(2, { amenity: 'toilets', name: 'Object B' })
        )
        fixture.detectChanges()

        expect(page.feature.id).toBe('node/2')
        expect(page.findElement(page.tags, { key: 'name' }).value).toBe(
            'Object B'
        )
        expect(page.originalTags).toContainEqual({
            key: 'name',
            value: 'Object B',
        })
    })

    it('does not overwrite an edited draft when another feature input arrives', () => {
        const { page, fixture } = createPage({
            amenity: 'toilets',
            name: 'Object A',
        })
        page.findElement(page.tags, { key: 'name' }).value = 'Draft A'

        fixture.componentRef.setInput(
            'data',
            featureWith(2, { amenity: 'toilets', name: 'Object B' })
        )
        fixture.detectChanges()

        expect(page.feature.id).toBe('node/1')
        expect(page.findElement(page.tags, { key: 'name' }).value).toBe(
            'Draft A'
        )
    })

    describe('with the real catalog', () => {
        const catalogTagsService = {
            brandPresetsLoaded: () => true,
            loadBrandPresets$: () => of(undefined),
            presets: () => catalogPresets,
            tags: () => catalogTags.tags,
            primaryKeys: () => catalogTags.primaryKeys,
        }

        function createCatalogPage(
            tags: Record<string, string | number>,
            type: 'Create' | 'Update' = 'Update',
            options: Parameters<typeof createPage>[2] = {}
        ) {
            const pkey = Object.entries(tags).find(([key]) =>
                catalogTags.primaryKeys.includes(key)
            )
            return createPage(tags, type, {
                ...options,
                tagsService: {
                    ...catalogTagsService,
                    findPkey: () =>
                        pkey ? { key: pkey[0], value: pkey[1] } : undefined,
                    ...options.tagsService,
                },
            })
        }

        const multiSelect = (
            fixture: ReturnType<typeof createPage>['fixture'],
            presetId: string
        ): MultiSelectComponent | undefined =>
            fixture.debugElement
                .queryAll(By.directive(MultiSelectComponent))
                .find(
                    (element) =>
                        element.componentInstance.preset()._id === presetId
                )?.componentInstance

        const toggle = (
            fixture: ReturnType<typeof createPage>['fixture'],
            presetId: string,
            key: string
        ): void => {
            const field = multiSelect(fixture, presetId)
            const item = field?.items().find((option) => option.key === key)
            if (!field || !item) throw new Error(`Missing option ${key}.`)
            field.toggle(item)
            fixture.detectChanges()
        }

        const otherTagKeys = (
            fixture: ReturnType<typeof createPage>['fixture']
        ): string[] =>
            fixture.debugElement
                .queryAll(By.directive(EditOtherTag))
                .map((element) => element.componentInstance.tag().key)

        it('adds female=yes to the toilets with male=yes and keeps both', () => {
            const { page, fixture } = createCatalogPage({
                amenity: 'toilets',
                male: 'yes',
            })
            fixture.detectChanges()

            const field = multiSelect(fixture, 'gender')
            expect(field).toBeDefined()
            expect(
                field?.items().find((item) => item.key === 'male')?.value
            ).toBe('yes')
            expect(otherTagKeys(fixture)).not.toContain('male')
            expect(
                page.tags.filter((tag) => tag.key === 'male' && tag.value)
            ).toHaveLength(1)

            toggle(fixture, 'gender', 'female')

            page.pushTagsToFeature()
            expect(page.feature.properties.tags).toEqual({
                amenity: 'toilets',
                male: 'yes',
                female: 'yes',
            })
            expect(page.changedFieldCount()).toBe(1)
        })

        it('removes the tag of an unchecked option and keeps the other values', () => {
            const { page, fixture } = createCatalogPage({
                amenity: 'toilets',
                male: 'yes',
                female: 'yes',
                unisex: 'no',
            })
            fixture.detectChanges()

            toggle(fixture, 'gender', 'male')

            page.pushTagsToFeature()
            expect(page.feature.properties.tags).toEqual({
                amenity: 'toilets',
                female: 'yes',
                unisex: 'no',
            })
        })

        it('attaches the payment tags of a bakery to its payment field', () => {
            const { page, fixture } = createCatalogPage({
                shop: 'bakery',
                'payment:cash': 'yes',
                'payment:visa': 'no',
                'payment:twint': 'yes',
            })
            fixture.detectChanges()

            const field = multiSelect(fixture, 'payment_multi')
            expect(field).toBeDefined()
            expect(
                Object.fromEntries(
                    (field?.items() ?? [])
                        .filter((item) => item.present)
                        .map((item) => [item.key, item.value])
                )
            ).toEqual({
                'payment:cash': 'yes',
                'payment:visa': 'no',
                'payment:twint': 'yes',
            })
            expect(
                otherTagKeys(fixture).filter((key) =>
                    key.startsWith('payment:')
                )
            ).toEqual([])

            toggle(fixture, 'payment_multi', 'payment:cards')
            toggle(fixture, 'payment_multi', 'payment:cash')

            page.pushTagsToFeature()
            expect(page.feature.properties.tags).toEqual({
                shop: 'bakery',
                'payment:cards': 'yes',
                'payment:visa': 'no',
                'payment:twint': 'yes',
            })
            expect(Object.keys(page.feature.properties.tags)).not.toContain(
                'payment:'
            )
        })

        it('shows an optional multi-value field that the object already uses', () => {
            const { fixture } = createCatalogPage({
                amenity: 'toilets',
                fee: 'yes',
                'payment:coins': 'yes',
            })
            fixture.detectChanges()

            expect(
                catalogTags.tags.find((tag) => tag.id === 'amenity/toilets')
                    ?.moreFields
            ).toContain('payment_multi_fee')
            expect(multiSelect(fixture, 'payment_multi_fee')).toBeDefined()
            expect(otherTagKeys(fixture)).not.toContain('payment:coins')
        })

        it('shows one fuel field for the two fuel lists of a fuel station', () => {
            const { page } = createCatalogPage({ amenity: 'fuel' })

            const fuelFields = page.tags.filter(
                (tag) => tag.preset?.key === 'fuel:'
            )
            expect(fuelFields).toHaveLength(1)
        })

        it('keeps a gender=* tag as a raw tag', () => {
            const { page, fixture } = createCatalogPage({
                amenity: 'toilets',
                gender: 'female',
            })
            fixture.detectChanges()

            const tag = page.tags.find(
                (candidate) => candidate.key === 'gender'
            )
            if (!tag) throw new Error('Missing gender tag.')
            expect(page.presetOf(tag)).toBeUndefined()
            expect(otherTagKeys(fixture)).toContain('gender')
        })

        it('adds the payment field from the tag list and attaches the existing tags', () => {
            const { page, fixture } = createCatalogPage({
                amenity: 'bench',
                'payment:cash': 'yes',
            })
            fixture.detectChanges()
            expect(otherTagKeys(fixture)).toContain('payment:cash')

            page.addNewKey('', 'payment_multi')
            page.addNewKey('', 'payment_multi_fee')
            fixture.detectChanges()

            expect(
                page.tags.filter((tag) => tag.preset?.key === 'payment:')
            ).toHaveLength(1)
            expect(multiSelect(fixture, 'payment_multi')).toBeDefined()
            expect(otherTagKeys(fixture)).not.toContain('payment:cash')
        })

        it('edits the cuisine as several values without losing an unlisted one', () => {
            const { page, fixture } = createCatalogPage({
                amenity: 'restaurant',
                cuisine: 'pizza;local_specialty',
            })
            fixture.detectChanges()

            const semiCombo = fixture.debugElement.query(
                By.directive(SemiComboComponent)
            ).componentInstance as SemiComboComponent
            expect(semiCombo.preset()._id).toBe('cuisine')
            expect(semiCombo.values()).toEqual(['pizza', 'local_specialty'])

            semiCombo.addValue('italian')
            fixture.detectChanges()
            semiCombo.removeValue(0)
            fixture.detectChanges()

            page.pushTagsToFeature()
            expect(page.feature.properties.tags['cuisine']).toBe(
                'local_specialty;italian'
            )
        })

        it('saves a value typed without the add button and asks before leaving', () => {
            const updateOsmElement = vi.fn((feature) => of(feature))
            const { page, fixture } = createCatalogPage(
                {
                    amenity: 'restaurant',
                    cuisine: 'local_specialty',
                    'payment:cash': 'yes',
                },
                'Update',
                { osmApi: { updateOsmElement } }
            )
            fixture.detectChanges()
            const semiCombo = fixture.debugElement.query(
                By.directive(SemiComboComponent)
            ).componentInstance as SemiComboComponent
            const payment = multiSelect(fixture, 'payment_multi')
            if (!payment) throw new Error('Missing payment field.')

            semiCombo.onQueryInput('Italian')
            payment.onCustomValueInput('Twint')

            expect(page.dataIsChanged()).toBe(true)
            expect(page.changedFieldCount()).toBe(2)

            page.updateOsmElement(page.tagConfig)

            expect(updateOsmElement).toHaveBeenCalledOnce()
            expect(updateOsmElement.mock.calls[0][0].properties.tags).toEqual(
                expect.objectContaining({
                    cuisine: 'local_specialty;italian',
                    'payment:cash': 'yes',
                    'payment:twint': 'yes',
                })
            )
        })

        it('creates the object with a value typed without the add button', () => {
            const { page, fixture, osmApi } = createCatalogPage(
                { amenity: 'restaurant' },
                'Create'
            )
            fixture.detectChanges()
            const semiCombo = fixture.debugElement.query(
                By.directive(SemiComboComponent)
            ).componentInstance as SemiComboComponent

            semiCombo.onQueryInput('pizza')
            page.createOsmElement(page.tagConfig)

            expect(
                osmApi.createOsmNode.mock.calls[0][0].properties.tags['cuisine']
            ).toBe('pizza')
        })

        it('drops the tags added by the old category when it changes', () => {
            const { page } = createCatalogPage({
                amenity: 'pharmacy',
                healthcare: 'pharmacy',
                dispensing: 'yes',
            })
            expect(page.tagConfig.id).toBe('amenity/pharmacy')
            const chemist = catalogTags.tags.find(
                (tag) => tag.id === 'shop/chemist'
            )
            if (!chemist) throw new Error('Missing chemist.')

            page.applyPrimaryTagSelection(structuredClone(chemist))
            page.pushTagsToFeature()

            expect(page.tagConfig.id).toBe('shop/chemist')
            expect(page.feature.properties.tags).toEqual({
                shop: 'chemist',
                dispensing: 'yes',
            })
        })

        it('keeps a tag of the old category that the new one adds again', () => {
            const { page } = createCatalogPage({
                amenity: 'pharmacy',
                healthcare: 'pharmacy',
            })
            const pharmacy = catalogTags.tags.find(
                (tag) => tag.id === 'amenity/pharmacy'
            )
            if (!pharmacy) throw new Error('Missing pharmacy.')

            page.applyPrimaryTagSelection(structuredClone(pharmacy))
            page.pushTagsToFeature()

            expect(page.feature.properties.tags).toEqual({
                amenity: 'pharmacy',
                healthcare: 'pharmacy',
            })
        })

        it('shows the replacement category once a deprecated tag is fixed', () => {
            const { page, fixture } = createCatalogPage({
                shop: 'fishmonger',
                name: 'Marée',
            })
            expect(page.tagConfig.id).toBe('shop/fishmonger')
            page.feature.properties.configId = 'shop/fishmonger'

            page.fixDeprecated({
                old: { shop: 'fishmonger' },
                replace: { shop: 'seafood' },
            })
            fixture.detectChanges()

            expect(page.tagConfig.id).toBe('shop/seafood')
            expect(
                (page.tagConfig as { deprecated?: boolean }).deprecated
            ).toBeFalsy()
            page.pushTagsToFeature()
            expect(page.feature.properties.tags).toEqual({
                shop: 'seafood',
                name: 'Marée',
            })
        })

        it('gives a category picked in the list the fields of its parents', () => {
            const { page } = createCatalogPage({ amenity: 'restaurant' })
            const pizza = catalogTags.tags.find(
                (tag) => tag.id === 'amenity/restaurant/pizza'
            )
            if (!pizza) throw new Error('Missing pizza restaurant.')
            expect(pizza.presets).not.toContain('wheelchair')

            page.applyPrimaryTagSelection(structuredClone(pizza))

            expect(page.tagConfig.id).toBe('amenity/restaurant/pizza')
            expect(page.tagConfig.presets).toContain('wheelchair')
            expect(
                page.tags.some((tag) => tag.preset?._id === 'wheelchair')
            ).toBe(true)
            expect(pizza.presets).not.toContain('wheelchair')
        })

        it('keeps one tracked entry per multi-key field while it is empty', () => {
            const { page } = createCatalogPage({ waterway: 'canal' })
            const emptyFields = page.tags.filter(
                (tag) => tag.preset && !tag.preset.key && tag.key === ''
            )

            const keys = page.tags.map((tag) => page.trackTag(tag))

            expect(emptyFields.length).toBeGreaterThan(1)
            expect(new Set(keys).size).toBe(keys.length)
        })

        it('shows the gender field of a barber that has no tag yet', () => {
            const { fixture } = createCatalogPage({
                shop: 'hairdresser',
                hairdresser: 'barber',
            })
            fixture.detectChanges()

            const field = multiSelect(fixture, 'gender_simple')

            expect(field).toBeDefined()
            expect(field?.items().map((item) => item.key)).toEqual([
                'female',
                'male',
            ])
        })

        it('never creates a field or a tag for a prefix preset', () => {
            const { page } = createCatalogPage({ shop: 'bakery' })

            expect(page.tags.filter((tag) => tag.key.endsWith(':'))).toEqual([])
            page.tags.push({ key: 'payment:', value: 'cash' })
            page.pushTagsToFeature()

            expect(Object.keys(page.feature.properties.tags)).not.toContain(
                'payment:'
            )
        })

        it('does not count an unsaveable prefix tag as a change', () => {
            const { page } = createCatalogPage({ shop: 'bakery' })
            page.tags.push({ key: 'payment:', value: 'cash' })

            expect(page.dataIsChanged()).toBe(false)
            expect(page.changedFieldCount()).toBe(0)
        })

        it('writes the preset key, not the preset id, when a field is added', () => {
            const { page } = createCatalogPage({ amenity: 'bench' })

            page.addNewKey('ele', 'elevation')

            expect(catalogPresets['elevation'].key).toBe('ele')
            expect(page.tags.at(-1)).toMatchObject({
                key: 'ele',
                value: '',
                isJustAdded: true,
            })
            expect(page.tags.at(-1)?.preset?._id).toBe('elevation')
        })

        it('adds an empty multi-key field without a key', () => {
            const { page } = createCatalogPage({ amenity: 'bench' })

            page.addNewKey('', 'activity')
            page.addNewKey('', 'activity')

            const fields = page.tags.filter(
                (tag) => tag.preset?._id === 'activity'
            )
            expect(fields).toHaveLength(1)
            expect(fields[0].key).toBe('')
        })

        it('adds a prefix field without its key and refuses a prefix key as free text', () => {
            const { page } = createCatalogPage({ amenity: 'bench' })
            const before = page.tags.length

            page.addNewKey('payment:')
            page.addNewKey('   ')
            expect(page.tags).toHaveLength(before)

            page.addNewKey('payment:', 'payment_multi')
            expect(page.tags).toHaveLength(before + 1)
            expect(page.tags.at(-1)).toMatchObject({
                key: '',
                value: '',
                isJustAdded: true,
            })
            page.pushTagsToFeature()
            expect(page.feature.properties.tags).toEqual({ amenity: 'bench' })
        })

        it('keeps the fields just added while they are still empty', () => {
            const { page } = createCatalogPage({ amenity: 'bench' })
            page.addNewKey('note')
            page.addNewKey('ele', 'elevation')
            page.addNewKey('', 'activity')
            page.addNewKey('', 'payment_multi')

            page.addPresetsTags({ backrest: 'yes' })

            expect(page.tags.some((tag) => tag.key === 'note')).toBe(true)
            expect(page.tags.some((tag) => tag.key === 'ele')).toBe(true)
            for (const presetId of ['activity', 'payment_multi']) {
                expect(
                    page.tags.filter((tag) => tag.preset?._id === presetId)
                ).toHaveLength(1)
            }
            expect(page.tags.some((tag) => tag.key === '' && !tag.preset)).toBe(
                false
            )
        })

        it('does not offer a field the object already shows in the add dialog', () => {
            const { page, dialog, nestedDialogRef } = createCatalogPage({
                amenity: 'restaurant',
                'contact:facebook': 'osmgo',
            })
            expect(page.tagConfig.moreFields).toContain('contact/facebook')

            page.openModalAddTag()

            expect(dialog.open).toHaveBeenCalled()
            const usedList =
                nestedDialogRef.componentRef.setInput.mock.calls.find(
                    ([name]) => name === 'usedList'
                )?.[1] as string[]
            expect(usedList).toContain('contact/facebook')
        })

        it('never writes an incomplete key through the multi-value patch', () => {
            const { page } = createCatalogPage({ shop: 'bakery' })

            page.applyTagsPatch({ 'payment:': 'yes', '': 'yes', ' ': null })
            page.pushTagsToFeature()

            expect(page.feature.properties.tags).toEqual({ shop: 'bakery' })
            expect(page.dataIsChanged()).toBe(false)
        })
    })

    it('refuses to save a value longer than 255 characters', () => {
        const { page, osmApi, snackBar } = createPage(
            { amenity: 'toilets', name: 'ok' },
            'Update',
            { osmApi: { updateOsmElement: vi.fn() } }
        )
        page.findElement(page.tags, { key: 'name' }).value = 'x'.repeat(256)

        page.updateOsmElement(tagConfig as any)

        expect(osmApi['updateOsmElement']).not.toHaveBeenCalled()
        expect(snackBar.open).toHaveBeenCalledWith(
            'MODAL_SELECTED_ITEM.VALUE_TOO_LONG',
            'SHARED.CLOSE',
            { duration: 4000 }
        )
        expect(page.typeFiche).toBe('Edit')
    })

    it('refuses to create an object with a control character in a value', () => {
        const { page, osmApi, snackBar } = createPage(
            { amenity: 'toilets', note: 'a\u0001b' },
            'Create'
        )

        page.createOsmElement(tagConfig as any)

        expect(osmApi.createOsmNode).not.toHaveBeenCalled()
        expect(snackBar.open).toHaveBeenCalledWith(
            'MODAL_SELECTED_ITEM.VALUE_INVALID',
            'SHARED.CLOSE',
            { duration: 4000 }
        )
    })

    it('explains that the object belongs to an unresolved upload', () => {
        const { page, snackBar } = createPage(
            { amenity: 'toilets', name: 'Old' },
            'Update',
            {
                osmApi: {
                    updateOsmElement: vi.fn(() =>
                        throwError(() => new UploadQueueLockedError(['node/1']))
                    ),
                },
            }
        )
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        page.findElement(page.tags, { key: 'name' }).value = 'New'

        page.updateOsmElement(tagConfig as any)

        expect(snackBar.open).toHaveBeenCalledWith(
            'MODAL_SELECTED_ITEM.UPLOAD_LOCKED',
            'SHARED.CLOSE',
            { duration: 4000 }
        )
        expect(page.typeFiche).toBe('Edit')
    })

    it('closes without saving when nothing changed and labels the button accordingly', () => {
        const { page, fixture, osmApi } = createPage({
            amenity: 'toilets',
            name: 'Same',
        })
        const dismissed = vi.fn()
        page.dismissed.subscribe(dismissed)
        fixture.detectChanges()

        const button = fixture.nativeElement.querySelector(
            '[data-testid="save-poi"]'
        ) as HTMLButtonElement
        expect(button.textContent).toContain('SHARED.CLOSE')
        expect(button.textContent).not.toContain('SAVE_CHANGE')

        button.click()

        expect(dismissed).toHaveBeenCalledWith(undefined)
        expect(osmApi['updateOsmElement']).toBeUndefined()
    })

    it('labels the button with the number of changes', () => {
        const { page } = createPage({ amenity: 'toilets', name: 'A' })

        page.findElement(page.tags, { key: 'name' }).value = 'B'

        expect(page.saveLabelKey(page.changedFieldCount())).toBe(
            'MODAL_SELECTED_ITEM.SAVE_CHANGE'
        )
        expect(page.saveLabelKey(2)).toBe('MODAL_SELECTED_ITEM.SAVE_CHANGES')
    })

    it('limits and capitalizes the name field', () => {
        const { fixture } = createPage({ amenity: 'toilets' })
        fixture.detectChanges()

        const input = fixture.nativeElement.querySelector(
            '.editor-toolbar input'
        ) as HTMLInputElement

        expect(input.getAttribute('autocapitalize')).toBe('words')
        expect(input.getAttribute('maxlength')).toBe('255')
    })

    describe('discarding local changes', () => {
        const flush = () => new Promise((resolve) => setTimeout(resolve))

        it('asks for a destructive confirmation before discarding', async () => {
            const cancelPendingChange = vi.fn().mockResolvedValue(undefined)
            const { page, dialog } = createPage(
                { amenity: 'toilets' },
                'Update',
                { dialogResult: true, dataService: { cancelPendingChange } }
            )
            page.feature.properties.changeType = 'Update'

            page.confirmCancelChange()
            await flush()

            expect(dialog.open).toHaveBeenCalledOnce()
            const config = (dialog.open.mock.calls[0] as unknown[])[1] as {
                data: Record<string, unknown>
            }
            expect(config.data).toMatchObject({
                title: 'MAIN.SELECTION.REVERT_LOCAL_TITLE',
                message: 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE',
                confirmLabel: 'MAIN.SELECTION.DISCARD',
                destructive: true,
            })
            expect(cancelPendingChange).toHaveBeenCalledWith('node/1')
        })

        it('keeps the local changes when the confirmation is refused', async () => {
            const cancelPendingChange = vi.fn()
            const { page } = createPage({ amenity: 'toilets' }, 'Update', {
                dialogResult: false,
                dataService: { cancelPendingChange },
            })
            page.feature.properties.changeType = 'Update'

            page.confirmCancelChange()
            await flush()

            expect(cancelPendingChange).not.toHaveBeenCalled()
        })

        it.each([
            ['Create', 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_CREATED'],
            ['Delete', 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_DELETED'],
        ] as const)('uses the %s wording', (changeType, message) => {
            const { page, dialog } = createPage(
                { amenity: 'toilets' },
                'Update',
                { dialogResult: false }
            )
            page.feature.properties.changeType = changeType

            page.confirmCancelChange()

            const config = (dialog.open.mock.calls[0] as unknown[])[1] as {
                data: { message: string }
            }
            expect(config.data.message).toBe(message)
        })

        it('names the banner button after the discard action', () => {
            const { fixture } = createPage({ amenity: 'toilets' }, 'Update', {
                changeType: 'Update',
            })
            fixture.detectChanges()

            const banner = fixture.nativeElement.querySelector(
                '.modified-warning button'
            ) as HTMLButtonElement

            expect(banner.textContent).toContain('MAIN.SELECTION.REVERT_LOCAL')
            expect(banner.textContent).not.toContain('SHARED.CLEAR')
        })
    })

    it('opens a relation made of several geometries without failing', () => {
        const { page } = createPage({ amenity: 'toilets' }, 'Update', {
            geometry: {
                type: 'GeometryCollection',
                geometries: [{ type: 'Point', coordinates: [1, 2] }],
            },
        })

        expect(page.geometryType).toBe('area')
        expect(page.typeFiche).toBe('Edit')
    })

    it('keeps the Create mode when a deprecated tag is fixed', () => {
        const { page } = createPage({ amenity: 'toilets' }, 'Create')

        page.fixDeprecated({ old: { fee: 'yes' }, replace: { fee: 'no' } })

        expect(page.mode).toBe('Create')
        expect(page.tags).toContainEqual(
            expect.objectContaining({ key: 'fee', value: 'no' })
        )
    })

    it('tells the user when the attributes are remembered', () => {
        const { page, snackBar } = createPage({ amenity: 'toilets' })

        page.copyFields()

        expect(snackBar.open).toHaveBeenCalledWith(
            'MODAL_SELECTED_ITEM.FIELDS_REMEMBERED',
            'SHARED.CLOSE',
            { duration: 4000 }
        )
    })

    describe('brand presets', () => {
        const brandPreset = {
            _id: 'name#brand',
            key: 'brand',
            type: 'text',
            lbl: { en: 'Brand' },
        }
        const brandConfig = {
            id: 'amenity/fast_food',
            lbl: { en: 'Fast food' },
            tags: { amenity: 'fast_food' },
            presets: ['name#brand'],
        }

        function createBrandPage() {
            const brandsLoaded = new Subject<void>()
            const page = createPage({ amenity: 'toilets' }, 'Update', {
                tagsService: {
                    presets: () => ({
                        gender: genderPreset,
                        'name#brand': brandPreset,
                    }),
                    brandPresetsLoaded: () => false,
                    loadBrandPresets$: () => brandsLoaded,
                },
            })
            return { ...page, brandsLoaded }
        }

        it('does not restore the previous category when brands arrive late', () => {
            const { page, brandsLoaded } = createBrandPage()

            page.initComponent(brandConfig as any)
            page.initComponent(tagConfig as any)
            brandsLoaded.next()

            expect(page.tagId).toBe('amenity/toilets')
        })

        it('applies the brands to the current category', () => {
            const { page, brandsLoaded } = createBrandPage()
            page.initComponent(brandConfig as any)
            const initialize = vi.spyOn(page, 'initComponent')

            brandsLoaded.next()

            expect(initialize).toHaveBeenCalledOnce()
        })

        it('stops waiting for brands once the editor is destroyed', () => {
            const { page, fixture, brandsLoaded } = createBrandPage()
            page.initComponent(brandConfig as any)
            const initialize = vi.spyOn(page, 'initComponent')

            fixture.destroy()
            brandsLoaded.next()

            expect(initialize).not.toHaveBeenCalled()
        })
    })
})
