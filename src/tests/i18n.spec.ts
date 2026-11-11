import { globSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { TestBed } from '@angular/core/testing'
import {
    TranslateModule,
    TranslateService,
    type TranslationObject,
} from '@ngx-translate/core'
import { firstValueFrom } from 'rxjs'

type Translations = TranslationObject

const translationsDirectory = path.join(process.cwd(), 'src', 'assets', 'i18n')

function readTranslations(language: string): Translations {
    return JSON.parse(
        readFileSync(
            path.join(translationsDirectory, `${language}.json`),
            'utf8'
        )
    )
}

function listTranslationKeys(
    translations: Translations,
    prefix = ''
): string[] {
    const keys: string[] = []

    for (const [name, value] of Object.entries(translations)) {
        const key = prefix ? `${prefix}.${name}` : name
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            keys.push(...listTranslationKeys(value as Translations, key))
        } else {
            keys.push(key)
        }
    }

    return keys
}

describe('interface translations', () => {
    const english = readTranslations('en')
    const englishKeys = new Set(listTranslationKeys(english))

    describe('interface language list', () => {
        const uiLanguages = (
            JSON.parse(
                readFileSync(
                    path.join(translationsDirectory, 'i18n.json'),
                    'utf8'
                )
            ) as { uiLanguages: string[] }
        ).uiLanguages

        // Languages below this share of the English keys would show mostly
        // English text: they are kept out of the list, not deleted.
        const MIN_COVERAGE = 0.1
        const coverage = (language: string): number => {
            const keys = listTranslationKeys(readTranslations(language))
            return (
                keys.filter((key) => englishKeys.has(key)).length /
                englishKeys.size
            )
        }

        it('always offers English and French', () => {
            expect(uiLanguages).toEqual(expect.arrayContaining(['en', 'fr']))
        })

        it('only offers languages whose catalog is meaningfully translated', () => {
            const tooEmpty = uiLanguages.filter(
                (language) => coverage(language) < MIN_COVERAGE
            )

            expect(tooEmpty).toEqual([])
        })

        it('keeps the nearly empty catalogs out of the list', () => {
            for (const language of ['es', 'ko']) {
                expect(coverage(language)).toBeLessThan(MIN_COVERAGE)
                expect(uiLanguages).not.toContain(language)
            }
        })

        it('has a catalog for every offered language', () => {
            const files = readdirSync(translationsDirectory)

            expect(
                uiLanguages.filter(
                    (language) => !files.includes(`${language}.json`)
                )
            ).toEqual([])
        })
    })

    it('gives every English text a context note for the translators', () => {
        const context = JSON.parse(
            readFileSync(
                path.join(process.cwd(), 'i18n', 'en.context.json'),
                'utf8'
            )
        ) as Translations
        const contextKeys = new Set(listTranslationKeys(context))

        expect([...englishKeys].filter((key) => !contextKeys.has(key))).toEqual(
            []
        )
        expect([...contextKeys].filter((key) => !englishKeys.has(key))).toEqual(
            []
        )
    })

    it('keeps the English placeholders in every translation', () => {
        const flat = (translations: Translations, prefix = '') =>
            listTranslationKeys(translations, prefix).map((key) => [
                key,
                String(
                    key
                        .split('.')
                        .reduce<unknown>(
                            (node, name) =>
                                (node as Record<string, unknown>)[name],
                            translations
                        )
                ),
            ])
        const placeholders = (text: string) =>
            (text.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? [])
                .map((placeholder) => placeholder.replace(/[{}\s]/g, ''))
                .sort()
                .join(',')
        const englishTexts = Object.fromEntries(flat(english))
        const mismatches: string[] = []

        for (const fileName of readdirSync(translationsDirectory)) {
            if (!fileName.endsWith('.json') || fileName === 'i18n.json') {
                continue
            }
            const language = fileName.replace('.json', '')
            for (const [key, text] of flat(readTranslations(language))) {
                if (
                    englishTexts[key] !== undefined &&
                    placeholders(text) !== placeholders(englishTexts[key])
                ) {
                    mismatches.push(`${language}: ${key}`)
                }
            }
        }

        expect(mismatches).toEqual([])
    })

    it('translates the label of the deprecated tag fix button', () => {
        const alert = (code: string) =>
            readTranslations(code)['ALERT'] as Record<string, string>

        expect(alert('fr')['FIX']).toBe('Corriger')
        expect(alert('en')['FIX']).toBe('Fix')
    })

    it('keeps the known French typos out of the catalog', () => {
        const text = JSON.stringify(readTranslations('fr'))

        for (const typo of [
            'check:date',
            'Cacher les surface ',
            'à été',
            'du marker',
        ]) {
            expect(text).not.toContain(typo)
        }
    })

    it('keeps French interface keys aligned with English', () => {
        const frenchKeys = new Set(listTranslationKeys(readTranslations('fr')))

        expect([...englishKeys].filter((key) => !frenchKeys.has(key))).toEqual(
            []
        )
        expect([...frenchKeys].filter((key) => !englishKeys.has(key))).toEqual(
            []
        )
    })

    it('provides an English fallback for every translated key', () => {
        const translationFiles = readdirSync(translationsDirectory).filter(
            (fileName) => fileName.endsWith('.json') && fileName !== 'i18n.json'
        )
        const missingKeys: string[] = []

        for (const fileName of translationFiles) {
            const language = fileName.replace('.json', '')
            for (const key of listTranslationKeys(readTranslations(language))) {
                if (!englishKeys.has(key)) {
                    missingKeys.push(`${fileName}: ${key}`)
                }
            }
        }

        expect(missingKeys).toEqual([])
    })

    it('provides English text for every static interface key', () => {
        const knownSections = new Set(Object.keys(english))
        const sourceFiles = [
            ...globSync('src/app/**/*.ts'),
            ...globSync('src/app/**/*.html'),
        ].filter((fileName) => !fileName.endsWith('.spec.ts'))
        const missingKeys = new Set<string>()
        const translationKeyPattern = /[A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)+/g

        for (const fileName of sourceFiles) {
            const source = readFileSync(fileName, 'utf8')
            for (const match of source.matchAll(translationKeyPattern)) {
                const key = match[0]
                const section = key.split('.')[0]
                if (knownSections.has(section) && !englishKeys.has(key)) {
                    missingKeys.add(key)
                }
            }
        }

        expect([...missingKeys].sort()).toEqual([])
    })

    it('uses English instead of exposing a raw key', async () => {
        TestBed.configureTestingModule({
            imports: [TranslateModule.forRoot({ fallbackLang: 'en' })],
        })
        const translate = TestBed.inject(TranslateService)
        const key = 'MANAGE_TAGS.REMOVE_ALL_HIDDEN_TAGS'

        // a catalog that does not have the text yet
        const german = structuredClone(readTranslations('de'))
        delete (german.MANAGE_TAGS as Record<string, unknown>)
            .REMOVE_ALL_HIDDEN_TAGS

        translate.setTranslation('en', english)
        translate.setTranslation('de', german)
        await firstValueFrom(translate.use('de'))

        expect(translate.instant(key)).toBe('Remove all')
        expect(translate.instant(key)).not.toBe(key)
    })
})
