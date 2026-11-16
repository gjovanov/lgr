import { describe, it, expect } from 'bun:test'
import { confirmsPaymentOnIssue } from '../../../invoicing-ui/src/composables/document-issue'
import en from '../../../ui-shared/src/locales/en.json'
import bg from '../../../ui-shared/src/locales/bg.json'
import de from '../../../ui-shared/src/locales/de.json'
import mk from '../../../ui-shared/src/locales/mk.json'

/**
 * Owner, 2026-11-12: "before sending an invoice (status sent), are you sure you want to send with the selected payment
 * method? Yes, No." The list's Send and the form's Issue share `useDocumentIssue`, which asks when this says so.
 */
describe('which documents ask for the payment method before they are issued', () => {
  it('an outgoing invoice asks', () => {
    expect(confirmsPaymentOnIssue({ direction: 'outgoing', type: 'invoice' })).toBe(true)
  })

  it('nothing else does: notes, proformas, bills, cash sales', () => {
    for (const type of ['credit_note', 'debit_note', 'proforma', 'cash_sale']) {
      expect({ type, asks: confirmsPaymentOnIssue({ direction: 'outgoing', type }) }).toEqual({ type, asks: false })
    }
    expect(confirmsPaymentOnIssue({ direction: 'incoming', type: 'invoice' })).toBe(false)
    expect(confirmsPaymentOnIssue({})).toBe(false)
  })
})

describe('the words, in four locales', () => {
  it('the question, its fallback, and the locked unit', () => {
    for (const [loc, cat] of Object.entries({ en, bg, de, mk }) as [string, any][]) {
      const ask = cat.invoicing?.issueFlow?.confirmPayment ?? {}
      expect({ loc, title: typeof ask.title, text: typeof ask.text, none: typeof ask.none, unit: typeof cat.invoicing?.unitFromProduct })
        .toEqual({ loc, title: 'string', text: 'string', none: 'string', unit: 'string' })
      expect(ask.title).toContain('{number}')
    }
  })
})
