import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadFailureOf } from 'ui-shared/composables/load-failure'
import { useFormFeedback } from 'ui-shared/composables/useFormFeedback'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

// FR-31.6 to .9 (#796): a failure is said on the screen, says what it is, and stays.

const settle = () => new Promise((r) => setTimeout(r, 5))

describe('what a failed load is (FR-31.6, .7)', () => {
  it('404 is not found, 401 and 403 not allowed, anything else could not be loaded', () => {
    expect(loadFailureOf({ response: { status: 404 } })).toBe('not_found')
    expect(loadFailureOf({ response: { status: 403 } })).toBe('forbidden')
    expect(loadFailureOf({ response: { status: 401 } })).toBe('forbidden')
    expect(loadFailureOf({ response: { status: 500 } })).toBe('failed')
    expect(loadFailureOf(new Error('Network Error'))).toBe('failed')
    expect(loadFailureOf(null)).toBe('failed')
  })

  it('a form says a failed load, forgets it on the next load, and an abort is no failure', () => {
    const f = useFormFeedback()
    f.loadFailed({ response: { status: 404 } })
    expect(f.loadError.value).toBe('not_found')
    f.loadStarted()
    expect(f.loadError.value).toBeNull()
    f.loadFailed(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }))
    expect(f.loadError.value).toBeNull()
  })

  it('a refusal stays until it is closed or the next action succeeds, on the form and the message line (FR-31.8)', () => {
    const f = useFormFeedback()
    const { snackbar } = useSnackbar()
    f.refused('Not enough stock')
    expect(f.refusal.value).toBe('Not enough stock')
    expect(snackbar.visible && snackbar.message).toBe('Not enough stock')
    f.succeeded()
    expect(f.refusal.value).toBe('')
    expect(snackbar.visible).toBe(false)
    f.refused('Again')
    f.dismissRefusal()
    expect(f.refusal.value).toBe('')
  })

  it('every string the failures name is in all four languages', () => {
    const dir = join(import.meta.dir, '..', '..', '..', 'ui-shared', 'src', 'locales')
    for (const locale of ['en', 'bg', 'de', 'mk']) {
      const c = JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8')).common
      for (const failure of ['not_found', 'forbidden', 'failed']) {
        expect(typeof c.loadFailure[failure].title).toBe('string')
        expect(typeof c.loadFailure[failure].text).toBe('string')
        expect(typeof c.listFailure[failure]).toBe('string')
      }
      expect(typeof c.retry).toBe('string')
      expect(typeof c.unexpectedError).toBe('string')
    }
  })
})

describe('the message line (FR-31.8)', () => {
  it('an error stays until closed; a second message waits instead of replacing it', async () => {
    const { snackbar, showError, showSuccess, hideSnackbar } = useSnackbar()
    showError('Refused: no stock')
    expect(snackbar.visible).toBe(true)
    expect(snackbar.timeout).toBe(-1)
    showSuccess('Saved')
    // The error is still what is shown; the success waits.
    expect(snackbar.message).toBe('Refused: no stock')
    expect(snackbar.queue.map((m) => m.message)).toEqual(['Saved'])
    hideSnackbar()
    await settle()
    expect(snackbar.visible).toBe(true)
    expect(snackbar.message).toBe('Saved')
    expect(snackbar.timeout).toBe(3000)
    hideSnackbar()
    await settle()
    expect(snackbar.visible).toBe(false)
  })

  it('a message that closes by itself is followed at once by a newer one; one behind an error waits', async () => {
    const { snackbar, showError, showSuccess, showSnackbar, hideSnackbar } = useSnackbar()
    showSuccess('Saved')
    showSnackbar('Reserved 1, short 3', 'warning', 8000)
    expect(snackbar.message).toBe('Reserved 1, short 3')
    expect(snackbar.queue).toHaveLength(0)
    showError('Refused')
    expect(snackbar.message).toBe('Refused')
    showSuccess('Saved again')
    showSnackbar('Short again', 'warning', 8000)
    expect(snackbar.message).toBe('Refused')
    expect(snackbar.queue.map((m) => m.message)).toEqual(['Saved again', 'Short again'])
    hideSnackbar()
    await settle()
    expect(snackbar.message).toBe('Saved again')
    hideSnackbar()
    await settle()
    expect(snackbar.message).toBe('Short again')
    hideSnackbar()
    await settle()
  })

  it('the same message twice in a row is said once', async () => {
    const { snackbar, showError, hideSnackbar } = useSnackbar()
    showError('Refused')
    showError('Refused')
    expect(snackbar.queue).toHaveLength(0)
    hideSnackbar()
    await settle()
    expect(snackbar.visible).toBe(false)
  })

  it('an error asked for with a time of its own still stays', () => {
    const { snackbar, showSnackbar, hideSnackbar } = useSnackbar()
    showSnackbar('Refused', 'error', 5000)
    expect(snackbar.timeout).toBe(-1)
    hideSnackbar()
  })
})
