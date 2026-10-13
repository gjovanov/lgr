import { describe, it, expect } from 'bun:test'
import { buildReportHtml } from 'reporting/pdf/report.pdf'
import { HOUSE_CSS } from 'reporting/pdf/house-style'

/**
 * Layout of the generic report PDF (`buildReportHtml`), asserted on the HTML so no Chromium
 * is needed — the contract `buildListHtml` / `buildCashAggHtml` already offer.
 *
 * Everything here is a regression from gjovanov/lgr#127, where the sales register grew to 15
 * columns and the printed page fell apart in three separate ways at once: headings broken
 * mid-word („Платен"/„и"), dates clipped to „16.10...." and a grand total wrapped across two
 * lines („12 451,3"/„6"). Nothing caught any of them, because nothing measured the table.
 */

/** The register as #127 produced it: six text columns, nine money, long Bulgarian headings. */
const HEADERS = [
  'Дата', 'Документ', 'Тип док.', 'Партньор', 'Статус', 'Валута',
  'Данъчна основа', 'ДДС', 'Общо', 'Платено', 'Остатък',
  'Платени в брой', 'Платени с карта', 'Платени с наложен платеж', 'Платени по банка',
]
const TYPES = ['date', 'text', 'text', 'text', 'text', 'text',
  'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money'] as const

function register() {
  const columns = HEADERS.map((header, i) => ({ key: `c${i}`, header, type: TYPES[i] as any }))
  const row: Record<string, any> = { c0: '2026-10-16', c1: 'INV-2025-0020', c2: 'invoice', c3: 'TechVision Solutions', c4: 'paid', c5: 'EUR' }
  for (let i = 6; i < columns.length; i++) row[`c${i}`] = 575.84
  return {
    title: 'Продажби — документи',
    orgName: 'Acme Corp',
    columns,
    rows: [row],
    // A sum is wider than any single value — the case that wrapped.
    totals: { c6: 10552, c7: 1899.36, c8: 12451.36, c9: 3724.08, c10: 8727.28, c11: 2964.16, c12: 122.72, c13: 363.44, c14: 273.76 },
    totalsLabel: 'Общо',
    locale: 'bg',
  }
}

/** Column widths in declaration order, as percentages. */
function headerWidths(html: string): number[] {
  const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'))
  return [...head.matchAll(/width:([0-9.]+)%/g)].map(m => Number(m[1]))
}

describe('report PDF layout', () => {
  it('never lets a heading break inside a word', () => {
    // `word-break: break-word` on the head is what chopped „Платени" into „Платен" + „и".
    const headRule = HOUSE_CSS.split('}').find(r => r.includes('table.lines thead th') && r.includes('word-break'))
    expect(headRule).toBeDefined()
    expect(headRule).toContain('word-break: normal')
    expect(headRule).toContain('overflow-wrap: normal')
    // …and clips rather than printing over the next column if one ever does not fit.
    expect(headRule).toContain('overflow: hidden')
  })

  it('gives every column room for its heading\'s longest word', () => {
    const { html } = buildReportHtml(register())
    const widths = headerWidths(html)
    expect(widths.length).toBe(HEADERS.length)

    // Weight floor is 1.5/char + 1.5 padding against a 100% total; converting back, a column
    // must hold at least as many characters as its longest heading word.
    const totalWeight = widths.reduce((a, b) => a + b, 0)
    expect(totalWeight).toBeCloseTo(100, 1)

    HEADERS.forEach((h, i) => {
      const longest = h.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0)
      // The nine money columns are the squeezed ones; assert the relationship holds there.
      if (TYPES[i] !== 'money') return
      const perChar = widths[i] / longest
      expect(perChar).toBeGreaterThan(0.6)
    })
  })

  it('sizes a money column for its widest value, not just its heading', () => {
    const base = register()
    const widths = headerWidths(buildReportHtml(base).html)
    // „Общо" is a 4-letter heading over a 9-character total — the column must follow the total.
    const obshto = widths[8]
    const dds = widths[7]   // „ДДС" over 1899,36 — shorter value, so a narrower column
    expect(obshto).toBeGreaterThan(dds)
  })

  it('sizes a date column for a full dd.mm.yyyy, never the bare heading', () => {
    const { html } = buildReportHtml(register())
    const widths = headerWidths(html)
    // „Дата" is 4 characters; the value is 10. Sized off the heading it clipped to „16.10....".
    const perChar = widths[0] / 'Дата'.length
    expect(perChar).toBeGreaterThan(1.0)
    expect(html).toContain('16.10.2026')
  })

  it('keeps the totals row on one line per cell', () => {
    const { html } = buildReportHtml(register())
    const grand = html.slice(html.indexOf('grand-row'))
    // Without `nowrap` the sums wrapped mid-number („12 451,3" / „6").
    expect(grand).toContain('a-right nowrap')
    // bg-BG groups thousands with a NO-BREAK space, not an ASCII one — which is also why the
    // cell could not break there on its own and needed `nowrap` to stay on one line.
    expect(grand).toMatch(/12[\s  ]451,36/)
  })

  it('switches the head to the dense treatment only past ten columns', () => {
    const wide = buildReportHtml(register()).html
    expect(wide).toContain('class="lines dense"')

    const narrow = register()
    narrow.columns = narrow.columns.slice(0, 8)
    const html = buildReportHtml(narrow).html
    expect(html).toContain('class="lines"')
    expect(html).not.toContain('dense')
  })

  it('leaves an explicit column weight alone', () => {
    const opts = register()
    opts.columns = [
      { key: 'a', header: 'Данъчна основа', type: 'money', weight: 50 } as any,
      { key: 'b', header: 'Общо', type: 'money', weight: 50 } as any,
    ]
    opts.totals = {}
    const widths = headerWidths(buildReportHtml(opts).html)
    expect(widths).toEqual([50, 50])
  })
})
