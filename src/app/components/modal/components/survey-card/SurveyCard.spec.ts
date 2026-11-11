import { TestBed } from '@angular/core/testing'
import { TranslateModule } from '@ngx-translate/core'
import type { OsmGoFeature } from '@osmgo/type'
import { SurveyCard } from './SurveyCard'

describe('SurveyCard', () => {
    function render(type: 'node' | 'way', removable?: boolean) {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: [SurveyCard, TranslateModule.forRoot()],
        })
        const fixture = TestBed.createComponent(SurveyCard)
        fixture.componentRef.setInput('feature', {
            properties: { type },
        } as OsmGoFeature)
        if (removable !== undefined) {
            fixture.componentRef.setInput('removable', removable)
        }
        fixture.detectChanges()
        return fixture
    }

    const noButton = (fixture: ReturnType<typeof render>) =>
        fixture.nativeElement.querySelector('.no-button') as HTMLButtonElement

    it('lets a point be reported as gone', () => {
        const fixture = render('node')

        expect(noButton(fixture).disabled).toBe(false)
        expect(
            fixture.nativeElement.querySelector('.survey-card__hint')
        ).toBeNull()
    })

    it('explains why "No" is unavailable for a way', () => {
        const fixture = render('way')

        expect(noButton(fixture).disabled).toBe(true)
        expect(
            fixture.nativeElement.querySelector('.survey-card__hint')
                .textContent
        ).toContain('MODAL_SELECTED_ITEM.SURVEY_NO_NODE_ONLY')
    })

    it('lets a bank on a building be reported as gone', () => {
        const fixture = render('way', true)

        expect(noButton(fixture).disabled).toBe(false)
        expect(
            fixture.nativeElement.querySelector('.survey-card__hint')
        ).toBeNull()
    })
})
