import { describe, it, expect, mock } from 'bun:test'
import { productCredit } from 'reporting/product-credit'

/**
 * Every generated PDF carries the software credit in its page foot — the LGR counterpart of
 * the line the legacy Bulgarian forms print naming the issuing program.
 *
 * The document forms (invoice, companion) paint their own fixed `.page-foot`, so we capture
 * the HTML handed to the renderer instead of rasterising a PDF; `markdownToPdf` is stubbed to
 * record its arguments.
 */

const captured: { html: string; options: any }[] = []
const realBase = await import('reporting/pdf/base.pdf')

mock.module('reporting/pdf/base.pdf', () => ({
  ...realBase,
  markdownToPdf: (html: string, options: any) => {
    captured.push({ html, options })
    return Promise.resolve(Buffer.from('%PDF-stub'))
  },
}))

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

  it('the invoice form prints it once in its own page foot, next to the issuer line', async () => {
    captured.length = 0
    const { generateInvoicePDF } = await import('reporting/pdf/invoice.pdf')
    await generateInvoicePDF(
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

    const { html, options } = captured.at(-1)!
    expect(html).toContain('page-foot')
    expect(html.split(productCredit('bg')).length - 1).toBe(1)
    // Opts out of the renderer's default foot, otherwise the credit prints twice.
    expect(options.defaultFooter).toBe(false)
  })

  it('the list export prints it in the renderer footer template', async () => {
    captured.length = 0
    const { generateInvoicingListPDF } = await import('reporting/pdf/invoicing-list.pdf')
    await generateInvoicingListPDF({
      title: 'Documents', orgName: 'Test Org', mode: 'compact', locale: 'de',
      rows: [{
        invoiceNumber: 'INV-1', type: 'invoice', direction: 'outgoing', status: 'paid',
        issueDate: new Date('2026-03-01'), dueDate: new Date('2026-04-01'),
        contactName: 'Acme', currency: 'EUR', total: 120,
      } as any],
    })

    const { html, options } = captured.at(-1)!
    expect(options.footerHtml).toContain(productCredit('de'))
    // The credit belongs to the page furniture, not the document body.
    expect(html).not.toContain(productCredit('de'))
  })
})
