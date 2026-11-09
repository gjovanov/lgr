import { describe, it, expect } from 'bun:test'
import { cashSaleLineAmounts, lineAmounts } from 'config/line-amounts'
import { buildPayloadLines, lineAmounts as formLineAmounts } from '../../../invoicing-ui/src/composables/document-form/document-payload'
import { DOCUMENT_CONFIGS } from '../../../invoicing-ui/src/composables/document-form/configs'

/**
 * #573 — the server stores a back-office cash sale's line amounts by the rule its form sends them with. One
 * implementation (`config/line-amounts`), which the forms re-export; these pin the server's rounded amounts to
 * what the cash-sale form's payload carries.
 */
describe('cashSaleLineAmounts (#573)', () => {
  it('the forms compute with the same function', () => {
    expect(formLineAmounts).toBe(lineAmounts)
  })

  it('is what the cash-sale form sends, for any line', () => {
    let seed = 23
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const lines = Array.from({ length: 5000 }, (_, i) => ({
      productId: `p${i}`,
      description: `Артикул ${i}`,
      quantity: rnd() < 0.2 ? Math.round(rnd() * 5000) / 1000 : 1 + Math.floor(rnd() * 120),
      unit: 'бр.',
      unitPrice: Math.round(rnd() * 400 * 10000) / 10000,
      taxRate: [0, 9, 20][Math.floor(rnd() * 3)],
    }))
    const sent = buildPayloadLines(lines, DOCUMENT_CONFIGS.cash_sale)
    expect(sent).toHaveLength(lines.length)
    sent.forEach((s, i) => expect(cashSaleLineAmounts(lines[i])).toEqual({ taxAmount: s.taxAmount, lineTotal: s.lineTotal }))
  })

  it('a discount, which only an API client sends, comes off the way the discount-aware forms take it', () => {
    const line = { quantity: 4, unitPrice: 25, discount: 10, taxRate: 20 }
    expect(cashSaleLineAmounts(line)).toEqual({ taxAmount: 18, lineTotal: 108 })
    const [invoiceLine] = buildPayloadLines([{ productId: 'p', ...line }], DOCUMENT_CONFIGS.invoice)
    expect(cashSaleLineAmounts(line)).toEqual({ taxAmount: invoiceLine.taxAmount, lineTotal: invoiceLine.lineTotal })
  })

  it('reads blank fields as nothing, as the forms do', () => {
    expect(cashSaleLineAmounts({ quantity: '2', unitPrice: '1.5', taxRate: '' })).toEqual({ taxAmount: 0, lineTotal: 3 })
    expect(cashSaleLineAmounts({})).toEqual({ taxAmount: 0, lineTotal: 0 })
  })
})
