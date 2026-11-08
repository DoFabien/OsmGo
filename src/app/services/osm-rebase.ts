import { cloneDeep } from '@app/utils/clone'
import {
    mergeNodePosition,
    mergeOsmTags,
    type TagConflict,
} from '@app/utils/osm-merge'
import { normalizeOsmTags } from '@app/utils/osm-tags'
import type { OsmGoFeature } from '@osmgo/type'
import type { OsmApiObject } from '@services/osmApi.service'

export type RebaseOutcome =
    | { kind: 'rebased'; feature: OsmGoFeature; adoptedRemoteKeys: string[] }
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
 * feature whose tags changed.
 */
export const rebaseOnRemote = (
    pending: OsmGoFeature,
    remote: OsmApiObject,
    finalize: (feature: OsmGoFeature) => OsmGoFeature
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
    const merge = mergeOsmTags(
        normalizeOsmTags(base.properties.tags),
        normalizeOsmTags(pending.properties.tags),
        theirsTags
    )

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
        position = result.conflict
        mergedPosition = result.position
    }

    if (merge.conflicts.length > 0 || position || structure) {
        return {
            kind: 'conflict',
            conflicts: merge.conflicts,
            position,
            structure,
        }
    }

    const meta = {
        version: remote.version,
        changeset: String(remote.changeset ?? ''),
        timestamp: remote.timestamp ?? '',
        user: remote.user ?? '',
        uid: String(remote.uid ?? ''),
    }

    const newBase = cloneDeep(base)
    newBase.properties.tags = theirsTags
    newBase.properties.meta = { ...meta }
    if (
        newBase.geometry.type === 'Point' &&
        pending.properties.type === 'node'
    ) {
        newBase.geometry = {
            type: 'Point',
            coordinates: [Number(remote.lon), Number(remote.lat)],
        }
    }
    delete newBase.properties.originalData
    delete newBase.properties.changeType

    const rebased = cloneDeep(pending)
    rebased.properties.tags = merge.tags
    rebased.properties.meta = { ...meta }
    if (mergedPosition && rebased.geometry.type === 'Point') {
        rebased.geometry = { type: 'Point', coordinates: mergedPosition }
    }
    rebased.properties.originalData = finalize(newBase)

    return {
        kind: 'rebased',
        feature: finalize(rebased),
        adoptedRemoteKeys: merge.adoptedRemoteKeys,
    }
}
