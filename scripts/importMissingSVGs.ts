import fs from 'fs'
import path from 'path'
import { fetchResponse } from './_fetch'
import { iconsSvgDir } from './_paths'
import { readTapTagsFromJson } from './_utils'

const tagConfig = readTapTagsFromJson()
const tagsOsmgo = tagConfig.tags

const idFaSvgUrl: string = `https://raw.githubusercontent.com/openstreetmap/iD/develop/svg/fontawesome`
const temakiSvgUrl: string = `https://raw.githubusercontent.com/ideditor/temaki/main/icons`
const roentgenSvgUrl: string = `https://raw.githubusercontent.com/facebook/Rapid/main/svg/roentgen`
// icônes Roentgen récentes, pas encore reprises par Rapid
const roentgenUpstreamSvgUrl: string = `https://raw.githubusercontent.com/enzet/Roentgen/main/icons`
const makiSvgUrl: string = `https://raw.githubusercontent.com/mapbox/maki/main/icons`
const pinheadSvgUrl: string = `https://cdn.jsdelivr.net/npm/@waysidemapping/pinhead/dist/icons`

const roentgenIconAliases: Record<string, string> = {
    vending_flower: 'flower_in_pot',
    vending_pack: 'vending_machine',
}

const pinheadIconAliases: Record<string, string> = {
    person_running_after_person: 'people_running',
}

// https://raw.githubusercontent.com/ideditor/temaki/main/icons/mast.svg

const download = async ({ url, path }: { url: string; path: string }) => {
    const response = await fetchResponse(url)
    const content = Buffer.from(await response.arrayBuffer())
    fs.writeFileSync(path, content)
}

const run = async () => {
    console.info('Import of missing SVGs')
    for (const t of tagsOsmgo) {
        const pathCurrentSVG = path.join(iconsSvgDir, `${t.icon}.svg`)
        if (t.icon && !fs.existsSync(pathCurrentSVG)) {
            console.log(`${t.icon}.svg`)
            if (/^fa/.test(t.icon)) {
                // => font awsome
                const iconIDUrl = `${idFaSvgUrl}/${t.icon}.svg`
                try {
                    await download({
                        url: iconIDUrl,
                        path: pathCurrentSVG,
                    })
                } catch (err) {
                    console.error(err)
                }
            } else if (/^temaki/.test(t.icon)) {
                // => temaki
                const iconTemakiUrl = `${temakiSvgUrl}/${
                    t.icon.split('temaki-')[1]
                }.svg`
                try {
                    await download({
                        url: iconTemakiUrl,
                        path: pathCurrentSVG,
                    })
                } catch (err) {
                    console.error(err)
                }
            } else if (/^roentgen/.test(t.icon)) {
                // => roentgen
                const iconName = t.icon.split('roentgen-')[1]
                const sourceIconName = roentgenIconAliases[iconName] ?? iconName
                const iconRoentgenUrl = `${roentgenSvgUrl}/${sourceIconName}.svg`
                try {
                    await download({
                        url: iconRoentgenUrl,
                        path: pathCurrentSVG,
                    })
                } catch {
                    try {
                        await download({
                            url: `${roentgenUpstreamSvgUrl}/${sourceIconName}.svg`,
                            path: pathCurrentSVG,
                        })
                    } catch (err) {
                        console.error(err)
                    }
                }
            } else if (/^pinhead/.test(t.icon)) {
                // => pinhead
                const iconName = t.icon.split('pinhead-')[1]
                const sourceIconName = pinheadIconAliases[iconName] ?? iconName
                const iconPinheadUrl = `${pinheadSvgUrl}/${sourceIconName}.svg`
                try {
                    await download({
                        url: iconPinheadUrl,
                        path: pathCurrentSVG,
                    })
                } catch (err) {
                    console.error(err)
                }
            } else if (/^maki/.test(t.icon)) {
                // => maki
                const iconMakiUrl = `${makiSvgUrl}/${
                    t.icon.split('maki-')[1]
                }.svg`
                try {
                    await download({
                        url: iconMakiUrl,
                        path: pathCurrentSVG,
                    })
                } catch (err) {
                    console.error(err)
                }
            }
        }
    }
}

run()
