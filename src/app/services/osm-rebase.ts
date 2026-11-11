import { cloneDeep } from '@app/utils/clone'
import {
    mergeNodePosition,
    mergeOsmTags,
    type TagConflict,
} from '@app/utils/osm-merge'
import { normalizeOsmTags } from '@app/utils/osm-tags'
import type { OsmGoFeature } from '@osmgo/type'
import type { OsmApiObject } from '@services/osmApi.service'

/** A tag whose local value differs from the current OpenStreetMap one. */
export interface TagDifference {
    key: string
    mine?: string
    theirs?: string
    /**
     * `local`: only changed locally, kept. `remote`: only changed on
     * OpenStreetMap, taken. `conflict`: changed differently on both sides.
     */
    origin: 'local' | 'remote' | 'conflict'
}

export type RebaseChoice = 'mine' | 'theirs'

/** The user's choice for each conflict, by tag key, and for the position. */
export interface RebaseResolution {
    tags?: Record<string, RebaseChoice>
    position?: RebaseChoice
}

export type RebaseOutcome =
    | {
          kind: 'rebased'
          feature: OsmGoFeature
          adoptedRemoteKeys: string[]
          differences: TagDifference[]
      }
    | { kind: 'upToDate' }
    | { kind: 'unsupported' }
    | { kind: 'gone' }
    | {
          kind: 'conflict'
          /** Tags changed differently locally and on OpenStreetMap. */
          conflicts: TagConflict[]
          /** The node was moved differently locally and on OpenStreetMap. */
          position: boolean
          /** Nodes of the way or members of the relation changed remotely. */
          structure: boolean
          differences: TagDifference[]
      }

const sameList = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length &&
    left.every((value, index) => value === right[index])

const memberKeys = (
    members: ReadonlyArray<{ type: string; ref: unknown; role: string }>
) => members.map((member) => `${member.type}/${member.ref}/${member.role}`)

/**
 * Re-applies a pending edit on top of the current OpenStreetMap version of the
 * object. Tags and node positions are merged three ways, using the version the
 * edit started from (`originalData`) as the common base. The edit is only
 * rebased when nothing overlaps; ways and relations whose nodes or members
 * changed remotely are left to the user, as their geometry is not available.
 *
 * `finalize` recomputes the derived display data (name, icon, marker) of a
 * feature whose tags changed. `resolution` settles conflicts the user
 * decided; the edit is rebased once none is left.
 */
export const rebaseOnRemote = (
    pending: OsmGoFeature,
    remote: OsmApiObject,
    finalize: (feature: OsmGoFeature) => OsmGoFeature,
    resolution: RebaseResolution = {}
): RebaseOutcome => {
    const base = pending.properties.originalData
    if (
        pending.properties.changeType !== 'Update' ||
        !base ||
        remote.version === undefined
    ) {
        return { kind: 'unsupported' }
    }
    if (remote.visible === false) return { kind: 'gone' }
    if (remote.version <= base.properties.meta.version) {
        return { kind: 'upToDate' }
    }

    const theirsTags = normalizeOsmTags(remote.tags ?? {})
    const mineTags = normalizeOsmTags(pending.properties.tags)
    const merge = mergeOsmTags(
        normalizeOsmTags(base.properties.tags),
        mineTags,
        theirsTags
    )
    const conflictKeys = new Set(merge.conflicts.map(({ key }) => key))
    const differences: TagDifference[] = [
        ...new Set([...Object.keys(mineTags), ...Object.keys(theirsTags)]),
    ]
        .filter((key) => mineTags[key] !== theirsTags[key])
        .sort()
        .map((key) => ({
            key,
            mine: mineTags[key],
            theirs: theirsTags[key],
            origin: conflictKeys.has(key)
                ? 'conflict'
                : merge.adoptedRemoteKeys.includes(key)
                  ? 'remote'
                  : 'local',
        }))
    const unresolved = merge.conflicts.filter((conflict) => {
        const choice = resolution.tags?.[conflict.key]
        if (choice === 'theirs') {
            if (conflict.theirs === undefined) delete merge.tags[conflict.key]
            else merge.tags[conflict.key] = conflict.theirs
        }
        return choice === undefined
    })

    let structure = false
    if (pending.properties.type === 'way') {
        structure = !sameList(
            (remote.nodes ?? []).map(String),
            (base.ndRefs ?? []).map(String)
        )
    } else if (pending.properties.type === 'relation') {
        structure = !sameList(
            memberKeys(remote.members ?? []),
            memberKeys(base.members ?? [])
        )
    }

    let position = false
    let mergedPosition: [number, number] | undefined
    if (
        pending.properties.type === 'node' &&
        pending.geometry.type === 'Point' &&
        base.geometry.type === 'Point'
    ) {
        const remoteLon = Number(remote.lon)
        const remoteLat = Number(remote.lat)
        if (!Number.isFinite(remoteLon) || !Number.isFinite(remoteLat)) {
            return { kind: 'unsupported' }
        }
        const result = mergeNodePosition(
            base.geometry.coordinates,
            pending.geometry.coordinates,
            [remoteLon, remoteLat]
        )
        position = result.conflict && resolution.position === undefined
        mergedPosition =
            result.conflict && resolution.position === 'theirs'
                ? [remoteLon, remoteLat]
                : result.position
    }

    if (unresolved.length > 0 || position || structure) {
        return {
            kind: 'conflict',
            conflicts: unresolved,
            position,
            structure,
            differences,
        }
    }

    const newBase = remoteVersionOf(base, remote)
    const rebased = cloneDeep(pending)
    rebased.properties.tags = merge.tags
    rebased.properties.meta = { ...newBase.properties.meta }
    if (mergedPosition && rebased.geometry.type === 'Point') {
        rebased.geometry = { type: 'Point', coordinates: mergedPosition }
    }
    rebased.properties.originalData = finalize(newBase)

    return {
        kind: 'rebased',
        feature: finalize(rebased),
        adoptedRemoteKeys: merge.adoptedRemoteKeys,
        differences,
    }
}

const remoteMeta = (remote: OsmApiObject) => ({
    version: remote.version ?? 0,
    changeset: String(remote.changeset ?? ''),
    timestamp: remote.timestamp ?? '',
    user: remote.user ?? '',
    uid: String(remote.uid ?? ''),
})

/** `base` updated to the current OpenStreetMap tags, version and node position. */
const remoteVersionOf = (
    base: OsmGoFeature,
    remote: OsmApiObject
): OsmGoFeature => {
    const current = cloneDeep(base)
    current.properties.tags = normalizeOsmTags(remote.tags ?? {})
    current.properties.meta = remoteMeta(remote)
    if (current.geometry.type === 'Point' && base.properties.type === 'node') {
        current.geometry = {
            type: 'Point',
            coordinates: [Number(remote.lon), Number(remote.lat)],
        }
    }
    delete current.properties.originalData
    delete current.properties.changeType
    return current
}

/**
 * The current OpenStreetMap version of the object a pending edit started
 * from, to show it again when the edit is dropped after a conflict. Undefined
 * when it cannot be rebuilt locally: a way or relation whose nodes or members
 * changed, a deleted object or an invalid answer.
 */
export const currentVersionOf = (
    pending: OsmGoFeature,
    remote: OsmApiObject,
    finalize: (feature: OsmGoFeature) => OsmGoFeature
): OsmGoFeature | undefined => {
    const base = pending.properties.originalData
    if (!base || remote.version === undefined || remote.visible === false) {
        return undefined
    }
    if (
        pending.properties.type === 'node' &&
        (!Number.isFinite(Number(remote.lon)) ||
            !Number.isFinite(Number(remote.lat)))
    ) {
        return undefined
    }
    if (
        (pending.properties.type === 'way' &&
            !sameList(
                (remote.nodes ?? []).map(String),
                (base.ndRefs ?? []).map(String)
            )) ||
        (pending.properties.type === 'relation' &&
            !sameList(
                memberKeys(remote.members ?? []),
                memberKeys(base.members ?? [])
            ))
    ) {
        return undefined
    }
    return finalize(remoteVersionOf(base, remote))
}
