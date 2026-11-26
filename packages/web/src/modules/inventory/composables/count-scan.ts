import type { PickedArticle } from './count-lines'

/**
 * FR-33.11 (#933): a scanner on the stock count's entry line.
 *
 * Enter in the field first asks the server what the field holds names (`GET /warehouse/product/lookup`, FR-22.55's rule:
 * the exact barcode, else the exact SKU, else the one article the search finds). Then:
 *
 * - **A code that names one article** puts it on the count, or shows its line when it is there already (FR-33.7, D-2),
 *   with no list: what follows is a pick's (FR-33.6).
 * - **Anything else, typed**, is FR-33.12's Enter: the first hit of what the field holds (waiting for its answer).
 * - **Anything else, scanned** (a code that names no article, or several) leaves the list open on it: a scan is never
 *   guessed, as at the till.
 *
 * A scan is told from typing by its pace: a scanner types the whole code, each key within `SCAN_KEY_GAP_MS` of the one
 * before, and Enter right behind it. A person typing, pasting or editing the text is not a scan.
 *
 * Enters are taken in turn. A code scanned while the one before is still being looked up lands behind it in the field;
 * the first takes only its own text out, so the second finds just its code.
 *
 * No Vue and no DOM in here: `unit/count-scan.test.ts` drives it with a lookup it answers by hand.
 */

/** The longest pause between two keys of one scan, and between its last key and Enter. */
export const SCAN_KEY_GAP_MS = 50
/** A scan is at least this many keys: a person can type two or three letters that fast. */
export const SCAN_MIN_KEYS = 4
/** Below this many characters Enter is the field's own (FR-33.12's minimum to search). */
export const CODE_MIN_CHARS = 2

export type CodeEnter =
  /** The code's one article is new to the count: a line for it. */
  | { kind: 'add'; article: PickedArticle }
  /** The code's one article is on the count: its line is shown (FR-33.7). */
  | { kind: 'show'; article: PickedArticle }
  /** Typed, and no code: FR-33.12's first hit of what the field holds. */
  | { kind: 'first-hit' }
  /** Scanned, and the code names none or several: the list stays open on it. */
  | { kind: 'list' }

/** What Enter does with the lookup's answer. An exact code wins; otherwise a typed text is FR-33.12's. */
export function decideCodeEnter(found: PickedArticle | null, scanned: boolean, onCount: readonly string[]): CodeEnter {
  if (found) return onCount.includes(String(found._id)) ? { kind: 'show', article: found } : { kind: 'add', article: found }
  return scanned ? { kind: 'list' } : { kind: 'first-hit' }
}

/** What stays in the field once the code `typed` is taken: what was typed behind it meanwhile (the next scan). */
export function textAfter(now: string, typed: string): string {
  return now.startsWith(typed) ? now.slice(typed.length) : now
}

/**
 * The pace of the keys typed into the field. A burst starts at the first key typed into an empty field, or after an
 * Enter; it is a scan while every key came within `SCAN_KEY_GAP_MS` of the one before, and no key edited the text.
 */
export function scanPace(now: () => number = () => Date.now()) {
  let keys = 0
  let last = 0
  let slow = false

  function reset() {
    keys = 0
    slow = false
  }

  return {
    /** A character typed; `fieldWasEmpty`: the field held nothing before it. */
    key(fieldWasEmpty: boolean) {
      const at = now()
      if (fieldWasEmpty) reset()
      if (keys > 0 && at - last > SCAN_KEY_GAP_MS) slow = true
      keys++
      last = at
    },
    /** A key that edits or moves in the text (Backspace, an arrow, Delete): a person, not a scanner. */
    edit() {
      slow = true
    },
    /** Enter on `text`: was the whole of it scanned? A new burst starts after it. */
    enter(text: string): boolean {
      const scanned = !slow && keys >= SCAN_MIN_KEYS && keys >= text.trim().length && now() - last <= SCAN_KEY_GAP_MS
      reset()
      return scanned
    },
    reset,
  }
}

export interface CountScannerOptions {
  /** What the field holds now. */
  text: () => string
  /** The article the code names, or null (none, several, or a failed request). */
  lookup: (code: string) => Promise<PickedArticle | null>
  /** The articles on the count. */
  onCount: () => readonly string[]
  /** The code was taken: the field keeps `rest`, what was typed behind the code ('' for a fresh field). */
  taken: (rest: string) => void
  /** Put the article on the count, or show its line (FR-33.7): what a pick does. */
  add: (article: PickedArticle) => void | Promise<void>
  /** FR-33.12: Enter for the first hit of what the field holds. Called only while the field still holds the text. */
  firstHit: () => void
}

export function useCountScanner(opts: CountScannerOptions) {
  let queue: Promise<void> = Promise.resolve()
  let pending = 0

  async function turn(scanned: boolean): Promise<CodeEnter | null> {
    const typed = opts.text()
    const code = typed.trim()
    if (code.length < CODE_MIN_CHARS) return null
    let found: PickedArticle | null = null
    try {
      found = await opts.lookup(code)
    } catch {
      // No answer: the search in the field is the answer, as at the till.
      found = null
    }
    const outcome = decideCodeEnter(found, scanned, opts.onCount())
    if (outcome.kind === 'add' || outcome.kind === 'show') {
      opts.taken(textAfter(opts.text(), typed))
      await opts.add(outcome.article)
    } else if (outcome.kind === 'first-hit' && opts.text() === typed) {
      opts.firstHit()
    }
    return outcome
  }

  return {
    /** A turn is waiting or running: an Enter now waits behind it, whatever the field holds. */
    busy: () => pending > 0,
    /** Enter, scanned or typed: taken after the Enters before it. Resolves with what it did. */
    enter(scanned: boolean): Promise<CodeEnter | null> {
      pending++
      const run = queue.then(() => turn(scanned))
      queue = run.then(() => undefined, () => undefined)
      return run.finally(() => { pending-- })
    },
  }
}
