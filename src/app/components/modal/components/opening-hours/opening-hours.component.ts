import {
    Component,
    effect,
    inject,
    input,
    model,
    type OnInit,
    output,
    signal,
    untracked,
} from '@angular/core'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatDialog } from '@angular/material/dialog'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { MinutesToHoursMinutesPipe } from '@pipes/minutes-to-hours-minutes.pipe'
import DateRange from '@scripts/YoHours/DateRange.js'
import Interval from '@scripts/YoHours/Interval.js'
import OpeningHoursBuilder from '@scripts/YoHours/OpeningHoursBuilder.js'
import OpeningHoursParser from '@scripts/YoHours/OpeningHoursParser.js'
import WideInterval from '@scripts/YoHours/WideInterval.js'
import { filter } from 'rxjs'
import {
    ModalAddOpeningHoursIntervalComponent,
    type OpeningHoursDay,
    type OpeningHoursDialogData,
    type OpeningHoursDialogResult,
    type OpeningHoursScheduleGroup,
    type OpeningHoursTime,
} from './modal-add-opening-hours-interval/modal-add-opening-hours-interval.component'

const parser = new OpeningHoursParser()
const builder = new OpeningHoursBuilder()

interface ScheduleRow {
    day: { index: number; text: string }
    intervals: Interval[]
}

@Component({
    selector: 'app-opening-hours',
    templateUrl: './opening-hours.component.html',
    styleUrls: ['./opening-hours.component.scss', '../style.scss'],
    imports: [
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MinutesToHoursMinutesPipe,
        TranslateModule,
    ],
})
export class OpeningHoursComponent implements OnInit {
    private readonly dialog = inject(MatDialog)
    private readonly translate = inject(TranslateService)

    readonly openingHours = model('')
    readonly displayCode = input(false)
    readonly editMode = input(false)

    readonly valueChangeEvent = output<string>()
    intervals: DateRange[] = []
    /** The weekly table of each date range, rebuilt whenever the value is parsed. */
    scheduleRows: ScheduleRow[][] = []
    isError = false
    isTooComplex = false

    /**
     * In edit mode the raw field replaces the visual editor only when the value
     * cannot be shown there at the moment it is opened. It must not flip while
     * the user is typing a value that happens to become valid.
     */
    readonly rawMode = signal(false)
    private typedValue: string | null = null
    private lastDisplayCode: boolean | null = null

    constructor() {
        effect(() => {
            const value = this.openingHours()
            const displayCode = this.displayCode()
            untracked(() => {
                this.parseOpeningHours()
                if (
                    value !== this.typedValue ||
                    displayCode !== this.lastDisplayCode
                ) {
                    this.rawMode.set(this.isError || this.isTooComplex)
                }
                this.lastDisplayCode = displayCode
            })
        })
    }

    get showRawField(): boolean {
        return this.editMode()
            ? this.displayCode() || this.rawMode()
            : this.displayCode() || this.isError || this.isTooComplex
    }

    days = [
        { index: 0, text: this.translate.instant('DAYS.MONDAY') },
        { index: 1, text: this.translate.instant('DAYS.TUESDAY') },
        { index: 2, text: this.translate.instant('DAYS.WEDNESDAY') },
        { index: 3, text: this.translate.instant('DAYS.THURSDAY') },
        { index: 4, text: this.translate.instant('DAYS.FRIDAY') },
        { index: 5, text: this.translate.instant('DAYS.SATURDAY') },
        { index: 6, text: this.translate.instant('DAYS.SUNDAY') },
    ]

    valueChange(value: string): void {
        this.typedValue = value
        this.openingHours.set(value)
        this.valueChangeEvent.emit(value)
        this.parseOpeningHours()
    }

    parseOpeningHours(): void {
        try {
            this.intervals = parser.parse(this.openingHours())
            this.isError = false
            this.isTooComplex = false
            this.scheduleRows = this.buildScheduleRows()

            if (this.openingHours() == '') {
                this.isError = false
                return
            }

            /**
             * First iteration
             * Only Simple opening hours (without holydays, specifics days, weeks, etc...)
             * definesTypicalWeek(
             */

            if (this.intervals.length > 1) {
                this.isTooComplex = true
            } else if (this.intervals.length == 1) {
                if (!this.intervals[0].definesTypicalWeek())
                    this.isTooComplex = true
                else if (this.intervals[0].getInterval()._type !== 'always')
                    this.isTooComplex = true
                else this.isTooComplex = false
            }
        } catch (error) {
            this.isError = true
            this.scheduleRows = []
        }
    }

    private buildScheduleRows(): ScheduleRow[][] {
        return this.intervals.map((dataRange) =>
            this.days.map((day) => ({
                day,
                intervals: this.findIntervalsByDay(
                    dataRange._typical._intervals,
                    day.index
                ),
            }))
        )
    }

    ngOnInit(): void {
        this.parseOpeningHours()
    }

    findIntervalsByDay(intervals: Interval[], day: number): Interval[] {
        const intervalsByDay = intervals.filter(
            (interval) => interval._dayStart === day
        )
        return intervalsByDay
    }

    deleteCurrentInterval(dataRange: DateRange, interval: Interval): void {
        const wideIntervalType = dataRange._wideInterval._type
        const currentDataRange = this.intervals.find(
            (candidate) => candidate._wideInterval._type === wideIntervalType
        )
        if (!currentDataRange) return

        const intervals2 = currentDataRange.getTypical().getIntervals()

        const currentIntervalIndex = intervals2.findIndex(
            (candidate) =>
                candidate._dayStart === interval._dayStart &&
                candidate._dayEnd === interval._dayEnd &&
                candidate._start === interval._start &&
                candidate._end === interval._end
        )

        if (currentIntervalIndex >= 0) {
            currentDataRange.getTypical().removeInterval(currentIntervalIndex)
        }

        this.openingHours.set(builder.build(this.intervals))
        this.valueChangeEvent.emit(this.openingHours())
        this.parseOpeningHours()
    }

    addIntervals(times: OpeningHoursTime[], days: OpeningHoursDay[]): void {
        const wideIntervalType = 'always'
        if (this.intervals.length === 0) {
            const wi = new WideInterval()
            this.intervals = [new DateRange(wi.always())]
        }

        const currentDataRange = this.intervals.find(
            (dateRange) => dateRange._wideInterval._type === wideIntervalType
        )
        if (!currentDataRange) return
        const daysIndex = days.filter((d) => d.selected).map((d) => d.index)

        for (const dayIndex of daysIndex) {
            for (const time of times) {
                this.addDayInterval(
                    currentDataRange.getTypical(),
                    dayIndex,
                    this.timeToMinutes(time.start),
                    this.timeToMinutes(time.end)
                )
            }
        }
        this.openingHours.set(builder.build(this.intervals))
        this.valueChangeEvent.emit(this.openingHours())
        this.parseOpeningHours()
    }

    getScheduleGroups(): OpeningHoursScheduleGroup[] {
        const currentDataRange = this.intervals.find(
            (dateRange) => dateRange._wideInterval._type === 'always'
        )
        if (!currentDataRange) return []

        const groups = new Map<
            string,
            { days: OpeningHoursDay[]; times: OpeningHoursTime[] }
        >()

        const intervals = currentDataRange.getTypical().getIntervals()
        const sundayNight = intervals.find(
            (interval) =>
                interval._dayStart === 6 &&
                interval._dayEnd === 6 &&
                interval._start > 0 &&
                interval._end === 24 * 60
        )
        // the parser splits a Sunday night at midnight: show it as one range
        const mondayMorning = sundayNight
            ? intervals.find(
                  (interval) =>
                      interval._dayStart === 0 &&
                      interval._dayEnd === 0 &&
                      interval._start === 0 &&
                      interval._end < sundayNight._start
              )
            : undefined

        for (const day of this.days) {
            const times = this.findIntervalsByDay(intervals, day.index)
                .filter((interval) => interval !== mondayMorning)
                .map((interval) => ({
                    start: this.minutesToTime(interval._start),
                    end: this.minutesToTime(
                        interval === sundayNight && mondayMorning
                            ? mondayMorning._end
                            : interval._end
                    ),
                }))
                .sort((first, second) =>
                    first.start.localeCompare(second.start)
                )

            if (times.length === 0) continue

            const signature = JSON.stringify(times)
            const existingGroup = groups.get(signature)
            if (existingGroup) {
                existingGroup.days[day.index].selected = true
                continue
            }

            groups.set(signature, {
                days: this.createDaysSelection(day.index),
                times,
            })
        }

        return [...groups.values()]
    }

    replaceScheduleGroups(groups: OpeningHoursScheduleGroup[]): void {
        const wideInterval = new WideInterval()
        const dateRange = new DateRange(wideInterval.always())

        for (const group of groups) {
            const daysIndex = group.days
                .filter((day) => day.selected)
                .map((day) => day.index)

            for (const dayIndex of daysIndex) {
                for (const time of group.times) {
                    this.addDayInterval(
                        dateRange.getTypical(),
                        dayIndex,
                        this.timeToMinutes(time.start),
                        this.timeToMinutes(time.end)
                    )
                }
            }
        }

        this.intervals = [dateRange]
        this.openingHours.set(builder.build(this.intervals))
        this.valueChangeEvent.emit(this.openingHours())
        this.parseOpeningHours()
    }

    /**
     * Same shape as the parser: a night past midnight ends the next day, and
     * on Sunday it is split at midnight since the week does not wrap around.
     */
    private addDayInterval(
        typical: ReturnType<DateRange['getTypical']>,
        day: number,
        start: number,
        end: number
    ): void {
        if (start <= end) {
            typical.addInterval(new Interval(day, day, start, end))
        } else if (day < 6) {
            typical.addInterval(new Interval(day, day + 1, start, end))
        } else {
            typical.addInterval(new Interval(day, day, start, 24 * 60))
            typical.addInterval(new Interval(0, 0, 0, end))
        }
    }

    timeToMinutes(time: string): number {
        const [hour, min] = time.split(':').map((t) => parseInt(t, 10))
        return min + hour * 60
    }

    minutesToTime(minutes: number): string {
        const hour = Math.floor(minutes / 60)
        const minute = minutes % 60
        return `${hour.toString().padStart(2, '0')}:${minute
            .toString()
            .padStart(2, '0')}`
    }

    private createDaysSelection(selectedDay: number): OpeningHoursDay[] {
        return this.days.map((day) => ({
            index: day.index,
            selected: day.index === selectedDay,
            label: [
                'DAYS.MONDAY',
                'DAYS.TUESDAY',
                'DAYS.WEDNESDAY',
                'DAYS.THURSDAY',
                'DAYS.FRIDAY',
                'DAYS.SATURDAY',
                'DAYS.SUNDAY',
            ][day.index],
        }))
    }

    openModalAddOpeningHours(): void {
        const data: OpeningHoursDialogData = {
            groups: this.getScheduleGroups(),
        }
        const dialogRef = this.dialog.open(
            ModalAddOpeningHoursIntervalComponent,
            {
                width: 'min(620px, calc(100vw - 24px))',
                maxWidth: 'calc(100vw - 24px)',
                maxHeight: 'calc(100dvh - 24px)',
                panelClass: 'osmgo-dialog',
                autoFocus: 'dialog',
                // A tap outside or Escape must not drop unsaved hours: the
                // dialog asks for a confirmation when it holds changes.
                disableClose: true,
                data,
            }
        )
        const requestClose = () => dialogRef.componentInstance?.cancel()
        dialogRef.backdropClick().subscribe(requestClose)
        dialogRef
            .keydownEvents()
            .pipe(filter((event) => event.key === 'Escape'))
            .subscribe(requestClose)

        dialogRef
            .afterClosed()
            .subscribe((result?: OpeningHoursDialogResult) => {
                if (result) {
                    this.replaceScheduleGroups(result.groups)
                }
            })
    }
}
