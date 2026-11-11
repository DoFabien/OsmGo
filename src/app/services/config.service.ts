import { DOCUMENT } from '@angular/common'
import { HttpClient } from '@angular/common/http'
import { Injector, inject, Service, signal } from '@angular/core'
import type { ChangesetBbox } from '@app/utils/changeset-bbox'
import { environment } from '@environments/environment'
import { TranslateService } from '@ngx-translate/core'
import {
    BING_MAX_ZOOM,
    IGN_BDORTHO_ID,
    IGN_BDORTHO_MAX_ZOOM,
    IGN_BDORTHO_TILE_URL,
} from '@osmgo/shared/basemap.constants'
import type { CountryCode, Iso6391Language } from '@osmgo/type'
import { AppStorage } from '@services/app-storage.service'
import type { Basemap } from '@services/basemaps.service'
import { DataService } from '@services/data.service'
import { TagsService } from '@services/tags.service'
import { from, type Observable } from 'rxjs'
import { map } from 'rxjs/operators'

/**
 * Country used to pick regional tag options: the region of the browser
 * locale, or the main country of its language when it carries none.
 */
export const defaultCountryFromLocale = (
    languages: readonly string[] = []
): string => {
    for (const language of languages) {
        const region = language.split('-')[1]
        if (region && /^[A-Za-z]{2}$/.test(region)) return region.toUpperCase()
    }
    for (const language of languages) {
        try {
            // `es-419` or `ar-001` carry a numeric area, not a country
            const region = new Intl.Locale(language).maximize().region
            if (region && /^[A-Z]{2}$/.test(region)) return region
        } catch {
            // Not a valid BCP 47 tag: try the next preferred language.
        }
    }
    return 'GB'
}

/**
 * The interface language to use for a requested one: itself when it is
 * offered, else the offered variant of the same language (`zh` is only
 * offered as `zh-CN` and `zh-TW`), else English.
 */
export const resolveUiLanguage = (
    requested: string,
    offered: readonly string[],
    preferred: readonly string[] = []
): string => {
    if (offered.includes(requested)) return requested
    const base = requested.split('-')[0]
    const variants = offered.filter(
        (language) => language.split('-')[0] === base
    )
    if (variants.length === 0) return 'en'
    for (const language of preferred) {
        if (variants.includes(language)) return language
        try {
            const { script, region } = new Intl.Locale(language).maximize()
            if (language.split('-')[0] !== base) continue
            const match = variants.find((variant) => {
                const locale = new Intl.Locale(variant).maximize()
                return locale.script === script || locale.region === region
            })
            if (match) return match
        } catch {
            // Not a valid BCP 47 tag: try the next preferred language.
        }
    }
    return variants[0]
}

export interface User {
    uid: string
    display_name: string
    connected: boolean
}

export interface Changeset {
    id: string
    last_changeset_activity: number
    created_at: number
    comment: string
    /** Area already covered by the uploads sent to this changeset. */
    bbox?: ChangesetBbox
}

export interface AppVersion {
    appName: string
    appVersionCode: string
    appVersionNumber: string
    platform?: string
    branch?: string
    shortHash?: string
}

interface I18nConfig {
    uiLanguages: string[]
    language: Iso6391Language[]
}

export interface Config {
    mapMarginBuffer: number
    lockMapHeading: boolean
    followPosition: boolean
    defaultPrimarykeyWindows: 'lastTags' | 'bookmarks'
    basemap: Basemap
    filterWayByArea: boolean
    filterWayByLength: boolean
    changeSetComment: string
    languageUi: string
    languageTags: string
    countryTags: string
    oldTagsIcon: { display: boolean; year: number }
    displayFixmeIcon: boolean
    addSurveyDate: boolean
    isDevServer: boolean
    checkedKey: 'survey:date' | 'check_date'
    surveyCard: {
        display: 'never' | 'when_older' | 'always'
        year: number
    }
    isSelectableLine: boolean
    isSelectablePolygon: boolean
    passwordSaved: boolean
    lastView: { lng: number; lat: number; zoom: number; bearing: number }
    centerWhenGpsIsReady: boolean
    openObjectSheetAsPreview: boolean
    limitFeatures: number
}

/**
 * The settings kept in the `config` key. The last map view has its own key
 * and signal: it changes on every map move and must not recompute every
 * reader of the settings.
 */
export type StoredConfig = Omit<Config, 'lastView'>

const LAST_VIEW_STORAGE_KEY = 'lastView'

const readMapView = (value: unknown): Config['lastView'] | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const view = value as Record<string, unknown>
    const { lng, lat, zoom, bearing } = view
    if (
        typeof lng !== 'number' ||
        typeof lat !== 'number' ||
        typeof zoom !== 'number' ||
        !Number.isFinite(lng) ||
        !Number.isFinite(lat) ||
        !Number.isFinite(zoom)
    ) {
        return undefined
    }
    return {
        lng,
        lat,
        zoom,
        bearing:
            typeof bearing === 'number' && Number.isFinite(bearing)
                ? bearing
                : 0,
    }
}

@Service()
export class ConfigService {
    readonly localStorage = inject(AppStorage)
    private readonly http = inject(HttpClient)
    private readonly translate = inject(TranslateService)
    private readonly document = inject(DOCUMENT)
    private readonly injector = inject(Injector)
    private readonly currentZoomState = signal<number | undefined>(undefined)
    readonly currentZoom = this.currentZoomState.asReadonly()
    private readonly userInfoState = signal<User>({
        uid: '',
        display_name: '',
        connected: false,
    })
    readonly userInfo = this.userInfoState.asReadonly()
    private readonly appVersionState = signal<AppVersion>({
        appName: 'Osm Go!',
        appVersionCode: '12',
        appVersionNumber: environment.version || '0.0.0',
        platform: environment.platform || undefined,
        branch: environment.branch || undefined,
        shortHash: environment.shortHash || undefined,
    })
    readonly appVersion = this.appVersionState.asReadonly()

    changeset: Changeset = {
        id: '',
        last_changeset_activity: 0,
        created_at: 0,
        comment: '',
    }
    i18nConfig: I18nConfig = { uiLanguages: [], language: [] }
    get interfaceLanguages(): Iso6391Language[] {
        const availableCodes = new Set(this.i18nConfig.uiLanguages)
        return this.i18nConfig.language.filter((language) =>
            availableCodes.has(language.code)
        )
    }
    countryConfig: CountryCode[] = []

    freezeMapRenderer = false
    platforms: string[] = []
    baseMapSources: Basemap[] | null = null
    selecableLayers: string[] = ['marker', 'marker_changed', 'icon-change']

    defaultBaseMap: Basemap = {
        default: true,
        description: 'Satellite and aerial imagery.',
        i18n: true,
        icon: 'https://osmlab.github.io/editor-layer-index/sources/world/Bing.png',
        id: 'Bing',
        license_url: 'https://wiki.openstreetmap.org/wiki/Bing_Maps',
        max_zoom: BING_MAX_ZOOM,
        min_zoom: 1,
        name: 'Bing Maps Aerial',
        no_tile_header: { 'X-VE-Tile-Info': ['no-tile'] },
        permission_osm: 'explicit',
        privacy_policy_url: 'https://privacy.microsoft.com/privacystatement',
        type: 'bing',
        url: 'https://www.bing.com/maps',
        tiles: [
            'https://ecn.t0.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=587&mkt=en-gb&n=z',
            'https://ecn.t1.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=587&mkt=en-gb&n=z',
            'https://ecn.t2.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=587&mkt=en-gb&n=z',
            'https://ecn.t3.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=587&mkt=en-gb&n=z',
        ],
    }

    private readonly configState = signal<StoredConfig>({
        mapMarginBuffer: 50,
        lockMapHeading: true,
        followPosition: true,
        defaultPrimarykeyWindows: 'lastTags',
        basemap: this.defaultBaseMap,
        filterWayByArea: true,
        filterWayByLength: true,
        changeSetComment: '',
        languageUi: window.navigator.language.split('-')[0] || 'en',
        languageTags: window.navigator.language.split('-')[0] || 'en',
        countryTags: defaultCountryFromLocale(
            window.navigator.languages?.length
                ? window.navigator.languages
                : [window.navigator.language]
        ),
        oldTagsIcon: { display: true, year: 4 },
        displayFixmeIcon: true,
        addSurveyDate: true,
        isDevServer: false,
        checkedKey: 'check_date',
        surveyCard: {
            display: 'always',
            year: 4,
        },
        isSelectableLine: true,
        isSelectablePolygon: false,
        passwordSaved: true,
        centerWhenGpsIsReady: true,
        openObjectSheetAsPreview: false,
        limitFeatures: 10000,
    })
    readonly config = this.configState.asReadonly()
    private readonly lastViewState = signal<Config['lastView']>({
        lng: -0.127758,
        lat: 51.507351,
        zoom: 18,
        bearing: 0,
    }) // London
    readonly lastView = this.lastViewState.asReadonly()

    private normalizeBasemap(basemap: Basemap): Basemap {
        if (basemap.id === 'Bing' && basemap.max_zoom !== BING_MAX_ZOOM) {
            return { ...basemap, max_zoom: BING_MAX_ZOOM }
        }
        if (
            basemap.id === IGN_BDORTHO_ID &&
            (basemap.max_zoom !== IGN_BDORTHO_MAX_ZOOM ||
                basemap.tiles.length !== 1 ||
                basemap.tiles[0] !== IGN_BDORTHO_TILE_URL)
        ) {
            return {
                ...basemap,
                max_zoom: IGN_BDORTHO_MAX_ZOOM,
                tiles: [IGN_BDORTHO_TILE_URL],
            }
        }
        return basemap
    }

    currentTagsCountryChoice: string[] = []

    geojsonIsLoadedFromCache = false

    private storedConfigUnreadable = false

    /**
     * The stored configuration could not be read: the defaults in use must not
     * be written over it. Changes stay in memory until the next start.
     */
    protectUnreadableStoredConfig(): void {
        this.storedConfigUnreadable = true
    }

    private updateConfig(update: Partial<StoredConfig>): Promise<unknown> {
        const config = { ...this.config(), ...update }
        this.configState.set(config)
        if (this.storedConfigUnreadable) return Promise.resolve(config)
        return this.localStorage.set('config', config)
    }

    getUserInfo() {
        return this.userInfo()
    }

    setUserInfo(userInfo: User): void {
        this.userInfoState.set(userInfo)
        this.localStorage.set('user_info', userInfo)
    }

    resetUserInfo(): void {
        const userInfo: User = {
            uid: '',
            display_name: '',
            connected: false,
        }
        this.userInfoState.set(userInfo)
        this.localStorage.set('user_info', userInfo)
    }

    getChangeset(): Changeset {
        return this.changeset
    }

    setChangeset(
        id: string,
        createdAt: number,
        lastActivity: number,
        comment: string,
        bbox?: ChangesetBbox
    ): void {
        this.changeset = {
            id,
            last_changeset_activity: lastActivity,
            created_at: createdAt,
            comment,
            ...(bbox ? { bbox } : {}),
        }
        this.localStorage.set('changeset', this.changeset)
    }

    setChangesetBbox(bbox: ChangesetBbox): void {
        this.changeset = { ...this.changeset, bbox }
        this.localStorage.set('changeset', this.changeset)
    }

    invalidateChangeset(): void {
        this.changeset = { ...this.changeset, id: '' }
        this.localStorage.set('changeset', this.changeset)
    }

    resetChangeset(): void {
        this.changeset = {
            id: '',
            last_changeset_activity: 0,
            created_at: 0,
            comment: '',
        }
        this.localStorage.set('changeset', this.changeset)
    }

    updateChangesetLastActivity(time = Date.now()): void {
        this.changeset = {
            ...this.changeset,
            last_changeset_activity: time,
        }
        this.localStorage.set('changeset', this.changeset)
    }

    getI18nConfig$(): Observable<I18nConfig> {
        return this.http.get<I18nConfig>('./assets/i18n/i18n.json').pipe(
            map((i18nConfig) => {
                this.i18nConfig = i18nConfig
                return i18nConfig
            })
        )
    }

    getCountryConfig$(): Observable<CountryCode[]> {
        return this.http.get<CountryCode[]>('./assets/countryCode.json').pipe(
            map((countryCode) => {
                this.countryConfig = countryCode
                return countryCode
            })
        )
    }

    loadConfig$(i18nConfig: I18nConfig | undefined): Observable<Config> {
        return from(
            Promise.all([
                this.localStorage.get('config'),
                this.localStorage.get(LAST_VIEW_STORAGE_KEY),
            ])
        ).pipe(
            map(([stored, storedLastView]) => {
                const { lastView: legacyLastView, ...d } = stored ?? {}
                const savedLastView = readMapView(storedLastView)
                const lastView =
                    savedLastView ??
                    readMapView(legacyLastView) ??
                    this.lastView()
                const basemap = this.normalizeBasemap(
                    d?.basemap || this.config().basemap
                )
                const requestedUiLanguage =
                    d?.languageUi || this.config().languageUi || 'en'
                const languageUi = resolveUiLanguage(
                    requestedUiLanguage,
                    i18nConfig?.uiLanguages ?? ['en'],
                    window.navigator.languages ?? [window.navigator.language]
                )
                // V1 saved `survey:date`, its default, and never wrote this
                // V2 setting: such a config moves once to `check_date`.
                const savedByV1 =
                    !!stored && !Object.hasOwn(d, 'openObjectSheetAsPreview')
                const checkedKey: Config['checkedKey'] =
                    savedByV1 && d.checkedKey === 'survey:date'
                        ? 'check_date'
                        : (d?.checkedKey ?? this.config().checkedKey)
                const config = {
                    ...this.config(),
                    ...d,
                    checkedKey,
                    basemap,
                    languageUi,
                    languageTags:
                        d?.languageTags || this.config().languageTags || 'en',
                    countryTags:
                        d?.countryTags || this.config().countryTags || 'GB',
                }
                this.configState.set(config)
                this.lastViewState.set(lastView)
                this.storedConfigUnreadable = false
                if (!savedLastView && readMapView(legacyLastView)) {
                    // The view moves to its own key before the settings drop it.
                    this.localStorage
                        .set(LAST_VIEW_STORAGE_KEY, lastView)
                        .then(() => this.localStorage.set('config', config))
                        .catch((error: unknown) =>
                            console.warn('Could not move the map view.', error)
                        )
                } else if (
                    !stored ||
                    savedByV1 ||
                    basemap !== d.basemap ||
                    languageUi !== d.languageUi ||
                    legacyLastView !== undefined
                ) {
                    this.localStorage.set('config', config)
                }

                this.applySelectableLine(config.isSelectableLine)
                this.applySelectablePolygon(config.isSelectablePolygon)

                return { ...this.config(), lastView: this.lastView() }
            })
        )
    }

    loadUserInfo$() {
        return from(this.localStorage.get('user_info')).pipe(
            map((userInfo) => {
                if (userInfo && userInfo.connected) {
                    this.userInfoState.set(userInfo)
                } else {
                    this.userInfoState.set({
                        uid: '',
                        display_name: '',
                        connected: false,
                    })
                }
                return this.userInfo()
            })
        )
    }

    loadChangeSet$() {
        return from(this.localStorage.get('changeset')).pipe(
            map((changeset) => {
                if (changeset) {
                    this.changeset = changeset
                } else {
                    this.changeset = {
                        id: '',
                        last_changeset_activity: 0,
                        created_at: 0,
                        comment: this.getChangeSetComment(),
                    }
                }
                return this.changeset
            })
        )
    }

    async loadAppVersion(): Promise<void> {
        this.appVersionState.update((appVersion) => ({
            ...appVersion,
            appVersionNumber: environment.version,
        }))
    }

    //Osm Go! 1.6.2-dev PWA
    getAppFullVersion() {
        const appVersion = this.appVersion()
        const isDev = appVersion.branch === 'develop'
        const platform = appVersion.platform
        return `${appVersion.appName} ${appVersion.appVersionNumber}${
            isDev ? '-dev' : ''
        } ${platform ? platform : ''}`
    }

    setMapMarginBuffer(buffer: number): void {
        void this.updateConfig({ mapMarginBuffer: buffer })
    }

    setCurrentZoom(zoom: number): void {
        this.currentZoomState.set(zoom)
    }
    getMapMarginBuffer() {
        return this.config().mapMarginBuffer
    }

    setLimitFeatures(limit: number): void {
        void this.updateConfig({ limitFeatures: limit })
    }
    getLimitFeatures() {
        return this.config().limitFeatures
    }

    setChangeSetComment(comment: string): void {
        void this.updateConfig({ changeSetComment: comment })
    }
    getChangeSetComment() {
        return this.config().changeSetComment
    }

    setLockMapHeading(isLockMapHeading: boolean): void {
        void this.updateConfig({ lockMapHeading: isLockMapHeading })
    }
    getLockMapHeading() {
        return this.config().lockMapHeading
    }

    setFollowPosition(isFollowingPosition: boolean): void {
        void this.updateConfig({ followPosition: isFollowingPosition })
    }
    getFollowPosition() {
        return this.config().followPosition
    }

    setDefaultPrimarykeyWindows(
        defaultPrimarykeyWindows: 'lastTags' | 'bookmarks'
    ): void {
        void this.updateConfig({ defaultPrimarykeyWindows })
    }

    getDefaultPrimarykeyWindows() {
        return this.config().defaultPrimarykeyWindows
    }

    setBasemap(basemap: Basemap): void {
        void this.updateConfig({ basemap: this.normalizeBasemap(basemap) })
    }

    getBasemap() {
        return this.config().basemap
    }

    /* Boolean, activé ou pas */
    setFilterWayByArea(enable: boolean): void {
        void this.updateConfig({ filterWayByArea: enable })
    }
    getFilterWayByArea() {
        return this.config().filterWayByArea
    }

    setFilterWayByLength(enable: boolean): void {
        void this.updateConfig({ filterWayByLength: enable })
    }

    getFilterWayByLength() {
        return this.config().filterWayByLength
    }

    setUiLanguage(lang: string): void {
        this.applyUiLanguage(lang)
        void this.updateConfig({ languageUi: lang })
    }

    applyUiLanguage(lang: string): void {
        this.document.documentElement.lang = lang
        this.document.documentElement.dir = ['ar', 'he'].includes(
            lang.split('-')[0].toLowerCase()
        )
            ? 'rtl'
            : 'ltr'
        this.translate.use(lang)
    }

    getUiLanguage() {
        return this.config().languageUi
    }

    setLanguageTags(lang: string): void {
        void this.updateConfig({ languageTags: lang })
    }

    setCountryTags(country: string): void {
        void this.updateConfig({ countryTags: country })
    }

    getOldTagsIcon() {
        return this.config().oldTagsIcon
    }

    setOldTagsIcon(display: boolean, year: number): void {
        void this.updateConfig({ oldTagsIcon: { display, year } })
    }

    getDisplayFixmeIcon() {
        return this.config().displayFixmeIcon
    }

    setDisplayFixmeIcon(display: boolean): void {
        void this.updateConfig({ displayFixmeIcon: display })
    }

    getAddSurveyDate() {
        return this.config().addSurveyDate
    }

    setAddSurveyDate(add: boolean): void {
        void this.updateConfig({ addSurveyDate: add })
    }

    getCheckedKey(): 'survey:date' | 'check_date' {
        return this.config().checkedKey
    }

    setCheckedKey(key: 'survey:date' | 'check_date'): void {
        void this.updateConfig({ checkedKey: key })
    }

    getDisplaySurveyCard(): 'never' | 'when_older' | 'always' {
        return this.config().surveyCard.display
    }

    setDisplaySurveyCard(value: 'never' | 'when_older' | 'always'): void {
        void this.updateConfig({
            surveyCard: { ...this.config().surveyCard, display: value },
        })
    }

    getSurveyCardYear(): number {
        return this.config().surveyCard.year
    }

    setSurveyCardYear(value: number): void {
        void this.updateConfig({
            surveyCard: { ...this.config().surveyCard, year: value },
        })
    }

    getIsDevServer() {
        return this.config().isDevServer
    }

    setIsSelectableLine(isSelectableLine: boolean): void {
        void this.updateConfig({ isSelectableLine })
        this.applySelectableLine(isSelectableLine)
    }

    private applySelectableLine(isSelectableLine: boolean): void {
        const layers = ['way_line', 'way_line_changed'] // way_line_changed TODO: add properties...
        let newSelectableLayers = this.selecableLayers.filter(
            (l) => !layers.includes(l)
        )
        if (isSelectableLine) {
            newSelectableLayers = [...newSelectableLayers, ...layers]
        }
        this.selecableLayers = [...newSelectableLayers]
    }

    setIsSelectablePolygon(isSelectablePolygon: boolean): void {
        void this.updateConfig({ isSelectablePolygon })
        this.applySelectablePolygon(isSelectablePolygon)
    }

    private applySelectablePolygon(isSelectablePolygon: boolean): void {
        const layers = ['way_fill', 'way_fill_changed'] //   TODO: add properties...
        let newSelectableLayers = this.selecableLayers.filter(
            (l) => !layers.includes(l)
        )
        if (isSelectablePolygon) {
            newSelectableLayers = [...newSelectableLayers, ...layers]
        }
        this.selecableLayers = [...newSelectableLayers]
    }

    /**
     * The OSM data of the server being left is set aside first (backed up,
     * quarantine included, after the running commits): when it cannot be
     * backed up, this rejects and nothing changes.
     */
    async switchOsmEnvironment(isDevServer: boolean): Promise<boolean> {
        if (this.config().isDevServer === isDevServer) return isDevServer
        await this.injector
            .get(DataService)
            .resetStoredOsmState({ includeQuarantine: true })
        // Each server keeps its own changeset comment draft.
        const commentKey = (dev: boolean) =>
            `changeSetComment:${dev ? 'dev' : 'prod'}`
        await this.localStorage.set(
            commentKey(!isDevServer),
            this.config().changeSetComment
        )
        const restoredComment = await this.localStorage.get<string>(
            commentKey(isDevServer)
        )
        await this.updateConfig({
            isDevServer,
            changeSetComment:
                typeof restoredComment === 'string' ? restoredComment : '',
        })
        this.userInfoState.set({ uid: '', display_name: '', connected: false })
        this.changeset = {
            id: '',
            last_changeset_activity: 0,
            created_at: 0,
            comment: '',
        }
        await Promise.all(
            [
                'user_info',
                'changeset',
                'osmToken',
                'osmToken:prod',
                'osmToken:dev',
                'osmOAuthTransaction:prod',
                'osmOAuthTransaction:dev',
            ].map((key) => this.localStorage.remove(key))
        )
        return isDevServer
    }

    setIsDevServer(isDevServer: boolean): Promise<boolean> {
        return this.switchOsmEnvironment(isDevServer)
    }

    setPasswordSaved(isSaved: boolean): void {
        void this.updateConfig({ passwordSaved: isSaved })
    }

    setCenterWhenGpsIsReady(center: boolean): void {
        void this.updateConfig({ centerWhenGpsIsReady: center })
    }

    setOpenObjectSheetAsPreview(preview: boolean): void {
        void this.updateConfig({ openObjectSheetAsPreview: preview })
    }

    /** Only the view key is written, and only when the view changed. */
    setLastView(lastView: Config['lastView']): void {
        const current = this.lastView()
        if (
            current.lng === lastView.lng &&
            current.lat === lastView.lat &&
            current.zoom === lastView.zoom &&
            current.bearing === lastView.bearing
        ) {
            return
        }
        const view = { ...lastView }
        this.lastViewState.set(view)
        void this.localStorage.set(LAST_VIEW_STORAGE_KEY, view)
    }
}
