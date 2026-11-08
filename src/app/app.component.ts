import {
    Component,
    InjectionToken,
    inject,
    type OnDestroy,
} from '@angular/core'
import { Router, RouterOutlet } from '@angular/router'
import { readNativeOAuthCallback } from '@app/utils/native-oauth-callback'
import { App } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { AppStorage } from '@services/app-storage.service'
import { ConfigService } from '@services/config.service'
import { TagsService } from '@services/tags.service'

export type AppLifecyclePlugin = Pick<
    typeof App,
    'addListener' | 'getLaunchUrl'
>

export const APP_LIFECYCLE_PLUGIN = new InjectionToken<AppLifecyclePlugin>(
    'Capacitor App plugin',
    { factory: () => App }
)

const NATIVE_OAUTH_TRANSACTION_KEYS = [
    'osmOAuthTransaction:prod',
    'osmOAuthTransaction:dev',
]

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    imports: [RouterOutlet],
})
export class AppComponent implements OnDestroy {
    readonly configService = inject(ConfigService)
    readonly tagService = inject(TagsService)
    private readonly storage = inject(AppStorage)
    private readonly router = inject(Router)
    private readonly appPlugin = inject(APP_LIFECYCLE_PLUGIN)
    private appUrlOpenListener?: PluginListenerHandle
    private lastHandledUrl?: string

    constructor() {
        this.initializeApp()
    }

    ngAfterViewInit(): void {
        SplashScreen.hide()
    }

    async initializeApp(): Promise<void> {
        await this.storage.ready()
        void this.requestPersistentStorage()

        if (Capacitor.isPluginAvailable('App')) {
            this.appUrlOpenListener = await this.appPlugin.addListener(
                'appUrlOpen',
                (data) => this.handleAppUrl(data.url)
            )
            await this.handleLaunchUrl()
        }

        this.configService.platforms = Capacitor.isNativePlatform()
            ? ['hybrid', Capacitor.getPlatform()]
            : ['web']

        await this.configService.loadAppVersion()
    }

    /**
     * Android kills the application while the browser shows the OpenStreetMap
     * consent page: the redirect then starts the application, and `appUrlOpen`
     * is never emitted for the URL that launched it. The launch URL is only
     * trusted while a sign-in is pending, so a stale one cannot replay.
     */
    private async handleLaunchUrl(): Promise<void> {
        try {
            const launch = await this.appPlugin.getLaunchUrl()
            if (!launch?.url) return
            const pending = await Promise.all(
                NATIVE_OAUTH_TRANSACTION_KEYS.map((key) =>
                    this.storage.get(key)
                )
            )
            if (pending.some((transaction) => transaction)) {
                this.handleAppUrl(launch.url)
            }
        } catch (error) {
            console.warn('The launch URL could not be read.', error)
        }
    }

    private handleAppUrl(url: string): void {
        const parameters = readNativeOAuthCallback(url)
        if (!parameters) return
        if (url === this.lastHandledUrl) return
        this.lastHandledUrl = url
        void this.router.navigate(['/'], {
            queryParams: {
                ...Object.fromEntries(parameters),
                nativeOAuthCallbackUrl: url,
            },
        })
    }

    /** Asks the browser not to evict the pending edits under storage pressure. */
    private async requestPersistentStorage(): Promise<void> {
        try {
            await navigator.storage?.persist?.()
        } catch {
            // Best effort: some browsers refuse without a prompt.
        }
    }

    ngOnDestroy(): void {
        void this.appUrlOpenListener?.remove()
    }
}
