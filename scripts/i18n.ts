/*
 * Interface translations, done with an AI model from the English catalog and
 * its context notes.
 *
 *   npm run i18n -- check                  validates every catalog
 *   npm run i18n -- todo <lang> [--all]    writes the batch to translate
 *   npm run i18n -- apply <lang> [file]    merges a translated batch
 *
 * English (src/assets/i18n/en.json) is the source. i18n/en.context.json has
 * the same keys and tells the translator where and how each text is used; it
 * is not shipped with the application.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type Catalog = { [key: string]: string | Catalog }
type FlatCatalog = Record<string, string>

const rootDirectory = path.join(__dirname, '..')
const catalogDirectory = path.join(rootDirectory, 'src', 'assets', 'i18n')
const contextPath = path.join(rootDirectory, 'i18n', 'en.context.json')
const todoDirectory = path.join(rootDirectory, 'i18n', 'todo')

const readJson = <T>(filePath: string): T =>
    JSON.parse(readFileSync(filePath, 'utf8')) as T

const catalogPath = (language: string): string =>
    path.join(catalogDirectory, `${language}.json`)

export const flatten = (catalog: Catalog, prefix = ''): FlatCatalog => {
    const flat: FlatCatalog = {}
    for (const [name, value] of Object.entries(catalog)) {
        const key = prefix ? `${prefix}.${name}` : name
        if (typeof value === 'string') flat[key] = value
        else Object.assign(flat, flatten(value, key))
    }
    return flat
}

/** Nests the keys in the order of the English catalog. */
export const unflatten = (flat: FlatCatalog, order: string[]): Catalog => {
    const catalog: Catalog = {}
    for (const key of order) {
        if (flat[key] === undefined) continue
        const names = key.split('.')
        let node = catalog
        for (const name of names.slice(0, -1)) {
            node[name] ??= {}
            node = node[name] as Catalog
        }
        node[names[names.length - 1]] = flat[key]
    }
    return catalog
}

export const placeholders = (text: string): string[] =>
    (text.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? [])
        .map((placeholder) => placeholder.replace(/[{}\s]/g, ''))
        .sort()

/** Problems of one translated text compared with its English source. */
export const textProblems = (
    english: string,
    translation: string
): string[] => {
    const problems: string[] = []
    if (translation.trim() === '') problems.push('empty translation')
    const expected = placeholders(english).join(', ')
    const actual = placeholders(translation).join(', ')
    if (expected !== actual) {
        problems.push(`placeholders {{${actual}}} instead of {{${expected}}}`)
    }
    return problems
}

const uiLanguages = (): string[] =>
    readJson<{ uiLanguages: string[] }>(
        path.join(catalogDirectory, 'i18n.json')
    ).uiLanguages

const writeCatalog = (filePath: string, catalog: Catalog): void => {
    writeFileSync(filePath, `${JSON.stringify(catalog, null, 4)}\n`, 'utf8')
}

const check = (): number => {
    const english = flatten(readJson<Catalog>(catalogPath('en')))
    const context = flatten(readJson<Catalog>(contextPath))
    const errors: string[] = []

    for (const key of Object.keys(english)) {
        if (!context[key]?.trim())
            errors.push(`en.context.json: no context for ${key}`)
    }
    for (const key of Object.keys(context)) {
        if (english[key] === undefined) {
            errors.push(`en.context.json: ${key} is not in en.json`)
        }
    }

    const coverage: string[] = []
    for (const language of uiLanguages()) {
        if (language === 'en') continue
        const translations = flatten(readJson<Catalog>(catalogPath(language)))
        for (const [key, text] of Object.entries(translations)) {
            if (english[key] === undefined) {
                errors.push(`${language}.json: ${key} is not in en.json`)
                continue
            }
            for (const problem of textProblems(english[key], text)) {
                errors.push(`${language}.json: ${key}: ${problem}`)
            }
        }
        const translated = Object.keys(english).filter(
            (key) => translations[key] !== undefined
        ).length
        coverage.push(
            `${language} ${translated}/${Object.keys(english).length}`
        )
    }

    console.log(`Coverage: ${coverage.join(', ')}`)
    for (const error of errors) console.error(error)
    if (errors.length > 0) {
        console.error(`${errors.length} translation problem(s).`)
        return 1
    }
    console.log('Translations are consistent.')
    return 0
}

const todo = (language: string, all: boolean): number => {
    if (language === 'en') throw new Error('English is the source catalog.')
    const english = flatten(readJson<Catalog>(catalogPath('en')))
    const context = flatten(readJson<Catalog>(contextPath))
    const current = existsSync(catalogPath(language))
        ? flatten(readJson<Catalog>(catalogPath(language)))
        : {}
    const french = flatten(readJson<Catalog>(catalogPath('fr')))

    const entries: Record<string, Record<string, string>> = {}
    for (const [key, text] of Object.entries(english)) {
        if (!all && current[key] !== undefined) continue
        entries[key] = {
            en: text,
            context: context[key] ?? '',
            ...(language !== 'fr' && french[key] ? { fr: french[key] } : {}),
            ...(current[key] !== undefined ? { current: current[key] } : {}),
            translation: '',
        }
    }

    mkdirSync(todoDirectory, { recursive: true })
    const todoPath = path.join(todoDirectory, `${language}.json`)
    writeFileSync(
        todoPath,
        `${JSON.stringify({ language, entries }, null, 4)}\n`,
        'utf8'
    )
    console.log(
        `${Object.keys(entries).length} text(s) to translate into "${language}": ${path.relative(rootDirectory, todoPath)}`
    )
    console.log(
        'Fill every "translation" field, then run: npm run i18n -- apply ' +
            language
    )
    return 0
}

const apply = (language: string, file?: string): number => {
    const english = flatten(readJson<Catalog>(catalogPath('en')))
    const todoPath = file
        ? path.resolve(file)
        : path.join(todoDirectory, `${language}.json`)
    const batch = readJson<{
        entries: Record<string, { translation?: string }>
    }>(todoPath)
    const current = existsSync(catalogPath(language))
        ? flatten(readJson<Catalog>(catalogPath(language)))
        : {}

    const errors: string[] = []
    let applied = 0
    for (const [key, entry] of Object.entries(batch.entries)) {
        const translation = entry.translation ?? ''
        if (english[key] === undefined) {
            errors.push(`${key} is not in en.json`)
            continue
        }
        if (translation === '') continue
        const problems = textProblems(english[key], translation)
        if (problems.length > 0) {
            errors.push(`${key}: ${problems.join('; ')}`)
            continue
        }
        current[key] = translation
        applied++
    }

    writeCatalog(
        catalogPath(language),
        unflatten(current, Object.keys(english))
    )
    console.log(
        `${applied} translation(s) written to src/assets/i18n/${language}.json`
    )
    for (const error of errors) console.error(`Not applied: ${error}`)
    return errors.length > 0 ? 1 : 0
}

if (require.main === module) {
    const [command, language, ...rest] = process.argv.slice(2)
    const usage =
        'Usage: npm run i18n -- check | todo <lang> [--all] | apply <lang> [file]'
    let status = 1
    if (command === 'check') status = check()
    else if (command === 'todo' && language)
        status = todo(language, rest.includes('--all'))
    else if (command === 'apply' && language) status = apply(language, rest[0])
    else console.error(usage)
    process.exit(status)
}
