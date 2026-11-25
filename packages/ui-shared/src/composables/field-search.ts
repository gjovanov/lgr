import { ref, type Ref } from 'vue'
import { latestOnly } from './latest-only'

/**
 * FR-33.12 — the search behind a product field, and what Enter may take from it.
 *
 * Both inline product fields (`ProductSearch`; `ProductLineDescription`, a document line's article) search the same
 * way: a pause after the last keystroke, then one request, and only the answer to the latest request reaches the
 * list (FR-31.4). This holds that, and the text the list answers:
 *
 * - **A late answer to an earlier text is dropped.** The list takes an answer only while the field still holds the
 *   text it was asked for. A slow answer to "bo" that lands during the pause after "bolt" was typed is not shown.
 * - **Enter takes only an answer to what the field holds** (`enter`). The list on screen may still be an earlier
 *   text's while the newer answer is on its way (the pause, then the request). Enter then waits for that answer, and
 *   only for it: a change of text, a failed search or `ENTER_WAIT_MS` ends the wait with nothing to take. Nothing on
 *   its way, and nothing answering the text, means nothing to take, at once: Enter never waits outside the pause.
 *
 * No Vue component in here, so `unit/field-search.test.ts` drives it with a request it answers by hand.
 */

/** The longest Enter waits for the answer on its way. Past it, Enter takes nothing (the pause is 300 ms). */
export const ENTER_WAIT_MS = 3000

export interface FieldSearchOptions<R> {
  /** The request. It passes `signal` on, so a request a newer one replaces is aborted. */
  search: (signal: AbortSignal, text: string) => Promise<R>
  /** The list takes an answer: called only with the answer to what the field holds, `text` trimmed. */
  onAnswer: (value: R, text: string) => void
  minChars: number
  debounceMs: number
  /** How long Enter waits at most (`ENTER_WAIT_MS`). */
  enterWaitMs?: number
}

export interface FieldSearch {
  /** A request is on its way: the field's spinner. */
  loading: Ref<boolean>
  /** The text (trimmed) the list answers. '' before any answer, and once the field holds less than `minChars`. */
  answeredFor: Ref<string>
  /** An answer to what the field holds is on its way: its pause has started, or its request has gone. */
  waiting: Ref<boolean>
  /**
   * The field now holds `text`. Long enough, its search starts after the pause, and true is returned. Shorter, what is
   * on its way is dropped and false is returned: the caller empties its list.
   */
  input(text: string | null | undefined): boolean
  /** The list answers exactly `text` (trimmed). */
  answers(text: string | null | undefined): boolean
  /**
   * The field holds the text it last searched for, `text`, and the list does not answer it: its answer is on its way,
   * or its search failed. The rows on screen, if any, are an earlier text's.
   */
  unanswered(text: string | null | undefined): boolean
  /**
   * Enter on `text`: true once the list answers it (at once when it already does), so its first row may be taken;
   * false when no answer to it is on its way, the field's text changed, the search failed or the wait ran out.
   */
  enter(text: string | null | undefined): Promise<boolean>
  /** The field is going: nothing on its way is wanted. */
  cancel(): void
}

export function useFieldSearch<R>(opts: FieldSearchOptions<R>): FieldSearch {
  const loading = ref(false)
  const answeredFor = ref('')
  const waiting = ref(false)
  /** The text (trimmed) the field holds, when long enough to search for; '' otherwise. */
  let wanted = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = latestOnly(opts.search)
  const listeners = new Set<() => void>()
  const changed = () => { for (const l of [...listeners]) l() }

  function input(raw: string | null | undefined): boolean {
    const text = String(raw ?? '')
    if (timer) clearTimeout(timer)
    timer = null
    if (text.length < opts.minChars) {
      // A search still on its way answers a question nobody asks any more.
      run.cancel()
      wanted = ''
      loading.value = false
      waiting.value = false
      answeredFor.value = ''
      changed()
      return false
    }
    wanted = text.trim()
    // The list may already answer this text (a letter typed and taken back): Enter can take it while the pause runs.
    waiting.value = answeredFor.value !== wanted
    changed()
    timer = setTimeout(() => { timer = null; void ask(text) }, opts.debounceMs)
    return true
  }

  async function ask(text: string) {
    const asked = text.trim()
    loading.value = true
    try {
      const answer = await run(text)
      // A newer request owns the list and the spinner; and an answer to a text the field no longer holds is dropped
      // (its newer text's request has not gone yet: the pause is still running).
      if (!answer.latest || asked !== wanted) return
      answeredFor.value = asked
      waiting.value = false
      opts.onAnswer(answer.value, asked)
      loading.value = false
    } catch {
      // The latest search failed: the list keeps what it shows, and nothing answering the field is on its way.
      if (asked === wanted) waiting.value = false
      loading.value = false
    } finally {
      changed()
    }
  }

  function answers(raw: string | null | undefined): boolean {
    const text = String(raw ?? '').trim()
    return text.length >= opts.minChars && answeredFor.value === text
  }

  function unanswered(raw: string | null | undefined): boolean {
    const text = String(raw ?? '').trim()
    return wanted !== '' && wanted === text && answeredFor.value !== text
  }

  function enter(raw: string | null | undefined): Promise<boolean> {
    const text = String(raw ?? '').trim()
    if (answers(text)) return Promise.resolve(true)
    if (!waiting.value || wanted !== text) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const done = (took: boolean) => {
        listeners.delete(check)
        clearTimeout(limit)
        resolve(took)
      }
      const check = () => {
        if (wanted !== text) done(false)
        else if (answeredFor.value === text) done(true)
        else if (!waiting.value) done(false)
      }
      const limit = setTimeout(() => done(false), opts.enterWaitMs ?? ENTER_WAIT_MS)
      listeners.add(check)
    })
  }

  function cancel() {
    if (timer) clearTimeout(timer)
    timer = null
    run.cancel()
    wanted = ''
    loading.value = false
    waiting.value = false
    changed()
  }

  return { loading, answeredFor, waiting, input, answers, unanswered, enter, cancel }
}
