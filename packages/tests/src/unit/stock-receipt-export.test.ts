import { describe, it, expect } from 'bun:test'
import { buildStockReceiptHtml, type StockReceiptData, type StockReceiptPrice } from 'reporting/pdf/stock-receipt.pdf'
import { stockReceiptI18n } from 'reporting/stock-receipt.i18n'

/**
 * „Складова разписка" — the goods a supplier bill booked, printed from the bill: one section per
 * receipt movement, the bill named by OUR number and date, and no supplier on it at all.
 *
 * It is the sheet the warehouse prices the goods from (owner, 2026-11-15): the price column is the
 * level the person printing chose, the sheet says which, and it carries no total.
 */

function fixture(over: Partial<StockReceiptData> = {}): StockReceiptData {
  return {
    sections: [{
      number: 'SM-2026-00041',
      date: new Date('2026-10-30T10:00:00Z'),
      warehouse: 'Склад Център',
      lines: [
        { name: 'БОЛТ М8Х30 - DIN 933', unit: 'pcs', quantity: 100, unitPrice: 0.0472 },
        { name: 'ГАЙКА М8 - DIN 934', unit: 'kg', quantity: 2.5, unitPrice: 12.5 },
      ],
    }],
    bill: { number: 'BILL-2026-00017', date: new Date('2026-10-29T12:00:00Z') },
    price: { kind: 'tier', tier: 'Цена на едро' },
    currency: 'EUR',
    footerText: 'тел.: 000 000 000',
    locale: 'bg',
    ...over,
  }
}

/** Just the text, for assertions about what the page says rather than its markup. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

const EVERY_PRICE: StockReceiptPrice[] = [
  { kind: 'selling' },
  { kind: 'booked' },
  { kind: 'tier', tier: 'Цена на едро' },
  { kind: 'tier', tier: 'Доставна цена' },
  { kind: 'tier', tier: 'Цена 3' },
]

describe('stock receipt print', () => {
  it('heads the page with its title, the receipt\'s number and date, its warehouse and OUR bill', () => {
    const { html } = buildStockReceiptHtml(fixture())
    const t = text(html)
    expect(html).toContain('<h1 class="doc-title">СКЛАДОВА РАЗПИСКА</h1>')
    expect(t).toContain('Номер: SM-2026-00041')
    expect(t).toContain('Дата: 30.10.2026')
    expect(t).toContain('Склад: Склад Център')
    expect(t).toContain('Входяща фактура: № BILL-2026-00017 от 29.10.2026')
    // No supplier block — it records what came into which warehouse, not who invoiced it.
    expect(t).not.toMatch(/доставчик/i)
    expect(t).not.toContain('ЕИК')
  })

  it('is no longer headed „Стокова разписка": that is the name of the receipt document itself', () => {
    const t = text(buildStockReceiptHtml(fixture()).html)
    expect(t).not.toMatch(/стокова разписка/i)
  })

  it('lists the lines: №, name, the unit as printed, quantity, price and value', () => {
    const { html } = buildStockReceiptHtml(fixture())
    const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'))
    for (const h of ['№', 'Наименование', 'Мярка', 'Количество', 'Цена', 'Стойност']) expect(head).toContain(`>${h}<`)
    // A fastener's price keeps its four decimals; a round one prints two.
    expect(html).toContain('<td class="c-price fit">0.0472</td>')
    expect(html).toContain('<td class="c-price fit">12.50</td>')
    // 100 × 0.0472 = 4.72; 2.5 × 12.50 = 31.25.
    expect(html).toContain('<td class="c-amount fit">4.72</td>')
    expect(html).toContain('<td class="c-amount fit">31.25</td>')
    expect(html).toContain('<td class="c-unit fit">БР.</td>')
    expect(html).toContain('<td class="c-unit fit">КГ.</td>')
    expect(html).toContain('<td class="c-qty fit">2.5</td>')
  })

  describe('says which price it shows', () => {
    it('a slot of the catalogue by its name, with what the prices are in', () => {
      const t = text(buildStockReceiptHtml(fixture()).html)
      expect(t).toContain('Цена: Цена на едро (€)')
      expect(text(buildStockReceiptHtml(fixture({ price: { kind: 'tier', tier: 'Цена 3' } })).html)).toContain('Цена: Цена 3 (€)')
    })

    it('the selling price and the booked price by their own names', () => {
      expect(text(buildStockReceiptHtml(fixture({ price: { kind: 'selling' } })).html)).toContain('Цена: Продажна цена (€)')
      expect(text(buildStockReceiptHtml(fixture({ price: { kind: 'booked' } })).html)).toContain('Цена: Цена на заприходяване (€)')
    })

    it('the slot stored as „Доставна цена" by its label, never by the name it is stored under', () => {
      const bg = text(buildStockReceiptHtml(fixture({ price: { kind: 'tier', tier: 'Доставна цена' } })).html)
      expect(bg).toContain('Цена: Цена с ТО (€)')
      expect(bg).not.toContain('Доставна цена')
      const en = text(buildStockReceiptHtml(fixture({ price: { kind: 'tier', tier: 'Доставна цена' }, locale: 'en' })).html)
      expect(en).toContain('Price: Trade-discount price (€)')
      expect(en).not.toContain('Доставна цена')
    })

    it('in the currency it was given, and without a mark when it has none', () => {
      expect(text(buildStockReceiptHtml(fixture({ currency: 'BGN' })).html)).toContain('Цена: Цена на едро (лв.)')
      const bare = text(buildStockReceiptHtml(fixture({ currency: '' })).html)
      expect(bare).toContain('Цена: Цена на едро ')
      expect(bare).not.toContain('Цена на едро (')
    })

    it('on every receipt of the bill', () => {
      const data = fixture()
      data.sections.push({ number: 'SM-2026-00042', date: new Date('2026-10-30T10:00:01Z'), warehouse: 'Склад Изток', lines: [{ name: 'ШАЙБА М8', unit: 'pcs', quantity: 40, unitPrice: 0.02 }] })
      expect(text(buildStockReceiptHtml(data).html).match(/Цена: Цена на едро \(€\)/g)).toHaveLength(2)
    })
  })

  it('prints a dash, in the price and in the value, for a line with no price at that level', () => {
    const data = fixture()
    data.sections[0].lines.push({ name: 'ШАЙБА М8 - DIN 125', unit: 'pcs', quantity: 40, unitPrice: null })
    const { html } = buildStockReceiptHtml(data)
    const rows = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>')).split('</tr>')
    const bare = rows.find((r) => r.includes('ШАЙБА'))!
    expect(bare).toContain('<td class="c-qty fit">40</td>')
    expect(bare).toContain('<td class="c-price fit">—</td>')
    expect(bare).toContain('<td class="c-amount fit">—</td>')
    // Nothing stands in for the missing price: no zero, and no figure borrowed from a neighbour.
    expect(bare).not.toMatch(/c-(price|amount) fit">[\d.]/)
    // The lines that do have the price keep theirs.
    expect(html).toContain('<td class="c-price fit">0.0472</td>')
    expect(html).toContain('<td class="c-amount fit">31.25</td>')
  })

  it('prints a booked price of nothing as the figure it is: a dash means „no price", not „zero"', () => {
    const data = fixture({ price: { kind: 'booked' } })
    data.sections[0].lines = [{ name: 'МОСТРА', unit: 'pcs', quantity: 3, unitPrice: 0 }]
    const { html } = buildStockReceiptHtml(data)
    expect(html).toContain('<td class="c-price fit">0.00</td>')
    expect(html).toContain('<td class="c-amount fit">0.00</td>')
  })

  it('carries no total, whichever price it shows and in whichever language', () => {
    for (const locale of ['bg', 'en', 'de', 'mk']) {
      for (const price of EVERY_PRICE) {
        const { html, css } = buildStockReceiptHtml(fixture({ locale, price }))
        const t = text(html)
        // 4.72 + 31.25: the figure the box used to hold.
        expect(t).not.toContain('35.97')
        expect(t).not.toMatch(/Общо|Total|Gesamt|Summe|Вкупно|ДДС|VAT|MwSt/i)
        expect(html).not.toContain('class="totals"')
        expect(css).not.toContain('totals')
      }
    }
    // Its string went with it.
    for (const locale of ['bg', 'en', 'de', 'mk']) expect(stockReceiptI18n(locale).label).not.toHaveProperty('total')
  })

  it('keeps each line\'s own value: only the total was taken off', () => {
    const { html } = buildStockReceiptHtml(fixture())
    expect(html.match(/class="c-amount fit">[\d.]+</g)).toHaveLength(2)
  })

  it('closes on the two signatures and the page foot', () => {
    const { html } = buildStockReceiptHtml(fixture())
    const t = text(html)
    expect(t).toContain('Предал:')
    expect(t).toContain('Приел:')
    expect(html).toContain('<div class="page-foot"><span>тел.: 000 000 000</span>')
    // With the total gone the signatures follow the lines directly.
    expect(html.indexOf('class="signatures"')).toBeGreaterThan(html.indexOf('</tbody>'))
  })

  it('prints one section per receipt, each on its own page', () => {
    const data = fixture()
    data.sections.push({ number: 'SM-2026-00042', date: new Date('2026-10-30T10:00:01Z'), warehouse: 'Склад Изток', lines: [{ name: 'ШАЙБА М8', unit: 'pcs', quantity: 40, unitPrice: 0.02 }] })
    const { html } = buildStockReceiptHtml(data)
    expect(html.match(/class="section-break"/g)).toHaveLength(1)
    expect(html.match(/СКЛАДОВА РАЗПИСКА/g)).toHaveLength(2)
    const second = html.slice(html.indexOf('section-break'))
    expect(second).toContain('SM-2026-00042')
    expect(second).toContain('Склад Изток')
    expect(second).not.toContain('БОЛТ')
    // Each receipt values its own lines: 40 × 0.02.
    expect(second).toContain('<td class="c-amount fit">0.80</td>')
    // The page foot is painted once; Chromium repeats it on every page.
    expect(html.match(/class="page-foot"/g)).toHaveLength(1)
  })

  it('marks the number of a bill not received yet: a draft\'s, which receiving replaces', () => {
    const t = text(buildStockReceiptHtml(fixture({ bill: { number: 'DRF-BILL-2026-00003', date: '2026-10-29T12:00:00Z', draft: true } })).html)
    expect(t).toContain('№ DRF-BILL-2026-00003 от 29.10.2026 (чернова)')
  })

  it('escapes what the catalog holds', () => {
    const data = fixture()
    data.sections[0].lines = [{ name: 'Кутия <5 & 6>', unit: 'pcs', quantity: 1, unitPrice: 1 }]
    const { html } = buildStockReceiptHtml(data)
    expect(html).toContain('Кутия &lt;5 &amp; 6&gt;')
  })

  it('speaks the other three languages, which keep their own name for it', () => {
    for (const locale of ['en', 'de', 'mk']) {
      const i18n = stockReceiptI18n(locale)
      const t = text(buildStockReceiptHtml(fixture({ locale, price: { kind: 'selling' } })).html)
      expect(t).toContain(i18n.title)
      expect(t).toContain(`${i18n.label.bill}: № BILL-2026-00017 ${i18n.label.of} 29.10.2026`)
      expect(t).toContain(`${i18n.label.price}: ${i18n.price.selling} (€)`)
      expect(t).toContain(`${i18n.label.handedOverBy}:`)
      expect(t).not.toContain('СКЛАДОВА РАЗПИСКА')
      expect(text(buildStockReceiptHtml(fixture({ locale, price: { kind: 'booked' } })).html)).toContain(`${i18n.label.price}: ${i18n.price.booked} (€)`)
    }
    // The rename is the Bulgarian name only.
    expect(stockReceiptI18n('en').title).toBe('GOODS RECEIPT')
    expect(stockReceiptI18n('de').title).toBe('WARENEINGANGSSCHEIN')
    expect(stockReceiptI18n('mk').title).toBe('ПРИЕМНИЦА')
    expect(stockReceiptI18n('bg').title).toBe('СКЛАДОВА РАЗПИСКА')
  })
})
