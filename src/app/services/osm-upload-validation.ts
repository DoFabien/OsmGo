import { isNodeReferencedByWayOrRelation } from '@app/utils/osm-feature'
import {
    isIncompleteOsmTagKey,
    MAX_OSM_TAG_LENGTH,
    osmTextLength,
} from '@app/utils/osm-tags'
import type { OsmGoChangeType, OsmGoFeature } from '@osmgo/type'

const OSM_TYPES = ['node', 'way', 'relation'] as const

const containsInvalidXmlCharacter = (value: string): boolean =>
    Array.from(value).some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 && code !== 9 && code !== 10 && code !== 13
    })

/** The queue entry `featureId` cannot be sent to OpenStreetMap as it is. */
export class UploadValidationError extends Error {
    readonly name = 'UploadValidationError'

    constructor(
        readonly featureId: string | undefined,
        readonly reason: string
    ) {
        super(
            featureId
                ? `The local OSM upload queue is invalid (${featureId}: ${reason}).`
                : `The local OSM upload queue is invalid (${reason}).`
        )
    }
}

const invalidQueue = (reason = 'invalid data'): never => {
    throw new UploadValidationError(undefined, reason)
}

const isValidOsmReference = (value: unknown): boolean =>
    /^-?[1-9]\d*$/.test(String(value))

const validateTags = (tags: unknown): void => {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
        invalidQueue('tags are missing')
    }
    for (const [key, value] of Object.entries(
        tags as Record<string, unknown>
    )) {
        if (
            key.length === 0 ||
            isIncompleteOsmTagKey(key) ||
            osmTextLength(key) > MAX_OSM_TAG_LENGTH ||
            containsInvalidXmlCharacter(key) ||
            (typeof value !== 'string' && typeof value !== 'number')
        ) {
            invalidQueue(`invalid tag key "${key}"`)
        }
        const serialized = String(value)
        if (
            osmTextLength(serialized) > MAX_OSM_TAG_LENGTH ||
            containsInvalidXmlCharacter(serialized) ||
            (typeof value === 'number' && !Number.isFinite(value))
        ) {
            invalidQueue(`invalid value for tag "${key}"`)
        }
    }
}

const validatePointGeometry = (feature: OsmGoFeature): void => {
    const geometry = feature.geometry
    if (geometry?.type !== 'Point') {
        invalidQueue('a point geometry is required')
        return
    }
    const [longitude, latitude] = geometry.coordinates
    if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        longitude < -180 ||
        longitude > 180 ||
        latitude < -90 ||
        latitude > 90
    ) {
        invalidQueue('coordinates are out of range')
    }
}

export interface ValidatedUploadFeature {
    id: string
    operation: OsmGoChangeType
}

const validateFeature = (feature: OsmGoFeature): ValidatedUploadFeature => {
    const properties = feature?.properties
    if (!properties || typeof properties !== 'object') {
        invalidQueue('properties are missing')
    }
    const type = properties.type
    const objectId = properties.id
    if (
        !OSM_TYPES.includes(type as (typeof OSM_TYPES)[number]) ||
        !Number.isSafeInteger(objectId) ||
        objectId === 0 ||
        feature.id !== `${type}/${objectId}`
    ) {
        invalidQueue('the object identity is inconsistent')
    }

    const changeType = properties.changeType
    if (!['Create', 'Update', 'Delete'].includes(String(changeType))) {
        invalidQueue('the change type is unknown')
    }
    validateTags(properties.tags)

    if (changeType === 'Create') {
        if (objectId >= 0 || type !== 'node') {
            invalidQueue('only new nodes can be created')
        }
        validatePointGeometry(feature)
    } else {
        if (
            objectId < 1 ||
            !Number.isInteger(properties.meta?.version) ||
            properties.meta.version < 1
        ) {
            invalidQueue('the OSM version is invalid')
        }
        if (type === 'node') {
            validatePointGeometry(feature)
        } else if (type === 'way') {
            if (
                !Array.isArray(feature.ndRefs) ||
                feature.ndRefs.length < 2 ||
                feature.ndRefs.some(
                    (reference) => !isValidOsmReference(reference)
                )
            ) {
                invalidQueue('the way node references are invalid')
            }
        } else if (
            !Array.isArray(feature.members) ||
            feature.members.some(
                (member) =>
                    !OSM_TYPES.includes(member?.type) ||
                    !isValidOsmReference(member?.ref) ||
                    typeof member?.role !== 'string' ||
                    containsInvalidXmlCharacter(member.role)
            )
        ) {
            invalidQueue('the relation members are invalid')
        }
    }

    const operation =
        changeType === 'Delete' && isNodeReferencedByWayOrRelation(feature)
            ? 'Update'
            : changeType
    return { id: String(feature.id), operation: operation! }
}

export const validateOsmUploadFeature = (
    feature: OsmGoFeature
): ValidatedUploadFeature => {
    try {
        return validateFeature(feature)
    } catch (error) {
        if (
            error instanceof UploadValidationError &&
            error.featureId === undefined
        ) {
            const id = feature?.id
            throw new UploadValidationError(
                id === undefined || id === null ? undefined : String(id),
                error.reason
            )
        }
        throw error
    }
}
