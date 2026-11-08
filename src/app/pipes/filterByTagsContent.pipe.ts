import { Pipe, type PipeTransform } from '@angular/core'
import type { TagConfig } from '@osmgo/type'
import { normalizeSearchText } from '@osmgo/utils'

const EXACT = 100
// "Boîte aux lettres (envoi)" for "boîte aux lettres"
const EXACT_WITHOUT_QUALIFIER = 95
const PREFIX = 80
const WORD = 60
const WORD_PREFIX = 40
const SUBSTRING = 20

// A tag value weighs less than a label, a search term even less, unless the
// term is the search text itself: a name ("borne de recharge" for a charging
// station) ranks above a label that starts with it, a word ("poste") as high.
const ENGLISH_LABEL = 0.9
const TAG_VALUE = 0.8
const TERM = 0.5
const EXACT_TERM_NAME = 0.9
const EXACT_TERM_WORD = 0.8

const normalizedTexts = new Map<string, string>()
const normalize = (text: string): string => {
    let normalized = normalizedTexts.get(text)
    if (normalized === undefined) {
        normalized = normalizeSearchText(text)
        normalizedTexts.set(text, normalized)
    }
    return normalized
}

const wordsOf = (text: string): string[] =>
    text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

const withoutQualifier = (text: string): string =>
    text.replace(/\s*\([^)]*\)\s*/g, ' ').trim()

const scoreText = (text: string, query: string): number => {
    const normalized = normalize(text)
    if (normalized === query) return EXACT
    if (withoutQualifier(normalized) === query) return EXACT_WITHOUT_QUALIFIER
    if (normalized.startsWith(query)) return PREFIX
    const words = wordsOf(normalized)
    if (words.includes(query)) return WORD
    if (words.some((word) => word.startsWith(query))) return WORD_PREFIX
    return normalized.includes(query) ? SUBSTRING : 0
}

const scoreWord = (text: string, queryWord: string): number => {
    const words = wordsOf(normalize(text))
    if (words.includes(queryWord)) return WORD
    return words.some((word) => word.startsWith(queryWord)) ? WORD_PREFIX : 0
}

const weighTerm =
    (term: string) =>
    (score: number): number =>
        score < EXACT_WITHOUT_QUALIFIER
            ? score * TERM
            : score *
              (wordsOf(normalize(term)).length > 1
                  ? EXACT_TERM_NAME
                  : EXACT_TERM_WORD)

type Weigh = (score: number) => number

const getTerms = (terms: string | string[] | undefined): string[] => {
    if (!terms) return []
    return Array.isArray(terms) ? terms : terms.split(',')
}

/**
 * Keeps the categories that match the search text and ranks them: an exact
 * label, then a label that starts with it, a whole word, the start of a word
 * and finally any part of a text. The label of the language, the English label,
 * the tag values and the terms are searched, a label counting more than a
 * value and a value more than a term. A search of several words also finds
 * the categories where every word starts a word of their texts ("arret bus").
 * On a tie, a category found in another text too comes first, then the
 * shorter label, the closer one.
 */
@Pipe({
    name: 'filterByTagsContent',
})
export class FilterByTagsContentPipe implements PipeTransform {
    transform(
        items: TagConfig[],
        args: string[],
        searchText: string
    ): TagConfig[] {
        const query = normalizeSearchText(searchText)
        if (!query) return items
        const [language] = args
        const matchesPair = query.includes('=')
        const queryWords = matchesPair ? [] : wordsOf(query)

        return items
            .map((item, position) => {
                const label = item.lbl?.[language] ?? item.lbl?.en ?? ''
                const texts: Array<[string, Weigh]> = [
                    [item.lbl?.[language] ?? '', (score) => score],
                    [item.lbl?.en ?? '', (score) => score * ENGLISH_LABEL],
                    ...Object.entries(item.tags).map(
                        ([key, value]): [string, Weigh] => [
                            matchesPair ? `${key}=${value}` : String(value),
                            (score) => score * TAG_VALUE,
                        ]
                    ),
                    ...[
                        ...getTerms(item.terms?.[language]),
                        ...(language === 'en' ? [] : getTerms(item.terms?.en)),
                    ].map((term): [string, Weigh] => [term, weighTerm(term)]),
                ]
                // a text found in several places (the label is also a term)
                // counts once
                const scoreByText = new Map<string, number>()
                for (const [text, weigh] of texts) {
                    const normalized = normalize(text)
                    const score = weigh(scoreText(text, query))
                    if (score > (scoreByText.get(normalized) ?? 0)) {
                        scoreByText.set(normalized, score)
                    }
                }
                const [best = 0, second = 0] = [...scoreByText.values()].sort(
                    (left, right) => right - left
                )
                const wordsScore =
                    queryWords.length > 1
                        ? Math.min(
                              ...queryWords.map((queryWord) =>
                                  Math.max(
                                      ...texts.map(([text, weigh]) =>
                                          weigh(scoreWord(text, queryWord))
                                      )
                                  )
                              )
                          )
                        : 0
                return {
                    item,
                    position,
                    score: Math.max(best, wordsScore),
                    otherScore: second,
                    labelLength: normalize(label).length,
                }
            })
            .filter(({ score }) => score > 0)
            .sort(
                (left, right) =>
                    right.score - left.score ||
                    right.otherScore - left.otherScore ||
                    left.labelLength - right.labelLength ||
                    left.position - right.position
            )
            .map(({ item }) => item)
    }
}
