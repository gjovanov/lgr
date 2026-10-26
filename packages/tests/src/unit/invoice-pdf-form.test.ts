import { describe, it, expect } from 'bun:test'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'

/**
 * The printed invoice form: letterhead logo above the centred title, the boxed totals block,
 * and the ОРИГИНАЛ/КОПИЕ pair a sales invoice is handed out in. Asserted on the HTML the
 * renderer is given, so no Chromium is needed.
 */

const baseInvoice = {
  invoiceNumber: 'INV-2026-00001',
  type: 'invoice',
  direction: 'outgoing',
  issueDate: new Date('2026-03-21'),
  currency: 'BGN',
  subtotal: 100,
  taxTotal: 20,
  total: 120,
  lines: [{ description: 'Item', quantity: 1, unit: 'бр', unitPrice: 100, taxRate: 20, lineTotal: 120 }],
}

function build(invoice: Record<string, unknown> = {}, org: Record<string, unknown> = {}, options: any = {}) {
  return buildInvoiceHtml(
    { ...baseInvoice, ...invoice } as any,
    { name: 'Test Org', ...org } as any,
    { companyName: 'Acme' } as any,
    undefined,
    { locale: 'bg', ...options },
  ).html
}

describe('printed invoice form', () => {
  it('prints the bundled logo on its own line above the title when the org has none of its own', () => {
    const html = build()
    expect(html).toContain('<div class="logo-bar"><img class="org-logo" src="data:image/png;base64,')
    // The letterhead line comes first; the title and the number/date block share the next one.
    expect(html.indexOf('logo-bar')).toBeLessThan(html.indexOf('top-bar'))
    expect(html.indexOf('org-logo')).toBeLessThan(html.indexOf('doc-title'))
  })

  it("uses the org's own logo when it is something the renderer can load", () => {
    expect(build({}, { logo: 'https://cdn.example.com/acme.png' }))
      .toContain('<img class="org-logo" src="https://cdn.example.com/acme.png"')
    expect(build({}, { logo: 'data:image/png;base64,AAAA' }))
      .toContain('<img class="org-logo" src="data:image/png;base64,AAAA"')
    // A storage key or relative path is not renderable on its own — fall back to the bundle.
    expect(build({}, { logo: 'uploads/acme.png' }))
      .toContain('<img class="org-logo" src="data:image/png;base64,')
    // Same for the uploaded-logo endpoint URL now stored on Org.logo: Chromium renders the form
    // with no base URL and no network, so the export controller inlines the bytes instead. If it
    // ever passes the raw URL through, this fallback is what keeps the letterhead from breaking.
    expect(build({}, { logo: '/api/org/64f000000000000000000001/logo?v=deadbeefdeadbeef' }))
      .toContain('<img class="org-logo" src="data:image/png;base64,')
  })

  it('spells out horizontal padding on every table so no block is inset from the margin', () => {
    const { css } = buildInvoiceHtml(baseInvoice as any, { name: 'Test Org' } as any, {} as any)
    // The renderer's own table style pads cells left and right; a rule that sets only
    // `padding-top` would leave the tax-event and signature rows out of line with the notices.
    for (const rule of css.split('}')) {
      if (!/^\s*table\.(meta-row|signatures)/.test(rule) || !rule.includes('padding')) continue
      expect(rule).not.toContain('padding-top')
      expect(rule).toMatch(/padding:\s*[\d.]+px\s+0\s+0\s+0/)
    }
  })

  it('centres the title by balancing the meta column with an empty side column', () => {
    const html = build()
    expect(html).toContain('side-cell')
    expect(html.indexOf('side-cell')).toBeLessThan(html.indexOf('title-cell'))
  })

  it('boxes the totals and emphasises the amount due', () => {
    const html = build()
    expect(html).toContain('<div class="totals-box">')
    // The three rows are named as the on-screen totals card names them, the last emphasised.
    const box = html.slice(html.indexOf('totals-box'), html.indexOf('</table>', html.indexOf('totals-box')))
    expect(box).toContain('Междинна сума')
    expect(box).toContain('Общо ДДС (20%)')
    expect(box).toContain('<tr class="grand"><td class="tk">Общо</td>')
    expect(box).toContain('120.00')

    const en = build({}, {}, { locale: 'en' })
    const enBox = en.slice(en.indexOf('totals-box'), en.indexOf('</table>', en.indexOf('totals-box')))
    expect(enBox).toContain('Subtotal')
    expect(enBox).toContain('Tax Total (20%)')
    expect(enBox).toContain('<tr class="grand"><td class="tk">Total</td>')
    // The pre-2026-08 wording is gone from the form.
    expect(enBox).not.toContain('Taxable amount')
    expect(enBox).not.toContain('Amount due')
  })

  it('prints the amount in words without its tax-base tail, whatever language it was written in', () => {
    // The notes line is written in the UI language of whoever saved the document, which need
    // not be the print language — and its wording for the tax base differs from the form's.
    const cases: [string, string, string][] = [
      ['en', 'In words : twenty-one euro and 60 cents, Tax base 18.00 €', 'In words : twenty-one euro and 60 cents'],
      ['bg', 'Словом : двадесет и едно евро и 60 цента, Данъчна основа 18.00 €', 'Словом : двадесет и едно евро и 60 цента'],
      ['de', 'In Worten : einundzwanzig Euro und 60 Cent, Steuerbasis 18.00 €', 'In Worten : einundzwanzig Euro und 60 Cent'],
      ['mk', 'Со зборови : дваесет и едно евро и 60 центи, Даночна основа 18.00 €', 'Со зборови : дваесет и едно евро и 60 центи'],
    ]
    for (const [locale, notes, expected] of cases) {
      const html = build({ notes }, {}, { locale })
      expect(html).toContain(`<td class="words">${expected}</td>`)
      expect(html).not.toContain('18.00 €')
    }
  })

  // INV-3000101474 on prod, 2026-10-13: a sales invoice imported before the import regenerated
  // the line kept PlusMinus's text, which has no comma before the tax base.
  it('drops the tax-base tail of an imported PlusMinus line, which has no comma', () => {
    const notes = 'Словом : деветнадесет евро и 76 цента Данъчна основа 16.47 €'
    const html = build({ notes }, {}, { locale: 'bg' })
    expect(html).toContain('<td class="words">Словом : деветнадесет евро и 76 цента</td>')
    expect(html).not.toContain('Данъчна основа 16.47')
  })

  it('keeps a note that merely follows the words line', () => {
    const html = build({ notes: 'In words : twenty-one euro and 60 cents, Tax base 18.00 €\nDelivery to the depot.' }, {}, { locale: 'en' })
    expect(html).toContain('<td class="words">In words : twenty-one euro and 60 cents</td>')
    expect(html).toContain('<p class="note-rest">Delivery to the depot.</p>')
  })

  it('prints the per-print note under the number block, and nothing at all when empty', () => {
    const withNote = build({}, {}, { headerNote: 'Доставка до обект №4\nМОЛ: Иван Петров' })
    expect(withNote).toContain('<div class="head-note">')
    expect(withNote).toContain('Доставка до обект №4')
    // Its own row: after the title/number bar closes, before the parties band opens.
    expect(withNote.indexOf('</table>', withNote.indexOf('top-bar'))).toBeLessThan(withNote.indexOf('head-note'))
    expect(withNote.indexOf('head-note')).toBeLessThan(withNote.indexOf('class="parties"'))
    // Both copies of a sales invoice carry it.
    expect(withNote.split('head-note').length - 1).toBe(2)

    // Absent, empty and whitespace-only all print no block at all — no empty frame, no gap.
    for (const headerNote of [undefined, '', '   ', '\n\t ']) {
      expect(build({}, {}, { headerNote })).not.toContain('head-note')
    }
  })

  it('caps the per-print note so a pasted wall of text cannot crowd the header', () => {
    const html = build({}, {}, { headerNote: 'x'.repeat(400) })
    const block = html.slice(html.indexOf('head-note'), html.indexOf('</div>', html.indexOf('head-note')))
    expect(block.split('x').length - 1).toBe(300)
  })

  // ── #127: the line table's unit column and quantity heading ──

  it('prints the localized unit abbreviation, never the stored code', () => {
    // Bulgarian documents say „БР.", as the legacy PlusMinus forms did.
    expect(build({ lines: [{ description: 'Item', quantity: 1, unit: 'pcs', unitPrice: 100, lineTotal: 120 }] }))
      .toContain('<td class="a-center">БР.</td>')
    // Already-abbreviated legacy values resolve to the same label rather than printing as typed.
    expect(build()).toContain('<td class="a-center">БР.</td>')
    expect(build({ lines: [{ description: 'Item', quantity: 2.5, unit: 'kg', unitPrice: 4, lineTotal: 12 }] }))
      .toContain('<td class="a-center">КГ.</td>')
    expect(build({ lines: [{ description: 'Item', quantity: 1, unit: 'pcs', unitPrice: 1, lineTotal: 1 }] }, {}, { locale: 'en' }))
      .toContain('<td class="a-center">pcs</td>')
    // A unit nothing knows about prints verbatim — `unit` is free text on the API.
    expect(build({ lines: [{ description: 'Item', quantity: 1, unit: 'ролка', unitPrice: 1, lineTotal: 1 }] }))
      .toContain('<td class="a-center">ролка</td>')
    // No unit, no guess.
    expect(build({ lines: [{ description: 'Item', quantity: 1, unitPrice: 1, lineTotal: 1 }] }))
      .toContain('<td class="a-center"></td>')
  })

  it('spells out the Bulgarian unit and quantity headings', () => {
    const html = build()
    const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'))
    expect(head).toContain('Мярка')
    expect(head).toContain('Количество')
    expect(head).not.toContain('>Кол<')
    expect(head).not.toContain('>Мяр<')
  })

  it('renders a sales invoice twice — ОРИГИНАЛ, then an unmarked copy on a new page', () => {
    const html = build()
    expect(html.split('ОРИГИНАЛ').length - 1).toBe(1)
    expect(html.split('copy-break').length - 1).toBe(1)
    expect(html.indexOf('ОРИГИНАЛ')).toBeLessThan(html.indexOf('copy-break'))
    // The second copy carries no marker, but keeps the line so both copies lay out alike.
    const marks = html.split('<div class="copy-mark">').slice(1).map(s => s.slice(0, s.indexOf('</div>')))
    expect(marks).toEqual(['ОРИГИНАЛ', '&nbsp;'])
    // The page foot is page furniture, painted once for the whole document.
    expect(html.split('page-foot').length - 1).toBe(1)
  })

  it('leaves every other document type as a single original', () => {
    for (const invoice of [{ type: 'proforma' }, { type: 'credit_note' }, { type: 'cash_sale' }, { direction: 'incoming' }]) {
      const html = build(invoice)
      expect(html).toContain('ОРИГИНАЛ')
      expect(html).not.toContain('КОПИЕ')
      expect(html).not.toContain('copy-break')
    }
  })

  it('prints a single copy with the requested marker when the caller names one', () => {
    const copy = build({}, {}, { copyMark: 'copy' })
    expect(copy).toContain('КОПИЕ')
    expect(copy).not.toContain('ОРИГИНАЛ')
    expect(copy).not.toContain('copy-break')

    const original = build({}, {}, { copyMark: 'original' })
    expect(original).toContain('ОРИГИНАЛ')
    expect(original).not.toContain('КОПИЕ')
  })
})

/**
 * FR-22.18: a document printed before it is issued. Its DRF- number goes on issue, so a printout
 * carrying it would hand the customer a number no invoice will ever have.
 */
describe('a printed draft', () => {
  const draft = { status: 'draft', invoiceNumber: 'DRF-INV-2026-00042' }

  it('says ЧЕРНОВА, as one copy, and never shows its draft number', () => {
    const html = build(draft)
    expect(html).toContain('ЧЕРНОВА')
    expect(html).toContain('draft-watermark')
    expect(html).not.toContain('DRF-INV-2026-00042')
    expect(html).not.toContain('ОРИГИНАЛ')
    expect(html).not.toContain('copy-break')
    // The date still prints; only the number row is left out.
    expect(html).toContain('21.03.2026')
  })

  it('in the language it is printed in', () => {
    const en = buildInvoiceHtml({ ...baseInvoice, ...draft } as any, { name: 'Test Org' } as any, {} as any, undefined, { locale: 'en' }).html
    expect(en).toContain('DRAFT')
    expect(en).not.toContain('DRF-INV')
  })

  it('wins over a requested marker: a draft is nobody’s original', () => {
    const html = build(draft, {}, { copyMark: 'original' })
    expect(html).toContain('ЧЕРНОВА')
    expect(html).not.toContain('ОРИГИНАЛ')
  })

  it('an issued document prints its number and no draft mark', () => {
    const html = build({ status: 'sent' })
    expect(html).toContain('INV-2026-00001')
    expect(html).not.toContain('ЧЕРНОВА')
    expect(html).not.toContain('draft-watermark')
  })
})
