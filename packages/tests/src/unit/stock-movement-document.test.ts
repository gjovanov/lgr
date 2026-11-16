import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStockMovementHtml, stockMovementNote, STOCK_MOVEMENT_NOTE_MAX, type StockMovementData } from 'reporting/pdf/stock-movement.pdf'
import { stockMovementI18n, stockMovementTitleKind } from 'reporting/stock-movement.i18n'

/**
 * A stock movement as a printed document (`reporting/pdf/stock-movement.pdf`): the layout, read off
 * the page's HTML, so nothing here launches Chromium.
 *
 * ⚠ It carries no price. A movement's `unitCost` is a cost figure not every role sees, and the sheet
 * leaves the org: the tests below hold that against the builder's input as well as its output.
 */

const PACKAGES = join(import.meta.dir, '..', '..', '..')
const LOCALES = ['en', 'bg', 'de', 'mk'] as const
const CATALOGS = LOCALES.map(locale => [locale, JSON.parse(readFileSync(join(PACKAGES, `ui-shared/src/locales/${locale}.json`), 'utf8'))] as const)

const base = (over: Partial<StockMovementData> = {}): StockMovementData => ({
  number: 'SM-2026-00042',
  date: '2026-11-16T00:00:00.000Z',
  type: 'transfer',
  from: { name: 'Main warehouse' },
  to: { name: 'Other site', external: true },
  lines: [
    { name: 'Bolt M8x25', unit: 'pcs', quantity: 16 },
    { name: 'Washer 8', unit: 'kg', quantity: 2.5 },
  ],
  locale: 'bg',
  ...over,
})

const html = (over: Partial<StockMovementData> = {}) => buildStockMovementHtml(base(over)).html
/** The text of the page, tags out: what a person reads. */
const text = (over: Partial<StockMovementData> = {}) => html(over).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('the title follows the type', () => {
  it('a receipt, a transfer and any other type, in Bulgarian', () => {
    expect(html({ type: 'receipt' })).toContain('<h1 class="doc-title">СТОКОВА РАЗПИСКА</h1>')
    expect(html({ type: 'transfer' })).toContain('<h1 class="doc-title">СКЛАДОВА РАЗПИСКА</h1>')
    for (const type of ['dispatch', 'adjustment', 'return', 'production_in', 'production_out']) {
      expect([type, html({ type }).includes('<h1 class="doc-title">ДОКУМЕНТ ЗА ДВИЖЕНИЕ НА СТОКИ</h1>')]).toEqual([type, true])
    }
  })

  it('and in English', () => {
    expect(html({ type: 'receipt', locale: 'en' })).toContain('<h1 class="doc-title">GOODS RECEIPT</h1>')
    expect(html({ type: 'transfer', locale: 'en' })).toContain('<h1 class="doc-title">STOCK TRANSFER NOTE</h1>')
    expect(html({ type: 'dispatch', locale: 'en' })).toContain('<h1 class="doc-title">STOCK MOVEMENT</h1>')
  })

  it('a type with no title of its own is named in a row, as the screens name it', () => {
    expect(text({ type: 'adjustment' })).toContain('Вид: Корекция')
    expect(text({ type: 'dispatch', locale: 'en' })).toContain('Type: Dispatch')
    // A receipt and a transfer say it in the title: no row repeats it.
    expect(text({ type: 'receipt' })).not.toContain('Вид:')
    expect(text({ type: 'transfer' })).not.toContain('Вид:')
  })

  it('names every type as the web catalogue does, in every language', () => {
    for (const [locale, catalog] of CATALOGS) {
      expect([locale, stockMovementI18n(locale).type]).toEqual([locale, catalog.warehouse.movementTypes])
    }
  })

  it('only a receipt and a transfer have a title of their own', () => {
    expect(stockMovementTitleKind('receipt')).toBe('receipt')
    expect(stockMovementTitleKind('transfer')).toBe('transfer')
    for (const type of ['dispatch', 'adjustment', 'return', 'production_in', 'production_out', '', undefined, null]) {
      expect(stockMovementTitleKind(type as any)).toBe('other')
    }
  })

  it('no language is left with another one\'s title', () => {
    const titles = LOCALES.map(l => JSON.stringify(stockMovementI18n(l).title))
    expect(new Set(titles).size).toBe(LOCALES.length)
  })
})

describe('the warehouses', () => {
  it('an external one is marked, on whichever side it stands', () => {
    expect(text()).toContain('От склад: Main warehouse Към склад: Other site (външен)')
    expect(text({ from: { name: 'Other site', external: true }, to: { name: 'Main warehouse' } }))
      .toContain('От склад: Other site (външен) Към склад: Main warehouse')
    expect(text({ locale: 'en' })).toContain('To warehouse: Other site (external)')
  })

  it('a warehouse of our own carries no mark', () => {
    const page = text({ to: { name: 'Second warehouse' } })
    expect(page).toContain('Към склад: Second warehouse')
    expect(page).not.toContain('външен')
  })

  it('a side the movement does not name has no row', () => {
    const receipt = text({ type: 'receipt', from: null })
    expect(receipt).not.toContain('От склад')
    expect(receipt).toContain('Към склад: Other site')
    expect(text({ type: 'dispatch', to: undefined })).not.toContain('Към склад')
  })
})

describe('what else the sheet says', () => {
  it('the number and the date', () => {
    const page = text()
    expect(page).toContain('Номер: SM-2026-00042')
    expect(page).toContain('Дата: 16.11.2026')
  })

  it('a draft says so beside its number, and a booked one does not', () => {
    expect(text({ draft: true })).toContain('Номер: SM-2026-00042 (чернова)')
    expect(text({ draft: true, locale: 'en' })).toContain('Number: SM-2026-00042 (draft)')
    expect(text({ draft: false })).not.toContain('чернова')
    expect(text()).not.toContain('чернова')
  })

  it('the partner, the reference and the note, each only when the movement has one', () => {
    const bare = text()
    for (const label of ['Контрагент', 'Основание', 'Забележка']) expect(bare).not.toContain(label)
    const full = text({ partner: 'Supplier Ltd', reference: 'sklrazp_0000012698', note: 'Handle with care' })
    expect(full).toContain('Контрагент: Supplier Ltd')
    expect(full).toContain('Основание: sklrazp_0000012698')
    expect(full).toContain('Забележка: Handle with care')
    // Blank is not a value.
    expect(text({ partner: '   ', reference: '', note: ' \n ' })).not.toContain('Контрагент')
  })

  it('the note is cut at 500 characters', () => {
    const long = 'a'.repeat(STOCK_MOVEMENT_NOTE_MAX + 250)
    expect(stockMovementNote(long)).toBe(`${'a'.repeat(STOCK_MOVEMENT_NOTE_MAX)}…`)
    expect(stockMovementNote('a'.repeat(STOCK_MOVEMENT_NOTE_MAX))).toBe('a'.repeat(STOCK_MOVEMENT_NOTE_MAX))
    const page = html({ note: long })
    expect(page).toContain(`${'a'.repeat(STOCK_MOVEMENT_NOTE_MAX)}…`)
    expect(page).not.toContain('a'.repeat(STOCK_MOVEMENT_NOTE_MAX + 1))
  })

  it('a note typed on several lines keeps them as breaks, never as lines of the page', () => {
    const page = html({ note: 'first line\n\nsecond line' })
    expect(page).toContain('first line<br>second line')
    // The page is handed to a Markdown renderer: a blank line inside the table would end it.
    expect(page.split('\n').every(line => line.trim().length > 0)).toBe(true)
  })

  it('whatever is typed is printed as text', () => {
    const page = html({ note: '<script>x</script>', partner: 'A & B <i>', to: { name: '<b>Site</b>', external: true }, lines: [{ name: '<img src=x>', quantity: 1 }] })
    // (The letterhead logo is the page's one `<img>`: the typed one is looked for by its source.)
    for (const raw of ['<script>', '<i>', '<b>Site', '<img src=x']) expect(page).not.toContain(raw)
    expect(page).toContain('&lt;script&gt;')
    expect(page).toContain('&lt;img src=x&gt;')
  })

  it('the two signature lines', () => {
    const page = text()
    expect(page).toContain('Предал:')
    expect(page).toContain('Приел:')
    expect(html().match(/class="sig-rule"/g)).toHaveLength(2)
  })

  it('the issuer line in the page foot', () => {
    expect(html({ footerText: 'тел.: 000 000' })).toContain('<div class="page-foot"><span>тел.: 000 000</span>')
  })
})

describe('the lines', () => {
  it('number, name, unit and quantity, in that order', () => {
    const page = html()
    const heads = [...page.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1])
    expect(heads).toEqual(['№', 'Наименование', 'Мярка', 'Количество'])
    const cells = [...page.matchAll(/<td class="c-no[^"]*">(\d+)<\/td>\s*<td>([^<]*)<\/td>\s*<td class="c-unit[^"]*">([^<]*)<\/td>\s*<td class="c-qty[^"]*">([^<]*)<\/td>/g)]
      .map(m => m.slice(1, 5))
    expect(cells).toEqual([['1', 'Bolt M8x25', 'БР.', '16'], ['2', 'Washer 8', 'КГ.', '2.5']])
  })

  it('⚠ no price and no total: the sheet leaves the org', () => {
    // A caller that hands the builder a movement's own lines hands it their costs too. None is printed.
    const withCosts = base({
      lines: [{ name: 'Bolt M8x25', unit: 'pcs', quantity: 16, unitCost: 1234.5678, totalCost: 19753.08 } as any],
      ...({ totalAmount: 19753.08 } as any),
    })
    for (const locale of LOCALES) {
      const page = buildStockMovementHtml({ ...withCosts, locale }).html
      expect(page).not.toContain('1234')
      expect(page).not.toContain('19753')
      expect(page).not.toMatch(/c-price|c-amount/)
      expect([...page.matchAll(/<th[\s>]/g)]).toHaveLength(4)
      const i18n: any = stockMovementI18n(locale)
      expect(Object.keys(i18n.header).sort()).toEqual(['lineNo', 'name', 'quantity', 'unit'])
    }
  })
})
