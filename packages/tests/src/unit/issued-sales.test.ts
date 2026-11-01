import { describe, it, expect } from 'bun:test'
import { issuedSale } from 'services/biz/replication/issued-sales'

/** FR-20.51: what no sync or repair path deletes. A document under a placeholder was never issued. */
describe('an issued sale', () => {
  it('carries a number and is no longer a draft, whatever its type', () => {
    expect(issuedSale('invoices', { status: 'sent', invoiceNumber: 'INV-2026-00007' })).toBe('INV-2026-00007')
    expect(issuedSale('invoices', { status: 'paid', invoiceNumber: 'CS-2026-00001' })).toBe('CS-2026-00001')
  })

  it('a draft is not one', () => {
    expect(issuedSale('invoices', { status: 'draft', invoiceNumber: 'DRF-INV-2026-00001' })).toBeNull()
  })

  it('⚠ nor is a document still under its placeholder: it reads `paid` from its insert, and drew no number', () => {
    expect(issuedSale('invoices', { status: 'paid', invoiceNumber: '~pending:doc:6a0000000000000000000000' })).toBeNull()
    expect(issuedSale('invoices', { status: 'paid', invoiceNumber: '~pending:some-client-key' })).toBeNull()
  })

  it('a till row always is', () => {
    expect(issuedSale('postransactions', { unpNumber: 'ED123456-0001-0000001' })).toBe('ED123456-0001-0000001')
  })
})
