import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadFailureOf } from 'ui-shared/composables/load-failure'
import { useFormFeedback } from 'ui-shared/composables/useFormFeedback'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { shortageMatches, shortageQuantity, shortagesOfCheck, shortagesOfRefusal } from '../../../web/src/modules/invoicing/composables/document-issue'

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

describe('a refusal about a line is marked on it (FR-31.8)', () => {
  const lines = [
    { description: 'A service', quantity: 1 },
    { productId: 'p1', warehouseId: 'w1', description: 'Болт М8', quantity: 600 },
    { productId: 'p1', warehouseId: 'w2', description: 'Болт М8', quantity: 5 },
    { productId: 'p1', warehouseId: 'w1', description: 'Болт М8', quantity: 400 },
  ]

  it('a shortfall of the stock check is about its article in its warehouse, on every such line', () => {
    const [s] = shortagesOfCheck([{ productId: 'p1', warehouseId: 'w1', requested: 1000, available: 3, productName: 'Болт М8' }])
    expect(s).toEqual({ productId: 'p1', warehouseId: 'w1', requested: 1000, available: 3 })
    expect(lines.map(l => shortageMatches(s, l))).toEqual([false, true, false, true])
    expect(shortageQuantity(s, lines)).toBe(1000)
    // A changed quantity on one of them: the sum is no longer what was refused.
    expect(shortageQuantity(s, [...lines.slice(0, 3), { ...lines[3], quantity: 1 }])).toBe(601)
  })

  it('a cost-layer refusal names the article, never an id, and is matched by that name', () => {
    const e = { response: { status: 422, data: { code: 'insufficient_cost_layers', product: 'Болт М8', sku: 'B8', warehouse: 'Main', needed: 5, available: 2 } } }
    const [s] = shortagesOfRefusal(e)
    expect(s).toEqual({ product: 'Болт М8', requested: 5, available: 2 })
    expect(lines.map(l => shortageMatches(s, l))).toEqual([false, true, true, true])
  })

  it('any other refusal is about no line', () => {
    expect(shortagesOfRefusal({ response: { status: 409, data: { code: 'invoice_not_draft', message: 'x' } } })).toEqual([])
    expect(shortagesOfRefusal({ response: { status: 500, data: { message: 'Internal server error (ref 0)' } } })).toEqual([])
    expect(shortagesOfRefusal(new Error('Network Error'))).toEqual([])
    expect(shortagesOfCheck(undefined)).toEqual([])
  })

  it('the line says it in all four languages', () => {
    for (const lang of ['en', 'bg', 'de', 'mk']) {
      const cat = JSON.parse(readFileSync(join(import.meta.dir, '../../../ui-shared/src/locales', `${lang}.json`), 'utf8'))
      expect(cat.invoicing.lineRefusal.short).toContain('{available}')
      expect(cat.invoicing.lineRefusal.short).toContain('{requested}')
    }
  })
})
