import {
    provideHttpClient,
    withInterceptorsFromDi,
    withXhr,
} from '@angular/common/http'
import {
    type ApplicationConfig,
    provideCheckNoChangesConfig,
} from '@angular/core'
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
        provideServiceWorker('ngsw-worker.js', {
            enabled: environment.production && !Capacitor.isNativePlatform(),
        }),
        provideTranslateService({
            fallbackLang: 'en',
            loader: provideTranslateHttpLoader({ prefix: './assets/i18n/' }),
        }),
    ],
}
