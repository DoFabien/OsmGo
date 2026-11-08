import { DOCUMENT } from '@angular/common'
import { HttpClient } from '@angular/common/http'
import { inject, Service, signal } from '@angular/core'
import type { DeviceInfo } from '@capacitor/device'
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
import { OSM_STATE_STORAGE_KEY } from '@services/osm-state'
import { TagsService } from '@services/tags.service'
import { from, type Observable } from 'rxjs'
import { map } from 'rxjs/operators'

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

@Service()
export class ConfigService {
    readonly localStorage = inject(AppStorage)
    private readonly http = inject(HttpClient)
    private readonly translate = inject(TranslateService)
    private readonly document = inject(DOCUMENT)
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
    deviceInfo: DeviceInfo | undefined
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

    private readonly configState = signal<Config>({
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
        countryTags:
            window.navigator.language && window.navigator.language.split('-')[1]
                ? window.navigator.language.split('-')[1].toUpperCase()
                : 'GB',
        oldTagsIcon: { display: true, year: 4 },
        displayFixmeIcon: true,
        addSurveyDate: true,
        isDevServer: false,
        checkedKey: 'survey:date',
        surveyCard: {
            display: 'always',
            year: 4,
        },
        isSelectableLine: true,
        isSelectablePolygon: false,
        passwordSaved: true,
        lastView: { lng: -0.127758, lat: 51.507351, zoom: 18, bearing: 0 }, // London
        centerWhenGpsIsReady: true,
        openObjectSheetAsPreview: false,
        limitFeatures: 10000,
    })
    readonly config = this.configState.asReadonly()

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

    private updateConfig(update: Partial<Config>): Promise<unknown> {
        const config = { ...this.config(), ...update }
        this.configState.set(config)
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
        comment: string
    ): void {
        this.changeset = {
            id,
            last_changeset_activity: lastActivity,
            created_at: createdAt,
            comment,
        }
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
        return from(this.localStorage.get('config')).pipe(
            map((d) => {
                const basemap = this.normalizeBasemap(
                    d?.basemap || this.config().basemap
                )
                const requestedUiLanguage =
                    d?.languageUi || this.config().languageUi || 'en'
                const languageUi = (i18nConfig?.uiLanguages ?? ['en']).includes(
                    requestedUiLanguage
                )
                    ? requestedUiLanguage
                    : 'en'
                const config = {
                    ...this.config(),
                    ...d,
                    basemap,
                    languageUi,
                    languageTags:
                        d?.languageTags || this.config().languageTags || 'en',
                    countryTags:
                        d?.countryTags || this.config().countryTags || 'GB',
                }
                this.configState.set(config)
                if (
                    !d ||
                    basemap !== d.basemap ||
                    languageUi !== d.languageUi
                ) {
                    this.localStorage.set('config', config)
                }

                this.setIsSelectableLine(config.isSelectableLine)
                this.setIsSelectablePolygon(config.isSelectablePolygon)

                return this.config()
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
        const layers = ['way_line', 'way_line_changed'] // way_line_changed TODO: add properties...
        void this.updateConfig({ isSelectableLine })
        let newSelectableLayers = this.selecableLayers.filter(
            (l) => !layers.includes(l)
        )
        if (isSelectableLine) {
            newSelectableLayers = [...newSelectableLayers, ...layers]
        }
        this.selecableLayers = [...newSelectableLayers]
    }

    setIsSelectablePolygon(isSelectablePolygon: boolean): void {
        const layers = ['way_fill', 'way_fill_changed'] //   TODO: add properties...
        void this.updateConfig({ isSelectablePolygon })
        let newSelectableLayers = this.selecableLayers.filter(
            (l) => !layers.includes(l)
        )
        if (isSelectablePolygon) {
            newSelectableLayers = [...newSelectableLayers, ...layers]
        }
        this.selecableLayers = [...newSelectableLayers]
    }

    async switchOsmEnvironment(isDevServer: boolean): Promise<boolean> {
        if (this.config().isDevServer === isDevServer) return isDevServer
        await this.updateConfig({ isDevServer })
        this.userInfoState.set({ uid: '', display_name: '', connected: false })
        this.changeset = {
            id: '',
            last_changeset_activity: 0,
            created_at: 0,
            comment: '',
        }
        await Promise.all(
            [
                'geojson',
                'geojsonBbox',
                'geojsonChanged',
                OSM_STATE_STORAGE_KEY,
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

    setLastView(lastView: Config['lastView']): void {
        void this.updateConfig({ lastView })
    }
}
