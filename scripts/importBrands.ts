import fs from 'fs-extra'
import { tapBrandPresetsPath, tapPresetsPath, tapTagsPath } from './_paths'
import {
    readTapPresetsFromJson,
    readTapTagsFromJson,
    stringifyCatalog,
} from './_utils'
import { type BrandOption, getBrandOptions } from './nameSuggestionIndex'

const tagsConfig = readTapTagsFromJson()
const tags = tagsConfig.tags
const presets = readTapPresetsFromJson()
const brandPresets: Record<string, unknown> = {}

const addBrandPreset = (
    presets: any,
    id: string,
    options: Array<BrandOption>
): void => {
    const compactOptions = options.map(
        ({ v, lbl, countryCodes, excludeCountryCodes, tags, addTags }) => {
            return {
                v,
                lbl,
                ...(countryCodes ? { countryCodes } : {}),
                ...(excludeCountryCodes ? { excludeCountryCodes } : {}),
                tags,
                addTags,
            }
        }
    )

    presets[id] = {
        key: 'brand',
        type: 'list',
        lbl: { en: 'Brand', fr: 'Enseigne' },
        options: compactOptions,
    }
}

const run = () => {
    const brandsData = getBrandOptions()

    for (const presetId of Object.keys(presets)) {
        if (presetId.endsWith('#brand')) {
            delete presets[presetId]
        }
    }

    for (const tagConfig of tags) {
        tagConfig.presets = tagConfig.presets.filter(
            (presetId) => !presetId.endsWith('#brand')
        )
    }

    for (const tagConfig of tags) {
        // The brands hang on an iD preset: a category with several tags
        // (`amenity=fast_food` + `cuisine=burger`) is found by its iD reference
        const tagKeys = Object.keys(tagConfig.tags)
        const singleTag =
            tagKeys.length === 1 && tagConfig.tags[tagKeys[0]]
                ? `${tagKeys[0]}/${tagConfig.tags[tagKeys[0]]}`
                : undefined
        const brandPath = [singleTag, tagConfig.iDRef, tagConfig.id].find(
            (path) => path && brandsData[path]
        )
        if (brandPath) {
            const id = `${brandPath.replaceAll('/', '#')}#brand`
            addBrandPreset(brandPresets, id, brandsData[brandPath])

            tagConfig.presets = [id, ...tagConfig.presets]
        }
    }

    fs.writeFileSync(tapPresetsPath, stringifyCatalog(presets), 'utf8')
    fs.writeFileSync(
        tapBrandPresetsPath,
        stringifyCatalog(brandPresets),
        'utf8'
    )
    fs.writeFileSync(tapTagsPath, stringifyCatalog(tagsConfig), 'utf8')
}
run()
