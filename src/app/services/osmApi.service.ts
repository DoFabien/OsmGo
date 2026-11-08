import { HttpClient, HttpHeaders } from '@angular/common/http'
import { inject, Service } from '@angular/core'
import {
    type ChangesetBbox,
    fitsInOneChangeset,
    isChangesetBbox,
    unionBbox,
} from '@app/utils/changeset-bbox'
import { cloneDeep } from '@app/utils/clone'
import { isNodeReferencedByWayOrRelation } from '@app/utils/osm-feature'
import {
    MAX_CHANGESET_COMMENT_LENGTH,
    normalizeOsmTags,
    osmTextLength,
} from '@app/utils/osm-tags'
import type {
    FeatureIdSource,
    OsmGoFeature,
    OsmGoFeatureCollection,
    OsmRelationMember,
} from '@osmgo/type'
import {
    addAttributesToFeature,
    type ConvertResult,
} from '@scripts/osmToOsmgo/index.js'
import { ConfigService, type User } from '@services/config.service'
import { DataService } from '@services/data.service'
import { MapService } from '@services/map.service'
import { requireMapDataResult } from '@services/osm-data-validation'
import { TagsService } from '@services/tags.service'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { BBox } from 'geojson'
import {
    from,
    Observable,
    of,
    type Subscription,
    throwError,
    timer,
} from 'rxjs'
import {
    catchError,
    map,
    mergeMap,
    switchMap,
    take,
    takeUntil,
    timeout,
    toArray,
} from 'rxjs/operators'
import { OsmAuthService } from './osm-auth.service'

const OSM_REQUEST_TIMEOUT_MS = 30_000
/** A large diff can legitimately take minutes on a mobile connection. */
export const OSM_UPLOAD_TIMEOUT_MS = 150_000
const OSM_WORKER_TIMEOUT_MS = 30_000
/** Multipolygons cut by the edge of a download that are fetched in full. */
const MAX_INCOMPLETE_RELATIONS = 20
const RELATION_FETCH_CONCURRENCY = 4
const RELATION_FETCH_TIMEOUT_MS = 10_000
/** The download goes on with what arrived once this budget is spent. */
const RELATION_FETCH_BUDGET_MS = 20_000

interface OsmUserResponse {
    user: {
        id: string | number
        display_name: string
    }
}

export interface OsmApiObject {
    type: 'node' | 'way' | 'relation'
    id?: string | number
    version?: number
    visible?: boolean
    timestamp?: string
    changeset?: string | number
    user?: string
    uid?: string | number
    lon?: string | number
    lat?: string | number
    nodes?: Array<string | number>
    members?: OsmRelationMember[]
    tags?: Record<string, string>
}

interface OsmObjectResponse {
    elements: OsmApiObject[]
}

interface WorkerResponse {
    ok: boolean
    data?: ConvertResult
    /** The worker waits for the full version of these relations. */
    incompleteRelationIds?: unknown[]
    error?: string
}

export interface OsmDiffResult {
    type: 'node' | 'way' | 'relation'
    old_id: string
    new_id?: string
    new_version?: number
    osmgoOldId: string
    osmgoNewId?: string
}

@Service()
export class OsmApiService {
    private readonly http = inject(HttpClient)
    readonly mapService = inject(MapService)
    readonly tagsService = inject(TagsService)
    readonly dataService = inject(DataService)
    readonly configService = inject(ConfigService)
    readonly osmAuthService = inject(OsmAuthService)

    isAuthenticated(): boolean {
        return this.osmAuthService.isAuthenticated()
    }

    getUrlApi(): string {
        return this.configService.getIsDevServer()
            ? this.osmAuthService.oauthParam.dev.url
            : this.osmAuthService.oauthParam.prod.url
    }

    getUserDetail$(test = false): Observable<User> {
        const PATH_API = '/api/0.6/user/details.json'
        const token = this.osmAuthService.getToken()
        if (!token) {
            return throwError(() => new Error('You are not connected'))
        }

        const url = this.getUrlApi() + PATH_API
        let headers = new HttpHeaders()
        headers = headers
            .set('Authorization', `Bearer ${token}`)
            .set('Content-Type', 'application/json')

        return this.http.get<OsmUserResponse>(url, { headers }).pipe(
            timeout(OSM_REQUEST_TIMEOUT_MS),
            map((response) => {
                if (
                    !response.user ||
                    response.user.id === null ||
                    response.user.id === undefined ||
                    typeof response.user.display_name !== 'string'
                ) {
                    throw new Error('OpenStreetMap returned invalid user data.')
                }
                const userInfo: User = {
                    uid: String(response.user.id),
                    display_name: response.user.display_name,
                    connected: true,
                }
                if (!test) {
                    this.configService.setUserInfo(userInfo)
                }
                return userInfo
            }),
            catchError((error: unknown) => {
                console.error(error)
                return this.handleAuthenticatedRequestError(error)
            })
        )
    }
    createOSMChangeSet(
        comment: string,
        bbox?: ChangesetBbox
    ): Observable<string> {
        if (osmTextLength(comment) > MAX_CHANGESET_COMMENT_LENGTH) {
            return throwError(
                () =>
                    new Error(
                        `The changeset comment is longer than ${MAX_CHANGESET_COMMENT_LENGTH} characters.`
                    )
            )
        }
        const appVersion = this.configService.getAppFullVersion()

        const localeId = navigator?.language || '*'
        const content = `
        <osm>
            <changeset>
                <tag k="created_by" v="${this.escapeXmlValue(appVersion)}"/>
                <tag k="locale" v="${this.escapeXmlValue(localeId)}"/>
                <tag k="comment" v="${this.escapeXmlValue(comment)}"/>
                <tag k="source" v="${this.escapeXmlValue('survey')}"/>
            </changeset>
        </osm>`

        const PATH_API = '/api/0.6/changeset/create'

        const url = this.getUrlApi() + PATH_API
        const token = this.osmAuthService.getToken()
        if (!token) {
            return throwError(() => new Error('You are not connected'))
        }
        let headers = new HttpHeaders()
        headers = headers
            .set('Authorization', `Bearer ${token}`)
            .set('Content-Type', 'text/xml')

        return this.http
            .put(url, content, {
                headers: headers,
                responseType: 'text',
            })
            .pipe(
                timeout(OSM_REQUEST_TIMEOUT_MS),
                map((res) => {
                    const changesetId = String(res).trim()
                    if (!/^[1-9]\d*$/.test(changesetId)) {
                        throw new Error(
                            'OpenStreetMap returned an invalid changeset ID.'
                        )
                    }
                    this.configService.setChangeset(
                        changesetId,
                        Date.now(),
                        Date.now(),
                        comment,
                        bbox
                    )
                    return changesetId
                }),
                catchError((error) =>
                    this.handleAuthenticatedRequestError(error)
                )
            )
    }

    /**
     * Reuses the open changeset for the same comment within the hour, unless
     * the upload would stretch the area it covers past one neighbourhood: a
     * new changeset is then opened and the previous one closed.
     */
    getValidChangeset(
        comment: string,
        bbox?: ChangesetBbox
    ): Observable<string> {
        const changeset = this.configService.getChangeset()
        if (
            !/^[1-9]\d*$/.test(changeset.id) ||
            comment !== changeset.comment ||
            Date.now() - changeset.last_changeset_activity > 3_540_000
        ) {
            return this.createOSMChangeSet(comment, bbox)
        }
        if (!bbox) return of(changeset.id)
        const covered = isChangesetBbox(changeset.bbox)
            ? unionBbox(changeset.bbox, bbox)
            : undefined
        if (!covered || !fitsInOneChangeset(covered)) {
            this.closeChangesetQuietly(changeset.id)
            return this.createOSMChangeSet(comment, bbox)
        }
        this.configService.setChangesetBbox(covered)
        return of(changeset.id)
    }

    /** Best effort: OpenStreetMap closes an idle changeset after an hour. */
    private closeChangesetQuietly(changesetId: string): void {
        const token = this.osmAuthService.getToken()
        if (!token) return
        const headers = new HttpHeaders().set(
            'Authorization',
            `Bearer ${token}`
        )
        this.http
            .put(
                `${this.getUrlApi()}/api/0.6/changeset/${changesetId}/close`,
                '',
                { headers, responseType: 'text' }
            )
            .pipe(timeout(OSM_REQUEST_TIMEOUT_MS))
            .subscribe({
                error: (error: unknown) =>
                    console.warn('Could not close the changeset.', error),
            })
    }

    /**
     * Attribute values are normalised by XML parsers: raw line breaks and tabs
     * would be flattened to spaces, so they travel as character references.
     */
    escapeXmlValue(value: unknown): string {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/'/g, '&apos;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '&#10;')
            .replace(/\r/g, '&#13;')
            .replace(/\t/g, '&#9;')
    }

    osmGoFeaturesToOsmDiffFile(
        features: OsmGoFeature[],
        idChangeset: string
    ): string {
        const createChanges: string[] = []
        const modifyChanges: string[] = []
        const deleteChanges: string[] = []

        for (const feature of features) {
            if (feature.properties.changeType === 'Create') {
                const xml = this.geojson2OsmCreate(feature, idChangeset)
                createChanges.push(xml)
            } else if (feature.properties.changeType === 'Update') {
                const xml = this.geojson2OsmUpdate(feature, idChangeset)
                modifyChanges.push(xml)
            } else if (feature.properties.changeType === 'Delete') {
                if (isNodeReferencedByWayOrRelation(feature)) {
                    const featureWithoutTags = {
                        ...feature,
                        properties: { ...feature.properties, tags: {} },
                    }
                    const xml = this.geojson2OsmUpdate(
                        featureWithoutTags,
                        idChangeset
                    )
                    modifyChanges.push(xml)
                } else {
                    const xml = this.geojson2OsmUpdate(feature, idChangeset)
                    deleteChanges.push(xml)
                }
            }
        }

        const diffFile = `<osmChange version="0.6" generator="Osm Go !">
                            <create> 
                                ${createChanges.join('\n')}
                            </create>

                            <modify> 
                                ${modifyChanges.join('\n')}
                            </modify>

                            <delete> 
                                ${deleteChanges.join('\n')}
                            </delete>

                        </osmChange>
                `

        return diffFile
    }

    convertDiffFileResultProperties(
        type: 'node' | 'way' | 'relation',
        properties: unknown
    ): OsmDiffResult {
        if (
            !properties ||
            typeof properties !== 'object' ||
            Array.isArray(properties)
        ) {
            throw new Error('OpenStreetMap returned an invalid diff result.')
        }
        const raw = properties as Record<string, unknown>
        const oldId = raw['old_id']
        const oldIdString = String(oldId ?? '').trim()
        if (!/^-?[1-9]\d*$/.test(oldIdString)) {
            throw new Error('OpenStreetMap returned an invalid diff result.')
        }

        const rawVersion = raw['new_version']
        const newVersion =
            rawVersion === undefined || rawVersion === null
                ? undefined
                : Number(rawVersion)
        if (
            newVersion !== undefined &&
            (!Number.isInteger(newVersion) || newVersion < 1)
        ) {
            throw new Error('OpenStreetMap returned an invalid diff result.')
        }

        const newId = raw['new_id']
        const newIdString = String(newId ?? '').trim()
        if (newVersion !== undefined && !/^[1-9]\d*$/.test(newIdString)) {
            throw new Error('OpenStreetMap returned an invalid diff result.')
        }
        if (newVersion === undefined && newIdString !== '') {
            throw new Error('OpenStreetMap returned an invalid diff result.')
        }
        const row: OsmDiffResult = {
            type,
            old_id: oldIdString,
            osmgoOldId: `${type}/${oldIdString}`,
        }

        if (newVersion !== undefined) {
            row.new_id = newIdString
            row.osmgoNewId = `${type}/${newIdString}`
            row.new_version = newVersion
        }
        return row
    }

    convertDiffFileResult(diffTextResult: string): OsmDiffResult[] {
        if (XMLValidator.validate(diffTextResult) !== true) {
            throw new Error('OpenStreetMap returned an invalid XML response.')
        }
        const options = {
            ignoreAttributes: false,
            attributeNamePrefix: '',
            allowBooleanAttributes: true,
        }
        const parser = new XMLParser(options)
        const diffJson = parser.parse(diffTextResult)?.diffResult
        if (
            !diffJson ||
            typeof diffJson !== 'object' ||
            Array.isArray(diffJson)
        ) {
            throw new Error('OpenStreetMap returned an invalid diff result.')
        }
        const result: OsmDiffResult[] = []
        if (diffJson.node !== undefined) {
            if (!Array.isArray(diffJson.node)) {
                diffJson.node = [diffJson.node]
            }
            for (const properties of diffJson.node) {
                const rowConverted = this.convertDiffFileResultProperties(
                    'node',
                    properties
                )
                result.push(rowConverted)
            }
        }

        if (diffJson.way !== undefined) {
            if (!Array.isArray(diffJson.way)) {
                diffJson.way = [diffJson.way]
            }
            for (const properties of diffJson.way) {
                const rowConverted = this.convertDiffFileResultProperties(
                    'way',
                    properties
                )
                result.push(rowConverted)
            }
        }

        if (diffJson.relation !== undefined) {
            if (!Array.isArray(diffJson.relation)) {
                diffJson.relation = [diffJson.relation]
            }
            for (const properties of diffJson.relation) {
                const rowConverted = this.convertDiffFileResultProperties(
                    'relation',
                    properties
                )
                result.push(rowConverted)
            }
        }
        return result
    }

    apiOsmSendOsmDiffFile(
        diffFile: string,
        changesetId: string
    ): Observable<OsmDiffResult[]> {
        return this.apiOsmSendOsmDiffFileRaw$(diffFile, changesetId).pipe(
            map((diffTextResult) => this.convertDiffFileResult(diffTextResult))
        )
    }

    /**
     * Sends the diff and returns the response text untouched, so the caller can
     * persist what the server answered before interpreting it.
     */
    apiOsmSendOsmDiffFileRaw$(
        diffFile: string,
        changesetId: string
    ): Observable<string> {
        const url =
            this.getUrlApi() + `/api/0.6/changeset/${changesetId}/upload`

        const token = this.osmAuthService.getToken()
        if (!token) {
            return throwError(() => new Error('You are not connected'))
        }

        let headers = new HttpHeaders()
        headers = headers
            .set('Authorization', `Bearer ${token}`)
            .set('accept', 'application/xml')
            .set('Content-Type', 'text/plain; charset=utf-8')

        return this.http
            .post(url, diffFile, {
                headers: headers,
                responseType: 'text',
            })
            .pipe(
                timeout(OSM_UPLOAD_TIMEOUT_MS),
                map((diffTextResult) => String(diffTextResult)),
                catchError((error) =>
                    this.handleAuthenticatedRequestError(error)
                )
            )
    }

    /** The osmChange document of everything uploaded in a changeset. */
    downloadChangeset$(changesetId: string): Observable<string> {
        if (!/^[1-9]\d*$/.test(changesetId)) {
            return throwError(() => new Error('Invalid changeset ID.'))
        }
        const headers = new HttpHeaders().set('Accept', 'application/xml')
        return this.http
            .get(
                this.getUrlApi() + `/api/0.6/changeset/${changesetId}/download`,
                { headers, responseType: 'text' }
            )
            .pipe(timeout(OSM_REQUEST_TIMEOUT_MS))
    }

    private handleAuthenticatedRequestError(error: unknown): Observable<never> {
        const status = this.getErrorStatus(error)
        if (status === 401) {
            void this.osmAuthService.clearToken()
        }
        return throwError(() => error)
    }

    geojson2OsmCreate(feature: OsmGoFeature, changesetId: string): string {
        if (feature.geometry.type !== 'Point') {
            throw new Error('Only point features can be created.')
        }
        const lng = feature.geometry.coordinates[0]
        const lat = feature.geometry.coordinates[1]
        const id = feature.properties.id
        if (!Number.isInteger(id) || id >= 0) {
            throw new Error(
                'A created OSM feature requires a strictly negative temporary ID.'
            )
        }
        const header = `<node changeset="${changesetId}" id="${id}" lat="${lat}" lon="${lng}">`
        return `${header}${this.osmTagsToXml(feature.properties.tags)}</node>`
    }

    geojson2OsmUpdate(feature: OsmGoFeature, changesetId: string): string {
        const tagsXml = this.osmTagsToXml(feature.properties.tags)
        const objectType = feature.properties.type
        const version = feature.properties.meta.version
        const id = feature.properties.id

        if (objectType === 'node') {
            if (feature.geometry.type !== 'Point') {
                throw new Error('An OSM node requires point geometry.')
            }
            const lng = feature.geometry.coordinates[0]
            const lat = feature.geometry.coordinates[1]
            const node_header = `<node id="${id}"
                    changeset="${changesetId}"
                    version="${version}"
                    lat="${lat}" lon="${lng}">`
            return `${node_header}${tagsXml}</node>`
        }
        if (objectType === 'way') {
            if (!feature.ndRefs) {
                throw new Error('An OSM way requires node references.')
            }
            const nodeReferences = feature.ndRefs
                .map((reference) => `<nd ref="${reference}"/>`)
                .join('')
            return `<way id="${id}" changeset="${changesetId}" version="${version}">${nodeReferences}${tagsXml}</way>`
        }
        if (objectType === 'relation') {
            if (!Array.isArray(feature.members)) {
                throw new Error('An OSM relation requires members.')
            }
            const members = feature.members
                .map((member) => this.osmRelationMemberToXml(member))
                .join('')
            return `<relation id="${id}" changeset="${changesetId}" version="${version}">${members}${tagsXml}</relation>`
        }
        throw new Error(`Unsupported OSM object type: ${objectType}`)
    }

    private osmRelationMemberToXml(member: OsmRelationMember): string {
        if (!['node', 'way', 'relation'].includes(member?.type)) {
            throw new Error('An OSM relation member has an invalid type.')
        }
        const ref = String(member.ref).trim()
        if (!/^-?[1-9]\d*$/.test(ref)) {
            throw new Error('An OSM relation member has an invalid reference.')
        }
        if (typeof member.role !== 'string') {
            throw new Error('An OSM relation member has an invalid role.')
        }
        return `<member type="${member.type}" ref="${ref}" role="${this.escapeXmlValue(member.role)}"/>`
    }

    createOsmNode(featureToCreate: OsmGoFeature): Observable<OsmGoFeature> {
        const feature = cloneDeep(featureToCreate)
        feature.properties.meta = {
            timestamp: '0',
            version: 0,
            user: '',
            uid: '',
            changeset: '',
        }
        addAttributesToFeature(feature)
        const styledFeature = this.mapService.getIconStyle(feature)
        return from(this.dataService.createPendingFeature(styledFeature))
    }

    updateOsmElement(
        featureToUpdate: OsmGoFeature,
        origineData: FeatureIdSource
    ): Observable<OsmGoFeature> {
        const feature = cloneDeep(featureToUpdate)
        addAttributesToFeature(feature)
        const styledFeature = this.mapService.getIconStyle(feature)
        if (!feature.id) {
            return throwError(() => new Error('A feature ID is required.'))
        }
        if (origineData === 'data_changed') {
            return from(
                this.dataService.updatePendingFeature(feature.id, styledFeature)
            )
        } else {
            return from(
                this.dataService.moveOfficialToPending(
                    feature.id,
                    styledFeature
                )
            )
        }
    }

    deleteOsmElement(featureToDelete: OsmGoFeature): Observable<unknown> {
        const feature = cloneDeep(featureToDelete)
        if (!feature.id) {
            return throwError(() => new Error('A feature ID is required.'))
        }
        return from(this.dataService.markPendingDeleted(feature.id))
    }

    formatOsmJsonData$(
        osmData: string,
        oldGeojson: OsmGoFeatureCollection,
        geojsonChanged: OsmGoFeatureCollection,
        limitFeatures = 10_000
    ): Observable<ConvertResult> {
        const oldBbox = this.dataService.getGeojsonBbox()
        const oldBboxFeature = cloneDeep(oldBbox.features[0])

        return new Observable<ConvertResult>((subscriber) => {
            let worker: Worker
            try {
                worker = new Worker(
                    new URL('../workers/osm-converter.worker', import.meta.url),
                    { type: 'module' }
                )
            } catch (error) {
                subscriber.error(
                    new Error('The OSM data worker could not start.', {
                        cause: error,
                    })
                )
                return
            }
            let isFinished = false
            let relationFetch: Subscription | undefined
            const finish = (callback: () => void): void => {
                if (isFinished) return
                isFinished = true
                window.clearTimeout(timeoutId)
                relationFetch?.unsubscribe()
                worker.terminate()
                callback()
            }
            const fail = (message: string): void => {
                finish(() => subscriber.error(new Error(message)))
            }
            const startTimeout = (): number =>
                window.setTimeout(() => {
                    fail('OSM data conversion timed out.')
                }, OSM_WORKER_TIMEOUT_MS)
            let timeoutId = startTimeout()

            worker.onmessage = (event) => {
                const response = event.data as WorkerResponse
                const data = response?.data
                if (
                    response?.ok &&
                    Array.isArray(response.incompleteRelationIds)
                ) {
                    // The conversion pauses while the relations are fetched.
                    window.clearTimeout(timeoutId)
                    relationFetch = this.fetchRelationsElements$(
                        response.incompleteRelationIds
                    ).subscribe((supplementalElements) => {
                        if (isFinished) return
                        timeoutId = startTimeout()
                        try {
                            worker.postMessage({ supplementalElements })
                        } catch (error) {
                            fail(
                                error instanceof Error
                                    ? error.message
                                    : 'The OSM data worker could not continue.'
                            )
                        }
                    })
                    return
                }
                if (!response || typeof response.ok !== 'boolean') {
                    fail('The OSM data worker returned an invalid response.')
                } else if (response.ok) {
                    if (data === undefined) {
                        fail(
                            'The OSM data worker returned an invalid response.'
                        )
                        return
                    }
                    let convertedData: ConvertResult
                    try {
                        convertedData = requireMapDataResult<ConvertResult>(
                            data,
                            'OSM data worker response'
                        )
                    } catch (error) {
                        fail(
                            error instanceof Error
                                ? error.message
                                : 'The OSM data worker returned invalid data.'
                        )
                        return
                    }
                    finish(() => {
                        subscriber.next(convertedData)
                        subscriber.complete()
                    })
                } else {
                    fail(
                        typeof response.error === 'string' &&
                            response.error.trim()
                            ? response.error
                            : 'The OSM data worker failed.'
                    )
                }
            }
            worker.onerror = (event) => {
                fail(event.message || 'The OSM data worker crashed.')
            }
            worker.onmessageerror = () => {
                fail('The OSM data worker returned an unreadable message.')
            }

            try {
                worker.postMessage({
                    tagsConfig: this.tagsService.converterTags(),
                    primaryKeys: this.tagsService.primaryKeys(),
                    osmData,
                    oldGeojson,
                    oldBboxFeature,
                    geojsonChanged,
                    limitFeatures,
                    maxIncompleteRelations: MAX_INCOMPLETE_RELATIONS,
                })
            } catch (error) {
                fail(
                    error instanceof Error
                        ? error.message
                        : 'The OSM data worker could not start.'
                )
            }

            return () => finish(() => {})
        })
    }

    /**
     * The elements of `relation/{id}/full` for each relation, a few requests
     * at a time. A relation that cannot be fetched is skipped, and the budget
     * bounds the wait: the download keeps the relations that arrived.
     */
    private fetchRelationsElements$(
        relationIds: unknown[]
    ): Observable<unknown[]> {
        const ids = relationIds
            .map((id) => Number(id))
            .filter((id) => Number.isSafeInteger(id) && id > 0)
        const headers = new HttpHeaders().set('Accept', 'application/json')
        return from(ids).pipe(
            mergeMap(
                (id) =>
                    this.http
                        .get<OsmObjectResponse>(
                            `${this.getUrlApi()}/api/0.6/relation/${id}/full.json`,
                            { headers, responseType: 'json' }
                        )
                        .pipe(
                            timeout(RELATION_FETCH_TIMEOUT_MS),
                            map((response) =>
                                Array.isArray(response?.elements)
                                    ? response.elements
                                    : []
                            ),
                            catchError((error: unknown) => {
                                console.warn(
                                    `Could not complete relation ${id}.`,
                                    error
                                )
                                return of([])
                            })
                        ),
                RELATION_FETCH_CONCURRENCY
            ),
            takeUntil(timer(RELATION_FETCH_BUDGET_MS)),
            toArray(),
            map((responses) => responses.flat())
        )
    }

    getOsmObjectById$(objectId: string): Observable<OsmApiObject> {
        if (!/^(node|way|relation)\/[1-9]\d*$/.test(objectId)) {
            return throwError(() => new Error('Invalid OSM object ID.'))
        }
        const numericId = Number(objectId.split('/')[1])
        if (!Number.isSafeInteger(numericId)) {
            return throwError(() => new Error('Invalid OSM object ID.'))
        }
        const headers = new HttpHeaders()
            .set('Content-Type', 'application/json')
            .set('Accept', 'application/json')

        const url = this.getUrlApi() + `/api/0.6/${objectId}.json`
        return this.http
            .get<OsmObjectResponse>(url, {
                headers: headers,
                responseType: 'json',
            })
            .pipe(
                timeout(OSM_REQUEST_TIMEOUT_MS),
                map((response) => {
                    const object = response.elements?.[0]
                    if (!object) {
                        throw new Error('No OSM object found.')
                    }
                    return object
                })
            )
    }

    fetchNodeCoordinates(
        nodeId: string | number
    ): Observable<{ lon: number; lat: number }> {
        return this.getOsmObjectById$(`node/${nodeId}`).pipe(
            map((node) => this.getNodeCoordinates(node))
        )
    }

    /*
       get the first coordinate of an object
        if it's a node, return the coordinate of the node
        if it's a way, return the coordinate of the first node
        if it's a relation, return the coordinate of the first node or way

     */
    getFirstCoordFromIdObject$(
        objectId: string
    ): Observable<{ lon: number; lat: number }> {
        const type = objectId.split('/')[0]
        if (!['node', 'way', 'relation'].includes(type)) {
            return throwError(() => new Error('Type not supported'))
        }

        return this.getOsmObjectById$(objectId).pipe(
            switchMap((object) => {
                if (object.type === 'node') {
                    return of(this.getNodeCoordinates(object))
                } else if (object.type === 'way') {
                    const nodeId = object.nodes?.[0]
                    if (nodeId === undefined) {
                        return throwError(
                            () => new Error('No coordinates found')
                        )
                    }
                    return this.fetchNodeCoordinates(nodeId)
                } else if (object.type === 'relation') {
                    const referencedObject = object.members?.find(
                        (member) =>
                            member.type === 'node' || member.type === 'way'
                    )
                    if (referencedObject) {
                        return this.getOsmObjectById$(
                            `${referencedObject.type}/${referencedObject.ref}`
                        ).pipe(
                            switchMap((referenced) => {
                                if (referenced.type === 'way') {
                                    const nodeId = referenced.nodes?.[0]
                                    if (nodeId === undefined) {
                                        return throwError(
                                            () =>
                                                new Error(
                                                    'No coordinates found'
                                                )
                                        )
                                    }
                                    return this.fetchNodeCoordinates(nodeId)
                                } else if (referenced.type === 'node') {
                                    return of(
                                        this.getNodeCoordinates(referenced)
                                    )
                                } else {
                                    return throwError(
                                        () => new Error('No coordinates found')
                                    )
                                }
                            })
                        )
                    } else {
                        return throwError(
                            () => new Error('No coordinates found')
                        )
                    }
                } else {
                    return throwError(() => new Error('No coordinates found'))
                }
            }),
            catchError(() =>
                throwError(() => new Error('No coordinates found'))
            )
        )
    }

    getDataFromBbox(
        bbox: BBox,
        limitFeatures = 10_000
    ): Observable<ConvertResult> {
        if (
            bbox.length !== 4 ||
            bbox.some((coordinate) => !Number.isFinite(coordinate)) ||
            bbox[0] < -180 ||
            bbox[0] > 180 ||
            bbox[2] < -180 ||
            bbox[2] > 180 ||
            bbox[1] < -90 ||
            bbox[1] > 90 ||
            bbox[3] < -90 ||
            bbox[3] > 90 ||
            bbox[0] >= bbox[2] ||
            bbox[1] >= bbox[3]
        ) {
            return throwError(() => new Error('Invalid OSM bounding box.'))
        }
        const headers = new HttpHeaders()
            .set('Content-Type', 'application/json')
            .set('Accept', 'application/json')

        const url = this.getUrlApi() + `/api/0.6/map?bbox=${bbox.join(',')}`

        return this.http
            .get(url, { headers: headers, responseType: 'text' })
            .pipe(
                timeout(OSM_REQUEST_TIMEOUT_MS),
                switchMap((osmData) =>
                    this.formatOsmJsonData$(
                        osmData,
                        this.dataService.getGeojson(),
                        this.dataService.getGeojsonChanged(),
                        limitFeatures
                    )
                ),
                take(1),
                catchError((error: unknown) =>
                    throwError(
                        () =>
                            new Error(
                                this.getErrorMessage(
                                    error,
                                    'Unable to download OpenStreetMap data.'
                                )
                            )
                    )
                )
            )
    }

    private osmTagsToXml(tags: Record<string, unknown>): string {
        let xml = ''
        for (const [key, value] of Object.entries(normalizeOsmTags(tags))) {
            xml += `<tag k="${this.escapeXmlValue(key)}" v="${this.escapeXmlValue(value)}"/>`
        }
        return xml
    }

    private getNodeCoordinates(node: OsmApiObject): {
        lon: number
        lat: number
    } {
        const lon = Number(node.lon)
        const lat = Number(node.lat)
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            throw new Error('No coordinates found')
        }
        return { lon, lat }
    }

    private getErrorStatus(error: unknown): number | undefined {
        if (typeof error !== 'object' || error === null) return undefined
        const status = (error as { status?: unknown }).status
        return typeof status === 'number' ? status : undefined
    }

    private getErrorMessage(error: unknown, fallback: string): string {
        if (error instanceof Error && error.message) return error.message
        if (typeof error !== 'object' || error === null) return fallback
        const details = error as { error?: unknown; message?: unknown }
        if (typeof details.error === 'string' && details.error.trim()) {
            return details.error
        }
        if (typeof details.message === 'string' && details.message.trim()) {
            return details.message
        }
        return fallback
    }
}
