import { Component, input, output } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MAX_OSM_TAG_LENGTH } from '@app/utils/osm-tags'
import { TranslateModule } from '@ngx-translate/core'
import type { Tag } from '@osmgo/type'
import { type TagValueIssue, tagValueIssue } from '../../editor-tag'

@Component({
    selector: 'edit-other-tag',
    template: `
        <article class="edit-other-tag">
            <strong><mat-icon fontSet="material-symbols-rounded">code</mat-icon>{{ tag().key }}</strong>
            <div>
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                    <input matInput type="text" [attr.maxlength]="maxLength" [attr.aria-label]="tag().key" [attr.aria-invalid]="issue ? true : null" [(ngModel)]="tag().value" />
                </mat-form-field>
                <button mat-icon-button type="button" [attr.aria-label]="'A11Y.REMOVE_TAG' | translate" (click)="eventDeleteTag()">
                    <mat-icon fontSet="material-symbols-rounded">delete</mat-icon>
                </button>
            </div>
            @if (issue === 'tooLong' || limitReached) {
                <p class="field-hint" role="status">{{ 'MODAL_SELECTED_ITEM.VALUE_LIMIT' | translate: { max: maxLength } }}</p>
            } @else if (issue === 'invalid') {
                <p class="field-hint field-hint--error" role="alert">{{ 'MODAL_SELECTED_ITEM.VALUE_INVALID' | translate: { key: tag().key } }}</p>
            }
        </article>
    `,
    styles: [
        `
        :host { display: block; }
        .edit-other-tag { padding: 12px 14px; border: 1px solid var(--osmgo-divider); border-radius: 16px; background: var(--osmgo-surface); }
        strong { display: flex; align-items: center; gap: 5px; color: var(--osmgo-ink-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
        strong mat-icon { width: 17px; height: 17px; font-size: 17px; }
        .edit-other-tag > div { display: grid; grid-template-columns: minmax(0, 1fr) 48px; align-items: center; gap: 4px; }
        mat-form-field { width: 100%; }
        button { color: var(--osmgo-error); }
        .field-hint { margin: 6px 2px 0; color: var(--osmgo-ink-muted); font-size: 12px; }
        .field-hint--error { color: var(--osmgo-error); }
    `,
    ],
    imports: [
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        TranslateModule,
    ],
})
export class EditOtherTag {
    readonly tag = input.required<Tag>()
    readonly deleteTag = output<Tag>()
    readonly maxLength = MAX_OSM_TAG_LENGTH

    get issue(): TagValueIssue | null {
        return tagValueIssue(this.tag().value)
    }

    get limitReached(): boolean {
        return String(this.tag().value ?? '').length >= this.maxLength
    }

    eventDeleteTag(): void {
        this.deleteTag.emit(this.tag())
    }
}
