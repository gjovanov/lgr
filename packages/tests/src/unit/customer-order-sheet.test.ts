import { describe, it, expect } from 'bun:test'
import { buildCustomerOrderMarkdown, CUSTOMER_ORDER_NOTE_MAX } from 'reporting/pdf/customer-order.pdf'
import { customerOrderI18n, type CustomerOrderCtx } from 'reporting/customer-order.i18n'
import { pageHtml } from 'reporting/pdf/base.pdf'

/**
 * The customer order's printed sheet, as markdown: what its title says per status, the head, the
 * two parties, the lines, the notes — and that no price, amount or total is on it, whatever the
 * order carries. The PDF itself is `integration/internal-order-print.flow.test.ts`.
 */

/** A confirmed order of two lines. Every figure that is a price is one no quantity or date repeats. */
function ctx(order: Record<string, any> = {}, over: Partial<CustomerOrderCtx> = {}): CustomerOrderCtx {
  return {
    order: {
      orderNumber: 'ORDI-2026-00042',
      status: 'confirmed',
      issueDate: new Date('2026-11-16T00:00:00Z'),
      requestedDeliveryDate: '2026-11-20T00:00:00.000Z',
      currency: 'EUR',
      exchangeRate: 1.95583,
      lines: [
        { productId: 'p1', description: 'ВИНТ М8Х25 - DIN 933', sku: 'TST-00001', quantity: 1000, unit: 'pcs', expectedUnitPrice: 7.31, pricePinned: true, taxRate: 19 },
        { productId: 'p2', description: '', quantity: 2.5, unit: '', expectedUnitPrice: 61.07 },
      ],
      ...order,
    },
    org: { name: 'ПРОБА ООД', taxId: '123456786', vatId: 'BG123456786', email: 'office@proba.test', phone: '+359 2 000 0000' },
    customer: { name: 'Клиент Едно ЕООД', taxId: '987654321', vatId: 'BG987654321', email: 'orders@klient.test', phone: '+359 88 000 0000' },
    productInfo: {
      p1: { name: 'каталожно име на първия', sku: 'CAT-1', unit: 'kg' },
      p2: { name: 'ГАЙКА М8 - DIN 934', sku: 'TST-00002', unit: 'kg' },
    },
    locale: 'bg',
    generatedAt: new Date('2026-11-16T09:00:00Z'),
    ...over,
  }
}

const md = (order: Record<string, any> = {}, over: Partial<CustomerOrderCtx> = {}) => buildCustomerOrderMarkdown(ctx(order, over))
/** A code as its cell holds it: kept on one line. */
const code = (text: string) => `<span class="one-line">${text}</span>`
const title = (text: string) => text.split('\n')[0]
/** The rows of the markdown's tables, as cells. A pipe written `\|` belongs to its cell. */
const tableRows = (text: string) => text.split('\n').filter((l) => l.startsWith('|'))
  .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim()))
/** The article rows: what follows the lines table's header and its rule. */
function lineRows(text: string) {
  const rows = tableRows(text)
  const header = rows.findIndex((r) => r[0] === '№')
  return rows.slice(header + 2)
}

describe('the customer order sheet: its title', () => {
  it('a draft is a draft, a cancelled order is cancelled, and every status from confirmed on is a confirmation', () => {
    expect(title(md({ status: 'draft' }))).toBe('# ПОРЪЧКА (ЧЕРНОВА)')
    expect(title(md({ status: 'cancelled' }))).toBe('# ПОРЪЧКА (ОТКАЗАНА)')
    for (const status of ['confirmed', 'partially_delivered', 'delivered', 'completed']) {
      expect({ status, title: title(md({ status })) }).toEqual({ status, title: '# ПОТВЪРЖДЕНИЕ НА ПОРЪЧКА' })
    }
  })

  it('a status it does not know is never called a confirmation', () => {
    expect(title(md({ status: 'on_hold' }))).toBe('# ПОРЪЧКА (ЧЕРНОВА)')
    expect(title(md({ status: undefined }))).toBe('# ПОРЪЧКА (ЧЕРНОВА)')
  })

  it('in each language', () => {
    const titles = (locale: string) => ['confirmed', 'draft', 'cancelled'].map((status) => title(md({ status }, { locale })))
    expect(titles('en')).toEqual(['# ORDER CONFIRMATION', '# ORDER (DRAFT)', '# ORDER (CANCELLED)'])
    expect(titles('de')).toEqual(['# AUFTRAGSBESTÄTIGUNG', '# AUFTRAG (ENTWURF)', '# AUFTRAG (STORNIERT)'])
    expect(titles('mk')).toEqual(['# ПОТВРДА НА НАРАЧКА', '# НАРАЧКА (НАЦРТ)', '# НАРАЧКА (ОТКАЖАНА)'])
    // A regional tag is its language; a language there is no table for prints in English.
    expect(titles('bg-BG')[0]).toBe('# ПОТВЪРЖДЕНИЕ НА ПОРЪЧКА')
    expect(titles('fr')[0]).toBe('# ORDER CONFIRMATION')
    expect(title(md({}, { locale: undefined }))).toBe('# ORDER CONFIRMATION')
  })
})

describe('the customer order sheet: its head', () => {
  it('the number, the date and the day the client asked for', () => {
    const text = md()
    expect(text).toContain('**Поръчка №** ORDI-2026-00042  \n')
    expect(text).toContain('**Дата:** 16.11.2026  \n')
    expect(text).toContain('**Желана дата на доставка:** 20.11.2026  \n')
  })

  it('a draft shows no number: its DRF- number goes when the order is confirmed', () => {
    const text = md({ status: 'draft', orderNumber: 'DRF-ORDI-2026-00007' })
    expect(text).not.toContain('DRF-ORDI-2026-00007')
    expect(text).not.toContain('Поръчка №')
    expect(text).toContain('**Дата:** 16.11.2026')
    expect(text).toContain('**Желана дата на доставка:** 20.11.2026')
  })

  it('a cancelled order keeps the number it was cancelled under', () => {
    expect(md({ status: 'cancelled' })).toContain('**Поръчка №** ORDI-2026-00042')
    expect(md({ status: 'cancelled', orderNumber: 'DRF-ORDI-2026-00007' })).toContain('**Поръчка №** DRF-ORDI-2026-00007')
  })

  it('a date is the calendar day it was stored as; one that is missing or unreadable is left out', () => {
    // 23:30 UTC is already the next day in Sofia: the sheet says the day the screens say.
    expect(md({ issueDate: new Date('2026-11-16T23:30:00Z') })).toContain('**Дата:** 16.11.2026')
    const text = md({ issueDate: 'not a date', requestedDeliveryDate: undefined })
    expect(text).not.toContain('**Дата:**')
    expect(text).not.toContain('Желана дата на доставка')
    expect(text).toContain('**Поръчка №** ORDI-2026-00042')
  })
})

describe('the customer order sheet: the two parties', () => {
  it('the supplier is the organization, the customer the contact, each with its numbers and how to reach it', () => {
    const rows = tableRows(md())
    expect(rows[0]).toEqual(['Доставчик', 'Клиент'])
    expect(rows[2]).toEqual([
      'ПРОБА ООД<br>ЕИК: 123456786<br>ИН по ДДС: BG123456786<br>Имейл: office@proba.test<br>Телефон: +359 2 000 0000',
      'Клиент Едно ЕООД<br>ЕИК: 987654321<br>ИН по ДДС: BG987654321<br>Имейл: orders@klient.test<br>Телефон: +359 88 000 0000',
    ])
  })

  it('what a party does not have is not printed, label and all', () => {
    const rows = tableRows(md({}, { org: { name: 'ПРОБА ООД', taxId: '123456786' }, customer: { name: 'Иван Иванов', email: '  ', phone: '0888 000 000' } }))
    expect(rows[2]).toEqual(['ПРОБА ООД<br>ЕИК: 123456786', 'Иван Иванов<br>Телефон: 0888 000 000'])
  })

  it('in each language', () => {
    expect(tableRows(md({}, { locale: 'en' }))[0]).toEqual(['Supplier', 'Customer'])
    expect(tableRows(md({}, { locale: 'de' }))[0]).toEqual(['Lieferant', 'Kunde'])
    expect(tableRows(md({}, { locale: 'mk' }))[0]).toEqual(['Добавувач', 'Купувач'])
    expect(tableRows(md({}, { locale: 'de' }))[2][1]).toBe('Клиент Едно ЕООД<br>Reg.-Nr.: 987654321<br>USt-IdNr.: BG987654321<br>E-Mail: orders@klient.test<br>Telefon: +359 88 000 0000')
  })
})

describe('the customer order sheet: its lines', () => {
  it('№, the article, the SKU, the quantity and the unit, the line\'s own words before the catalogue\'s', () => {
    const rows = tableRows(md())
    expect(rows[3]).toEqual(['№', 'Артикул', 'Код', 'Количество', 'Мярка'])
    expect(lineRows(md())).toEqual([
      // Its own description and SKU, although the catalogue has others; the unit as a Bulgarian form prints it.
      ['1', 'ВИНТ М8Х25 - DIN 933', code('TST-00001'), '1000', 'БР.'],
      // Nothing of its own: the article's name, SKU and unit.
      ['2', 'ГАЙКА М8 - DIN 934', code('TST-00002'), '2.5', 'КГ.'],
    ])
  })

  it('a code stays on one line, unless it is so long that it would push the table off the page', () => {
    const lines = [
      { productId: 'x', description: 'А', sku: 'ABCDEFGH-0123456789-XYZW', quantity: 1, unit: 'pcs' },
      { productId: 'x', description: 'Б', sku: 'ABCDEFGH-0123456789-XYZWV', quantity: 1, unit: 'pcs' },
      { productId: 'x', description: 'В', quantity: 1, unit: 'pcs' },
    ]
    // 24 characters, 25, and an article with no code at all.
    expect(lineRows(md({ lines })).map((r) => r[2])).toEqual([code('ABCDEFGH-0123456789-XYZW'), 'ABCDEFGH-0123456789-XYZWV', ''])
  })

  it('a quantity prints without trailing zeros, a unit nobody knows as it was typed', () => {
    const lines = [
      { productId: 'p1', description: 'А', quantity: 12.5, unit: 'ролка' },
      { productId: 'p1', description: 'Б', quantity: 0.125, unit: 'L' },
      { productId: 'p1', description: 'В', quantity: 3, unit: 'pcs' },
    ]
    expect(lineRows(md({ lines })).map((r) => [r[3], r[4]])).toEqual([['12.5', 'ролка'], ['0.125', 'Л.'], ['3', 'БР.']])
    expect(lineRows(md({ lines }, { locale: 'en' })).map((r) => r[4])).toEqual(['ролка', 'L', 'pcs'])
  })

  it('the headers in each language', () => {
    expect(tableRows(md({}, { locale: 'en' }))[3]).toEqual(['№', 'Article', 'SKU', 'Quantity', 'Unit'])
    expect(tableRows(md({}, { locale: 'de' }))[3]).toEqual(['№', 'Artikel', 'Art.-Nr.', 'Menge', 'Einheit'])
    expect(tableRows(md({}, { locale: 'mk' }))[3]).toEqual(['№', 'Артикл', 'Шифра', 'Количина', 'Мерка'])
  })
})

describe('the customer order sheet: no price, no amount, no total', () => {
  /** A word for a price, an amount or a total, in the four languages. */
  const MONEY_WORD = /цен|сума|стойност|общо|ддс \d|price|amount|total|value|preis|betrag|summe|gesamt|wert|износ|вкупно|вредност/i

  it('nothing the order holds about money reaches the page, pinned price or not', () => {
    for (const locale of ['bg', 'en', 'de', 'mk']) {
      const text = md({}, { locale })
      // The two unit prices, what each line comes to, the currency and its rate, the VAT rate.
      for (const figure of ['7.31', '7,31', '7310', '61.07', '61,07', '152.6', '152,6', 'EUR', '€', 'лв', '1.95583', '19']) {
        expect({ locale, figure, printed: text.includes(figure) }).toEqual({ locale, figure, printed: false })
      }
      expect({ locale, word: text.match(MONEY_WORD)?.[0] }).toEqual({ locale, word: undefined })
    }
  })

  it('every line row has the five columns and no sixth', () => {
    for (const locale of ['bg', 'en', 'de', 'mk']) {
      const rows = tableRows(md({}, { locale }))
      expect(rows.slice(3).map((r) => r.length)).toEqual([5, 5, 5, 5])
    }
  })

  it('no label of the sheet names one, in any language', () => {
    const keys = Object.keys(customerOrderI18n('en')).sort()
    for (const locale of ['bg', 'en', 'de', 'mk']) {
      const labels = customerOrderI18n(locale) as unknown as Record<string, string>
      expect(Object.keys(labels).sort()).toEqual(keys)
      for (const [key, label] of Object.entries(labels)) {
        expect({ locale, key, empty: !label.trim() }).toEqual({ locale, key, empty: false })
        expect({ locale, key, word: label.match(MONEY_WORD)?.[0] }).toEqual({ locale, key, word: undefined })
      }
    }
  })
})

describe('the customer order sheet: notes, terms and the foot', () => {
  it('the notes are cut at 500 characters, and the cut is marked', () => {
    const kept = 'н'.repeat(CUSTOMER_ORDER_NOTE_MAX)
    expect(CUSTOMER_ORDER_NOTE_MAX).toBe(500)
    const text = md({ notes: `${kept}ОПАШКА` })
    expect(text).toContain(`**Бележки:** ${kept}…\n`)
    expect(text).not.toContain('ОПАШКА')
    // Exactly 500: whole, and nothing says it was cut.
    const whole = md({ notes: kept })
    expect(whole).toContain(`**Бележки:** ${kept}\n`)
    expect(whole).not.toContain('…')
  })

  it('the terms are printed whole; an order without notes or terms prints neither label', () => {
    const terms = 'у'.repeat(700)
    expect(md({ terms })).toContain(`**Условия:** ${terms}\n`)
    const bare = md({ notes: '   ', terms: undefined })
    expect(bare).not.toContain('Бележки')
    expect(bare).not.toContain('Условия')
  })

  it('a note of several lines stays one paragraph, its lines broken where they were', () => {
    expect(md({ notes: 'Първи ред\r\nВтори ред\n\n  Трети ред  ' })).toContain('**Бележки:** Първи ред<br>Втори ред<br>Трети ред\n')
  })

  it('the foot says when it was made, under a rule', () => {
    expect(md().endsWith('\n\n---\n\n*Изготвено на: 16.11.2026*\n')).toBe(true)
    expect(md({}, { locale: 'en' })).toContain('*Generated on: 16.11.2026*')
    expect(md({}, { locale: 'de' })).toContain('*Erstellt am: 16.11.2026*')
    // Nobody said when: today.
    expect(md({}, { generatedAt: undefined })).toMatch(/\*Изготвено на: \d{2}\.\d{2}\.\d{4}\*\n$/)
  })
})

describe('the customer order sheet: what was typed is printed as text', () => {
  const typed = 'Болт <script>alert(1)</script> | *едро* _x_ [виж](http://e.test) `код` \\ ~~не~~ & <b>'
  const hostile = () => md(
    {
      lines: [{ productId: 'p1', description: typed, sku: 'A|B', quantity: 1, unit: 'pcs' }],
      notes: 'ред едно\n# не е заглавие\n| а | б |\n---\n<img src=x onerror=alert(1)>',
      terms: '1. първо\n- второ\n> трето',
    },
    { customer: { name: 'Клиент <img src=x onerror=alert(1)> | ООД', taxId: '1|2' } },
  )
  const textOf = (html: string) => html.replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

  it('a pipe does not open a column, in the markdown', () => {
    const rows = tableRows(hostile())
    expect(rows.map((r) => r.length)).toEqual([2, 2, 2, 5, 5, 5])
    expect(lineRows(hostile())[0][2]).toBe(code('A\\|B'))
  })

  it('no markup and no markdown of the text is obeyed, in the page', async () => {
    const html = await pageHtml(hostile())
    // The page's own structure, and nothing a stored value added to it.
    expect(html.match(/<h1/g)?.length).toBe(1)
    expect(html).not.toMatch(/<h[2-6]/)
    expect(html.match(/<table/g)?.length).toBe(2)
    expect(html.match(/<hr/g)?.length).toBe(1)
    expect(html.match(/<em>/g)?.length).toBe(1)
    for (const tag of ['<script', '<img', '<b>', '<code', '<del', '<ul', '<ol', '<li', '<blockquote']) {
      expect({ tag, found: html.includes(tag) }).toEqual({ tag, found: false })
    }

    const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1])
    // Two parties, then one line of five cells.
    expect(cells.length).toBe(7)
    expect(textOf(cells[1])).toBe('Клиент <img src=x onerror=alert(1)> | ООДЕИК: 1|2')
    expect(textOf(cells[3])).toBe(typed)
    expect(textOf(cells[4])).toBe('A|B')
    // The notes: every line of them, as text.
    expect(textOf(html)).toContain('Бележки: ред едно# не е заглавие| а | б |---<img src=x onerror=alert(1)>')
    expect(textOf(html)).toContain('Условия: 1. първо- второ> трето')
  })
})
