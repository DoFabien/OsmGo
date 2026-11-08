import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

type Scheme = 'light' | 'dark'

// Loaded at run time so the test bundle does not embed the Sass compiler.
const sass = createRequire(path.join(process.cwd(), 'package.json'))(
    'sass'
) as typeof import('sass')

const compileTheme = (file: string): string =>
    sass.compile(path.join(process.cwd(), 'src', 'theme', file), {
        loadPaths: [path.join(process.cwd(), 'node_modules')],
    }).css

const supportsBlock =
    /@supports\s*\(color:\s*light-dark\(white, black\)\)\s*\{/g

// Splits the compiled CSS into what every browser reads and what only the
// browsers supporting light-dark() read.
const splitSupports = (css: string): { base: string; modern: string } => {
    let base = ''
    let modern = ''
    let cursor = 0
    for (const match of css.matchAll(supportsBlock)) {
        const open = (match.index ?? 0) + match[0].length
        let depth = 1
        let index = open
        while (depth > 0 && index < css.length) {
            if (css[index] === '{') depth++
            if (css[index] === '}') depth--
            index++
        }
        base += css.slice(cursor, match.index)
        modern += css.slice(open, index - 1)
        cursor = index
    }
    base += css.slice(cursor)
    return { base, modern }
}

const variables = splitSupports(compileTheme('variables.scss'))
const material = splitSupports(compileTheme('material.scss'))

const hex = '#[0-9a-fA-F]{6}'

const token = (name: string, scheme: Scheme = 'light'): string => {
    const light = new RegExp(`${name}:\\s*(${hex})\\s*;`).exec(variables.base)
    if (!light) throw new Error(`Missing light color token ${name}.`)
    if (scheme === 'light') return light[1]
    const pair = new RegExp(
        `${name}:\\s*light-dark\\(\\s*(${hex}),\\s*(${hex})\\s*\\)\\s*;`
    ).exec(variables.modern)
    if (pair && pair[1] !== light[1]) {
        throw new Error(`${name} has two different light values.`)
    }
    return pair ? pair[2] : light[1]
}

const luminance = (hex: string): number => {
    const [red, green, blue] = [1, 3, 5].map((start) => {
        const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255
        return channel <= 0.03928
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

const contrast = (first: string, second: string): number => {
    const [lighter, darker] = [luminance(first), luminance(second)].sort(
        (a, b) => b - a
    )
    return (lighter + 0.05) / (darker + 0.05)
}

const textPairs: [string, string][] = [
    ['--osmgo-ink-strong', '--osmgo-surface'],
    ['--osmgo-ink-strong', '--osmgo-surface-muted'],
    ['--osmgo-ink-strong', '--osmgo-map-surface'],
    ['--osmgo-ink-strong', '--osmgo-blue-container'],
    ['--osmgo-ink-strong', '--osmgo-amber-container'],
    ['--osmgo-ink-muted', '--osmgo-surface'],
    ['--osmgo-ink-muted', '--osmgo-surface-muted'],
    ['--osmgo-ink-muted', '--osmgo-blue-container'],
    ['--osmgo-ink-muted', '--osmgo-amber-container'],
    ['--osmgo-blue', '--osmgo-surface'],
    ['--osmgo-blue', '--osmgo-surface-muted'],
    ['--osmgo-blue', '--osmgo-blue-container'],
    ['--osmgo-blue-dark', '--osmgo-blue-container'],
    ['--osmgo-map-blue', '--osmgo-surface'],
    ['--osmgo-map-blue', '--osmgo-surface-muted'],
    ['--osmgo-map-blue', '--osmgo-blue-container'],
    ['--osmgo-amber-ink', '--osmgo-amber-container'],
    ['--osmgo-amber-ink', '--osmgo-surface'],
    ['--osmgo-error', '--osmgo-surface'],
    ['--osmgo-error', '--osmgo-surface-muted'],
    ['--osmgo-error', '--osmgo-error-container'],
    ['--osmgo-error', '--osmgo-error-surface'],
    ['--osmgo-on-error-container', '--osmgo-error-container'],
    ['--osmgo-on-error-container', '--osmgo-error-surface'],
    ['--osmgo-success', '--osmgo-surface'],
    ['--osmgo-success', '--osmgo-success-container'],
    ['--osmgo-on-blue', '--osmgo-blue'],
    ['--osmgo-on-header', '--osmgo-header-surface'],
    ['--osmgo-on-error', '--osmgo-error'],
    ['--osmgo-on-success', '--osmgo-success'],
    ['--osmgo-on-amber', '--osmgo-amber'],
]

describe('theme tokens', () => {
    it('gives browsers without light-dark() a complete light theme', () => {
        for (const { base } of [variables, material]) {
            expect(base).not.toContain('light-dark(')
        }
        expect(variables.base).toMatch(/color-scheme:\s*light\s*;/)
        expect(variables.base).not.toMatch(/color-scheme:\s*light dark/)
        expect(material.base).toMatch(/--mat-sys-surface:\s*#[0-9a-f]{6}\s*;/)

        const declared = (css: string) =>
            new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]))
        const fallback = declared(variables.base + material.base)
        for (const name of declared(variables.modern + material.modern)) {
            expect(fallback, name).toContain(name)
        }
    })

    it('keeps component styles free of colour functions old WebViews lack', () => {
        const sources = readdirSync(path.join(process.cwd(), 'src'), {
            recursive: true,
            encoding: 'utf8',
        }).filter(
            (file) =>
                /\.s?css$/.test(file) &&
                !file.startsWith(path.join('theme', 'variables')) &&
                !file.startsWith(path.join('theme', 'material.scss'))
        )

        expect(sources.length).toBeGreaterThan(20)
        for (const file of sources) {
            const css = readFileSync(
                path.join(process.cwd(), 'src', file),
                'utf8'
            )
            expect(css, file).not.toMatch(/light-dark\(|color-mix\(/)
        }
    })

    it('follows the system colour scheme where light-dark() works', () => {
        expect(variables.modern).toMatch(/color-scheme:\s*light dark\s*;/)
        expect(variables.modern).toContain('light-dark(')
        expect(material.modern).toMatch(
            /--mat-sys-surface:\s*light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)/
        )
    })

    for (const scheme of ['light', 'dark'] as const) {
        describe(`in ${scheme} mode`, () => {
            it('draws field borders with at least 3:1 contrast on the surfaces', () => {
                const outline = token('--osmgo-outline', scheme)

                expect(
                    contrast(outline, token('--osmgo-surface', scheme))
                ).toBeGreaterThanOrEqual(3)
                expect(
                    contrast(outline, token('--osmgo-surface-muted', scheme))
                ).toBeGreaterThanOrEqual(3)
                expect(
                    contrast(
                        token('--osmgo-blue', scheme),
                        token('--osmgo-surface', scheme)
                    )
                ).toBeGreaterThanOrEqual(3)
            })

            it('keeps the soft outline for decoration only', () => {
                expect(
                    contrast(
                        token('--osmgo-outline-soft', scheme),
                        token('--osmgo-surface', scheme)
                    )
                ).toBeLessThan(3)
            })

            for (const [foreground, background] of textPairs) {
                it(`keeps ${foreground} readable on ${background}`, () => {
                    expect(
                        contrast(
                            token(foreground, scheme),
                            token(background, scheme)
                        )
                    ).toBeGreaterThanOrEqual(4.5)
                })
            }
        })
    }

    it('maps the Material outline to the field border token', () => {
        expect(variables.base).toMatch(
            /--mat-sys-outline:\s*var\(--osmgo-outline\)\s*;/
        )
        expect(variables.base).not.toMatch(
            /--mat-sys-outline:\s*var\(--osmgo-outline-soft\)/
        )
    })

    it('puts white screen header content on a blue with enough contrast', () => {
        expect(token('--osmgo-on-header')).toBe('#ffffff')
        expect(
            contrast('#ffffff', token('--osmgo-header-surface', 'dark'))
        ).toBeGreaterThanOrEqual(4.5)
        expect(
            contrast('#ffffff', token('--osmgo-header-surface'))
        ).toBeGreaterThanOrEqual(4.5)
    })

    it('keeps white marker glyphs readable on the fallback icon fills', () => {
        for (const fill of ['--osmgo-icon-fill', '--osmgo-marker-fallback']) {
            expect(contrast('#ffffff', token(fill))).toBeGreaterThanOrEqual(4.5)
        }
    })
})
