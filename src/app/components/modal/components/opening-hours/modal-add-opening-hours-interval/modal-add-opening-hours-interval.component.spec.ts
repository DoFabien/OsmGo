import { TestBed } from '@angular/core/testing'
import {
    MAT_DIALOG_DATA,
    MatDialog,
    MatDialogRef,
} from '@angular/material/dialog'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { of } from 'rxjs'
import {
    ModalAddOpeningHoursIntervalComponent,
    type OpeningHoursDialogData,
    openingHoursScheduleIssues,
    openingHoursScheduleIsValid,
} from './modal-add-opening-hours-interval.component'

describe('ModalAddOpeningHoursIntervalComponent', () => {
    const dismiss = vi.fn()
    const openDialog = vi.fn()
    let language = 'en'
    const day = (index: number, selected = false) => ({
        index,
        selected,
        label: `DAYS.${index}`,
    })
    const week = (...selected: number[]) =>
        Array.from({ length: 7 }, (_, index) =>
            day(index, selected.includes(index))
        )

    const providers = (data: OpeningHoursDialogData, mockTranslate = true) => [
        { provide: MatDialogRef, useValue: { close: dismiss } },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialog, useValue: { open: openDialog } },
        ...(mockTranslate
            ? [
                  {
                      provide: TranslateService,
                      useValue: {
                          instant: (key: string) => key,
                          getCurrentLang: () => language,
                      },
                  },
              ]
            : []),
    ]

    const createComponent = (
        data: OpeningHoursDialogData = { groups: [] }
    ): ModalAddOpeningHoursIntervalComponent => {
        TestBed.configureTestingModule({ providers: providers(data) })
        return TestBed.runInInjectionContext(
            () => new ModalAddOpeningHoursIntervalComponent()
        )
    }

    beforeEach(() => {
        TestBed.resetTestingModule()
        dismiss.mockReset()
        openDialog.mockReset()
        language = 'en'
    })

    it('updates a time range from a native time value', () => {
        const component = createComponent()
        const group = component.groups()[0]

        component.updateTimeRange(group.id, group.times[0].id, 'start', '10:30')

        expect(component.groups()[0].times[0].start).toBe('10:30')
    })

    it('offers 24:00 explicitly and restores the previous native end time', () => {
        const component = createComponent()
        const group = component.groups()[0]
        const time = group.times[0]

        component.updateTimeRange(group.id, time.id, 'end', '18:30')
        component.toggleEndAtMidnight(group.id, time.id)

        expect(component.groups()[0].times[0].end).toBe('24:00')

        component.toggleEndAtMidnight(group.id, time.id)

        expect(component.groups()[0].times[0].end).toBe('18:30')
    })

    it('creates multiple independent day groups in one submission', () => {
        const component = createComponent()
        const weekGroup = component.groups()[0]

        component.toggleDay(weekGroup.id, 1)
        component.toggleDay(weekGroup.id, 2)
        component.updateTimeRange(
            weekGroup.id,
            weekGroup.times[0].id,
            'start',
            '08:00'
        )
        component.addNewInterval(weekGroup.id)
        const afternoon = component.groups()[0].times[1]
        component.updateTimeRange(weekGroup.id, afternoon.id, 'start', '14:00')
        component.updateTimeRange(weekGroup.id, afternoon.id, 'end', '18:00')

        component.addScheduleGroup()
        const saturdayGroup = component.groups()[1]
        component.toggleDay(saturdayGroup.id, 5)
        component.updateTimeRange(
            saturdayGroup.id,
            saturdayGroup.times[0].id,
            'end',
            '11:30'
        )
        component.submit()

        expect(component.groupsAreValid()).toBe(true)
        expect(dismiss).toHaveBeenCalledWith({
            groups: [
                {
                    days: expect.arrayContaining([
                        expect.objectContaining({ index: 1, selected: true }),
                        expect.objectContaining({ index: 2, selected: true }),
                    ]),
                    times: [
                        { start: '08:00', end: '12:00' },
                        { start: '14:00', end: '18:00' },
                    ],
                },
                {
                    days: expect.arrayContaining([
                        expect.objectContaining({ index: 5, selected: true }),
                    ]),
                    times: [{ start: '09:00', end: '11:30' }],
                },
            ],
        })
    })

    it('loads existing opening hours for editing', () => {
        const component = createComponent({
            groups: [
                {
                    days: [{ index: 1, selected: true, label: 'DAYS.TUESDAY' }],
                    times: [{ start: '08:00', end: '12:00' }],
                },
            ],
        })

        expect(component.groups()[0].days[1].selected).toBe(true)
        expect(component.groups()[0].times[0]).toEqual(
            expect.objectContaining({ start: '08:00', end: '12:00' })
        )
    })

    it('accepts 24:00 only as an end and rejects an empty range', () => {
        const days = [{ index: 0, selected: true, label: 'DAYS.MONDAY' }]

        expect(openingHoursScheduleIsValid([])).toBe(false)
        expect(
            openingHoursScheduleIsValid([
                { days, times: [{ start: '20:00', end: '24:00' }] },
            ])
        ).toBe(true)
        expect(
            openingHoursScheduleIsValid([
                { days, times: [{ start: '24:00', end: '24:00' }] },
            ])
        ).toBe(false)
        expect(
            openingHoursScheduleIsValid([
                { days, times: [{ start: '09:00', end: '09:00' }] },
            ])
        ).toBe(false)
    })

    describe('ranges that run past midnight', () => {
        it('accepts a Friday range ending after midnight', () => {
            const groups = [
                {
                    days: week(4),
                    times: [{ start: '18:00', end: '02:00' }],
                },
            ]

            expect(openingHoursScheduleIsValid(groups)).toBe(true)
            expect(openingHoursScheduleIssues(groups)).toEqual([])
        })

        it('rejects a range that overlaps the end of an overnight range', () => {
            const groups = [
                { days: week(4), times: [{ start: '18:00', end: '02:00' }] },
                { days: week(5), times: [{ start: '01:00', end: '03:00' }] },
            ]

            expect(openingHoursScheduleIssues(groups)).toEqual([
                { groupIndex: 0, timeIndex: 0, code: 'overlap' },
                { groupIndex: 1, timeIndex: 0, code: 'overlap' },
            ])
        })

        it('accepts a range that starts exactly when the overnight range ends', () => {
            const groups = [
                { days: week(4), times: [{ start: '18:00', end: '02:00' }] },
                { days: week(5), times: [{ start: '02:00', end: '04:00' }] },
            ]

            expect(openingHoursScheduleIsValid(groups)).toBe(true)
        })

        it('wraps from Sunday night to Monday morning', () => {
            const groups = [
                { days: week(6), times: [{ start: '22:00', end: '02:00' }] },
                { days: week(0), times: [{ start: '01:00', end: '05:00' }] },
            ]

            expect(openingHoursScheduleIsValid(groups)).toBe(false)
        })

        it('does not overlap itself when open all day every day', () => {
            const groups = [
                {
                    days: week(0, 1, 2, 3, 4, 5, 6),
                    times: [{ start: '00:00', end: '24:00' }],
                },
            ]

            expect(openingHoursScheduleIsValid(groups)).toBe(true)
        })

        it('opens an existing overnight schedule and saves it back unchanged', () => {
            const component = createComponent({
                groups: [
                    {
                        days: week(4),
                        times: [{ start: '18:00', end: '02:00' }],
                    },
                ],
            })

            expect(component.groupsAreValid()).toBe(true)
            component.submit()

            expect(dismiss).toHaveBeenCalledWith({
                groups: [
                    {
                        days: expect.arrayContaining([
                            expect.objectContaining({
                                index: 4,
                                selected: true,
                            }),
                        ]),
                        times: [{ start: '18:00', end: '02:00' }],
                    },
                ],
            })
        })

        it('tells the user that the range ends the next day', () => {
            const component = createComponent()

            expect(
                component.endsNextDay({ start: '18:00', end: '02:00' })
            ).toBe(true)
            expect(
                component.endsNextDay({ start: '08:00', end: '12:00' })
            ).toBe(false)
            expect(
                component.endsNextDay({ start: '08:00', end: '24:00' })
            ).toBe(false)
        })
    })

    describe('validation messages', () => {
        const days = week(0)

        it('reports an identical start and end', () => {
            expect(
                openingHoursScheduleIssues([
                    { days, times: [{ start: '09:00', end: '09:00' }] },
                ])
            ).toEqual([{ groupIndex: 0, timeIndex: 0, code: 'sameTime' }])
        })

        it('reports a missing or malformed time', () => {
            expect(
                openingHoursScheduleIssues([
                    { days, times: [{ start: '09:00', end: '' }] },
                ])
            ).toEqual([{ groupIndex: 0, timeIndex: 0, code: 'invalidTime' }])
        })

        it('reports a group without a day or without a range', () => {
            expect(
                openingHoursScheduleIssues([
                    { days: week(), times: [{ start: '09:00', end: '10:00' }] },
                    { days, times: [] },
                ])
            ).toEqual([
                { groupIndex: 0, code: 'noDay' },
                { groupIndex: 1, code: 'noRange' },
            ])
        })

        it('shows the reason under the range that blocks the save button', () => {
            TestBed.configureTestingModule({
                imports: [
                    ModalAddOpeningHoursIntervalComponent,
                    TranslateModule.forRoot(),
                ],
                providers: providers(
                    {
                        groups: [
                            {
                                days: week(0),
                                times: [
                                    { start: '09:00', end: '12:00' },
                                    { start: '11:00', end: '13:00' },
                                ],
                            },
                        ],
                    },
                    false
                ),
            })
            const fixture = TestBed.createComponent(
                ModalAddOpeningHoursIntervalComponent
            )
            fixture.detectChanges()

            const messages = fixture.nativeElement.querySelectorAll(
                '.time-message--error'
            ) as NodeListOf<HTMLElement>
            const submit = fixture.nativeElement.querySelector(
                '.submit-button'
            ) as HTMLButtonElement

            expect(messages).toHaveLength(2)
            expect(messages[0].textContent).toContain(
                'OPENINGHOURS.ERRORS.OVERLAP'
            )
            expect(submit.disabled).toBe(true)
        })
    })

    describe('weekday labels', () => {
        it('uses the short weekday names of the interface language', () => {
            language = 'fr'

            const labels = createComponent().shortDayLabels

            expect(labels).toHaveLength(7)
            expect(labels[0]).toBe(
                new Intl.DateTimeFormat('fr', {
                    weekday: 'short',
                    timeZone: 'UTC',
                }).format(new Date(Date.UTC(2024, 0, 1)))
            )
            expect(labels[0].toLowerCase()).toContain('lun')
        })

        it('does not cut Arabic names to three characters', () => {
            language = 'ar'

            const labels = createComponent().shortDayLabels

            expect(new Set(labels).size).toBe(7)
        })

        it('falls back to the browser language for an unknown code', () => {
            language = 'not a locale'

            expect(createComponent().shortDayLabels).toHaveLength(7)
        })
    })

    describe('leaving the dialog', () => {
        it('closes at once when nothing was changed', () => {
            const component = createComponent({
                groups: [
                    {
                        days: week(1),
                        times: [{ start: '08:00', end: '12:00' }],
                    },
                ],
            })

            component.cancel()

            expect(openDialog).not.toHaveBeenCalled()
            expect(dismiss).toHaveBeenCalledWith(null)
        })

        it('asks before dropping edited hours', () => {
            openDialog.mockReturnValue({ afterClosed: () => of(true) })
            const component = createComponent()
            const group = component.groups()[0]
            component.toggleDay(group.id, 2)

            component.cancel()

            expect(openDialog).toHaveBeenCalledOnce()
            expect(openDialog.mock.calls[0][1].data).toMatchObject({
                title: 'MAIN.SELECTION.DISCARD_TITLE',
                destructive: true,
            })
            expect(dismiss).toHaveBeenCalledWith(null)
        })

        it('keeps the dialog open when the user declines', () => {
            openDialog.mockReturnValue({ afterClosed: () => of(false) })
            const component = createComponent()
            component.toggleDay(component.groups()[0].id, 2)

            component.cancel()

            expect(dismiss).not.toHaveBeenCalled()
        })

        it('is not dirty again once the edit is undone', () => {
            const component = createComponent()
            const group = component.groups()[0]

            component.toggleDay(group.id, 2)
            expect(component.isDirty()).toBe(true)
            component.toggleDay(group.id, 2)

            expect(component.isDirty()).toBe(false)
        })
    })

    it('rejects duplicate and overlapping ranges on the same day', () => {
        const days = [{ index: 0, selected: true, label: 'DAYS.MONDAY' }]

        expect(
            openingHoursScheduleIsValid([
                {
                    days,
                    times: [
                        { start: '09:00', end: '12:00' },
                        { start: '11:30', end: '13:00' },
                    ],
                },
            ])
        ).toBe(false)
        expect(
            openingHoursScheduleIsValid([
                { days, times: [{ start: '09:00', end: '12:00' }] },
                { days, times: [{ start: '09:00', end: '12:00' }] },
            ])
        ).toBe(false)
    })
})
