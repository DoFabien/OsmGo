import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { By } from '@angular/platform-browser'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import type { EventShowModal, Preset, TagConfig } from '@osmgo/type'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmApiService } from '@services/osmApi.service'
import { TagsService } from '@services/tags.service'
import { of } from 'rxjs'
import { IconComponent } from '../../icon/icon.component'
import { ObjectEditorContentComponent } from '../../modal/modal'
import { ConfirmDialogComponent } from '../../shared/confirm-dialog/confirm-dialog'
import { ObjectSheetComponent } from './object-sheet'

const catalogPresets: Record<
    string,
    Preset
> = require('../../../../assets/tagsAndPresets/presets.json')
for (const [id, preset] of Object.entries(catalogPresets)) {
    preset._id = id
}
const catalogTags: {
    primaryKeys: string[]
    tags: TagConfig[]
} = require('../../../../assets/tagsAndPresets/tags.json')

describe('ObjectSheetComponent swipes', () => {
    const dialog = {
        open: vi.fn(() => ({ afterClosed: () => of(false) })),
    }
    let bookmarksIds: ReturnType<typeof signal<string[]>>
    let surveyDisplay: 'always' | 'never' | 'when_older'
    let checkedKey: 'survey:date' | 'check_date'
    let presets: Record<string, unknown>
    let mapProcessing: ReturnType<typeof signal<boolean>>
    let mapService: {
        isProcessing: typeof mapProcessing
        setIsProcessing: ReturnType<typeof vi.fn>
        getIconStyle: ReturnType<typeof vi.fn>
    }
    let osmApi: {
        updateOsmElement: ReturnType<typeof vi.fn>
        deleteOsmElement: ReturnType<typeof vi.fn>
    }
    let dataService: {
        cancelPendingChange: ReturnType<typeof vi.fn>
    }
    let tagsService: {
        tags: ReturnType<typeof vi.fn>
        tagsById: () => Record<string, TagConfig>
        presets: ReturnType<typeof vi.fn>
        jsonSprites: ReturnType<typeof vi.fn>
        primaryKeys: ReturnType<typeof vi.fn>
        bookmarksIds: typeof bookmarksIds
        savedFields: Record<string, never>
        findPkey: ReturnType<typeof vi.fn>
        addBookMark: ReturnType<typeof vi.fn>
        removeBookMark: ReturnType<typeof vi.fn>
    }
    const touchStartAt = (clientY: number, target: EventTarget): TouchEvent =>
        ({ target, touches: [{ clientY }] }) as unknown as TouchEvent
    const touchEndAt = (clientY: number): TouchEvent =>
        ({ changedTouches: [{ clientY }] }) as unknown as TouchEvent
    const pointerAt = (
        clientY: number,
        currentTarget: EventTarget
    ): PointerEvent =>
        ({ clientY, currentTarget, pointerId: 1 }) as unknown as PointerEvent
    const selectionWith = (
        id: number,
        icon: string,
        hexColor: string
    ): EventShowModal => ({
        type: 'Read',
        origineData: 'data',
        geojson: {
            type: 'Feature',
            id: `node/${id}`,
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: {
                _name: `Object ${id}`,
                hexColor,
                icon,
                id,
                marker: '',
                meta: {
                    changeset: '1',
                    timestamp: '2026-01-01T00:00:00Z',
                    uid: '1',
                    user: 'mapper',
                    version: 1,
                },
                primaryTag: { key: 'amenity', value: 'bench' },
                tags: { amenity: 'bench' },
                type: 'node',
            },
        },
    })

    const createComponent = (level: 'collapsed' | 'medium' | 'expanded') => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput('level', level)
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'information', '#9d7178')
        )
        return fixture.componentInstance
    }

    beforeEach(() => {
        bookmarksIds = signal<string[]>([])
        surveyDisplay = 'never'
        checkedKey = 'survey:date'
        presets = {}
        mapProcessing = signal(false)
        mapService = {
            isProcessing: mapProcessing,
            setIsProcessing: vi.fn((processing: boolean) =>
                mapProcessing.set(processing)
            ),
            getIconStyle: vi.fn((feature) => feature),
        }
        osmApi = {
            updateOsmElement: vi.fn((feature) => of(feature)),
            deleteOsmElement: vi.fn(() => of(undefined)),
        }
        dataService = {
            cancelPendingChange: vi.fn(() => Promise.resolve()),
        }
        tagsService = {
            tags: vi.fn(() => []),
            tagsById: () =>
                Object.fromEntries(
                    (tagsService.tags as () => TagConfig[])().map((tag) => [
                        tag.id,
                        tag,
                    ])
                ),
            presets: vi.fn(() => presets),
            jsonSprites: vi.fn(() => ({})),
            primaryKeys: vi.fn(() => ['amenity']),
            bookmarksIds,
            savedFields: {},
            findPkey: vi.fn((featureOrTags: any) => {
                if (Array.isArray(featureOrTags)) {
                    const tag = featureOrTags.find(
                        (candidate) => candidate.key === 'amenity'
                    )
                    return tag ? { key: tag.key, value: tag.value } : undefined
                }
                const value = featureOrTags.properties.tags.amenity
                return value ? { key: 'amenity', value } : undefined
            }),
            addBookMark: vi.fn((tag) => {
                bookmarksIds.set([tag.id, ...bookmarksIds()])
            }),
            removeBookMark: vi.fn((tag) => {
                bookmarksIds.set(bookmarksIds().filter((id) => id !== tag.id))
            }),
        }
        TestBed.configureTestingModule({
            imports: [ObjectSheetComponent, TranslateModule.forRoot()],
            providers: [
                { provide: MatDialog, useValue: dialog },
                {
                    provide: MapService,
                    useValue: mapService,
                },
                {
                    provide: ConfigService,
                    useValue: {
                        config: () => ({
                            checkedKey,
                            countryTags: 'FR',
                            languageTags: 'fr',
                            languageUi: 'fr',
                        }),
                        getDisplaySurveyCard: () => surveyDisplay,
                        getSurveyCardYear: () => 1,
                        getUiLanguage: () => 'fr',
                    },
                },
                { provide: TagsService, useValue: tagsService },
                { provide: OsmApiService, useValue: osmApi },
                { provide: DataService, useValue: dataService },
                { provide: MatSnackBar, useValue: { open: vi.fn() } },
            ],
        })
    })

    it('disables resize gestures while editing', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        const selection = selectionWith(1, 'information', '#9d7178')
        selection.type = 'Update'
        fixture.componentRef.setInput('selection', selection)
        fixture.componentRef.setInput('level', 'expanded')
        const component = fixture.componentInstance
        const levelChange = vi.fn()
        component.levelChange.subscribe(levelChange)

        component.onSheetTouchStart(
            touchStartAt(120, document.createElement('div'))
        )
        component.onSheetTouchEnd(touchEndAt(210))

        expect(levelChange).not.toHaveBeenCalled()
    })

    it('names the category found for the object rather than the one of its main tag', () => {
        tagsService.tags.mockReturnValue([
            { id: 'amenity/bench', lbl: { fr: 'Banc' } },
            { id: 'amenity/bench/memorial', lbl: { fr: 'Banc commémoratif' } },
        ])
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        const selection = selectionWith(1, 'information', '#9d7178')
        selection.geojson.properties.configId = 'amenity/bench/memorial'
        fixture.componentRef.setInput('selection', selection)
        fixture.componentRef.setInput('level', 'medium')

        expect(fixture.componentInstance.category()).toBe('Banc commémoratif')
    })

    it('protects a creation draft before closing the sheet', () => {
        dialog.open.mockClear()
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        const selection = selectionWith(1, 'information', '#9d7178')
        selection.type = 'Create'
        fixture.componentRef.setInput('selection', selection)

        fixture.componentInstance.requestExit()

        expect(dialog.open).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ panelClass: 'osmgo-dialog' })
        )
    })

    it.each([
        ['content', document.createElement('div')],
        ['action', document.createElement('button')],
    ])(
        'reduces the expanded sheet after a downward swipe from its %s',
        (_, target) => {
            const component = createComponent('expanded')
            const closeRequested = vi.fn()
            const levelChange = vi.fn()
            component.closeRequested.subscribe(closeRequested)
            component.levelChange.subscribe(levelChange)

            component.onSheetTouchStart(touchStartAt(120, target))
            component.onSheetTouchEnd(touchEndAt(190))

            expect(levelChange).toHaveBeenCalledWith('medium')
            expect(closeRequested).not.toHaveBeenCalled()
        }
    )

    it('keeps the expanded sheet open after a short downward gesture', () => {
        const component = createComponent('expanded')
        const closeRequested = vi.fn()
        const levelChange = vi.fn()
        component.closeRequested.subscribe(closeRequested)
        component.levelChange.subscribe(levelChange)

        component.onSheetTouchStart(
            touchStartAt(120, document.createElement('div'))
        )
        component.onSheetTouchEnd(touchEndAt(170))

        expect(closeRequested).not.toHaveBeenCalled()
        expect(levelChange).not.toHaveBeenCalled()
    })

    it('closes a medium sheet after a downward swipe', () => {
        const component = createComponent('medium')
        const closeRequested = vi.fn()
        component.closeRequested.subscribe(closeRequested)

        component.onSheetTouchStart(
            touchStartAt(120, document.createElement('div'))
        )
        component.onSheetTouchEnd(touchEndAt(210))

        expect(closeRequested).toHaveBeenCalledOnce()
    })

    it('expands a medium sheet after an upward swipe from the header', () => {
        const component = createComponent('medium')
        const levelChange = vi.fn()
        component.levelChange.subscribe(levelChange)
        const header = document.createElement('header')
        header.className = 'object-header'
        const title = document.createElement('h1')
        header.append(title)

        component.onSheetTouchStart(touchStartAt(210, title))
        component.onSheetTouchEnd(touchEndAt(130))

        expect(levelChange).toHaveBeenCalledWith('expanded')
    })

    it.each([
        ['medium', 'expanded'],
        ['expanded', 'medium'],
    ] as const)(
        'toggles the mobile sheet button from %s to %s',
        (level, expected) => {
            const fixture = TestBed.createComponent(ObjectSheetComponent)
            fixture.componentRef.setInput('level', level)
            fixture.componentRef.setInput(
                'selection',
                selectionWith(1, 'information', '#9d7178')
            )
            const levelChange = vi.fn()
            fixture.componentInstance.levelChange.subscribe(levelChange)
            fixture.detectChanges()

            const resizeButton = fixture.nativeElement.querySelector(
                '[data-testid="toggle-sheet-size"]'
            ) as HTMLButtonElement
            resizeButton.click()

            expect(levelChange).toHaveBeenCalledWith(expected)
        }
    )

    it('ignores an upward swipe outside the header', () => {
        const component = createComponent('medium')
        const levelChange = vi.fn()
        component.levelChange.subscribe(levelChange)

        component.onSheetTouchStart(
            touchStartAt(210, document.createElement('div'))
        )
        component.onSheetTouchEnd(touchEndAt(130))

        expect(levelChange).not.toHaveBeenCalled()
    })

    it('uses the same downward state transitions from the handle', () => {
        const handle = {
            setPointerCapture: vi.fn(),
            releasePointerCapture: vi.fn(),
        } as unknown as HTMLElement
        const expanded = createComponent('expanded')
        const expandedLevelChange = vi.fn()
        expanded.levelChange.subscribe(expandedLevelChange)

        expanded.onPointerDown(pointerAt(100, handle))
        expanded.onPointerUp(pointerAt(160, handle))

        expect(expandedLevelChange).toHaveBeenCalledWith('medium')

        const medium = createComponent('medium')
        const closeRequested = vi.fn()
        medium.closeRequested.subscribe(closeRequested)

        medium.onPointerDown(pointerAt(100, handle))
        medium.onPointerUp(pointerAt(160, handle))

        expect(closeRequested).toHaveBeenCalledOnce()
    })

    it('updates the icon and its background when the selection changes', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'first-icon', '#123456')
        )
        fixture.detectChanges()

        const iconContainer = fixture.nativeElement.querySelector(
            '.object-icon'
        ) as HTMLElement
        const iconComponent = fixture.debugElement.query(
            By.directive(IconComponent)
        ).componentInstance as IconComponent

        expect(iconContainer.style.backgroundColor).toBe('rgb(18, 52, 86)')
        expect(iconComponent.icon()).toBe('first-icon')
        expect(iconComponent.renderMode()).toBe('svg')

        fixture.componentRef.setInput(
            'selection',
            selectionWith(2, 'second-icon', '#d97706')
        )
        fixture.detectChanges()

        expect(iconContainer.style.backgroundColor).toBe('rgb(217, 119, 6)')
        expect(iconComponent.icon()).toBe('second-icon')
    })

    it('shows no stack navigation for a single object', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'information', '#9d7178')
        )
        fixture.detectChanges()

        expect(
            fixture.nativeElement.querySelector('.stack-navigation')
        ).toBeNull()
    })

    it('browses stacked objects from the header', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'information', '#9d7178')
        )
        fixture.componentRef.setInput('stackPosition', { index: 1, count: 3 })
        fixture.detectChanges()
        const steps: number[] = []
        let listRequests = 0
        fixture.componentInstance.stackStepRequested.subscribe((step) =>
            steps.push(step)
        )
        fixture.componentInstance.stackListRequested.subscribe(
            () => listRequests++
        )
        const element: HTMLElement = fixture.nativeElement
        const count = element.querySelector<HTMLButtonElement>(
            '[data-testid="stack-count"]'
        )

        expect(count?.textContent?.trim()).toBe('2 / 3')

        element
            .querySelector<HTMLButtonElement>('[data-testid="stack-previous"]')
            ?.click()
        element
            .querySelector<HTMLButtonElement>('[data-testid="stack-next"]')
            ?.click()
        count?.click()

        expect(steps).toEqual([-1, 1])
        expect(listRequests).toBe(1)
    })

    it('keeps the unified reading sheet when an expanded selection changes', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput('level', 'expanded')
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'first-icon', '#123456')
        )
        fixture.detectChanges()

        expect(
            fixture.debugElement.query(
                By.directive(ObjectEditorContentComponent)
            )
        ).toBeNull()
        expect(fixture.nativeElement.querySelector('h1').textContent).toContain(
            'Object 1'
        )

        fixture.componentRef.setInput(
            'selection',
            selectionWith(2, 'second-icon', '#d97706')
        )
        fixture.detectChanges()

        expect(fixture.nativeElement.querySelector('h1').textContent).toContain(
            'Object 2'
        )
    })

    it('resets category and code-display state for each selected object', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput('level', 'expanded')
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'first-icon', '#123456')
        )
        fixture.detectChanges()
        const component = fixture.componentInstance
        component.toggleCode()
        component.openCategory()

        fixture.componentRef.setInput(
            'selection',
            selectionWith(2, 'second-icon', '#d97706')
        )
        fixture.detectChanges()

        expect(component.displayCode()).toBe(false)
        expect(component.categoryOpen()).toBe(false)
    })

    it('shows every readable tag and switches to raw OSM codes in the same sheet', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        const selection = selectionWith(1, 'information', '#9d7178')
        selection.geojson.properties.tags = {
            amenity: 'bench',
            name: 'Central bench',
            material: 'wood',
            operator: 'City',
        }
        fixture.componentRef.setInput('selection', selection)
        fixture.componentRef.setInput('level', 'expanded')
        fixture.detectChanges()
        const component = fixture.componentInstance
        const levelChange = vi.fn()
        component.levelChange.subscribe(levelChange)

        expect(component.rows().map((row) => row.key)).toEqual([
            'material',
            'operator',
        ])
        expect(
            fixture.debugElement.query(
                By.directive(ObjectEditorContentComponent)
            )
        ).toBeNull()

        component.toggleCode()
        fixture.detectChanges()

        expect(new Set(component.rows().map((row) => row.key))).toEqual(
            new Set(['amenity', 'name', 'material', 'operator'])
        )
        expect(levelChange).toHaveBeenCalledWith('expanded')
        expect(
            fixture.nativeElement.querySelector('.object-facts--code')
        ).not.toBeNull()
    })

    it('records a direct survey action from the unified reading sheet', () => {
        surveyDisplay = 'always'
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        const selection = selectionWith(1, 'information', '#9d7178')
        fixture.componentRef.setInput('selection', selection)
        fixture.detectChanges()
        const component = fixture.componentInstance
        const completed = vi.fn()
        component.sessionCompleted.subscribe(completed)

        expect(component.shouldShowSurveyCard()).toBe(true)

        component.handleSurveyYes()

        expect(osmApi.updateOsmElement).toHaveBeenCalledWith(
            expect.objectContaining({
                properties: expect.objectContaining({
                    tags: expect.objectContaining({
                        'survey:date':
                            expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
                    }),
                }),
            }),
            'data'
        )
        expect(completed).toHaveBeenCalledWith(
            expect.objectContaining({ redraw: true })
        )
        expect(mapProcessing()).toBe(false)
    })

    it('keeps the direct non-existence action behind confirmation', () => {
        dialog.open.mockReturnValueOnce({ afterClosed: () => of(true) })
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'information', '#9d7178')
        )
        fixture.detectChanges()
        const completed = vi.fn()
        fixture.componentInstance.sessionCompleted.subscribe(completed)

        fixture.componentInstance.handleSurveyNo()

        expect(dialog.open).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ panelClass: 'osmgo-dialog' })
        )
        expect(osmApi.deleteOsmElement).toHaveBeenCalledOnce()
        expect(completed).toHaveBeenCalledWith({
            redraw: true,
            deleted: true,
        })
    })

    it('starts editing a deprecated replacement without mutating the read feature', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        const selection = selectionWith(1, 'information', '#9d7178')
        fixture.componentRef.setInput('selection', selection)
        fixture.detectChanges()
        const editRequested = vi.fn()
        fixture.componentInstance.editRequested.subscribe(editRequested)

        fixture.componentInstance.fixDeprecated({
            old: { amenity: 'bench' },
            replace: { leisure: 'picnic_table' },
        })

        expect(editRequested).toHaveBeenCalledWith(
            expect.objectContaining({
                properties: expect.objectContaining({
                    tags: { leisure: 'picnic_table' },
                }),
            })
        )
        expect(selection.geojson.properties.tags).toEqual({ amenity: 'bench' })
    })

    it('derives bookmarks from TagsService and persists both transitions', () => {
        bookmarksIds.set(['amenity/bench'])
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'information', '#9d7178')
        )
        fixture.detectChanges()
        const component = fixture.componentInstance

        expect(component.bookmarked()).toBe(true)

        component.toggleBookmark()
        expect(tagsService.removeBookMark).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'amenity/bench' })
        )
        expect(component.bookmarked()).toBe(false)

        component.toggleBookmark()
        expect(tagsService.addBookMark).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'amenity/bench' })
        )
        expect(component.bookmarked()).toBe(true)
    })

    it('renders the complete object name without truncating it', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        const selection = selectionWith(1, 'information', '#9d7178')
        selection.geojson.properties._name =
            'Tourism Malaysia — Office de tourisme international'
        fixture.componentRef.setInput('selection', selection)
        fixture.detectChanges()

        const title = fixture.nativeElement.querySelector('h1') as HTMLElement
        const titleStyle = getComputedStyle(title)

        expect(title.textContent?.trim()).toBe(
            'Tourism Malaysia — Office de tourisme international'
        )
        expect(titleStyle.whiteSpace).toBe('normal')
        expect(titleStyle.textOverflow).toBe('clip')
        expect(titleStyle.overflowWrap).toBe('anywhere')
        expect(title.dataset['titleSize']).toBe('compact')
    })

    it.each([
        ['Tourism Malaysia', 'large'],
        ['École élémentaire du Bourg', 'medium'],
        ['Tourism Malaysia — Office de tourisme international', 'compact'],
        [
            'Centre international de documentation et de ressources communautaires',
            'minimum',
        ],
    ])('adapts the title size for %s', (name, expectedSize) => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        const selection = selectionWith(1, 'information', '#9d7178')
        selection.geojson.properties._name = name
        fixture.componentRef.setInput('selection', selection)
        fixture.detectChanges()

        const title = fixture.nativeElement.querySelector('h1') as HTMLElement
        expect(title.dataset['titleSize']).toBe(expectedSize)
    })

    it('keeps header actions outside the identity header', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'information', '#9d7178')
        )
        fixture.detectChanges()

        const sheet = fixture.nativeElement.querySelector(
            '.object-sheet'
        ) as HTMLElement
        const header = sheet.querySelector('.object-header') as HTMLElement
        const actions = sheet.querySelector(
            '.object-header-actions'
        ) as HTMLElement

        expect(header.contains(actions)).toBe(false)
        expect(actions.parentElement).toBe(sheet)
    })

    it('shows only the OSM version after the relative metadata', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        fixture.componentRef.setInput(
            'selection',
            selectionWith(1, 'information', '#9d7178')
        )
        fixture.detectChanges()

        const secondaryMetadata = fixture.nativeElement.querySelector(
            '.metadata-secondary'
        ) as HTMLElement

        expect(secondaryMetadata.textContent?.trim()).toBe('v1')
        expect(secondaryMetadata.querySelector('time')).toBeNull()
    })

    describe('external links', () => {
        const linkFor = (value: string) => {
            presets = { website: { type: 'url', lbl: { en: 'Website' } } }
            const fixture = TestBed.createComponent(ObjectSheetComponent)
            const selection = selectionWith(1, 'information', '#9d7178')
            selection.geojson.properties.tags = {
                amenity: 'bench',
                website: value,
            }
            fixture.componentRef.setInput('selection', selection)
            fixture.detectChanges()
            return {
                anchor: fixture.nativeElement.querySelector(
                    '.fact-row a'
                ) as HTMLAnchorElement | null,
                row: fixture.componentInstance
                    .rows()
                    .find((candidate) => candidate.key === 'website'),
            }
        }

        it('links a website on another host', () => {
            const { anchor, row } = linkFor('https://example.com')

            expect(row?.href).toBe('https://example.com')
            expect(anchor?.getAttribute('href')).toBe('https://example.com')
        })

        it.each([
            'https://localhost/_capacitor_http_interceptor_?u=https://evil.test/x',
            'http://127.0.0.1/page',
            'javascript:alert(1)',
            'osmgo://auth',
            'not a link',
        ])('shows %s as plain text', (value) => {
            const { anchor, row } = linkFor(value)

            expect(row?.href).toBeUndefined()
            expect(row?.value).toBe(value)
            expect(anchor).toBeNull()
        })
    })

    describe('survey confirmation', () => {
        const confirmSurvey = (tags: Record<string, string>) => {
            const fixture = TestBed.createComponent(ObjectSheetComponent)
            const selection = selectionWith(1, 'information', '#9d7178')
            selection.geojson.properties.tags = { amenity: 'bench', ...tags }
            fixture.componentRef.setInput('selection', selection)
            fixture.detectChanges()
            fixture.componentInstance.handleSurveyYes()
            return osmApi.updateOsmElement.mock.calls[0][0].properties.tags
        }
        const today = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)

        it('dates the configured key and leaves the other key out when it was absent', () => {
            expect(confirmSurvey({})).toEqual({
                amenity: 'bench',
                'survey:date': today,
            })
        })

        it('keeps the other date key and brings it to the same day', () => {
            const tags = confirmSurvey({ check_date: '2020-01-01' })

            expect(tags['check_date']).toEqual(today)
            expect(tags['check_date']).toBe(tags['survey:date'])
        })

        it('works the same way when check_date is the configured key', () => {
            checkedKey = 'check_date'

            const tags = confirmSurvey({ 'survey:date': '2019-05-05' })

            expect(tags['check_date']).toEqual(today)
            expect(tags['survey:date']).toBe(tags['check_date'])
        })

        it('never removes other tags', () => {
            const tags = confirmSurvey({
                'survey:date': '2018-01-01',
                name: 'A',
            })

            expect(tags['name']).toBe('A')
            expect(tags['amenity']).toBe('bench')
        })
    })

    describe('discarding local changes', () => {
        const pendingSheet = (changeType: 'Create' | 'Update' | 'Delete') => {
            const fixture = TestBed.createComponent(ObjectSheetComponent)
            const selection = selectionWith(1, 'information', '#9d7178')
            selection.geojson.properties.changeType = changeType
            selection.origineData = 'data_changed'
            fixture.componentRef.setInput('selection', selection)
            fixture.detectChanges()
            return fixture
        }

        it('labels the banner action as discarding local changes', () => {
            const fixture = pendingSheet('Update')

            const button = fixture.nativeElement.querySelector(
                '.sheet-notice--pending button'
            ) as HTMLButtonElement

            expect(button.textContent).toContain('MAIN.SELECTION.REVERT_LOCAL')
            expect(button.textContent).not.toContain('SHARED.CLEAR')
        })

        it.each([
            ['Update', 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE'],
            ['Create', 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_CREATED'],
            ['Delete', 'MAIN.SELECTION.REVERT_LOCAL_MESSAGE_DELETED'],
        ] as const)(
            'asks for a destructive confirmation before discarding a %s',
            (changeType, message) => {
                dialog.open.mockClear()
                dialog.open.mockReturnValueOnce({
                    afterClosed: () => of(false),
                })
                const fixture = pendingSheet(changeType)

                ;(
                    fixture.nativeElement.querySelector(
                        '.sheet-notice--pending button'
                    ) as HTMLButtonElement
                ).click()

                expect(dialog.open).toHaveBeenCalledWith(
                    ConfirmDialogComponent,
                    expect.objectContaining({
                        data: expect.objectContaining({
                            title: 'MAIN.SELECTION.REVERT_LOCAL_TITLE',
                            message,
                            confirmLabel: 'MAIN.SELECTION.DISCARD',
                            destructive: true,
                        }),
                    })
                )
                expect(dataService.cancelPendingChange).not.toHaveBeenCalled()
            }
        )

        it('discards the change only once confirmed', async () => {
            dialog.open.mockReturnValueOnce({ afterClosed: () => of(true) })
            const fixture = pendingSheet('Update')
            const completed = vi.fn()
            fixture.componentInstance.sessionCompleted.subscribe(completed)

            fixture.componentInstance.confirmCancelChange()

            await vi.waitFor(() => expect(completed).toHaveBeenCalled())
            expect(dataService.cancelPendingChange).toHaveBeenCalledWith(
                'node/1'
            )
            expect(completed).toHaveBeenCalledWith({
                redraw: true,
                deleted: true,
            })
        })
    })

    describe('accessibility', () => {
        it('lets the keyboard resize the sheet from its handle without double-triggering pointer taps', () => {
            const component = createComponent('medium')
            const levelChange = vi.fn()
            component.levelChange.subscribe(levelChange)

            component.onHandleClick({ detail: 1 } as MouseEvent)
            expect(levelChange).not.toHaveBeenCalled()

            component.onHandleClick({ detail: 0 } as MouseEvent)
            expect(levelChange).toHaveBeenCalledWith('expanded')
        })

        it('names the sheet handle and exposes its state', () => {
            const fixture = TestBed.createComponent(ObjectSheetComponent)
            fixture.componentRef.setInput('level', 'expanded')
            fixture.componentRef.setInput(
                'selection',
                selectionWith(1, 'information', '#9d7178')
            )
            fixture.detectChanges()

            const handle = fixture.nativeElement.querySelector(
                '.sheet-handle'
            ) as HTMLButtonElement

            expect(handle.getAttribute('aria-label')).toBe(
                'MAIN.SELECTION.RESIZE_PANEL'
            )
            expect(handle.getAttribute('aria-expanded')).toBe('true')
        })

        it('announces the position in the stack to screen readers', () => {
            const translate = TestBed.inject(TranslateService)
            translate.setTranslation('en', {
                MAIN: {
                    SELECTION: {
                        STACK: {
                            POSITION: '{{index}} / {{count}}, show all',
                        },
                    },
                },
            })
            translate.use('en')
            const fixture = TestBed.createComponent(ObjectSheetComponent)
            fixture.componentRef.setInput(
                'selection',
                selectionWith(1, 'information', '#9d7178')
            )
            fixture.componentRef.setInput('stackPosition', {
                index: 1,
                count: 5,
            })
            fixture.detectChanges()

            const count = fixture.nativeElement.querySelector(
                '[data-testid="stack-count"]'
            ) as HTMLButtonElement

            expect(count.textContent?.trim()).toBe('2 / 5')
            expect(count.getAttribute('aria-label')).toBe('2 / 5, show all')
        })
    })

    describe('category picker', () => {
        it('closes the picker without applying a category', () => {
            const fixture = TestBed.createComponent(ObjectSheetComponent)
            fixture.componentRef.setInput(
                'selection',
                selectionWith(1, 'information', '#9d7178')
            )
            const component = fixture.componentInstance

            expect(component.closeCategory()).toBe(false)

            component.openCategory()
            expect(component.closeCategory()).toBe(true)
            expect(component.categoryOpen()).toBe(false)
        })
    })

    it('goes back to the reading sheet when an existing object is abandoned', () => {
        const fixture = TestBed.createComponent(ObjectSheetComponent)
        const selection = selectionWith(1, 'information', '#9d7178')
        selection.type = 'Update'
        fixture.componentRef.setInput('selection', selection)
        const completed = vi.fn()
        const closed = vi.fn()
        fixture.componentInstance.sessionCompleted.subscribe(completed)
        fixture.componentInstance.closeRequested.subscribe(closed)

        fixture.componentInstance.requestExit()

        expect(completed).toHaveBeenCalledWith({ type: 'Cancel' })
        expect(closed).not.toHaveBeenCalled()
    })

    describe('fields with several values', () => {
        const rowsFor = (
            primaryTag: { key: string; value: string },
            tags: Record<string, string>
        ) => {
            presets = catalogPresets
            tagsService.tags.mockReturnValue(catalogTags.tags)
            const translate = TestBed.inject(TranslateService)
            translate.setTranslation('fr', {
                MAIN: {
                    SELECTION: {
                        FIELDS: {
                            OPTION_VALUE: '{{label}} : {{value}}',
                            VALUE_NO: 'non',
                            VALUE_ONLY: 'uniquement',
                        },
                    },
                },
            })
            translate.use('fr')
            const fixture = TestBed.createComponent(ObjectSheetComponent)
            const selection = selectionWith(1, 'information', '#9d7178')
            selection.geojson.properties.primaryTag = primaryTag
            selection.geojson.properties.tags = {
                [primaryTag.key]: primaryTag.value,
                ...tags,
            }
            fixture.componentRef.setInput('selection', selection)
            fixture.detectChanges()
            return fixture
        }
        const readable = (fixture: ReturnType<typeof rowsFor>) =>
            fixture.componentInstance
                .rows()
                .map((row) => [row.label, row.value])

        it('names every value of a semicolon list', () => {
            const fixture = rowsFor(
                { key: 'amenity', value: 'restaurant' },
                { cuisine: 'pizza;italian;not_in_catalog' }
            )

            expect(readable(fixture)).toEqual([
                ['Cuisines', 'Pizza, Italienne, not_in_catalog'],
            ])
        })

        it('gathers the tags of a key prefix in one row', () => {
            const fixture = rowsFor(
                { key: 'shop', value: 'bakery' },
                {
                    'payment:visa': 'no',
                    'payment:cash': 'yes',
                    'payment:cards': 'only',
                    'payment:lydia': 'yes',
                    wheelchair: 'yes',
                }
            )

            expect(readable(fixture)).toEqual([
                [
                    'Types de paiement',
                    'Liquide, lydia, Carte de paiement : uniquement, Visa : non',
                ],
                ['Accès en fauteuil roulant', 'Oui'],
            ])
            expect(
                fixture.nativeElement.querySelectorAll('.fact-row')
            ).toHaveLength(2)
        })

        it('gathers several keys in the row of their field', () => {
            const fixture = rowsFor(
                { key: 'amenity', value: 'toilets' },
                { male: 'yes', female: 'yes' }
            )

            expect(readable(fixture)).toEqual([['Genre', 'Homme, Femme']])
        })

        it('gathers a key prefix that the category does not list', () => {
            const fixture = rowsFor(
                { key: 'amenity', value: 'toilets' },
                { 'diet:vegan': 'yes' }
            )

            expect(readable(fixture)).toEqual([
                ['Options alimentaires', 'Végane'],
            ])
        })

        it('keeps the raw tags in code mode', () => {
            const fixture = rowsFor(
                { key: 'shop', value: 'bakery' },
                {
                    'payment:cash': 'yes',
                    'payment:visa': 'no',
                    cuisine: 'pizza;italian',
                }
            )

            fixture.componentInstance.toggleCode()

            expect(
                fixture.componentInstance
                    .rows()
                    .map((row) => [row.label, row.value])
            ).toEqual([
                ['shop', 'bakery'],
                ['payment:cash', 'yes'],
                ['payment:visa', 'no'],
                ['cuisine', 'pizza;italian'],
            ])
        })
    })
})
