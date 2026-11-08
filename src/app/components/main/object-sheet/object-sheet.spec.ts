import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import { By } from '@angular/platform-browser'
import { TranslateModule } from '@ngx-translate/core'
import type { EventShowModal } from '@osmgo/type'
import { ConfigService } from '@services/config.service'
import { DataService } from '@services/data.service'
import { MapService } from '@services/map.service'
import { OsmApiService } from '@services/osmApi.service'
import { TagsService } from '@services/tags.service'
import { of } from 'rxjs'

import { IconComponent } from '../../icon/icon.component'
import { ObjectEditorContentComponent } from '../../modal/modal'
import { ObjectSheetComponent } from './object-sheet'

describe('ObjectSheetComponent swipes', () => {
    const dialog = {
        open: vi.fn(() => ({ afterClosed: () => of(false) })),
    }
    let bookmarksIds: ReturnType<typeof signal<string[]>>
    let surveyDisplay: 'always' | 'never' | 'when_older'
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
            presets: vi.fn(() => ({})),
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
                            checkedKey: 'survey:date',
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
})
