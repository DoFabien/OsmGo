import { writeFileSync } from 'fs'
import yargs from 'yargs'
import { defaultLanguages } from './_i18n'
import { tapPresetsPath, tapTagsPath } from './_paths'
import {
    readTapPresetsFromJson,
    readTapTagsFromJson,
    stringifyCatalog,
} from './_utils'

const args = yargs(process.argv.slice(2))
    .usage(
        `$0 [args]
        
        Adds translations for tags from the iD editor.
        This script looks up the translations in the third-party repository of the iD editor and aligns its definitions with the OsmGo i18n data.`
    )
    .help('help')
    .version(false)
    .option('overwrite', {
        alias: 'o',
        type: 'boolean',
        description: 'Overwrite tag descriptions in multiple languages',
        default: true,
    })
    .option('language', {
        type: 'array',
        choices: defaultLanguages,
        default: defaultLanguages,
        description:
            'Languages that should be looked up through the taginfo.openstreetmap.org service',
    })
    .parseSync()

// Words people search with that iD does not list
const EXTRA_TERMS: Record<string, Record<string, string[]>> = {
    'amenity/post_office': { fr: ['poste', 'la poste'] },
    'amenity/recycling_container': {
        fr: [
            'verre',
            'conteneur à verre',
            'colonne à verre',
            'bouteilles',
            'papier',
            'emballages',
        ],
    },
    'education/school': {
        fr: [
            'école',
            'école primaire',
            'école élémentaire',
            'collège',
            'lycée',
        ],
    },
}

for (const language of args.language as string[]) {
    const idTr = require(
        `@openstreetmap/id-tagging-schema/dist/translations/${language}.json`
    )[language]

    // const presetsIDPath = path.join(idRepoPath, 'data', 'presets', 'fields.json')

    const tagsOsmgoConfig = readTapTagsFromJson()
    const tagsOsmgo = tagsOsmgoConfig.tags
    const presetsOsmgo = readTapPresetsFromJson()

    if (!idTr.presets) {
        console.log('Remove language (no presets): ' + language)
        continue
    }

    const trFields = idTr.presets.fields
    const trPresets = idTr.presets.presets

    if (!trFields || !trPresets) {
        console.log('Remove language (no fields or presets) ' + language)
        continue
    }

    // console.log(trPresets);

    // TAGS
    const importTrTags = (language: string) => {
        for (const tag of tagsOsmgo) {
            // console.log(tag.iDRef);
            if (tag.iDRef) {
                if (trPresets[tag.iDRef]?.name) {
                    if (!tag.lbl[language] || args.overwrite) {
                        tag.lbl[language] = trPresets[tag.iDRef].name
                    }
                }

                if (trPresets[tag.iDRef]?.terms) {
                    if (tag.terms === undefined) {
                        tag['terms'] = {}
                    }
                    if (!tag.terms[language] || args.overwrite) {
                        tag.terms[language] = trPresets[tag.iDRef].terms
                    }
                }
            }
            const extraTerms = EXTRA_TERMS[tag.id]?.[language]
            if (extraTerms) {
                const terms = tag.terms?.[language] ?? []
                tag.terms = {
                    ...tag.terms,
                    [language]: [
                        ...new Set([
                            ...(Array.isArray(terms)
                                ? terms
                                : terms.split(',')),
                            ...extraTerms,
                        ]),
                    ],
                }
            }
        }

        writeFileSync(tapTagsPath, stringifyCatalog(tagsOsmgoConfig), 'utf8')
    }

    const importFields = (language: string) => {
        for (const k in presetsOsmgo) {
            const osmGoPreset = presetsOsmgo[k]
            //   console.log(osmGoPreset);
            if (trFields[k]) {
                if (trFields[k].label) {
                    // console.log(osmGoPreset);
                    if (
                        !osmGoPreset.lbl ||
                        !osmGoPreset.lbl[language] ||
                        args.overwrite
                    ) {
                        if (!osmGoPreset.lbl) {
                            osmGoPreset['lbl'] = {}
                        }
                        osmGoPreset.lbl[language] = trFields[k].label
                    }
                }

                if (trFields[k].options) {
                    const iDoptions = trFields[k].options

                    if (!osmGoPreset.options) {
                        osmGoPreset.options = []
                    }

                    for (const osmgoOpt of osmGoPreset.options) {
                        const optionId =
                            osmgoOpt.v === '' ? 'undefined' : osmgoOpt.v
                        if (iDoptions[optionId]) {
                            if (typeof iDoptions[optionId] === 'string') {
                                if (!osmgoOpt.lbl[language] || args.overwrite) {
                                    osmgoOpt.lbl[language] = iDoptions[optionId]
                                }
                            } else {
                                if (iDoptions[optionId].title) {
                                    if (
                                        !osmgoOpt.lbl[language] ||
                                        args.overwrite
                                    ) {
                                        osmgoOpt.lbl[language] =
                                            iDoptions[optionId].title
                                    }
                                }
                            }
                        }
                    }
                }
            }
            //
        }

        writeFileSync(tapPresetsPath, stringifyCatalog(presetsOsmgo), 'utf8')
    }

    importTrTags(language)
    importFields(language)
}
