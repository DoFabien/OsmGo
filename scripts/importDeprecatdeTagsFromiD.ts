import { isDeepStrictEqual } from 'node:util'
import fs from 'fs'
import { tapTagsPath } from './_paths'
import { readTapTagsFromJson, stringifyCatalog } from './_utils'

const tagsOsmgo = readTapTagsFromJson()
const deprecatedID = require('@openstreetmap/id-tagging-schema/dist/deprecated.json')

// iD is the only source: a category that iD no longer deprecates is valid again
for (const tag of tagsOsmgo.tags) {
    delete tag.deprecated
    delete tag['replace']
}

for (const depiD of deprecatedID) {
    const depOsmgo = tagsOsmgo.tags.find((t) => {
        return isDeepStrictEqual(depiD.old, t.tags)
    })
    if (depOsmgo) {
        console.log(depOsmgo.id)
        depOsmgo['deprecated'] = true
        if (depiD.replace) {
            depOsmgo['replace'] = depiD.replace
        }
    }
}

fs.writeFileSync(tapTagsPath, stringifyCatalog(tagsOsmgo), 'utf8')
