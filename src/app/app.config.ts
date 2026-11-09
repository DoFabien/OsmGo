import {
    provideHttpClient,
    withInterceptorsFromDi,
    withXhr,
} from '@angular/common/http'
import {
    type ApplicationConfig,
    provideCheckNoChangesConfig,
} from '@angular/core'
import {
    MAT_DIALOG_DEFAULT_OPTIONS,
    MatDialogConfig,
} from '@angular/material/dialog'
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async'
import { provideRouter, withRouterConfig } from '@angular/router'
import { provideServiceWorker } from '@angular/service-worker'
import { routes } from '@app/app.routes'
import { Capacitor } from '@capacitor/core'
import { environment } from '@environments/environment'
import { provideTranslateService } from '@ngx-translate/core'
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader'

export const appConfig: ApplicationConfig = {
    providers: [
        provideRouter(
            routes,
            withRouterConfig({ canceledNavigationResolution: 'computed' })
        ),
        ...(environment.production
            ? []
            : [
                  provideCheckNoChangesConfig({
                      exhaustive: true,
                      interval: 1000,
                  }),
              ]),
        provideHttpClient(withXhr(), withInterceptorsFromDi()),
        provideAnimationsAsync(),
        // The map page closes its dialogs itself on the back gesture, which
        // also moves through the history (see MainPage.handlePopState).
        {
            provide: MAT_DIALOG_DEFAULT_OPTIONS,
            useValue: { ...new MatDialogConfig(), closeOnNavigation: false },
        },
        provideServiceWorker('ngsw-worker.js', {
            enabled: environment.production && !Capacitor.isNativePlatform(),
        }),
        provideTranslateService({
            fallbackLang: 'en',
            loader: provideTranslateHttpLoader({ prefix: './assets/i18n/' }),
        }),
    ],
}
