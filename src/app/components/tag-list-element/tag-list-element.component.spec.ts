import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core'
import { type ComponentFixture, TestBed } from '@angular/core/testing'
import { By } from '@angular/platform-browser'
import { IconComponent } from '@components/icon/icon.component'
import { TranslateModule } from '@ngx-translate/core'
import { TagListElementComponent } from './tag-list-element.component'

const tagsConfig: any = require('../../../assets/tagsAndPresets/tags.json')

describe('TagListElementComponent', () => {
    let component: TagListElementComponent
    let fixture: ComponentFixture<TagListElementComponent>

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [TranslateModule.forRoot(), TagListElementComponent],
            schemas: [CUSTOM_ELEMENTS_SCHEMA],
        }).compileComponents()
        fixture = TestBed.createComponent(TagListElementComponent)
        component = fixture.componentInstance
        fixture.componentRef.setInput('tag', tagsConfig.tags[0])
        const sprite = { height: 16, width: 16, x: 0, y: 0 }
        fixture.componentRef.setInput('jsonSprites', {
            [tagsConfig.tags[0].icon]: sprite,
            'wiki-question': sprite,
        })
        fixture.detectChanges()
    })

    it('should create', () => {
        expect(component).toBeTruthy()
    })

    it('renders the sprite first and hydrates the SVG when available', () => {
        const iconComponent = fixture.debugElement.query(
            By.directive(IconComponent)
        ).componentInstance as IconComponent

        expect(iconComponent.renderMode()).toBe('svg')
        expect(fixture.nativeElement.querySelector('.sprite')).not.toBeNull()
        expect(fixture.nativeElement.querySelector('.svgIcon')).not.toBeNull()
    })

    it('uses a blue filled heart only for bookmarked tags', () => {
        const favoriteButton = fixture.nativeElement.querySelector(
            '.tag-actions button'
        ) as HTMLButtonElement
        const favoriteIcon = favoriteButton.querySelector(
            'mat-icon'
        ) as HTMLElement

        expect(favoriteButton.classList.contains('is-bookmarked')).toBe(false)
        expect(favoriteIcon.textContent?.trim()).toBe('favorite')

        fixture.componentRef.setInput('bookmarksIds', [tagsConfig.tags[0].id])
        fixture.detectChanges()

        expect(favoriteButton.classList.contains('is-bookmarked')).toBe(true)
        expect(favoriteIcon.textContent?.trim()).toBe('favorite')
    })

    it('gives the selected indicator a role so that its label is announced', () => {
        fixture.componentRef.setInput('oldTagConfig', tagsConfig.tags[0])
        fixture.detectChanges()

        const indicator = fixture.nativeElement.querySelector(
            '.current-indicator'
        ) as HTMLElement

        expect(indicator.getAttribute('role')).toBe('img')
        expect(indicator.getAttribute('aria-label')).toBe('A11Y.SELECTED')
    })
})
