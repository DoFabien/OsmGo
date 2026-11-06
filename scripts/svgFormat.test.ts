import assert from 'assert'
import { formatSvg, pathBounds, pathsOutsideFrame } from './svgFormat'

// roentgen-needleleaved_tree tel que publié par Rapid : le dessin est autour
// de (72, 216) et recentré par un `transform` sur le path
const roentgenTree = `<?xml version="1.0" encoding="utf-8" ?>
<svg baseProfile="full" height="16" version="1.1" width="16" xmlns="http://www.w3.org/2000/svg"><defs /><path d="m 72,211 c -0.5,1.25 -1.75,2.25 -3,3 h 2 c -0.5,1.25 -1.75,2.25 -3,3 h 2 c -0.5,1.25 -1.75,2.25 -3,3 h 4 v 3 h 2 v -3 h 4 c -1.25,-0.75 -2.5,-1.75 -3,-3 h 2 c -1.25,-0.75 -2.5,-1.75 -3,-3 h 2 c -1.25,-0.75 -2.5,-1.75 -3,-3 z" fill="#000" transform="translate(8.0,8.0) translate(-72.0,-216.0)" /></svg>`

const offsetViewBox = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 200 30 30"><path d="M100 200h30v30h-30z"/></svg>`

const groupTransform = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"><g transform="translate(-50 -50)"><path d="M50 50h15v15h-15z"/></g></svg>`

const assertInFrame = (name: string, svg: string) => {
    assert.deepStrictEqual(
        pathsOutsideFrame(svg),
        [],
        `${name}: le path sort du cadre`
    )
}

const run = () => {
    const tree = formatSvg(roentgenTree)
    assertInFrame('roentgen tree', tree)
    assert.match(tree, /width="15px"/)

    const square = formatSvg(offsetViewBox)
    assertInFrame('viewBox décalé', square)
    const squareD = square.match(/ d="([^"]+)"/)[1]
    assert.deepStrictEqual(pathBounds(squareD), {
        minX: 0,
        minY: 0,
        maxX: 15,
        maxY: 15,
    })

    assertInFrame('transform de groupe', formatSvg(groupTransform))

    // garde-fou : l'ancien résultat cassé est bien détecté
    assert.strictEqual(
        pathsOutsideFrame(
            `<svg width="15px" height="15px"><path d="M67.5 197.8h1.9v2.8z"/></svg>`
        ).length,
        1
    )

    console.info('svgFormat tests passed')
}

run()
