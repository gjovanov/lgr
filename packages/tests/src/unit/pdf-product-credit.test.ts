import { describe, it, expect } from 'bun:test'
import { productCredit } from 'reporting/product-credit'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'
import { buildListHtml, footerTemplate } from 'reporting/pdf/invoicing-list.pdf'

/**
 * Every generated PDF carries the software credit in its page foot — the LGR counterpart of
 * the line the legacy Bulgarian forms print naming the issuing program. Where it goes differs
 * by document: the invoice form paints its own fixed `.page-foot`, while the list exports
 * hand the credit to the renderer's footer template.
 *
 * These assert the HTML builders directly rather than stubbing the renderer.
 *
 * ⚠ This file used to `mock.module('reporting/pdf/base.pdf', …)` to capture what was handed
 * to `markdownToPdf`. Bun applies a module mock to the WHOLE process, and nothing undoes it
 * — not even `mock.restore()`, because the modules that consumed it (invoice.pdf,
 * invoicing-list.pdf) are already bound to the stub by then. So every test file running after
 * this one received `Buffer.from('%PDF-stub')` — 9 bytes, and starting with the PDF magic —
 * where it expected a real document, and two export suites failed with a bare "Received: 9"
 * that reproduced only in a full-suite run. Do not reintroduce a module mock here.
 */

describe('PDF software credit', () => {
  it('is translated for every supported locale', () => {
    expect(productCredit('en')).toBe('Software product LGR https://lgrai.app')
    expect(productCredit('bg')).toBe('Програмен продукт LGR https://lgrai.app')
    expect(productCredit('de')).toBe('Softwareprodukt LGR https://lgrai.app')
    expect(productCredit('mk')).toBe('Програмски продукт LGR https://lgrai.app')
    // Unknown / missing locale falls back to English rather than printing nothing.
    expect(productCredit('fr')).toBe('Software product LGR https://lgrai.app')
    expect(productCredit()).toBe('Software product LGR https://lgrai.app')
  })

  it('the invoice form prints it once in its own page foot', () => {
    const { html } = buildInvoiceHtml(
      {
        invoiceNumber: 'INV-2026-00001', type: 'invoice', direction: 'outgoing',
        issueDate: new Date('2026-03-21'), currency: 'EUR', subtotal: 100, taxTotal: 20, total: 120,
        lines: [{ description: 'Item', quantity: 1, unit: 'pcs', unitPrice: 100, taxRate: 20, lineTotal: 120 }],
      } as any,
      { name: 'Test Org' } as any,
      { companyName: 'Acme' } as any,
      undefined,
      { locale: 'bg', footerText: 'Test Org' },
    )

    expect(html).toContain('page-foot')
    // Exactly once. The form opts out of the renderer's default foot
    // (`generateInvoicePDF` passes `defaultFooter: false`) precisely so it isn't doubled.
    expect(html.split(productCredit('bg')).length - 1).toBe(1)
  })

  it('the list export carries it in the page furniture, not the document body', () => {
    const { html } = buildListHtml({
      title: 'Documents', orgName: 'Test Org', mode: 'compact', locale: 'de',
      rows: [{
        invoiceNumber: 'INV-1', type: 'invoice', direction: 'outgoing', status: 'paid',
        issueDate: new Date('2026-03-01'), dueDate: new Date('2026-04-01'),
        contactName: 'Acme', currency: 'EUR', total: 120,
      } as any],
    })

    expect(footerTemplate('Test Org', 'de')).toContain(productCredit('de'))
    expect(html).not.toContain(productCredit('de'))
  })
})
