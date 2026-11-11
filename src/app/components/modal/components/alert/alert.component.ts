import { Component, input, output } from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { TranslateModule } from '@ngx-translate/core'
import type { TagConfig } from '@osmgo/type'

interface AlertTagConfig extends TagConfig {
    alert?: Record<string, string>
    deprecated?: boolean
    replace?: Record<string, string | number>
    warning?: Record<string, string>
    warningCountryCodes?: string[]
}

@Component({
    selector: 'app-alert',
    templateUrl: './alert.component.html',
    styleUrls: ['./alert.component.scss'],
    imports: [MatButtonModule, MatIconModule, TranslateModule],
})
export class AlertComponent {
    readonly tagConfig = input<AlertTagConfig>()
    readonly language = input('en')
    readonly countryCode = input('')
    /**
     * Whether the replacement can be applied by the editor. A replacement
     * without a primary key (a scrap yard becomes `landuse=industrial`) would
     * leave an object the editor cannot open.
     */
    readonly canFix = input(true)
    readonly fixDeprecated = output<{
        old: Record<string, string | number>
        replace: Record<string, string | number>
    }>()
}
