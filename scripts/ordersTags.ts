// ORDER TAGS BY PRIMARYKEYS ( order than "primaryKeys": ["advertising","shop","healthcare" etc ]
// It's define the priority of tags detection

import fs from 'fs'
import { tapTagsPath } from './_paths'
import { readTapTagsFromJson, stringifyCatalog } from './_utils'

const tagConfig = readTapTagsFromJson()
const tagsOsmgo = tagConfig.tags

// A primary key that no category uses (`seamark`, `piste`, `building_part` are
// not real OSM keys) can never match an object: drop it.
const usedKeys = new Set(tagsOsmgo.flatMap((tag) => Object.keys(tag.tags)))
const primaryKeys = tagConfig.primaryKeys.filter((key) => {
    if (usedKeys.has(key)) return true
    console.log(`Unused primary key => deletion : ${key}`)
    return false
})
tagConfig.primaryKeys = primaryKeys

// ORDER BY primaryKeys FIRST, on the key of the ID, else on the tags
const getRank = (tag: (typeof tagsOsmgo)[number]): number => {
    const idRank = primaryKeys.indexOf(tag.id.split('/')[0])
    if (idRank !== -1) {
        return idRank
    }
    const tagRanks = Object.keys(tag.tags)
        .map((key) => primaryKeys.indexOf(key))
        .filter((rank) => rank !== -1)
    return tagRanks.length > 0 ? Math.min(...tagRanks) : primaryKeys.length
}

tagConfig.tags = tagsOsmgo
    .map((tag) => ({ tag, rank: getRank(tag) }))
    .sort((left, right) => left.rank - right.rank)
    .map(({ tag }) => tag)

fs.writeFileSync(tapTagsPath, stringifyCatalog(tagConfig), 'utf8')
