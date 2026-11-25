/**
 * FR-33.2: how a typed search text matches, in one place for the server and the screens.
 *
 * - **Words.** A search text is its whitespace-separated words, and a text matches when it holds every one of them.
 * - **Case.** Both sides are lowercased with the Bulgarian locale, as the lowered mirrors are (`loweredFieldsPlugin`).
 * - **Look-alikes.** A Latin and a Cyrillic letter that look the same are one letter (`x`/`х`, `m`/`м`, `a`/`а`, …).
 *   Product names mix both alphabets freely: „М8х20" may be typed with a Latin M or a Cyrillic х, in the query or in
 *   the name, and the two are indistinguishable on screen.
 *
 * The server's product search (`services/biz/search.utils.ts`) turns a word into a pattern of letter classes
 * (`homoglyphPattern`); a screen that filters rows it already holds (the stock count's lines) folds both sides to one
 * letter (`searchTextMatcher`). Both read `HOMOGLYPH_PAIRS`, and `unit/search-text.test.ts` holds them to the same
 * answers on a fixed word list.
 *
 * Import-pure: the API and the web app import it.
 */

/** The locale both sides are lowercased with, as the lowered mirrors are. */
export const SEARCH_LOCALE = 'bg'

/**
 * Lowercase Latin ↔ Cyrillic pairs that render identically (or nearly) once lowercased from
 * their look-alike capitals (A/А, B/В, C/С, E/Е, H/Н, K/К, M/М, O/О, P/Р, T/Т, X/Х, Y/У).
 */
export const HOMOGLYPH_PAIRS: ReadonlyArray<readonly [latin: string, cyrillic: string]> = [
  ['a', 'а'], ['b', 'в'], ['c', 'с'], ['e', 'е'], ['h', 'н'], ['k', 'к'],
  ['m', 'м'], ['o', 'о'], ['p', 'р'], ['t', 'т'], ['x', 'х'], ['y', 'у'],
]

/** Each look-alike letter, either alphabet, to its regex class (`[aа]`). */
const HOMOGLYPH_CLASS: Record<string, string> = {}
/** Each look-alike letter, either alphabet, to its Latin one. */
const HOMOGLYPH_FOLD: Record<string, string> = {}
for (const [lat, cyr] of HOMOGLYPH_PAIRS) {
  HOMOGLYPH_CLASS[lat] = `[${lat}${cyr}]`
  HOMOGLYPH_CLASS[cyr] = `[${lat}${cyr}]`
  HOMOGLYPH_FOLD[cyr] = lat
}

/** The keywords of a search text: whitespace-separated, none empty. */
export function searchKeywords(search: string): string[] {
  return search.trim().split(/\s+/).filter(Boolean)
}

/** Expand look-alike letters of an already-escaped, lowercased keyword into character classes. */
export function homoglyphPattern(escapedLower: string): string {
  let out = ''
  for (const ch of escapedLower) out += HOMOGLYPH_CLASS[ch] ?? ch
  return out
}

/** A text lowercased, with each look-alike letter read as its Latin one: two texts that look alike fold alike. */
export function foldSearchText(text: string): string {
  let out = ''
  for (const ch of text.toLocaleLowerCase(SEARCH_LOCALE)) out += HOMOGLYPH_FOLD[ch] ?? ch
  return out
}

/**
 * A test of a text against a search: true when the text holds every word, in any case, look-alikes as one letter.
 * The search is folded once, so a screen can test thousands of rows with it. An empty search is `null`: nothing to
 * test.
 */
export function searchTextMatcher(search: string | null | undefined): ((text: string) => boolean) | null {
  const words = searchKeywords(search || '').map(foldSearchText)
  if (!words.length) return null
  return (text: string) => {
    const folded = foldSearchText(text)
    return words.every((w) => folded.includes(w))
  }
}
