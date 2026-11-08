import fs from 'fs-extra'
import path from 'path'
import { assetsDir, tapPresetsPath, tapTagsPath } from './_paths'
import {
    isUnsupportedField,
    MULTI_VALUE_FIELD_TYPES,
    readTapPresetsFromJson,
    readTapTagsFromJson,
    stringifyCatalog,
} from './_utils'

const tagsConfig = readTapTagsFromJson()
const presetsOsmgo = readTapPresetsFromJson()
const tagsID = require('@openstreetmap/id-tagging-schema/dist/presets.json')
const sprites: Record<string, unknown> = fs.readJsonSync(
    path.join(assetsDir, 'mapStyle', 'sprites', 'sprites.json')
)

// The map draws this icon for a category without one
const FALLBACK_ICON = 'maki-circle'

const uniqIds: string[] = []
const indicesToDelete: number[] = []
const iconById = new Map(tagsConfig.tags.map((tag) => [tag.id, tag.icon]))
const iconByTag = new Map(
    tagsConfig.tags
        .filter((tag) => Object.keys(tag.tags).length === 1)
        .map((tag) => {
            const [key, value] = Object.entries(tag.tags)[0]
            return [`${key}=${value}`, tag.icon]
        })
)

// The iD icon when it is already a sprite, else the one of the closest parent
// category, else the neutral map icon: a category never has an empty icon.
const getIconOfTag = (tag: {
    id: string
    iDRef?: string
    addTags?: Record<string, string | number>
}): string => {
    const iDIcon = tagsID[tag.iDRef ?? tag.id]?.icon
    if (iDIcon && sprites[iDIcon]) {
        return iDIcon
    }
    const segments = tag.id.split('/')
    for (let length = segments.length - 1; length > 0; length--) {
        const parentIcon = iconById.get(segments.slice(0, length).join('/'))
        if (parentIcon) {
            return parentIcon
        }
    }
    // education=school is written with amenity=school: same icon
    for (const [key, value] of Object.entries(tag.addTags ?? {})) {
        const siblingIcon = iconByTag.get(`${key}=${value}`)
        if (siblingIcon) {
            return siblingIcon
        }
    }
    return FALLBACK_ICON
}

const getCanonicalPresetId = (presetId: string): string => {
    const preset = presetsOsmgo[presetId]
    if (!preset) {
        return presetId
    }

    for (const separator of [':', '_']) {
        const candidateId = presetId.split(separator).join('/')
        const candidate = presetsOsmgo[candidateId]
        if (candidate && candidate.key === preset.key) {
            return candidateId
        }
    }

    return presetId
}

for (let i = 0; i < tagsConfig.tags.length; i++) {
    const tag = tagsConfig.tags[i]

    const isEditable = (presetId: string): boolean =>
        !presetsOsmgo[presetId] || !isUnsupportedField(presetsOsmgo[presetId])
    tag.presets = [
        ...new Set(tag.presets.map(getCanonicalPresetId).filter(isEditable)),
    ]
    if (tag.moreFields) {
        tag.moreFields = [
            ...new Set(
                tag.moreFields.map(getCanonicalPresetId).filter(isEditable)
            ),
        ]
    }

    if (tag.id) {
        if (!uniqIds.includes(tag.id)) {
            uniqIds.push(tag.id)
        } else {
            console.log(`Duplicate tag id : ${tag.id} => deletion`)
            indicesToDelete.push(i)
        }
    } else {
        console.error(`No id for tag ${i}`)
    }

    // delete "key" property
    if (tag.key) {
        console.log(`Deprecated key property for tag ${tag.id}`)
        delete tag.key
    }

    for (const pid of tag.presets) {
        if (!presetsOsmgo[pid]) {
            console.error(`Preset ${pid} not found for tag ${tag.id}`)
        }
    }

    if (!tag.icon) {
        tag.icon = getIconOfTag(tag)
        console.log(`No icon for tag ${tag.id} => ${tag.icon}`)
    }

    if (!tag.tags) {
        console.error(`No tags for tag ${tag.id} !!`)
    }

    // tag.presets = tag.presets.filter((p: string) => p !== 'name')
}

for (let i = indicesToDelete.length - 1; i >= 0; i--) {
    tagsConfig.tags.splice(indicesToDelete[i], 1)
}

console.log(indicesToDelete)

fs.writeFileSync(tapTagsPath, stringifyCatalog(tagsConfig))

// Delete unused presets
let usedPresetIdsFromTags: string[] = []
for (const tag of tagsConfig.tags) {
    usedPresetIdsFromTags = [
        ...usedPresetIdsFromTags,
        ...tag.presets,
        ...(tag.moreFields || []),
    ]
}

for (const pid in presetsOsmgo) {
    if (!usedPresetIdsFromTags.includes(pid)) {
        console.log(`Preset ${pid} not used => deletion`)
        delete presetsOsmgo[pid]
        continue
    }

    const preset = presetsOsmgo[pid]
    // a field with several values keeps the editor of its iD type
    if (MULTI_VALUE_FIELD_TYPES.includes(preset.iDtype ?? '')) {
        preset.type = preset.iDtype as string
    }
    if (preset.options) {
        preset.options = preset.options.filter((option) => {
            return !(
                option.v === 'undefined' ||
                (option.v === '' && option.lbl?.en === 'undefined')
            )
        })
    }
}

// for (let pid in presetsOsmgo) {
//     const preset = presetsOsmgo[pid]
//     if (['select', 'list'].includes(preset.type)) {
//         if (!preset.options || preset.options.length < 2) {
//             console.log(`Options Preset ${pid} has no options => deletion`)
//             delete presetsOsmgo[pid]
//         }
//     }
// }
fs.writeFileSync(tapPresetsPath, stringifyCatalog(presetsOsmgo))
