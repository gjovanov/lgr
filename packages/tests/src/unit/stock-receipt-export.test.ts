import { describe, it, expect } from 'bun:test'
import { buildStockReceiptHtml, type StockReceiptData } from 'reporting/pdf/stock-receipt.pdf'
import { stockReceiptI18n } from 'reporting/stock-receipt.i18n'

/**
 * „Стокова разписка" — the goods a supplier bill booked, printed from the bill: one section per
 * receipt movement, the bill named by OUR number and date, and no supplier on it at all.
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

describe('stock receipt print', () => {
  it('heads the page with its title, the receipt\'s number and date, its warehouse and OUR bill', () => {
    const { html } = buildStockReceiptHtml(fixture())
    const t = text(html)
    expect(html).toContain('<h1 class="doc-title">СТОКОВА РАЗПИСКА</h1>')
    expect(t).toContain('Номер: SM-2026-00041')
    expect(t).toContain('Дата: 30.10.2026')
    expect(t).toContain('Склад: Склад Център')
    expect(t).toContain('Входяща фактура: № BILL-2026-00017 от 29.10.2026')
    // No supplier block — it records what came into which warehouse, not who invoiced it.
    expect(t).not.toMatch(/доставчик/i)
    expect(t).not.toContain('ЕИК')
  })

  it('lists the lines: №, name, the unit as printed, quantity, price and value', () => {
    const { html } = buildStockReceiptHtml(fixture())
    const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'))
    for (const h of ['№', 'Наименование', 'Мярка', 'Количество', 'Цена', 'Стойност']) expect(head).toContain(`>${h}<`)
    // A fastener's price keeps its four decimals; a round one prints two.
    expect(html).toContain('<td class="c-price">0.0472</td>')
    expect(html).toContain('<td class="c-price">12.50</td>')
    // 100 × 0.0472 = 4.72; 2.5 × 12.50 = 31.25.
    expect(html).toContain('<td class="c-amount">4.72</td>')
    expect(html).toContain('<td class="c-amount">31.25</td>')
    expect(html).toContain('<td class="c-unit">БР.</td>')
    expect(html).toContain('<td class="c-unit">КГ.</td>')
    expect(html).toContain('<td class="c-qty">2.5</td>')
  })

  it('totals the printed values before VAT, in the bill\'s currency', () => {
    const t = text(buildStockReceiptHtml(fixture()).html)
    expect(t).toContain('Общо без ДДС: 35.97 €')
  })

  it('closes on the two signatures and the page foot', () => {
    const { html } = buildStockReceiptHtml(fixture())
    const t = text(html)
    expect(t).toContain('Предал:')
    expect(t).toContain('Приел:')
    expect(html).toContain('<div class="page-foot"><span>тел.: 000 000 000</span>')
  })

  it('prints one section per receipt, each on its own page', () => {
    const data = fixture()
    data.sections.push({ number: 'SM-2026-00042', date: new Date('2026-10-30T10:00:01Z'), warehouse: 'Склад Изток', lines: [{ name: 'ШАЙБА М8', unit: 'pcs', quantity: 40, unitPrice: 0.02 }] })
    const { html } = buildStockReceiptHtml(data)
    expect(html.match(/class="section-break"/g)).toHaveLength(1)
    expect(html.match(/СТОКОВА РАЗПИСКА/g)).toHaveLength(2)
    const second = html.slice(html.indexOf('section-break'))
    expect(second).toContain('SM-2026-00042')
    expect(second).toContain('Склад Изток')
    expect(second).not.toContain('БОЛТ')
    // Each receipt totals its own lines: 40 × 0.02.
    expect(text(second)).toContain('Общо без ДДС: 0.80 €')
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

  it('speaks the other three languages', () => {
    for (const locale of ['en', 'de', 'mk']) {
      const i18n = stockReceiptI18n(locale)
      const t = text(buildStockReceiptHtml(fixture({ locale })).html)
      expect(t).toContain(i18n.title)
      expect(t).toContain(`${i18n.label.bill}: № BILL-2026-00017 ${i18n.label.of} 29.10.2026`)
      expect(t).toContain(`${i18n.label.total}: 35.97 €`)
      expect(t).toContain(`${i18n.label.handedOverBy}:`)
      expect(t).not.toContain('СТОКОВА РАЗПИСКА')
    }
    expect(stockReceiptI18n('en').title).toBe('GOODS RECEIPT')
  })
})
