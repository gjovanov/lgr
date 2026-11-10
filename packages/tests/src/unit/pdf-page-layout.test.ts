import { describe, it, expect } from 'bun:test'
import { PAGE_SIDE_MARGIN } from 'reporting/pdf/page-margins'
import { DEFAULT_PAGE_MARGIN, evaluateRenderedPage } from 'reporting/pdf/base.pdf'
import { HOUSE_MARGIN, footerTemplate } from 'reporting/pdf/house-style'
import { buildInvoiceHtml, INVOICE_MARGIN } from 'reporting/pdf/invoice.pdf'
import { buildCompanionHtml, COMPANION_MARGIN } from 'reporting/pdf/companion-doc.pdf'
import { buildStockReceiptHtml, STOCK_RECEIPT_MARGIN } from 'reporting/pdf/stock-receipt.pdf'
import { GRID_EDGE_PADDING_PX, GRID_GUTTER_PX } from 'reporting/pdf/line-grid'

/**
 * The page every PDF prints on (2026-11-08): one side margin for all of them, and on the
 * document forms a line grid that runs from margin to margin with its outer columns' text a
 * small inset inside it (2026-11-10), fitted to its contents and kept apart by one gutter. The
 * parties band above the grid follows the same rules in each of its two halves.
 *
 * The grid and the band are asserted on the page as Chrome lays it out for printing, every
 * stylesheet applied: a class on the right cell proves nothing if another rule outranks it (the
 * band's titles printed flush for exactly that reason), so the test measures where the text
 * actually lands.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const RENDER_TIMEOUT = 120_000

describe('every PDF prints with the same side margins', () => {
  it('is 18 mm: the 12 mm the forms printed with, half again', () => {
    expect(PAGE_SIDE_MARGIN).toBe('18mm')
  })

  it('on the document forms, the list and report exports and the markdown documents alike', () => {
    for (const m of [INVOICE_MARGIN, COMPANION_MARGIN, STOCK_RECEIPT_MARGIN, HOUSE_MARGIN, DEFAULT_PAGE_MARGIN]) {
      expect(m.left).toBe(PAGE_SIDE_MARGIN)
      expect(m.right).toBe(PAGE_SIDE_MARGIN)
    }
  })

  it("keeps each document's own top and bottom", () => {
    expect([INVOICE_MARGIN.top, INVOICE_MARGIN.bottom]).toEqual(['8mm', '14mm'])
    expect([COMPANION_MARGIN.top, COMPANION_MARGIN.bottom]).toEqual(['14mm', '14mm'])
    expect([STOCK_RECEIPT_MARGIN.top, STOCK_RECEIPT_MARGIN.bottom]).toEqual(['14mm', '14mm'])
    expect([HOUSE_MARGIN.top, HOUSE_MARGIN.bottom]).toEqual(['12mm', '16mm'])
    expect([DEFAULT_PAGE_MARGIN.top, DEFAULT_PAGE_MARGIN.bottom]).toEqual(['20mm', '20mm'])
  })

  it('sets the list and report page foot in by the same margin, so its rule stops where the text does', () => {
    const foot = footerTemplate('Org', 'bg')
    expect(foot).toContain(`margin:0 ${PAGE_SIDE_MARGIN}`)
    // Without it, Chrome's footer flex row shrinks the box to its text (see footerTemplate).
    expect(foot).toContain('width:100%')
    // A padded box draws its rule edge to edge across the sheet, through both margins.
    expect(foot).not.toMatch(/padding:0 \d/)
  })
})

// ── Fixtures: long names that wrap, and wide values side by side ─────────────────────────────

const LONG = 'АНКЕРЕН БОЛТ С ГАЙКА И ШАЙБА ЗА БЕТОН М16Х250 - DIN 529 - 5.8 - ГОРЕЩО ПОЦИНКОВАН (HDG) С ДЪЛГО ОПИСАНИЕ'
/** No space, hyphen or slash: nothing a line may break at. */
const UNBROKEN = 'DIN933M16X250ZN88HDGКОДНАДОСТАВЧИКА0001234567890123456789ПАРТИДА4417СЕРТИФИКАТEN102043'

const invoice = buildInvoiceHtml(
  {
    invoiceNumber: 'INV-2026-00001', type: 'invoice', direction: 'outgoing', status: 'sent',
    issueDate: new Date('2026-05-04'), currency: 'EUR', subtotal: 1, taxTotal: 1, total: 1,
    notes: 'Словом : едно евро',
    lines: [
      { description: 'Болт М10х40 - DIN 931 - 8.8 - ZN', unit: 'pcs', quantity: 3, unitPrice: 41, taxRate: 20, lineTotal: 147.6 },
      { description: LONG, unit: 'pcs', quantity: 12345.678, unitPrice: 1234.5678, discount: 12.5, taxRate: 20, lineTotal: 1234567.89 },
      { description: 'ШАЙБА М8 - DIN 125-A - ZN', unit: 'kg', quantity: 1000, unitPrice: 9999.99, taxRate: 9, lineTotal: 9999990 },
      // One unbroken token wider than the whole name column: it must wrap, not push the grid
      // past the right margin, now that the fitted columns cannot give up any width.
      { description: UNBROKEN, unit: 'pcs', quantity: 1, unitPrice: 1, taxRate: 20, lineTotal: 1.2 },
    ],
  } as any,
  { name: 'ПРОБА ООД' } as any,
  { companyName: 'ТЕСТ ТЕХНИК АД' } as any,
  ['lineNo', 'description', 'unit', 'quantity', 'unitPrice', 'discount', 'taxRate', 'lineTotal'],
  { locale: 'bg', copyMark: 'original' },
)

const certificate = buildCompanionHtml({
  kind: 'certificate',
  number: 'CERT-2026-00001',
  date: new Date('2026-11-03'),
  recipient: { name: 'ТЕСТ ТЕХНИК АД' },
  supplier: { name: 'ПРОБА ООД' },
  lines: [
    { name: 'Болт М10х40 - DIN 931 - 8.8 - ZN', unit: 'pcs', quantity: 3, note: 'EN 10204 3.1' },
    { name: LONG, unit: 'set', quantity: 12345, note: 'Партида 4417' },
    { name: UNBROKEN, unit: 'pcs', quantity: 1, note: UNBROKEN },
  ],
  sourceDocs: [{ label: 'Фактура', number: 'INV-2026-00001', date: new Date('2026-11-03') }],
  locale: 'bg',
})

const stockReceipt = buildStockReceiptHtml({
  sections: [{
    number: 'SM-2026-00001', date: new Date('2026-11-03'), warehouse: 'Основен склад',
    lines: [
      { name: 'Болт М10х40 - DIN 931 - 8.8 - ZN', unit: 'pcs', quantity: 3, unitPrice: 41 },
      { name: LONG, unit: 'pcs', quantity: 12345.678, unitPrice: 1234.5678 },
      { name: UNBROKEN, unit: 'pcs', quantity: 1, unitPrice: 1 },
    ],
  }],
  bill: { number: 'BILL-2026-00001', date: new Date('2026-11-03') },
  currency: 'EUR',
  locale: 'bg',
})

/** The width the page's margins leave on A4 portrait, so the screen layout is the printed one. */
const PRINTED_WIDTH = `body { width: ${210 - 2 * parseFloat(PAGE_SIDE_MARGIN)}mm !important; }`

/** Every cell of the first line grid, with its box, its padding and its text's box, in px. */
const MEASURE = `(() => {
  const table = document.querySelector('table.lines')
  const t = table.getBoundingClientRect()
  const textBox = (el) => {
    if (!el || !el.textContent.trim()) return null
    const r = document.createRange()
    r.selectNodeContents(el)
    const b = r.getBoundingClientRect()
    return { left: b.left - t.left, right: b.right - t.left }
  }
  return {
    width: t.width,
    bodyWidth: document.body.getBoundingClientRect().width,
    words: textBox(document.querySelector('td.words')),
    rows: [...table.rows].map(tr => [...tr.cells].map(c => {
      const b = c.getBoundingClientRect()
      const s = getComputedStyle(c)
      return {
        text: c.textContent.trim(),
        fit: c.classList.contains('fit'),
        left: b.left - t.left,
        right: b.right - t.left,
        padLeft: parseFloat(s.paddingLeft),
        padRight: parseFloat(s.paddingRight),
        textBox: textBox(c),
      }
    })),
  }
})()`

interface Cell {
  text: string
  fit: boolean
  left: number
  right: number
  padLeft: number
  padRight: number
  textBox: { left: number; right: number } | null
}
interface Measured {
  width: number
  bodyWidth: number
  words: { left: number; right: number } | null
  rows: Cell[][]
}

async function measure(doc: { html: string; css: string }): Promise<Measured> {
  return evaluateRenderedPage<Measured>(doc.html, { css: `${doc.css}\n${PRINTED_WIDTH}` }, MEASURE)
}

/** What every document form's grid must hold, measured. */
function expectCompactGrid(m: Measured, wrappingColumns: number) {
  const half = GRID_GUTTER_PX / 2
  expect(m.rows.length).toBeGreaterThan(1)
  // The grid spans the width between the margins exactly: never wider, whatever a name holds.
  expect(m.width).toBeCloseTo(m.bodyWidth, 0)

  for (const cells of m.rows) {
    const first = cells[0]
    const last = cells[cells.length - 1]
    // The cells reach the grid's edges, which are the margins...
    expect(first.left).toBeCloseTo(0, 0)
    expect(last.right).toBeCloseTo(m.width, 0)
    // ...and pad the outer columns' text in from them.
    expect(first.padLeft).toBe(GRID_EDGE_PADDING_PX)
    expect(last.padRight).toBe(GRID_EDGE_PADDING_PX)
    // No text nearer an edge than the inset, whatever the column holds or however it wraps.
    if (first.textBox) expect(first.textBox.left).toBeGreaterThanOrEqual(GRID_EDGE_PADDING_PX - 0.5)
    if (last.textBox) expect(m.width - last.textBox.right).toBeGreaterThanOrEqual(GRID_EDGE_PADDING_PX - 0.5)
    // Every inner boundary is padded by half the gutter on each side.
    for (const c of cells.slice(1)) expect(c.padLeft).toBe(half)
    for (const c of cells.slice(0, -1)) expect(c.padRight).toBe(half)
    // No two neighbouring texts closer than one gutter.
    const texts = cells.filter(c => c.textBox)
    for (let i = 1; i < texts.length; i++) {
      expect(texts[i].textBox!.left - texts[i - 1].textBox!.right).toBeGreaterThanOrEqual(GRID_GUTTER_PX - 0.5)
    }
  }

  // The line numbers, and their heading, start exactly one inset in from the margin.
  for (const cells of m.rows) expect(cells[0].textBox!.left).toBeCloseTo(GRID_EDGE_PADDING_PX, 0)

  // Fitted columns are exactly their widest entry, heading or value, plus their padding.
  const header = m.rows[0]
  expect(header.filter(c => !c.fit).length).toBe(wrappingColumns)
  header.forEach((h, j) => {
    if (!h.fit) return
    const column = m.rows.map(r => r[j])
    const widest = Math.max(...column.map(c => (c.textBox ? c.textBox.right - c.textBox.left : 0)))
    expect(h.right - h.left).toBeCloseTo(widest + h.padLeft + h.padRight, 0)
  })
}

describe('the line grid of the document forms, as Chrome prints it', () => {
  it('never lets the outer columns touch the edges: at least 5px', () => {
    expect(GRID_EDGE_PADDING_PX).toBeGreaterThanOrEqual(5)
  })

  it('the invoicing documents: inset, fitted, one gutter apart, the amount in words in line', async () => {
    const m = await measure(invoice)
    expectCompactGrid(m, 1)
    // The amounts end one inset short of the right margin.
    for (const cells of m.rows) expect(cells[cells.length - 1].textBox!.right).toBeCloseTo(m.width - GRID_EDGE_PADDING_PX, 0)
    // The name, the one column that wraps, takes the rest of the line.
    const name = m.rows[0][1]
    expect(name.text).toBe('Име')
    expect(name.right - name.left).toBeGreaterThan(m.width / 3)
    // The amount in words below starts in line with the line numbers.
    expect(m.words!.left).toBeCloseTo(m.rows[1][0].textBox!.left, 0)
  }, RENDER_TIMEOUT)

  it('the protocol and the certificate: the remark column keeps its share for free text', async () => {
    const m = await measure(certificate)
    expectCompactGrid(m, 2)
    const note = m.rows[0][4]
    expect(note.fit).toBe(false)
    expect(note.textBox!.left).toBeCloseTo(note.left + note.padLeft, 0)
  }, RENDER_TIMEOUT)

  it('the stock receipt: inset, fitted, one gutter apart', async () => {
    const m = await measure(stockReceipt)
    expectCompactGrid(m, 1)
    for (const cells of m.rows) expect(cells[cells.length - 1].textBox!.right).toBeCloseTo(m.width - GRID_EDGE_PADDING_PX, 0)
  }, RENDER_TIMEOUT)
})

// ── The parties band above the grid ──────────────────────────────────────────────────────────

/** Long enough that the name and the address wrap inside their half of the band. */
const PARTY = {
  name: 'ДРУЖЕСТВО ЗА ТЪРГОВИЯ С КРЕПЕЖНИ ЕЛЕМЕНТИ И ИНСТРУМЕНТИ БЪЛГАРИЯ ЕООД КЛОН СОФИЯ',
  city: 'Велико Търново',
  street: 'бул. „Цар Освободител" № 126, вх. Б, ет. 4, ап. 17, Промишлена зона Север, склад 3',
  taxId: '123456789',
  vatId: 'BG123456789',
}

/** Every language a form prints in: their band titles differ in width (ДОСТАВУВАЧ, EMPFÄNGER). */
const LOCALES = ['bg', 'en', 'de', 'mk']

const invoiceIn = (locale: string) => buildInvoiceHtml(
  {
    invoiceNumber: 'INV-2026-00001', type: 'invoice', direction: 'outgoing', status: 'sent',
    issueDate: new Date('2026-05-04'), currency: 'EUR', subtotal: 1, taxTotal: 1, total: 1,
    lines: [{ description: 'Болт М10х40 - DIN 931 - 8.8 - ZN', unit: 'pcs', quantity: 3, unitPrice: 41, taxRate: 20, lineTotal: 147.6 }],
  } as any,
  { name: PARTY.name, taxNumber: PARTY.taxId, vatNumber: PARTY.vatId, addresses: [{ city: PARTY.city, street: PARTY.street }] } as any,
  { companyName: PARTY.name, taxId: PARTY.taxId, vatNumber: PARTY.vatId, addresses: [{ city: PARTY.city, street: PARTY.street }] } as any,
  ['lineNo', 'description', 'unit', 'quantity', 'unitPrice', 'taxRate', 'lineTotal'],
  { locale, copyMark: 'original' },
)

const certificateIn = (locale: string) => buildCompanionHtml({
  kind: 'certificate',
  number: 'CERT-2026-00001',
  date: new Date('2026-11-03'),
  recipient: { name: PARTY.name, city: PARTY.city, address: PARTY.street, taxId: PARTY.taxId },
  supplier: { name: PARTY.name, city: PARTY.city, address: PARTY.street, taxId: PARTY.taxId },
  lines: [{ name: 'Болт М10х40 - DIN 931 - 8.8 - ZN', unit: 'pcs', quantity: 3, note: 'EN 10204 3.1' }],
  sourceDocs: [],
  locale,
})

/** Every parties table on the page, cell by cell, and where the first line number starts; px from the page's left. */
const MEASURE_PARTIES = `(() => {
  const page = document.body.getBoundingClientRect()
  const textBox = (el) => {
    if (!el || !el.textContent.trim()) return null
    const r = document.createRange()
    r.selectNodeContents(el)
    const b = r.getBoundingClientRect()
    return { left: b.left - page.left, right: b.right - page.left }
  }
  return {
    lineNumber: textBox(document.querySelector('table.lines tbody td')).left,
    tables: [...document.querySelectorAll('table.parties')].map(table => [...table.rows].map(tr => [...tr.cells].map(c => {
      const b = c.getBoundingClientRect()
      const s = getComputedStyle(c)
      return {
        cls: c.className,
        left: b.left - page.left,
        right: b.right - page.left,
        padLeft: parseFloat(s.paddingLeft),
        padRight: parseFloat(s.paddingRight),
        textBox: textBox(c),
      }
    }))),
  }
})()`

interface PartyCell {
  cls: string
  left: number
  right: number
  padLeft: number
  padRight: number
  textBox: { left: number; right: number } | null
}
interface PartiesMeasured {
  lineNumber: number
  tables: PartyCell[][][]
}

/** One form in every language, on one page: its stylesheet is the same whatever the language. */
async function measureParties(build: (locale: string) => { html: string; css: string }): Promise<PartiesMeasured> {
  const docs = LOCALES.map(build)
  for (const d of docs) expect(d.css).toBe(docs[0].css)
  return evaluateRenderedPage<PartiesMeasured>(docs.map(d => d.html).join('\n'), { css: `${docs[0].css}\n${PRINTED_WIDTH}` }, MEASURE_PARTIES)
}

/** What the parties band of every document form must hold, measured: both halves, every row. */
function expectInsetParties(m: PartiesMeasured) {
  // One table per language: each form here prints a single copy.
  expect(m.tables.length).toBe(LOCALES.length)
  for (const rows of m.tables) {
    expect(rows[0].map(c => c.cls)).toEqual(['k', 'v', 'gap', 'k', 'v'])
    for (const cells of rows) {
      for (const at of [0, 3]) { // the recipient's half, then the supplier's
        const [key, value] = [cells[at], cells[at + 1]]
        // The title on the band and every key under it: one inset in from the half's edge...
        expect(key.padLeft).toBe(GRID_EDGE_PADDING_PX)
        expect(key.textBox!.left - key.left).toBeCloseTo(GRID_EDGE_PADDING_PX, 0)
        // ...one gutter from its value, however wide the language's title is...
        expect(key.padRight).toBe(GRID_GUTTER_PX)
        if (value.textBox) expect(value.textBox.left - key.textBox!.right).toBeGreaterThanOrEqual(GRID_GUTTER_PX - 0.5)
        // ...and the value, wrapped or not, ends at least one inset short of the half's other edge.
        expect(value.padRight).toBe(GRID_EDGE_PADDING_PX)
        if (value.textBox) expect(value.right - value.textBox.right).toBeGreaterThanOrEqual(GRID_EDGE_PADDING_PX - 0.5)
      }
      // The recipient's title and keys start in line with the line numbers below them.
      expect(cells[0].textBox!.left).toBeCloseTo(m.lineNumber, 0)
    }
  }
}

describe('the parties band of the document forms, as Chrome prints it', () => {
  it('the invoicing documents: titles and keys inset, a gutter before the value, values short of the end', async () => {
    expectInsetParties(await measureParties(invoiceIn))
  }, RENDER_TIMEOUT)

  it('the protocol and the certificate: the same', async () => {
    expectInsetParties(await measureParties(certificateIn))
  }, RENDER_TIMEOUT)
})

describe('the invoice line table as built (no Chromium)', () => {
  it('sizes no column by a fixed percentage, and fits every column but the description', () => {
    const table = invoice.html.slice(invoice.html.indexOf('<table class="lines">'), invoice.html.indexOf('</table>', invoice.html.indexOf('<table class="lines">')))
    expect(table).not.toContain('style="width')
    const cells = [...table.matchAll(/<t[hd] class="([^"]*)"/g)].map(m => m[1].split(' '))
    expect(cells.length).toBeGreaterThan(8)
    for (const cls of cells) expect(cls.includes('desc') !== cls.includes('fit')).toBe(true)
  })
})
