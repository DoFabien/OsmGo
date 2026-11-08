import { Component, computed, inject, signal } from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import {
    MAT_DIALOG_DATA,
    MatDialog,
    MatDialogRef,
} from '@angular/material/dialog'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import {
    ConfirmDialogComponent,
    type ConfirmDialogData,
} from '@components/shared/confirm-dialog/confirm-dialog'
import { TranslateModule, TranslateService } from '@ngx-translate/core'

export interface OpeningHoursTime {
    start: string
    end: string
}

interface OpeningHoursTimeRange extends OpeningHoursTime {
    id: number
}

export interface OpeningHoursDay {
    index: number
    selected: boolean
    label: string
}

export interface OpeningHoursScheduleGroup {
    days: OpeningHoursDay[]
    times: OpeningHoursTime[]
}

export interface OpeningHoursDialogData {
    groups: OpeningHoursScheduleGroup[]
}

export interface OpeningHoursDialogResult {
    groups: OpeningHoursScheduleGroup[]
}

interface EditableScheduleGroup {
    id: number
    days: OpeningHoursDay[]
    times: OpeningHoursTimeRange[]
}

const DAY_LABELS = [
    'DAYS.MONDAY',
    'DAYS.TUESDAY',
    'DAYS.WEDNESDAY',
    'DAYS.THURSDAY',
    'DAYS.FRIDAY',
    'DAYS.SATURDAY',
    'DAYS.SUNDAY',
]

const START_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const END_TIME_PATTERN = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/

const timeToMinutes = (value: string): number => {
    const [hours, minutes] = value.split(':').map(Number)
    return hours * 60 + minutes
}

export type OpeningHoursIssueCode =
    | 'noDay'
    | 'noRange'
    | 'invalidTime'
    | 'sameTime'
    | 'overlap'

export interface OpeningHoursIssue {
    groupIndex: number
    /** Absent for an issue that concerns the whole group. */
    timeIndex?: number
    code: OpeningHoursIssueCode
}

const MINUTES_PER_DAY = 24 * 60
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY

interface WeekSpan {
    start: number
    end: number
    groupIndex: number
    timeIndex: number
}

/** A range whose end is before its start runs past midnight into the next day. */
export const endsNextDay = (time: OpeningHoursTime): boolean =>
    START_TIME_PATTERN.test(time.start) &&
    END_TIME_PATTERN.test(time.end) &&
    timeToMinutes(time.end) < timeToMinutes(time.start)

const weekSpansOverlap = (first: WeekSpan, second: WeekSpan): boolean =>
    [-MINUTES_PER_WEEK, 0, MINUTES_PER_WEEK].some(
        (shift) =>
            first.start < second.end + shift && second.start + shift < first.end
    )

export function openingHoursScheduleIssues(
    groups: OpeningHoursScheduleGroup[]
): OpeningHoursIssue[] {
    const issues: OpeningHoursIssue[] = []
    const spans: WeekSpan[] = []

    groups.forEach((group, groupIndex) => {
        const selectedDays = group.days
            .filter((day) => day.selected)
            .map((day) => day.index)
        if (selectedDays.length === 0) {
            issues.push({ groupIndex, code: 'noDay' })
        }
        if (group.times.length === 0) {
            issues.push({ groupIndex, code: 'noRange' })
        }

        group.times.forEach((time, timeIndex) => {
            if (
                !START_TIME_PATTERN.test(time.start) ||
                !END_TIME_PATTERN.test(time.end)
            ) {
                issues.push({ groupIndex, timeIndex, code: 'invalidTime' })
                return
            }
            const start = timeToMinutes(time.start)
            const end = timeToMinutes(time.end)
            if (end === start) {
                issues.push({ groupIndex, timeIndex, code: 'sameTime' })
                return
            }
            const length =
                end > start ? end - start : end + MINUTES_PER_DAY - start
            for (const day of selectedDays) {
                const weekStart = day * MINUTES_PER_DAY + start
                spans.push({
                    start: weekStart,
                    end: weekStart + length,
                    groupIndex,
                    timeIndex,
                })
            }
        })
    })

    const overlapping = new Set<string>()
    for (let first = 0; first < spans.length; first++) {
        for (let second = first + 1; second < spans.length; second++) {
            if (weekSpansOverlap(spans[first], spans[second])) {
                for (const span of [spans[first], spans[second]]) {
                    overlapping.add(`${span.groupIndex}:${span.timeIndex}`)
                }
            }
        }
    }
    for (const key of overlapping) {
        const [groupIndex, timeIndex] = key.split(':').map(Number)
        issues.push({ groupIndex, timeIndex, code: 'overlap' })
    }
    return issues
}

export function openingHoursScheduleIsValid(
    groups: OpeningHoursScheduleGroup[]
): boolean {
    return groups.length > 0 && openingHoursScheduleIssues(groups).length === 0
}

const scheduleSignature = (groups: OpeningHoursScheduleGroup[]): string =>
    JSON.stringify(
        groups.map((group) => [
            group.days.filter((day) => day.selected).map((day) => day.index),
            group.times.map((time) => [time.start, time.end]),
        ])
    )

@Component({
    selector: 'app-modal-add-opening-hours-interval',
    templateUrl: './modal-add-opening-hours-interval.component.html',
    styleUrls: ['./modal-add-opening-hours-interval.component.scss'],
    imports: [
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        TranslateModule,
    ],
})
export class ModalAddOpeningHoursIntervalComponent {
    private readonly dialogRef = inject(
        MatDialogRef<ModalAddOpeningHoursIntervalComponent>
    )
    private readonly data = inject<OpeningHoursDialogData>(MAT_DIALOG_DATA, {
        optional: true,
    })
    private readonly dialog = inject(MatDialog)
    private readonly translate = inject(TranslateService)
    private readonly previousEndTimes = new Map<number, string>()
    private confirmingDiscard = false
    private nextTimeRangeId = 0
    private nextGroupId = 0

    readonly groups = signal<EditableScheduleGroup[]>(
        this.createInitialGroups(this.data?.groups)
    )

    private readonly initialSignature = scheduleSignature(this.groups())
    readonly isDirty = computed(
        () => scheduleSignature(this.groups()) !== this.initialSignature
    )

    readonly issues = computed(() => {
        const byTarget = new Map<string, OpeningHoursIssueCode>()
        for (const issue of openingHoursScheduleIssues(this.groups())) {
            const target = `${issue.groupIndex}:${issue.timeIndex ?? ''}`
            if (!byTarget.has(target)) byTarget.set(target, issue.code)
        }
        return byTarget
    })
    readonly groupsAreValid = computed(
        () => this.groups().length > 0 && this.issues().size === 0
    )

    /** Short weekday names in the interface language, Monday first. */
    readonly shortDayLabels = this.createShortDayLabels()

    issueOf(
        groupIndex: number,
        timeIndex?: number
    ): OpeningHoursIssueCode | undefined {
        return this.issues().get(`${groupIndex}:${timeIndex ?? ''}`)
    }

    endsNextDay(time: OpeningHoursTime): boolean {
        return endsNextDay(time)
    }

    updateTimeRange(
        groupId: number,
        timeId: number,
        field: 'start' | 'end',
        value: string
    ): void {
        this.groups.update((groups) =>
            groups.map((group) =>
                group.id === groupId
                    ? {
                          ...group,
                          times: group.times.map((time) =>
                              time.id === timeId
                                  ? { ...time, [field]: value }
                                  : time
                          ),
                      }
                    : group
            )
        )
    }

    toggleEndAtMidnight(groupId: number, timeId: number): void {
        const time = this.groups()
            .find((group) => group.id === groupId)
            ?.times.find((candidate) => candidate.id === timeId)
        if (!time) return

        if (time.end === '24:00') {
            this.updateTimeRange(
                groupId,
                timeId,
                'end',
                this.previousEndTimes.get(timeId) ?? '23:55'
            )
            return
        }

        this.previousEndTimes.set(timeId, time.end)
        this.updateTimeRange(groupId, timeId, 'end', '24:00')
    }

    addNewInterval(groupId: number): void {
        this.groups.update((groups) =>
            groups.map((group) =>
                group.id === groupId
                    ? {
                          ...group,
                          times: [...group.times, this.createTimeRange()],
                      }
                    : group
            )
        )
    }

    removeInterval(groupId: number, timeId: number): void {
        this.groups.update((groups) =>
            groups.map((group) =>
                group.id === groupId
                    ? {
                          ...group,
                          times: group.times.filter(
                              (time) => time.id !== timeId
                          ),
                      }
                    : group
            )
        )
    }

    toggleDay(groupId: number, dayIndex: number): void {
        this.groups.update((groups) =>
            groups.map((group) =>
                group.id === groupId
                    ? {
                          ...group,
                          days: group.days.map((day) =>
                              day.index === dayIndex
                                  ? { ...day, selected: !day.selected }
                                  : day
                          ),
                      }
                    : group
            )
        )
    }

    addScheduleGroup(): void {
        this.groups.update((groups) => [...groups, this.createGroup()])
    }

    removeScheduleGroup(groupId: number): void {
        this.groups.update((groups) =>
            groups.filter((group) => group.id !== groupId)
        )
    }

    cancel(): void {
        if (!this.isDirty()) {
            this.dialogRef.close(null)
            return
        }
        if (this.confirmingDiscard) return
        this.confirmingDiscard = true
        const data: ConfirmDialogData = {
            title: this.translate.instant('MAIN.SELECTION.DISCARD_TITLE'),
            message: this.translate.instant('MAIN.SELECTION.DISCARD_MESSAGE'),
            cancelLabel: this.translate.instant('SHARED.CANCEL'),
            confirmLabel: this.translate.instant('MAIN.SELECTION.DISCARD'),
            destructive: true,
        }
        this.dialog
            .open(ConfirmDialogComponent, {
                data,
                maxWidth: 'calc(100vw - 32px)',
                panelClass: 'osmgo-dialog',
            })
            .afterClosed()
            .subscribe((confirmed) => {
                this.confirmingDiscard = false
                if (confirmed) this.dialogRef.close(null)
            })
    }

    submit(): void {
        if (!this.groupsAreValid()) return

        const groups = this.groups().map((group) => ({
            days: group.days.map((day) => ({ ...day })),
            times: group.times.map(({ start, end }) => ({ start, end })),
        }))
        this.dialogRef.close({ groups })
    }

    private createShortDayLabels(): string[] {
        let formatter: Intl.DateTimeFormat
        try {
            formatter = new Intl.DateTimeFormat(
                this.translate.getCurrentLang() || undefined,
                { weekday: 'short', timeZone: 'UTC' }
            )
        } catch {
            formatter = new Intl.DateTimeFormat(undefined, {
                weekday: 'short',
                timeZone: 'UTC',
            })
        }
        // 1 January 2024 is a Monday.
        return DAY_LABELS.map((_label, index) =>
            formatter.format(new Date(Date.UTC(2024, 0, 1 + index)))
        )
    }

    private createInitialGroups(
        groups: OpeningHoursScheduleGroup[] | undefined
    ): EditableScheduleGroup[] {
        if (!groups?.length) return [this.createGroup()]
        return groups.map((group) => this.createGroup(group))
    }

    private createGroup(
        group?: OpeningHoursScheduleGroup
    ): EditableScheduleGroup {
        return {
            id: this.nextGroupId++,
            days: DAY_LABELS.map((label, index) => ({
                index,
                selected:
                    group?.days.find((day) => day.index === index)?.selected ??
                    false,
                label,
            })),
            times: group?.times.length
                ? group.times.map((time) => this.createTimeRange(time))
                : [this.createTimeRange()],
        }
    }

    private createTimeRange(
        time: OpeningHoursTime = { start: '09:00', end: '12:00' }
    ): OpeningHoursTimeRange {
        return { id: this.nextTimeRangeId++, ...time }
    }
}
