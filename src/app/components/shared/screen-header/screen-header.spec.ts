import { TestBed } from '@angular/core/testing'
import { TranslateModule } from '@ngx-translate/core'
import { ScreenHeaderComponent } from './screen-header'

describe('ScreenHeaderComponent', () => {
    function render() {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            imports: [ScreenHeaderComponent, TranslateModule.forRoot()],
        })
        const fixture = TestBed.createComponent(ScreenHeaderComponent)
        fixture.componentRef.setInput('title', 'Settings')
        fixture.detectChanges()
        return fixture
    }

    it('names the back arrow and emits when it is pressed', () => {
        const fixture = render()
        const back = vi.fn()
        fixture.componentInstance.backRequested.subscribe(back)

        const button = fixture.nativeElement.querySelector(
            'button'
        ) as HTMLButtonElement
        button.click()

        expect(button.getAttribute('aria-label')).toBe('SHARED.CLOSE')
        expect(back).toHaveBeenCalledOnce()
    })

    it('paints the icon buttons with the header ink on the blue toolbar', () => {
        render()

        const styles = Array.from(document.querySelectorAll('style'))
            .map((style) => style.textContent ?? '')
            .join('\n')

        expect(styles).toMatch(
            /--mat-icon-button-icon-color:\s*var\(--osmgo-on-header\)/
        )
        expect(styles).toMatch(/background:\s*var\(--osmgo-header-surface\)/)
    })
})
