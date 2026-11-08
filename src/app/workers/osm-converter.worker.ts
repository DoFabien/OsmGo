/// <reference lib="webworker" />

import {
    convert,
    findIncompleteMultipolygons,
} from '../../../scripts/osmToOsmgo/index.js'

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** A conversion waiting for the full version of incomplete relations. */
let waitingConversion:
    | { osm: unknown; options: Record<string, unknown> }
    | undefined

addEventListener('message', (event) => {
    try {
        const input = event.data
        if (Array.isArray(input.supplementalElements)) {
            if (!waitingConversion) {
                throw new Error('No conversion is waiting for relations.')
            }
            const { osm, options } = waitingConversion
            waitingConversion = undefined
            const data = convert(osm, {
                ...options,
                supplementalElements: input.supplementalElements,
            })
            postMessage({ ok: true, data })
            return
        }

        const osm =
            typeof input.osmData === 'string'
                ? JSON.parse(input.osmData)
                : input.osmData
        const options = {
            tagConfig: input.tagsConfig,
            primaryKeys: input.primaryKeys,
            oldGeojson: input.oldGeojson,
            geojsonChanged: input.geojsonChanged,
            oldBboxFeature: input.oldBboxFeature,
            limitFeatures: input.limitFeatures,
        }
        const incompleteRelationIds =
            Number.isInteger(input.maxIncompleteRelations) &&
            input.maxIncompleteRelations > 0
                ? findIncompleteMultipolygons(osm, {
                      primaryKeys: input.primaryKeys,
                      limit: input.maxIncompleteRelations,
                  })
                : []
        if (incompleteRelationIds.length > 0) {
            waitingConversion = { osm, options }
            postMessage({ ok: true, incompleteRelationIds })
            return
        }
        const data = convert(osm, options)
        postMessage({ ok: true, data })
    } catch (error) {
        postMessage({ ok: false, error: getErrorMessage(error) })
    }
})
