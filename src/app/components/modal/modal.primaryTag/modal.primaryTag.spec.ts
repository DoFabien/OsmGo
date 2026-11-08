import { TestBed } from '@angular/core/testing'
import { MatDialogRef } from '@angular/material/dialog'
import { TranslateModule } from '@ngx-translate/core'
import { ConfigService } from '@services/config.service'
import { CustomTagError, TagsService } from '@services/tags.service'
import { ModalPrimaryTag, normalizeCustomValue } from './modal.primaryTag'

describe('ModalPrimaryTag', () => {
    const addCustomTag = vi.fn()
    const pointerAt = (clientX: number): PointerEvent =>
        ({ clientX }) as PointerEvent

    const createModal = (): ModalPrimaryTag =>
        TestBed.runInInjectionContext(() => new ModalPrimaryTag())

    beforeEach(() => {
        addCustomTag.mockReset()
        TestBed.configureTestingModule({
            providers: [
                { provide: MatDialogRef, useValue: {} },
                { provide: TagsService, useValue: { addCustomTag } },
                { provide: ConfigService, useValue: {} },
            ],
        })
    })

    it('updates the search signal from a native input value', () => {
        const modal = createModal()

        modal.onSearchInput('cafe')

        expect(modal.searchText()).toBe('cafe')

        modal.onSearchInput('')

        expect(modal.searchText()).toBe('')
    })

    it('shows bookmarks after a left swipe', () => {
        const modal = createModal()

        modal.startSwipe(pointerAt(100))
        modal.endSwipe(pointerAt(40))

        expect(modal.displayType).toBe('bookmarks')
    })

    it('shows recent tags after a right swipe', () => {
        const modal = createModal()

        modal.startSwipe(pointerAt(40))
        modal.endSwipe(pointerAt(100))

        expect(modal.displayType).toBe('lastTags')
    })

    it('ignores a canceled swipe', () => {
        const modal = createModal()

        modal.startSwipe(pointerAt(100))
        modal.cancelSwipe()
        modal.endSwipe(pointerAt(40))

        expect(modal.displayType).toBe('lastTags')
    })

    it('submits the validated custom tag returned by TagsService', () => {
        const modal = createModal()
        const tag = { id: 'cuisine/pizza' }
        addCustomTag.mockReturnValue(tag)
        vi.spyOn(modal, 'summit').mockReturnValue(undefined)

        modal.addCustomValue('cuisine', 'pizza')

        expect(addCustomTag).toHaveBeenCalledWith('cuisine', 'pizza')
        expect(modal.summit).toHaveBeenCalledWith(tag)
        expect(modal.customValueError()).toBeNull()
    })

    it('exposes a catalog collision without closing the selector', () => {
        const modal = createModal()
        addCustomTag.mockImplementation(() => {
            throw new CustomTagError('collision')
        })
        vi.spyOn(modal, 'summit').mockReturnValue(undefined)

        modal.addCustomValue('amenity', 'cafe')

        expect(modal.summit).not.toHaveBeenCalled()
        expect(modal.customValueError()).toBe(
            'MODAL_SELECTED_ITEM.CUSTOM_TAG_COLLISION'
        )
    })

    describe('custom values', () => {
        it('normalizes the typed text into an OSM value', () => {
            expect(normalizeCustomValue('  Fast  Food ')).toBe('fast_food')
            expect(normalizeCustomValue('Boulan')).toBe('boulan')
        })

        it('keeps the custom values folded until the user asks for them', () => {
            const modal = createModal()

            modal.onSearchInput('boulan')

            expect(modal.customValuesOpen()).toBe(false)
            expect(modal.customValue()).toBe('boulan')
        })

        it('folds them again, and forgets the error, when the search is cleared', () => {
            const modal = createModal()
            modal.onSearchInput('boulan')
            modal.customValuesOpen.set(true)
            modal.customValueError.set('MODAL_SELECTED_ITEM.CUSTOM_TAG_INVALID')

            modal.onSearchInput('bo')

            expect(modal.customValuesOpen()).toBe(false)
            expect(modal.customValueError()).toBeNull()
        })

        describe('in the template', () => {
            function render() {
                TestBed.resetTestingModule()
                TestBed.configureTestingModule({
                    imports: [ModalPrimaryTag, TranslateModule.forRoot()],
                    providers: [
                        { provide: MatDialogRef, useValue: {} },
                        {
                            provide: TagsService,
                            useValue: {
                                addCustomTag,
                                tags: () => [],
                                primaryKeys: () => ['shop', 'amenity'],
                                hiddenTagsIds: () => [],
                                jsonSprites: () => ({}),
                                bookmarksIds: () => [],
                                lastTagsUsedIds: () => [],
                            },
                        },
                        {
                            provide: ConfigService,
                            useValue: {
                                config: () => ({
                                    defaultPrimarykeyWindows: 'lastTags',
                                    languageTags: 'en',
                                    countryTags: 'FR',
                                }),
                            },
                        },
                    ],
                })
                const fixture = TestBed.createComponent(ModalPrimaryTag)
                fixture.componentRef.setInput('tagConfig', { id: 'x' })
                fixture.componentRef.setInput('geometryType', 'point')
                fixture.detectChanges()
                fixture.componentInstance.onSearchInput('Boulan')
                fixture.detectChanges()
                return fixture
            }

            it('does not offer a ready-made key=value button for every search', () => {
                const fixture = render()

                expect(
                    fixture.nativeElement.querySelectorAll(
                        '.custom-values .code'
                    )
                ).toHaveLength(0)
                expect(
                    fixture.nativeElement.querySelector(
                        '.custom-values__toggle'
                    ).textContent
                ).toContain('MODAL_SELECTED_ITEM.CUSTOM_KEY_VALUE')
            })

            it('lists the normalized key=value buttons after the explicit action', () => {
                const fixture = render()

                fixture.nativeElement
                    .querySelector('.custom-values__toggle')
                    .click()
                fixture.detectChanges()

                const buttons = Array.from(
                    fixture.nativeElement.querySelectorAll(
                        '.custom-values .code'
                    )
                ).map((element) => (element as HTMLElement).textContent?.trim())
                expect(buttons).toEqual(['amenity=boulan', 'shop=boulan'])
            })

            it('creates the tag only from a tap on a listed button', () => {
                const fixture = render()
                addCustomTag.mockReturnValue({ id: 'amenity/boulan' })
                vi.spyOn(fixture.componentInstance, 'summit').mockReturnValue(
                    undefined
                )

                fixture.nativeElement
                    .querySelector('.custom-values__toggle')
                    .click()
                fixture.detectChanges()
                expect(addCustomTag).not.toHaveBeenCalled()
                fixture.nativeElement
                    .querySelector('.custom-values button')
                    .click()

                expect(addCustomTag).toHaveBeenCalledWith('amenity', 'boulan')
            })
        })
    })
})
