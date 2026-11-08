import { TestBed } from '@angular/core/testing'
import { Router } from '@angular/router'
import { Capacitor } from '@capacitor/core'
import { AppStorage } from '@services/app-storage.service'
import { ConfigService } from '@services/config.service'
import { TagsService } from '@services/tags.service'
import { APP_LIFECYCLE_PLUGIN, AppComponent } from './app.component'

describe('AppComponent', () => {
    let listener: (event: { url: string }) => void
    let navigate: ReturnType<typeof vi.fn>
    let stored: Record<string, unknown>
    let configService: { platforms: string[]; loadAppVersion: Mock }

    type Mock = ReturnType<typeof vi.fn>

    const create = async (launchUrl?: string): Promise<AppComponent> => {
        vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true)
        vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
        vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android')
        const appPlugin = {
            addListener: vi.fn(
                async (_event: string, callback: typeof listener) => {
                    listener = callback
                    return { remove: vi.fn() }
                }
            ),
            getLaunchUrl: vi.fn(async () =>
                launchUrl ? { url: launchUrl } : undefined
            ),
        }
        navigate = vi.fn().mockResolvedValue(true)
        configService = {
            platforms: [],
            loadAppVersion: vi.fn().mockResolvedValue(undefined),
        }
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
            providers: [
                { provide: ConfigService, useValue: configService },
                { provide: TagsService, useValue: {} },
                { provide: Router, useValue: { navigate } },
                { provide: APP_LIFECYCLE_PLUGIN, useValue: appPlugin },
                {
                    provide: AppStorage,
                    useValue: {
                        ready: vi.fn().mockResolvedValue(undefined),
                        get: vi.fn((key: string) =>
                            Promise.resolve(stored[key] ?? null)
                        ),
                    },
                },
            ],
        })
        const component = TestBed.runInInjectionContext(
            () => new AppComponent()
        )
        await vi.waitFor(() =>
            expect(configService.loadAppVersion).toHaveBeenCalled()
        )
        return component
    }

    beforeEach(() => {
        stored = {}
    })

    afterEach(() => vi.restoreAllMocks())

    it('routes an OAuth redirect received while running', async () => {
        await create()

        listener({ url: 'osmgo://auth?code=abc&state=xyz' })

        expect(navigate).toHaveBeenCalledWith(['/'], {
            queryParams: {
                code: 'abc',
                state: 'xyz',
                nativeOAuthCallbackUrl: 'osmgo://auth?code=abc&state=xyz',
            },
        })
    })

    it('routes the redirect where the WebView leaves the host of osmgo URLs empty', async () => {
        await create()
        vi.stubGlobal(
            'URL',
            class {
                hostname = ''
                protocol = 'osmgo:'
                searchParams = new URLSearchParams()
            }
        )
        try {
            listener({ url: 'osmgo://auth?code=abc&state=xyz' })
        } finally {
            vi.unstubAllGlobals()
        }

        expect(navigate).toHaveBeenCalledWith(['/'], {
            queryParams: {
                code: 'abc',
                state: 'xyz',
                nativeOAuthCallbackUrl: 'osmgo://auth?code=abc&state=xyz',
            },
        })
    })

    it('recovers the redirect that started the application after it was killed', async () => {
        stored['osmOAuthTransaction:prod'] = { state: 'xyz' }

        await create('osmgo://auth?code=abc&state=xyz')

        expect(navigate).toHaveBeenCalledOnce()
        expect(navigate).toHaveBeenCalledWith(
            ['/'],
            expect.objectContaining({
                queryParams: expect.objectContaining({
                    code: 'abc',
                    nativeOAuthCallbackUrl: 'osmgo://auth?code=abc&state=xyz',
                }),
            })
        )
    })

    it('handles a redirect delivered both as launch URL and as an event only once', async () => {
        stored['osmOAuthTransaction:dev'] = { state: 'xyz' }
        await create('osmgo://auth?code=abc&state=xyz')

        listener({ url: 'osmgo://auth?code=abc&state=xyz' })

        expect(navigate).toHaveBeenCalledOnce()
    })

    it('ignores a stale launch URL when no sign-in is pending', async () => {
        await create('osmgo://auth?code=abc&state=xyz')

        expect(navigate).not.toHaveBeenCalled()
    })

    it.each(['https://auth/?code=abc', 'osmgo://other?code=abc', 'not a url'])(
        'rejects %s with the same validation as events',
        async (url) => {
            stored['osmOAuthTransaction:prod'] = { state: 'xyz' }
            await create(url)

            listener({ url })

            expect(navigate).not.toHaveBeenCalled()
        }
    )

    it('asks for persistent storage without failing when it is refused', async () => {
        const persist = vi.fn().mockRejectedValue(new Error('denied'))
        Object.defineProperty(navigator, 'storage', {
            configurable: true,
            value: { persist },
        })
        try {
            await create()
            await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
        } finally {
            Reflect.deleteProperty(navigator, 'storage')
        }
    })
})
