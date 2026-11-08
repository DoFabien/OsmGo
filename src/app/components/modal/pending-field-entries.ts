import { computed, Injectable, signal } from '@angular/core'

/**
 * Text typed in an "add a value" box but not added yet. The editor adds it
 * on save and counts it as a change, so it is never dropped silently.
 */
@Injectable()
export class PendingFieldEntries {
    private readonly entries = signal<ReadonlyMap<object, () => void>>(
        new Map()
    )
    readonly count = computed(() => this.entries().size)

    set(owner: object, commit: (() => void) | null): void {
        const entries = this.entries()
        if (!commit && !entries.has(owner)) return
        const next = new Map(entries)
        if (commit) {
            next.set(owner, commit)
        } else {
            next.delete(owner)
        }
        this.entries.set(next)
    }

    commitAll(): void {
        for (const commit of [...this.entries().values()]) commit()
    }
}
