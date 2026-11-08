import { type ComponentFixture, TestBed } from '@angular/core/testing'
import { MatDialogRef } from '@angular/material/dialog'
import { TranslateModule } from '@ngx-translate/core'
import { DialogMultiFeaturesComponent } from './dialog-multi-features.component'

describe('DialogMultiFeaturesComponent', () => {
    let component: DialogMultiFeaturesComponent
    let fixture: ComponentFixture<DialogMultiFeaturesComponent>

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [DialogMultiFeaturesComponent, TranslateModule.forRoot()],
            providers: [{ provide: MatDialogRef, useValue: {} }],
        }).compileComponents()
        fixture = TestBed.createComponent(DialogMultiFeaturesComponent)
        component = fixture.componentInstance
        fixture.componentRef.setInput('features', [])
        fixture.componentRef.setInput('jsonSprites', {})
        fixture.detectChanges()
    })

    it('should create', () => {
        expect(component).toBeTruthy()
    })

    it('lists a node and a way that share the same numeric id', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const feature = (type: string, name: string) => ({
            properties: {
                _name: name,
                hexColor: '#000',
                icon: '',
                id: 42,
                type,
            },
        })
        fixture.componentRef.setInput('features', [
            feature('node', 'A node'),
            feature('way', 'A way'),
        ])
        fixture.detectChanges()
        fixture.componentRef.setInput('features', [
            feature('node', 'A node'),
            feature('way', 'A way'),
            feature('relation', 'A relation'),
        ])
        fixture.detectChanges()

        const rows: HTMLElement[] = Array.from(
            fixture.nativeElement.querySelectorAll('.feature-row')
        )

        expect(rows.map((row) => row.textContent)).toEqual([
            expect.stringContaining('A node'),
            expect.stringContaining('A way'),
            expect.stringContaining('A relation'),
        ])
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('NG0955'))
        warn.mockRestore()
    })
})
