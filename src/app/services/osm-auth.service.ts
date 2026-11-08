import { HttpClient, HttpHeaders } from '@angular/common/http'
import { InjectionToken, inject, Service, signal } from '@angular/core'
import {
    NATIVE_OAUTH_REDIRECT_URI,
    readNativeOAuthCallback,
} from '@app/utils/native-oauth-callback'
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import { AppStorage } from '@services/app-storage.service'
import { defer, firstValueFrom, from, map, type Observable, of } from 'rxjs'
import { finalize, switchMap, timeout } from 'rxjs/operators'

import { ConfigService } from './config.service'

const OAUTH_SCOPES = 'read_prefs write_api'
const OAUTH_REQUIRED_SCOPE = 'write_api'
const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000
const OAUTH_TOKEN_TIMEOUT_MS = 30_000
const OAUTH_REVOKE_TIMEOUT_MS = 10_000

interface OAuthTransaction {
    state: string
    verifier: string
    environment: 'prod' | 'dev'
    redirectUri: string
    createdAt: number
}

interface OAuthTokenResponse {
    access_token?: string
    token_type?: string
    scope?: string
    created_at?: number
}

export type OAuthBrowser = Pick<typeof Browser, 'close' | 'open'>

export const OAUTH_BROWSER = new InjectionToken<OAuthBrowser>('OAuth browser', {
    factory: () => Browser,
})

@Service()
export class OsmAuthService {
    private readonly http = inject(HttpClient)
    private readonly configService = inject(ConfigService)
    private readonly browser = inject(OAUTH_BROWSER)
    readonly localStorage = inject(AppStorage)

    oauthParam = {
        prod: {
            url: 'https://www.openstreetmap.org',
            clientId: '-1NG8U9VYF2bMfdgWNHVRbO9LE1gWx_ABmst9egWdBQ',
        },
        dev: {
            url: 'https://master.apis.dev.openstreetmap.org',
            clientId: 'aqB_PKIY18QNLJODai_i4dQzoBlTAEwSxY_258JML0Y',
        },
    }

    private readonly tokenState = signal<string | null>(null)
    readonly token = this.tokenState.asReadonly()
    private tokenRevision = 0
    private tokenPersistence = Promise.resolve()

    private get environmentId(): 'prod' | 'dev' {
        return this.configService.config().isDevServer ? 'dev' : 'prod'
    }

    private get tokenStorageKey(): string {
        return `osmToken:${this.environmentId}`
    }

    private get transactionStorageKey(): string {
        return `osmOAuthTransaction:${this.environmentId}`
    }

    async loadToken(): Promise<string | null> {
        const revision = this.tokenRevision
        try {
            let value = await this.localStorage.get<string>(
                this.tokenStorageKey
            )
            if (!value) {
                value = await this.localStorage.get<string>('osmToken')
                if (value) {
                    await this.localStorage.set(this.tokenStorageKey, value)
                    await this.localStorage.remove('osmToken')
                }
            }
            if (revision === this.tokenRevision && value) {
                this.tokenState.set(value)
            }
        } catch (error) {
            console.error(error)
        }
        return this.token()
    }

    get redirectUri(): string {
        if (Capacitor.isNativePlatform()) {
            return NATIVE_OAUTH_REDIRECT_URI
        }
        return document.baseURI
    }

    get clientId(): string {
        return this.configService.config().isDevServer
            ? this.oauthParam.dev.clientId
            : this.oauthParam.prod.clientId
    }

    get oauthUrl(): string {
        const server = this.configService.config().isDevServer
            ? this.oauthParam.dev.url
            : this.oauthParam.prod.url
        return `${server}/oauth2`
    }

    async getLoginUrl(): Promise<string> {
        const verifier = this.createRandomValue()
        const state = this.createRandomValue()
        const challenge = await this.createCodeChallenge(verifier)

        const transaction: OAuthTransaction = {
            state,
            verifier,
            environment: this.environmentId,
            redirectUri: this.redirectUri,
            createdAt: Date.now(),
        }
        await this.persistAuthorization(transaction)

        const parameters = new URLSearchParams()
        parameters.set('client_id', this.clientId)
        parameters.set('redirect_uri', this.redirectUri)
        parameters.set('response_type', 'code')
        parameters.set('scope', OAUTH_SCOPES)
        parameters.set('state', state)
        parameters.set('code_challenge', challenge)
        parameters.set('code_challenge_method', 'S256')

        return `${this.oauthUrl}/authorize?${parameters.toString()}`
    }

    login(): Observable<void> {
        return from(this.getLoginUrl()).pipe(
            switchMap((url) => {
                if (Capacitor.isNativePlatform()) {
                    return from(this.browser.open({ url }))
                }

                // OAuth must stay in the current web tab. Opening a second tab
                // separates the callback from its sessionStorage PKCE verifier
                // and leaves the original OsmGo tab unaware of the new token.
                window.location.assign(url)
                return of(undefined)
            })
        )
    }

    handleCallback(url: string): Observable<OAuthTokenResponse> {
        const shouldCloseBrowser = Capacitor.isNativePlatform()
        return defer(() => from(this.consumeAuthorization(url))).pipe(
            switchMap(({ code, verifier }) =>
                this.exchangeCodeForToken(code, verifier)
            ),
            finalize(() => {
                if (shouldCloseBrowser) {
                    void this.closeNativeBrowser()
                }
            })
        )
    }

    exchangeCodeForToken(
        code: string,
        verifier: string
    ): Observable<OAuthTokenResponse> {
        const body = new URLSearchParams()
        body.set('grant_type', 'authorization_code')
        body.set('code', code)
        body.set('redirect_uri', this.redirectUri)
        body.set('client_id', this.clientId)
        body.set('code_verifier', verifier)

        return this.http
            .post<OAuthTokenResponse>(
                `${this.oauthUrl}/token`,
                body.toString(),
                {
                    headers: new HttpHeaders().set(
                        'Content-Type',
                        'application/x-www-form-urlencoded'
                    ),
                }
            )
            .pipe(
                timeout(OAUTH_TOKEN_TIMEOUT_MS),
                switchMap((response) => {
                    if (!response.access_token) {
                        throw new Error(
                            'OpenStreetMap returned no OAuth access token.'
                        )
                    }
                    if (
                        typeof response.scope === 'string' &&
                        !response.scope
                            .split(/\s+/)
                            .includes(OAUTH_REQUIRED_SCOPE)
                    ) {
                        // A token that cannot edit would only fail at upload.
                        throw new Error(
                            'The OpenStreetMap authorization does not allow editing the map.'
                        )
                    }

                    return from(this.setToken(response.access_token)).pipe(
                        map(() => response)
                    )
                })
            )
    }

    async setToken(token: string): Promise<void> {
        const previousToken = this.token()
        const revision = ++this.tokenRevision
        this.tokenState.set(token)

        try {
            await this.queueTokenPersistence(() =>
                this.localStorage.set(this.tokenStorageKey, token)
            )
        } catch (error) {
            if (revision === this.tokenRevision) {
                this.tokenState.set(previousToken)
            }
            throw error
        }
    }

    /**
     * Forgets the token locally. The returned promise settles once the stored
     * copy is deleted; a storage failure is logged, not thrown.
     */
    clearToken(): Promise<void> {
        this.tokenRevision++
        this.tokenState.set(null)
        const tokenKey = this.tokenStorageKey
        const deletion = this.queueTokenPersistence(async () => {
            await Promise.all([
                this.localStorage.remove(tokenKey),
                this.localStorage.remove('osmToken'),
            ])
        }).catch((error) => {
            console.error(error)
        })
        this.configService.resetUserInfo()
        this.configService.resetChangeset()
        return deletion
    }

    /**
     * Asks OpenStreetMap to invalidate a token. Failing (offline, refused) is
     * harmless: the token was already forgotten locally.
     */
    private async revokeToken(token: string): Promise<void> {
        const body = new URLSearchParams()
        body.set('token', token)
        body.set('client_id', this.clientId)
        try {
            await firstValueFrom(
                this.http
                    .post(`${this.oauthUrl}/revoke`, body.toString(), {
                        headers: new HttpHeaders().set(
                            'Content-Type',
                            'application/x-www-form-urlencoded'
                        ),
                        responseType: 'text',
                    })
                    .pipe(timeout(OAUTH_REVOKE_TIMEOUT_MS))
            )
        } catch (error) {
            console.warn('The OAuth token could not be revoked.', error)
        }
    }

    async clearAllAuthentication(): Promise<void> {
        this.tokenRevision++
        this.tokenState.set(null)
        await this.queueTokenPersistence(async () => {
            await Promise.all(
                [
                    'osmToken',
                    'osmToken:prod',
                    'osmToken:dev',
                    'osmOAuthTransaction:prod',
                    'osmOAuthTransaction:dev',
                ].map((key) => this.localStorage.remove(key))
            )
        })
        sessionStorage.removeItem('osmOAuthTransaction:prod')
        sessionStorage.removeItem('osmOAuthTransaction:dev')
        this.configService.resetUserInfo()
        this.configService.resetChangeset()
    }

    getToken(): string | null {
        return this.token()
    }

    /** Signs out: forgets the token, then revokes it on OpenStreetMap. */
    async logout(): Promise<void> {
        const token = this.token()
        const revocation = token ? this.revokeToken(token) : Promise.resolve()
        await Promise.all([this.clearToken(), revocation])
    }

    isAuthenticated(): boolean {
        return !!this.getToken()
    }

    private createRandomValue(): string {
        const bytes = crypto.getRandomValues(new Uint8Array(32))
        return this.toBase64Url(bytes)
    }

    private async createCodeChallenge(verifier: string): Promise<string> {
        const value = new TextEncoder().encode(verifier)
        const digest = await crypto.subtle.digest('SHA-256', value)
        return this.toBase64Url(new Uint8Array(digest))
    }

    private toBase64Url(bytes: Uint8Array): string {
        let value = ''
        for (const byte of bytes) {
            value += String.fromCharCode(byte)
        }
        return btoa(value)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '')
    }

    private async persistAuthorization(
        transaction: OAuthTransaction
    ): Promise<void> {
        if (Capacitor.isNativePlatform()) {
            await this.localStorage.set(this.transactionStorageKey, transaction)
            return
        }
        sessionStorage.setItem(
            this.transactionStorageKey,
            JSON.stringify(transaction)
        )
    }

    /**
     * The stored transaction is only removed once the callback carries its
     * `state`: a stale or forged callback cannot cancel the sign-in in
     * progress.
     */
    private async consumeAuthorization(
        url: string
    ): Promise<{ code: string; verifier: string }> {
        const isNative = Capacitor.isNativePlatform()
        let parameters: URLSearchParams
        if (isNative) {
            const nativeParameters = readNativeOAuthCallback(url)
            if (!nativeParameters) {
                throw new Error('Invalid native OAuth callback URL.')
            }
            parameters = nativeParameters
        } else {
            const callbackUrl = new URL(url, document.baseURI)
            const redirectUrl = new URL(document.baseURI)
            if (
                callbackUrl.origin !== redirectUrl.origin ||
                callbackUrl.pathname !== redirectUrl.pathname
            ) {
                throw new Error('Invalid web OAuth callback URL.')
            }
            parameters = callbackUrl.searchParams
        }

        const storageKey = this.transactionStorageKey
        let transaction: OAuthTransaction | null = null
        if (isNative) {
            transaction =
                await this.localStorage.get<OAuthTransaction>(storageKey)
        } else {
            const persisted = sessionStorage.getItem(storageKey)
            if (persisted) {
                try {
                    transaction = JSON.parse(persisted) as OAuthTransaction
                } catch {
                    sessionStorage.removeItem(storageKey)
                    throw new Error('The OAuth transaction is corrupted.')
                }
            }
        }

        const state = parameters.get('state')
        if (!transaction || !state || state !== transaction.state) {
            throw new Error('Invalid OAuth state.')
        }
        if (isNative) {
            await this.localStorage.remove(storageKey)
        } else {
            sessionStorage.removeItem(storageKey)
        }

        const oauthError = parameters.get('error')
        if (oauthError) {
            const description = parameters.get('error_description')
            throw new Error(description || oauthError)
        }
        const code = parameters.get('code')
        if (!code) {
            throw new Error('No authorization code found in callback URL.')
        }
        if (
            transaction.environment !== this.environmentId ||
            transaction.redirectUri !== this.redirectUri
        ) {
            throw new Error('Invalid OAuth state.')
        }
        if (
            !Number.isFinite(transaction.createdAt) ||
            Date.now() - transaction.createdAt > OAUTH_TRANSACTION_TTL_MS
        ) {
            throw new Error('The OAuth authorization request has expired.')
        }
        if (!transaction.verifier) {
            throw new Error('No PKCE verifier found for this callback.')
        }
        return { code, verifier: transaction.verifier }
    }

    private queueTokenPersistence(
        operation: () => Promise<unknown>
    ): Promise<void> {
        const persistence = this.tokenPersistence
            .catch(() => undefined)
            .then(operation)
            .then(() => undefined)
        this.tokenPersistence = persistence.catch(() => undefined)
        return persistence
    }

    private async closeNativeBrowser(): Promise<void> {
        await this.browser.close().catch(() => undefined)
    }
}
