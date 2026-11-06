// redimensionne et harmonise les path d'un SVG à 15px (côté le plus grand)
import parse from 'parse-svg-path'
import scale from 'scale-svg-path'
import serialize from 'serialize-svg-path'
import { optimize } from 'svgo'

// import * as cheerio from 'cheerio'
const cheerio = require('cheerio') // TODO @dotcs: typings are wrong

type Segment = [string, ...number[]]

export interface Bounds {
    minX: number
    minY: number
    maxX: number
    maxY: number
}

/**
 * Tolérance (en px) : les points de contrôle des courbes débordent souvent
 * de 1 à 2 px sans que le dessin sorte du cadre.
 */
const frameTolerance = 4

function mergeSVGPaths(svgString: string): string {
    const result = optimize(svgString, {
        plugins: [
            {
                name: 'mergePaths',
                params: {
                    force: true,
                },
            },
        ],
    })

    return result.data
}

/**
 * Applique les `transform` (ceux des path, et ceux des groupes quand svgo
 * peut les descendre) directement dans les données des path.
 * Les icônes Roentgen dessinent par exemple autour de (72, 216) et se
 * recentrent avec `transform="translate(8,8) translate(-72,-216)"`.
 */
function applyTransforms(svgString: string): string {
    if (!/\stransform=/.test(svgString)) return svgString
    return optimize(svgString, {
        plugins: [
            'moveGroupAttrsToElems',
            {
                name: 'convertPathData',
                params: {
                    applyTransforms: true,
                    applyTransformsStroked: true,
                    floatPrecision: 5,
                },
            },
        ],
    }).data
}

function translate(segments: Segment[], dx: number, dy: number): Segment[] {
    return segments.map((segment, index) => {
        const command = segment[0]
        // un premier `m` relatif est en réalité absolu
        const isAbsolute =
            command === command.toUpperCase() ||
            (index === 0 && command === 'm')
        if (!isAbsolute || (dx === 0 && dy === 0)) return segment

        const name = command.toLowerCase()
        const out = [...segment] as Segment
        if (name === 'h') {
            out[1] = (out[1] as number) + dx
        } else if (name === 'v') {
            out[1] = (out[1] as number) + dy
        } else if (name === 'a') {
            out[6] = (out[6] as number) + dx
            out[7] = (out[7] as number) + dy
        } else {
            for (let i = 1; i < out.length; i++) {
                out[i] = (out[i] as number) + (i % 2 ? dx : dy)
            }
        }
        return out
    })
}

/**
 * Boîte englobante approximative d'un path : points d'extrémité et points
 * de contrôle (les courbes restent dans leur enveloppe convexe).
 */
export function pathBounds(d: string): Bounds | undefined {
    const segments: Segment[] = parse(d)
    const xs: number[] = []
    const ys: number[] = []
    let x = 0
    let y = 0
    let startX = 0
    let startY = 0

    const add = (px: number, py: number) => {
        xs.push(px)
        ys.push(py)
    }

    for (const segment of segments) {
        const command = segment[0]
        const name = command.toLowerCase()
        const relative = command !== command.toUpperCase()
        const args = segment.slice(1) as number[]
        const ox = relative ? x : 0
        const oy = relative ? y : 0

        if (name === 'z') {
            x = startX
            y = startY
            continue
        }
        if (name === 'h') {
            x = ox + args[0]
        } else if (name === 'v') {
            y = oy + args[0]
        } else if (name === 'a') {
            x = ox + args[5]
            y = oy + args[6]
        } else {
            for (let i = 0; i < args.length; i += 2) {
                add(ox + args[i], oy + args[i + 1])
            }
            x = ox + args[args.length - 2]
            y = oy + args[args.length - 1]
        }
        add(x, y)
        if (name === 'm') {
            startX = x
            startY = y
        }
    }

    if (!xs.length) return undefined
    return {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
    }
}

/** Retourne les `d` des path qui sortent du cadre `width` × `height`. */
export function pathsOutsideFrame(svgString: string): string[] {
    const _$ = cheerio.load(svgString, { xmlMode: true })
    const svg = _$('svg')
    const width = Number.parseFloat(svg.attr('width'))
    const height = Number.parseFloat(svg.attr('height'))
    const outside: string[] = []

    _$('path').each((_, element) => {
        const d = element.attribs['d']
        const bounds = d ? pathBounds(d) : undefined
        if (
            bounds &&
            (bounds.minX < -frameTolerance ||
                bounds.minY < -frameTolerance ||
                bounds.maxX > width + frameTolerance ||
                bounds.maxY > height + frameTolerance)
        ) {
            outside.push(d)
        }
    })
    return outside
}

export function formatSvg(svgStr: string): string {
    const _$ = cheerio.load(applyTransforms(svgStr))

    const viewBox = _$('svg').attr('viewBox')
    let viewBoxSize: number[]
    if (!viewBox) {
        const svgW = Number(
            _$('svg')
                .attr('width')
                .match(/[\d,.]+/gi)
        )
        const svgH = Number(
            _$('svg')
                .attr('height')
                .match(/[\d,.]+/gi)
        )
        viewBoxSize = [0, 0, svgW, svgH]
    } else {
        viewBoxSize = viewBox
            .trim()
            .split(/[\s,]+/)
            .map(Number)
    }
    const [vBMinX, vBMinY, vBWidth, vBHeight] = viewBoxSize

    const dimMax = vBHeight < vBWidth ? vBWidth : vBHeight
    const factorMax = 15 / dimMax

    const maxSide = vBHeight < vBWidth ? 'w' : 'h'

    const ratioMax = maxSide == 'h' ? vBWidth / vBHeight : vBHeight / vBWidth
    // le coté le plus grand sera de 15px

    const outHMax = maxSide == 'h' ? 15 : 15 * ratioMax
    const outWMax = maxSide == 'w' ? 15 : 15 * ratioMax

    const _path = _$('path')
    const newPaths = []

    for (let i = 0; i < _path.length; i++) {
        const _pathD = _path[i].attribs['d']
        const path = translate(parse(_pathD), -vBMinX, -vBMinY)
        const x = scale(path, factorMax)

        const newPath = `<path d="${serialize(x)}" fill="#FFFFFF"/>`
        newPaths.push(newPath)
    }

    const newSvg = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="${outWMax}px" height="${outHMax}px" viewBox="0 0 ${outWMax} ${outHMax}" style="enable-background:new 0 0 15 15;" space="preserve">
    ${newPaths.join(' ')}
    </svg>`

    return mergeSVGPaths(newSvg)
}
