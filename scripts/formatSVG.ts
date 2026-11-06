// redimensionne et harmonise les path des SVG à 15px (min) et
import fs from 'fs'
import path from 'path'
import { iconsSvgDir } from './_paths'
import { formatSvg, pathsOutsideFrame } from './svgFormat'

console.info('Format SVGs')

const blackList: string[] = [
    'none.svg',
    'Delete.svg',
    'Create.svg',
    'Update.svg',
    'arrow-position.svg',
    'Old.svg',
    'Fixme.svg',
    'maki-circle-custom.svg',
    'location-without-orientation.svg',
    'location-with-orientation.svg',
]

const listOfSvgsName: string[] = fs
    .readdirSync(iconsSvgDir)
    .filter((svgName) => blackList.indexOf(svgName) == -1)
    .filter((svgName) => path.extname(svgName) == '.svg')

const outsideFrame: string[] = []

for (let i = 0; i < listOfSvgsName.length; i++) {
    const pathSvg = path.join(iconsSvgDir, listOfSvgsName[i])
    const svgStr = fs.readFileSync(pathSvg, 'utf8')

    const optimisedSVG = formatSvg(svgStr)
    if (pathsOutsideFrame(optimisedSVG).length) {
        outsideFrame.push(listOfSvgsName[i])
    }
    fs.writeFileSync(pathSvg, optimisedSVG, 'utf8')
}

if (outsideFrame.length) {
    // le décalage d'origine est perdu une fois formaté : il faut supprimer
    // ces fichiers et relancer `npm run sprites` pour les retélécharger
    console.error(
        `SVG dessinés hors de leur cadre (icône vide) :\n${outsideFrame.join('\n')}`
    )
    process.exitCode = 1
}
