/**
 * `indexExistingInvoices`: the importer must recognise an invoice typed into LGR by hand
 * (`INV-<year>-<PlusMinus number>`, no reference) as already there — regal-pz 2026-10-05..08, 64 of them.
 */
import { describe, it, expect } from 'bun:test'
import { indexExistingInvoices } from '../../../../scripts/lib/invoice-index'

describe('indexExistingInvoices', () => {
  const rows = [
    { invoiceNumber: 'INV-3000100390', type: 'invoice', direction: 'outgoing', status: 'paid' },
    { invoiceNumber: 'DRF-INV-2026-01330', reference: '3000101685', type: 'invoice', direction: 'outgoing', status: 'draft' },
    { invoiceNumber: 'INV-2026-3000101323', type: 'invoice', direction: 'outgoing', status: 'paid' },
    { invoiceNumber: 'CSR-2026-00001', reference: 'salesAnalysis:2026-07-21', type: 'cash_sale', direction: 'outgoing' },
    { invoiceNumber: 'BILL-2026-00004', type: 'invoice', direction: 'incoming' },
  ]
  const { byNum, handEntered } = indexExistingInvoices(rows)

  it('knows an imported invoice by its INV-<number>', () => {
    expect(byNum.get('3000100390')?.invoiceNumber).toBe('INV-3000100390')
  })

  it('knows an unissued draft by its all-digits reference', () => {
    expect(byNum.get('3000101685')?.invoiceNumber).toBe('DRF-INV-2026-01330')
  })

  it('reports a hand-entered invoice separately, keyed by the PlusMinus number in its LGR number', () => {
    expect(handEntered.get('3000101323')?.invoiceNumber).toBe('INV-2026-3000101323')
    expect(byNum.has('3000101323')).toBe(false) // never confused with an import
  })

  it('does not treat a cash sale, a bill or a short counter number as hand-entered', () => {
    expect(handEntered.size).toBe(1)
    expect(indexExistingInvoices([{ invoiceNumber: 'INV-2026-00083', type: 'invoice', direction: 'outgoing' }]).handEntered.size).toBe(0)
    expect(indexExistingInvoices([{ invoiceNumber: 'INV-2026-3000101323', type: 'invoice', direction: 'incoming' }]).handEntered.size).toBe(0)
  })
})
