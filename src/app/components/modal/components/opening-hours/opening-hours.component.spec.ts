import { TestBed } from '@angular/core/testing'
import { MatDialog } from '@angular/material/dialog'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import DateRange from '@scripts/YoHours/DateRange.js'
import Interval from '@scripts/YoHours/Interval.js'
import WideInterval from '@scripts/YoHours/WideInterval.js'
import { Subject } from 'rxjs'
import {
    type OpeningHoursScheduleGroup,
    openingHoursScheduleIsValid,
} from './modal-add-opening-hours-interval/modal-add-opening-hours-interval.component'
import { OpeningHoursComponent } from './opening-hours.component'

describe('OpeningHoursComponent', () => {
    const createComponent = (): OpeningHoursComponent => {
        TestBed.configureTestingModule({
            providers: [
                { provide: MatDialog, useValue: {} },
                {
                    provide: TranslateService,
                    useValue: { instant: (key: string) => key },
                },
            ],
        })
        return TestBed.runInInjectionContext(() => new OpeningHoursComponent())
    }

    beforeEach(() => TestBed.resetTestingModule())

    it('deletes an interval only from its matching date range', () => {
        const component = createComponent()
        const weeklyRange = new DateRange(new WideInterval().always())
        const holidayRange = new DateRange(new WideInterval().holiday('PH'))
        const weeklyInterval = new Interval(0, 0, 540, 720)
        const holidayInterval = new Interval(0, 0, 600, 660)
        weeklyRange.getTypical().addInterval(weeklyInterval)
        holidayRange.getTypical().addInterval(holidayInterval)
        component.intervals = [weeklyRange, holidayRange]

        component.deleteCurrentInterval(holidayRange, holidayInterval)

        expect(weeklyRange.getTypical().getIntervals()).toContain(
            weeklyInterval
        )
        expect(holidayRange.getTypical().getIntervals()).not.toContain(
            holidayInterval
        )
    })

    it('replaces a complete weekly schedule with several day groups', () => {
        const component = createComponent()
        const day = (index: number, selected: boolean) => ({
            index,
            selected,
            label: `DAYS.${index}`,
        })
        const days = (selected: number[]) =>
            Array.from({ length: 7 }, (_, index) =>
                day(index, selected.includes(index))
            )
        const groups: OpeningHoursScheduleGroup[] = [
            {
                days: days([1, 2]),
                times: [
                    { start: '08:00', end: '12:00' },
                    { start: '14:00', end: '18:00' },
                ],
            },
            {
                days: days([5]),
                times: [{ start: '09:00', end: '11:30' }],
            },
        ]

        component.replaceScheduleGroups(groups)

        const intervals = component.intervals[0].getTypical().getIntervals()
        expect(component.openingHours()).toContain('Tu')
        expect(component.openingHours()).toContain('Sa')
        expect(
            intervals.filter((interval) => interval._dayStart === 1)
        ).toHaveLength(2)
        expect(
            intervals.filter((interval) => interval._dayStart === 2)
        ).toHaveLength(2)
        expect(
            intervals.filter((interval) => interval._dayStart === 5)
        ).toEqual([expect.objectContaining({ _start: 540, _end: 690 })])
    })

    it('groups days sharing the same intervals when editing', () => {
        const component = createComponent()
        component.openingHours.set(
            'Tu-We 08:00-12:00,14:00-18:00; Sa 09:00-11:30'
        )
        component.parseOpeningHours()

        const groups = component.getScheduleGroups()

        expect(groups).toHaveLength(2)
        expect(
            groups.find((group) => group.days[1].selected)?.days[2].selected
        ).toBe(true)
        expect(groups.find((group) => group.days[5].selected)?.times).toEqual([
            { start: '09:00', end: '11:30' },
        ])
    })

    it('reads an overnight schedule and gives it back to the dialog as valid', () => {
        const component = createComponent()
        component.openingHours.set('Fr 18:00-02:00')
        component.parseOpeningHours()

        const groups = component.getScheduleGroups()

        expect(component.isError).toBe(false)
        expect(component.isTooComplex).toBe(false)
        expect(groups).toHaveLength(1)
        expect(groups[0].days[4].selected).toBe(true)
        expect(groups[0].times).toEqual([{ start: '18:00', end: '02:00' }])
        expect(openingHoursScheduleIsValid(groups)).toBe(true)
    })

    it('writes an overnight range back as a range that ends the next day', () => {
        const component = createComponent()
        const days = Array.from({ length: 7 }, (_, index) => ({
            index,
            selected: index === 4,
            label: `DAYS.${index}`,
        }))

        component.replaceScheduleGroups([
            { days, times: [{ start: '18:00', end: '02:00' }] },
        ])

        expect(component.openingHours()).toBe('Fr 18:00-02:00')
    })

    describe('a night past midnight on Sunday', () => {
        const groupOf = (selected: number[], start: string, end: string) => ({
            days: Array.from({ length: 7 }, (_, index) => ({
                index,
                selected: selected.includes(index),
                label: `DAYS.${index}`,
            })),
            times: [{ start, end }],
        })

        it('keeps Sunday when every day closes after midnight', () => {
            const component = createComponent()

            component.replaceScheduleGroups([
                groupOf([0, 1, 2, 3, 4, 5, 6], '22:00', '02:00'),
            ])

            expect(component.openingHours()).toBe('22:00-02:00')
        })

        it('writes Sunday alone instead of an empty value', () => {
            const component = createComponent()

            component.replaceScheduleGroups([groupOf([6], '22:00', '02:00')])

            expect(component.openingHours()).toBe('Su 22:00-02:00')
        })

        it('adds a Sunday night from the add dialog', () => {
            const component = createComponent()
            const { days, times } = groupOf([6], '23:00', '03:00')

            component.addIntervals(times, days)

            expect(component.openingHours()).toBe('Su 23:00-03:00')
        })

        it('gives a parsed Sunday night back to the dialog unchanged', () => {
            const component = createComponent()
            component.openingHours.set('Mo-Su 22:00-02:00')
            component.parseOpeningHours()

            const groups = component.getScheduleGroups()

            expect(groups).toHaveLength(1)
            expect(groups[0].days.every((day) => day.selected)).toBe(true)
            expect(groups[0].times).toEqual([{ start: '22:00', end: '02:00' }])
            expect(openingHoursScheduleIsValid(groups)).toBe(true)
            component.replaceScheduleGroups(groups)
            expect(component.openingHours()).toBe('22:00-02:00')
        })
    })

    it('builds the weekly table once per parse', () => {
        const component = createComponent()
        component.openingHours.set('Tu-We 08:00-12:00; Sa 09:00-11:30')
        component.parseOpeningHours()

        const rows = component.scheduleRows[0]

        expect(rows).toHaveLength(7)
        expect(rows[1].intervals).toHaveLength(1)
        expect(rows[0].intervals).toHaveLength(0)
    })

    describe('visual or raw editor', () => {
        function render(openingHours: string, editMode = true) {
            TestBed.resetTestingModule()
            TestBed.configureTestingModule({
                imports: [OpeningHoursComponent, TranslateModule.forRoot()],
                providers: [{ provide: MatDialog, useValue: {} }],
            })
            const fixture = TestBed.createComponent(OpeningHoursComponent)
            fixture.componentRef.setInput('editMode', editMode)
            fixture.componentRef.setInput('openingHours', openingHours)
            fixture.detectChanges()
            return fixture
        }
        const rawEditor = (fixture: ReturnType<typeof render>) =>
            fixture.nativeElement.querySelector('.raw-editor')
        const visualEditor = (fixture: ReturnType<typeof render>) =>
            fixture.nativeElement.querySelector('.add-hours')

        it('opens a simple value in the visual editor', () => {
            const fixture = render('Mo-Fr 08:00-12:00')

            expect(visualEditor(fixture)).not.toBeNull()
            expect(rawEditor(fixture)).toBeNull()
        })

        it('keeps the raw field while the user types a value that becomes valid', () => {
            const fixture = render('Mo-Fr garbage')
            expect(rawEditor(fixture)).not.toBeNull()

            fixture.componentInstance.valueChange('Mo 08:00-12:00')
            fixture.detectChanges()

            expect(fixture.componentInstance.isError).toBe(false)
            expect(rawEditor(fixture)).not.toBeNull()
            expect(visualEditor(fixture)).toBeNull()
        })

        it('keeps the raw field for a value too complex for the visual editor', () => {
            const fixture = render('Mo 08:00-12:00; PH off')

            expect(rawEditor(fixture)).not.toBeNull()
            expect(fixture.componentInstance.isTooComplex).toBe(true)
        })

        it('switches with the code toggle', () => {
            const fixture = render('Mo 08:00-12:00')

            fixture.componentRef.setInput('displayCode', true)
            fixture.detectChanges()
            expect(rawEditor(fixture)).not.toBeNull()

            fixture.componentRef.setInput('displayCode', false)
            fixture.detectChanges()
            expect(visualEditor(fixture)).not.toBeNull()
            expect(rawEditor(fixture)).toBeNull()
        })

        it('still follows the value in the read-only sheet', () => {
            const fixture = render('Mo 08:00-12:00; PH off', false)
            expect(
                fixture.nativeElement.querySelector('.raw-value')
            ).not.toBeNull()

            fixture.componentRef.setInput('openingHours', 'Mo 08:00-12:00')
            fixture.detectChanges()

            expect(fixture.nativeElement.querySelector('.raw-value')).toBeNull()
            expect(
                fixture.nativeElement.querySelector('.schedule')
            ).not.toBeNull()
        })
    })

    describe('editing dialog', () => {
        function open() {
            const backdrop = new Subject<MouseEvent>()
            const keys = new Subject<KeyboardEvent>()
            const cancel = vi.fn()
            const dialogRef = {
                backdropClick: () => backdrop,
                keydownEvents: () => keys,
                afterClosed: () => new Subject(),
                componentInstance: { cancel },
            }
            const openDialog = vi.fn(
                (_component: unknown, _config?: unknown) => dialogRef
            )
            TestBed.resetTestingModule()
            TestBed.configureTestingModule({
                providers: [
                    { provide: MatDialog, useValue: { open: openDialog } },
                    {
                        provide: TranslateService,
                        useValue: { instant: (key: string) => key },
                    },
                ],
            })
            const component = TestBed.runInInjectionContext(
                () => new OpeningHoursComponent()
            )
            component.openModalAddOpeningHours()
            return { openDialog, backdrop, keys, cancel }
        }

        it('does not close on an outside tap or Escape by itself', () => {
            const { openDialog } = open()

            expect(openDialog.mock.calls[0][1]).toMatchObject({
                disableClose: true,
            })
        })

        it('routes an outside tap and Escape through the dialog confirmation', () => {
            const { backdrop, keys, cancel } = open()

            backdrop.next(new MouseEvent('click'))
            keys.next(new KeyboardEvent('keydown', { key: 'Escape' }))
            keys.next(new KeyboardEvent('keydown', { key: 'a' }))

            expect(cancel).toHaveBeenCalledTimes(2)
        })
    })
})
