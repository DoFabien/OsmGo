import { normalizeOsmTags } from '@app/utils/osm-tags'
import type { PersistedUploadSubmission } from '@services/osm-state'
import type { OsmDiffResult } from '@services/osmApi.service'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export type UploadVerification =
    | { kind: 'applied'; receipt: OsmDiffResult[] }
    | { kind: 'notFound' }
    | { kind: 'partial'; matched: string[]; missing: string[] }

type ChangeAction = 'create' | 'modify' | 'delete'

interface ChangedElement {
    action: ChangeAction
    type: 'node' | 'way' | 'relation'
    id: string
    version: number
    lat?: number
    lon?: number
    tags: Record<string, string>
}

const COORDINATE_TOLERANCE = 1e-6

const asArray = <T>(value: T | T[] | undefined): T[] =>
    value === undefined || value === null
        ? []
        : Array.isArray(value)
          ? value
          : [value]

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const readTags = (element: Record<string, unknown>): Record<string, string> => {
    const tags: Record<string, string> = {}
    for (const tag of asArray(element['tag'])) {
        if (isRecord(tag) && tag['k'] !== undefined) {
            tags[String(tag['k'])] = String(tag['v'] ?? '')
        }
    }
    return tags
}

/** Flattens the `<create>`, `<modify>` and `<delete>` blocks of an osmChange. */
export const parseChangesetDownload = (xml: string): ChangedElement[] => {
    if (XMLValidator.validate(xml) !== true) {
        throw new Error('OpenStreetMap returned an invalid changeset document.')
    }
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '',
        isArray: (name) =>
            ['create', 'modify', 'delete', 'node', 'way', 'relation'].includes(
                name
            ),
    })
    const root = parser.parse(xml)?.osmChange
    if (!isRecord(root)) {
        throw new Error('OpenStreetMap returned an invalid changeset document.')
    }
    const elements: ChangedElement[] = []
    for (const action of ['create', 'modify', 'delete'] as const) {
        for (const block of asArray(root[action])) {
            if (!isRecord(block)) continue
            for (const type of ['node', 'way', 'relation'] as const) {
                for (const raw of asArray(block[type])) {
                    if (!isRecord(raw)) continue
                    const version = Number(raw['version'])
                    if (!Number.isInteger(version)) continue
                    elements.push({
                        action,
                        type,
                        id: String(raw['id']),
                        version,
                        lat:
                            raw['lat'] === undefined
                                ? undefined
                                : Number(raw['lat']),
                        lon:
                            raw['lon'] === undefined
                                ? undefined
                                : Number(raw['lon']),
                        tags: readTags(raw),
                    })
                }
            }
        }
    }
    return elements
}

const sameTags = (
    submitted: Record<string, string>,
    uploaded: Record<string, string>
): boolean => {
    const keys = Object.keys(submitted)
    return (
        keys.length === Object.keys(uploaded).length &&
        keys.every((key) => uploaded[key] === submitted[key])
    )
}

const samePosition = (
    element: ChangedElement,
    coordinates: number[] | undefined
): boolean =>
    coordinates !== undefined &&
    element.lon !== undefined &&
    element.lat !== undefined &&
    Math.abs(element.lon - coordinates[0]) < COORDINATE_TOLERANCE &&
    Math.abs(element.lat - coordinates[1]) < COORDINATE_TOLERANCE

const sameCreation = (
    a: PersistedUploadSubmission,
    b: PersistedUploadSubmission
): boolean => {
    const first = a.feature
    const second = b.feature
    return (
        b.operation === 'Create' &&
        first.properties.type === second.properties.type &&
        first.geometry.type === 'Point' &&
        second.geometry.type === 'Point' &&
        Math.abs(
            first.geometry.coordinates[0] - second.geometry.coordinates[0]
        ) < COORDINATE_TOLERANCE &&
        Math.abs(
            first.geometry.coordinates[1] - second.geometry.coordinates[1]
        ) < COORDINATE_TOLERANCE &&
        sameTags(
            normalizeOsmTags(first.properties.tags),
            normalizeOsmTags(second.properties.tags)
        )
    )
}

/**
 * Compares what a changeset contains with the immutable snapshot of an upload
 * attempt, to learn whether OpenStreetMap applied a request whose answer was
 * lost. Edits are recognised by `version + 1`; creations (no identity yet) by
 * their position and their exact tags, among the created elements this device
 * does not already know (`isKnownElement`, e.g. `node/111`): a reused
 * changeset can hold an identical object from an earlier upload. A creation
 * that several unknown elements could match is not counted as applied.
 */
export const matchUploadAgainstChangeset = (
    xml: string,
    submissions: PersistedUploadSubmission[],
    isKnownElement: (id: string) => boolean = () => false
): UploadVerification => {
    const elements = parseChangesetDownload(xml)
    const usedElements = new Set<ChangedElement>()
    const receipt: OsmDiffResult[] = []
    const matched: string[] = []
    const missing: string[] = []
    let ambiguous = false

    for (const submission of submissions) {
        const feature = submission.feature
        const type = feature.properties.type as OsmDiffResult['type']
        const oldId = String(feature.properties.id)
        const row: OsmDiffResult = {
            type,
            old_id: oldId,
            osmgoOldId: `${type}/${oldId}`,
        }
        let found: ChangedElement | undefined

        if (submission.operation === 'Create') {
            const submittedTags = normalizeOsmTags(feature.properties.tags)
            const coordinates =
                feature.geometry.type === 'Point'
                    ? feature.geometry.coordinates
                    : undefined
            const candidates = elements.filter(
                (element) =>
                    element.action === 'create' &&
                    element.type === type &&
                    element.version === 1 &&
                    !isKnownElement(`${type}/${element.id}`) &&
                    samePosition(element, coordinates) &&
                    sameTags(submittedTags, element.tags)
            )
            const identicalSubmissions = submissions.filter((other) =>
                sameCreation(submission, other)
            ).length
            if (candidates.length > identicalSubmissions) {
                ambiguous = true
            } else {
                found = candidates.find((element) => !usedElements.has(element))
            }
            if (found) {
                row.new_id = found.id
                row.new_version = found.version
                row.osmgoNewId = `${type}/${found.id}`
            }
        } else {
            const action: ChangeAction =
                submission.operation === 'Delete' ? 'delete' : 'modify'
            const expectedVersion = feature.properties.meta.version + 1
            found = elements.find(
                (element) =>
                    element.action === action &&
                    element.type === type &&
                    element.id === oldId &&
                    element.version === expectedVersion &&
                    !usedElements.has(element)
            )
            if (found && action === 'modify') {
                row.new_id = oldId
                row.new_version = found.version
                row.osmgoNewId = `${type}/${oldId}`
            }
        }

        if (found) {
            usedElements.add(found)
            receipt.push(row)
            matched.push(submission.oldId)
        } else {
            missing.push(submission.oldId)
        }
    }

    if (missing.length === 0) return { kind: 'applied', receipt }
    if (matched.length === 0 && !ambiguous) return { kind: 'notFound' }
    return { kind: 'partial', matched, missing }
}
