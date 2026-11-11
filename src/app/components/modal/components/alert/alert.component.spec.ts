import { type ComponentFixture, TestBed } from '@angular/core/testing'
import { TranslateModule } from '@ngx-translate/core'
import { AlertComponent } from './alert.component'

describe('AlertComponent', () => {
    let component: AlertComponent
    let fixture: ComponentFixture<AlertComponent>

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AlertComponent, TranslateModule.forRoot()],
        }).compileComponents()
        fixture = TestBed.createComponent(AlertComponent)
        component = fixture.componentInstance
        fixture.detectChanges()
    })

    it('should create', () => {
        expect(component).toBeTruthy()
    })

    describe('fixing a deprecated tag', () => {
        const showAlert = (canFix: boolean) => {
            fixture.componentRef.setInput('tagConfig', {
                id: 'amenity/scrapyard',
                deprecated: true,
                tags: { amenity: 'scrapyard' },
                replace: { landuse: 'industrial' },
            })
            fixture.componentRef.setInput('canFix', canFix)
            fixture.detectChanges()
            return fixture.nativeElement as HTMLElement
        }

        it('offers the fix when the editor can apply it', () => {
            expect(showAlert(true).querySelector('button')).not.toBeNull()
        })

        it('keeps the warning but not the fix when it cannot', () => {
            const element = showAlert(false)

            expect(element.querySelector('[role="alert"]')).not.toBeNull()
            expect(element.querySelector('button')).toBeNull()
        })
    })
})
