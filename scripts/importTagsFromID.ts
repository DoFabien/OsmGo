/**
 * Update files tags.json & presets.json in folder tagsAndPresets
 */

import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { PresetOption, TagConfig } from '@osmgo/type'
import fs from 'fs'
import { assetsDir, tapPresetsPath, tapTagsPath } from './_paths'
import {
    isUnsupportedField,
    readTapPresetsFromJson,
    readTapTagsFromJson,
    stringifyCatalog,
} from './_utils'
import { getCountryCodes } from './nameSuggestionIndex'

const tagConfig = readTapTagsFromJson()
const tagsOsmgo = tagConfig.tags
const presetsOsmgo = readTapPresetsFromJson()
const tagsID = require('@openstreetmap/id-tagging-schema/dist/presets.json')
const presetsID = require('@openstreetmap/id-tagging-schema/dist/fields.json')

// presets to ignore
const excludesPresets = [
    //'access_simple', to add?
    'address',
    //'branch_brand', to add?
    'brand',
    'building_area',
    //'charge_fee', to add?
    //'gnis/feature_id-US', to add?
    'gnis/feature_id',
    //'mimics', to add?
    'name',
    //'not/name', to add?
    //'opening_hours/covid19', to add?
    'operator',
    //'portable', to add?
    'post',
    //'real_fire-GB-IE', to add?
    //'ref', to add?
    //'ref/vatin', to add?
    //'visibility', to add?
    'level_semi',
]

// iD describes schools, colleges... with education=* (amenity=school alone is
// no longer offered by its search): the catalog needs that key
for (const [requiredKey, afterKey] of [['education', 'amenity']]) {
    if (!tagConfig.primaryKeys.includes(requiredKey)) {
        const position = tagConfig.primaryKeys.indexOf(afterKey) + 1
        tagConfig.primaryKeys.splice(position, 0, requiredKey)
    }
}
const osmgoPkeys = tagConfig.primaryKeys
const sprites: Record<string, unknown> = JSON.parse(
    fs.readFileSync(
        path.join(assetsDir, 'mapStyle', 'sprites', 'sprites.json'),
        'utf8'
    )
)

const getOsmGoMarkerColorFromTagRoot = (tagRoot) => {
    let result = [] // =>
    for (const tag of tagsOsmgo) {
        const currentTagRoot = tag.id.split('/')[0]
        if (currentTagRoot === tagRoot) {
            const resultColor = result.find((r) => r.color === tag.markerColor)
            if (resultColor) {
                resultColor.count = resultColor.count + 1
            } else {
                result = [...result, { color: tag.markerColor, count: 1 }]
            }
        }
    }
    // take object with the max count
    let maxCountColor: { color: string; count: number } | undefined
    for (const r of result) {
        if (!maxCountColor || maxCountColor.count < r.count) {
            maxCountColor = r
        }
    }
    return maxCountColor?.color
}

// A category of a new root (education=school) takes the colour of the root
// that its addTags write too (amenity=school)
const getMarkerColor = (tagRoot: string, addTags: Record<string, string>) =>
    [tagRoot, ...Object.keys(addTags ?? {})]
        .map(getOsmGoMarkerColorFromTagRoot)
        .find(Boolean) ?? '#000000'

const idTagFieldIds = new Set<string>()
const searchableVotes = new Map<TagConfig, boolean[]>()

const mergeFieldIds = (
    currentIds: Array<string> = [],
    importedIds: Array<string>
): Array<string> => [...new Set([...currentIds, ...importedIds])]

/* IMPORT TAGS */
for (const iDid in tagsID) {
    const tagiD = tagsID[iDid]
    const tagIDKeys = Object.keys(tagiD.tags)

    if (iDid.split('/').length === 1) {
        // primary key
        continue
    }

    if (iDid.split('/')[0] == 'type') {
        continue
    }

    // exclude brands...
    //TODO rework
    if (tagiD['addTags'] && tagiD['addTags']['brand']) {
        continue
    }

    //TODO rework
    if (!tagIDKeys.some((key) => osmgoPkeys.includes(key))) {
        continue
    }

    let iDFields = [] // for this tag
    let iDMoreFields = []

    // get liste of fields from current tag from iD
    let currentTagFields = []
    let currentTagMoreFields = []
    for (const f of tagiD.fields || []) {
        if (/\{/.test(f)) {
            // if field look like { ... } => reference to anothers parent fields
            const keyRef = f.replace('{', '').replace('}', '')
            const refFields = tagsID[keyRef].fields
            currentTagFields = [...currentTagFields, ...refFields]
            if (tagsID[keyRef].moreFields) {
                currentTagMoreFields = [
                    ...currentTagMoreFields,
                    ...tagsID[keyRef].moreFields,
                ]
            }
        } else {
            currentTagFields = [...currentTagFields, f]
        }
    }

    // get liste of morreFields from current tag from iD
    for (const f of tagiD.moreFields || []) {
        if (/\{/.test(f)) {
            // if field look like { ... }
            const keyRef = f.replace('{', '').replace('}', '')
            const refFields = tagsID[keyRef].fields
            currentTagMoreFields = [...currentTagMoreFields, ...refFields]
            if (tagsID[keyRef].moreFields) {
                currentTagMoreFields = [
                    ...currentTagMoreFields,
                    ...tagsID[keyRef].moreFields,
                ]
            }
        } else {
            currentTagMoreFields = [...currentTagMoreFields, f]
        }
    }

    for (const f of currentTagFields) {
        if (!presetsID[f]) {
            console.log('missing preset', f)
            continue
        }
        if (
            presetsID[f].type === 'typeCombo' ||
            excludesPresets.includes(f) ||
            isUnsupportedField(presetsID[f])
        ) {
            continue
        }

        idTagFieldIds.add(f)
        iDFields = mergeFieldIds(iDFields, [f])
    }

    for (const f of currentTagMoreFields) {
        if (
            !presetsID[f] ||
            presetsID[f].type === 'typeCombo' ||
            excludesPresets.includes(f) ||
            isUnsupportedField(presetsID[f])
        ) {
            continue
        }

        idTagFieldIds.add(f)
        iDMoreFields = mergeFieldIds(iDMoreFields, [f])
    }

    const tagOsmgoById = tagsOsmgo.find((t) => t.id === iDid)

    const currenOsmgoTag = tagsOsmgo.find((ogT) => {
        return isDeepStrictEqual(tagiD.tags, ogT.tags)
    })

    const rootTag = iDid.split('/')[0]

    // The Osm Go category that stands for this iD preset: same id first, then
    // same tags (legacy ids and per-geometry iD presets share the tags).
    const mappedTag = tagOsmgoById ?? currenOsmgoTag
    if (mappedTag) {
        searchableVotes.set(mappedTag, [
            ...(searchableVotes.get(mappedTag) ?? []),
            tagiD.searchable !== false,
        ])
        if (!mappedTag.iDRef || !tagsID[mappedTag.iDRef]) {
            mappedTag.iDRef = iDid
        }
    }

    if (tagOsmgoById && !currenOsmgoTag) {
        // tag found by id, we can update tags
        console.log('!tags & sameIds', iDid)
        tagOsmgoById.tags = tagiD.tags
        tagOsmgoById.presets = mergeFieldIds(tagOsmgoById.presets, iDFields)
        tagOsmgoById.moreFields = mergeFieldIds(
            tagOsmgoById.moreFields,
            iDMoreFields
        )
        if (tagiD.addTags) {
            tagOsmgoById['addTags'] = tagiD.addTags
        }
    } else if (!tagOsmgoById && !currenOsmgoTag) {
        // new
        console.log('new', iDid)
        const newTag = {
            id: iDid,
            tags: tagiD.tags,
            // an icon that is not a sprite yet is chosen by cleanTags
            icon: sprites[tagiD.icon] ? tagiD.icon : '',
            markerColor: getMarkerColor(rootTag, tagiD.addTags),
            presets: iDFields,
            moreFields: iDMoreFields,
            lbl: { en: tagiD.name },
            terms: { en: tagiD.terms ? tagiD.terms.join(', ') : '' },
            geometry: tagiD.geometry,
            iDRef: iDid,
        } as TagConfig
        if (tagiD.terms) newTag['terms'] = { en: tagiD.terms.join(', ') }
        if (tagiD.addTags) newTag['addTags'] = tagiD.addTags
        if (tagiD.reference) newTag['reference'] = tagiD.reference

        tagsOsmgo.push(newTag)
        searchableVotes.set(newTag, [tagiD.searchable !== false])
    } else if (tagOsmgoById) {
        // tag already exist in tags.json
        // we can update tags
        tagOsmgoById.tags = tagiD.tags
        tagOsmgoById.presets = mergeFieldIds(tagOsmgoById.presets, iDFields)
        tagOsmgoById.moreFields = mergeFieldIds(
            tagOsmgoById.moreFields,
            iDMoreFields
        )
    } else {
        // same tags as another category: only the geometries can add up
        currenOsmgoTag.geometry = [
            ...new Set([...currenOsmgoTag.geometry, ...tagiD.geometry]),
        ]
        // iD names the point a stop ("Bus Stop") and the line or area a
        // platform: Osm Go mostly adds points, the point preset names the
        // category and gives the tags it writes
        const referencedTag = tagsID[currenOsmgoTag.iDRef]
        if (
            tagiD.searchable !== false &&
            tagiD.geometry.includes('point') &&
            !referencedTag?.geometry.includes('point')
        ) {
            console.log('point preset names', currenOsmgoTag.id, iDid)
            currenOsmgoTag.iDRef = iDid
            currenOsmgoTag.lbl = { en: tagiD.name }
            currenOsmgoTag.terms = { en: (tagiD.terms ?? []).join(', ') }
            if (tagiD.addTags) {
                currenOsmgoTag.addTags = tagiD.addTags
            } else {
                delete currenOsmgoTag.addTags
            }
        }
    }

    // the addTags follow the iD preset that the category stands for
    if (mappedTag?.iDRef === iDid && tagiD.addTags) {
        mappedTag.addTags = tagiD.addTags
    }
}

// iD ranks the presets that match an object by their matchScore (0.5 for a
// building, 0.6 for a bare platform), so that `amenity=school` +
// `building=yes` is a school. A category without an iD preset takes the score
// that most iD presets of its key use.
const matchScoreCounts = new Map<string, Map<number, number>>()
for (const [iDid, tagiD] of Object.entries<{ matchScore?: number }>(tagsID)) {
    if (!iDid.includes('/')) continue
    const rootTag = iDid.split('/')[0]
    const counts = matchScoreCounts.get(rootTag) ?? new Map<number, number>()
    const score = tagiD.matchScore ?? 1
    counts.set(score, (counts.get(score) ?? 0) + 1)
    matchScoreCounts.set(rootTag, counts)
}
const getUsualMatchScore = (rootTag: string): number => {
    let usual = 1
    for (const [score, count] of matchScoreCounts.get(rootTag) ?? []) {
        if (count > (matchScoreCounts.get(rootTag)?.get(usual) ?? 0)) {
            usual = score
        }
    }
    return usual
}
for (const tag of tagsOsmgo as Array<TagConfig & { matchScore?: number }>) {
    const matchScore = tagsID[tag.iDRef]
        ? (tagsID[tag.iDRef].matchScore ?? 1)
        : getUsualMatchScore(tag.id.split('/')[0])
    if (matchScore === 1) {
        delete tag.matchScore
    } else {
        tag.matchScore = matchScore
    }
}

// A category stays searchable while one of its iD presets is
for (const [tag, votes] of searchableVotes) {
    if (votes.some(Boolean)) {
        delete tag.searchable
    } else {
        tag.searchable = false
    }
}

// iD writes healthcare=* along with amenity=* (doctors, dentist, hospital): a
// healthcare category of Osm Go alone that an iD category writes too is not
// offered, the search gives the iD category, which writes both keys
const COMPANION_KEYS = ['healthcare']
const isIDCategory = (tag: TagConfig): boolean =>
    Boolean(tagsID[tag.iDRef]) && !tag.deprecated && tag.searchable !== false
for (const tag of tagsOsmgo) {
    if (
        tagsID[tag.iDRef] ||
        tag.deprecated ||
        !Object.keys(tag.tags).every((key) => COMPANION_KEYS.includes(key))
    ) {
        continue
    }
    const isWrittenByIDCategory = tagsOsmgo.some(
        (other) =>
            other !== tag &&
            isIDCategory(other) &&
            Object.entries(tag.tags).every(
                ([key, value]) => String(other.addTags?.[key]) === String(value)
            )
    )
    if (isWrittenByIDCategory) {
        tag.searchable = false
    }
}

// iD only offers a regional preset (bicycle_foot paths, Irish pubs) where it
// applies
for (const tag of tagsOsmgo as Array<TagConfig & { countryCodes?: string[] }>) {
    const locationSet = tagsID[tag.iDRef]?.locationSet
    if (!locationSet) continue
    const { countryCodes, excludeCountryCodes } = getCountryCodes(locationSet)
    const upperCase = (codes?: string[]) =>
        codes?.map((code) => code.toUpperCase())
    if (countryCodes) {
        tag.countryCodes = upperCase(countryCodes)
    } else {
        delete tag.countryCodes
    }
    if (excludeCountryCodes) {
        tag.excludeCountryCodes = upperCase(excludeCountryCodes)
    } else {
        delete tag.excludeCountryCodes
    }
}

/* IMPORT PRESETS */
// list des Presets/fields used : idTagsFieldsListId

for (const fiDId of idTagFieldIds) {
    if (excludesPresets.includes(fiDId)) {
        continue
    }
    const currentIDPreset = structuredClone(presetsID[fiDId])
    let currentOsmGoPreset = presetsOsmgo[fiDId]
    if (!currentIDPreset) {
        continue
    }

    if (currentIDPreset.label) {
        currentIDPreset.lbl = { en: currentIDPreset.label }
    }

    if (
        !currentIDPreset.options &&
        currentIDPreset.key &&
        currentIDPreset.type === 'radio'
    ) {
        const matchingField = Object.values(presetsID).find((field: any) => {
            return (
                field !== presetsID[fiDId] &&
                field.key === currentIDPreset.key &&
                Array.isArray(field.options)
            )
        }) as { options?: Array<string> } | undefined
        currentIDPreset.options = matchingField?.options
    }

    if (currentIDPreset.options) {
        currentIDPreset.options = currentIDPreset.options.map((o) => {
            return {
                v: o === 'undefined' ? '' : o,
                lbl: { en: o },
            }
        })
    }

    if (currentIDPreset.strings) {
        const objs = currentIDPreset.strings.options
        const options = []
        for (const k in objs) {
            options.push({
                v: k !== 'undefined' ? k : '',
                lbl: { en: objs[k] },
            })
        }
        delete currentIDPreset.strings
        currentIDPreset['options'] = options
    }

    if (currentIDPreset.type === 'check') {
        const options = [
            { v: 'yes', lbl: { en: 'yes', fr: 'Oui' } },
            { v: 'no', lbl: { en: 'no', fr: 'Non' } },
        ]
        currentIDPreset['iDtype'] = currentIDPreset.type
        currentIDPreset['type'] = 'select'
        currentIDPreset['options'] = options
    } else if (['defaultCheck', 'onewayCheck'].includes(currentIDPreset.type)) {
        // iD lists the unset value ("undefined") first: the select already
        // offers it, only the real values stay
        const options = (currentIDPreset.options ?? []).filter(
            (option) => option.v !== ''
        )
        currentIDPreset['iDtype'] = currentIDPreset.type
        currentIDPreset['type'] = 'select'
        currentIDPreset['options'] =
            options.length > 0
                ? options
                : [{ v: 'yes', lbl: { en: 'yes', fr: 'Oui' } }]
    } else if (
        ['semiCombo', 'multiCombo', 'manyCombo'].includes(currentIDPreset.type)
    ) {
        // Fields with several values, each with its own editor: semicolon
        // separated values of one key (`cuisine=pizza;italian`), one `yes` tag
        // per option under a key prefix (`payment:cash=yes`), or one `yes` tag
        // per option key (`male=yes`, `female=yes`)
        currentIDPreset['iDtype'] = currentIDPreset.type
    } else if (
        ['combo', 'access', 'typeCombo'].includes(currentIDPreset.type)
    ) {
        currentIDPreset['iDtype'] = currentIDPreset.type
        if (currentIDPreset['options']) {
            currentIDPreset['type'] = 'list'
        } else {
            // currentIDPreset['type'] = 'select' // ? // we need to integrate options from taginfo ?
            currentIDPreset['type'] = 'text'
        }
    } else if (['tel', 'email', 'url'].includes(currentIDPreset.type)) {
        currentIDPreset['iDtype'] = currentIDPreset.type
        currentIDPreset['type'] = currentIDPreset.type
    } else if (
        ['number', 'integer', 'maxspeed', 'roadheight'].includes(
            currentIDPreset.type
        )
    ) {
        currentIDPreset['iDtype'] = currentIDPreset.type
        currentIDPreset['type'] = 'number'
    } else if (currentIDPreset.type == 'radio') {
        currentIDPreset['iDtype'] = currentIDPreset.type
        currentIDPreset['type'] = 'select'
    } else if (['text'].includes(currentIDPreset.type)) {
        currentIDPreset['iDtype'] = currentIDPreset.type
        currentIDPreset['type'] = 'text'
    }
    //TODO :add type textarea... in Osm Go
    else {
        console.error(
            `unknown iD type : ${currentIDPreset.type}  => text in Osm Go`
        )
        currentIDPreset['iDtype'] = currentIDPreset.type
        currentIDPreset['type'] = 'text'
    }

    delete currentIDPreset.label

    // already in OSMGO
    if (currentOsmGoPreset) {
        if (currentIDPreset.options) {
            for (const oiD of currentIDPreset.options) {
                let oGo: PresetOption | undefined
                if (currentOsmGoPreset.options) {
                    oGo = currentOsmGoPreset.options.find((o) => o.v === oiD.v)
                }
                if (oGo) {
                    // oGo.lbl.en = oiD.lbl.en;
                } else {
                    if (currentOsmGoPreset.options) {
                        currentOsmGoPreset.options.push(oiD)
                    }
                }
            }
            // currentOsmGoPreset.options = [...currentOsmGoPreset.options, ...currentIDPreset.options]
        }

        currentOsmGoPreset = { ...currentOsmGoPreset, ...currentIDPreset }
        presetsOsmgo[fiDId] = currentOsmGoPreset
    } else {
        presetsOsmgo[fiDId] = currentIDPreset
    }
}

fs.writeFileSync(tapTagsPath, stringifyCatalog(tagConfig), 'utf8')
fs.writeFileSync(tapPresetsPath, stringifyCatalog(presetsOsmgo), 'utf8')
