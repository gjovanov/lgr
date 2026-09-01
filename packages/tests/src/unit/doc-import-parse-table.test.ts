import { describe, it, expect } from 'bun:test'
import { parseTable, draftFromLayoutText } from 'services/biz/doc-import/parse-table'

/**
 * The fixtures are built column-by-column rather than written as literals so the alignment the
 * parser depends on is explicit — and so no real supplier or product data lands in the repo.
 */
function row(...cells: Array<[number, string]>): string {
  let out = ''
  for (const [at, text] of cells) {
    if (out.length > at) throw new Error(`fixture overlap at ${at}: "${out}"`)
    out = out.padEnd(at, ' ') + text
  }
  return out
}

/** стокова разписка: 4-dp cost plus the Цена 1..2 sale tiers, headings split down four rows. */
function stockNote(body: string[], footer: number, supplier = '2000 КОРЕКЦИЯ'): string {
  return [
    row([52, 'СТОКОВА'], [90, 'Номер:']),
    row([92, 'Дата:']),
    row([100, '3000099001']),
    row([100, '27.08.2026']),
    row([52, 'РАЗПИСКА']),
    row([0, 'Склад / Магазин:'], [35, 'ТЕСТ СКЛАД'], [67, 'Доставчик:'], [88, supplier]),
    row([0, 'N'], [23, 'Име'], [47, 'М'], [52, 'Кол'], [59, 'Цен'], [69, 'Цен'], [79, 'Цен'], [87, 'Стой'], [96, 'Забележка']),
    row([0, 'o'], [47, 'я'], [60, 'а'], [70, 'а1'], [80, 'а2'], [87, 'ност']),
    row([47, 'р']),
    row([47, '.']),
    ...body,
    row([0, 'Словом: тест'], [70, 'Данъчна основа'], [90, footer.toFixed(2)]),
  ].join('\n')
}

describe('parse-table — PlusMinus layout reader', () => {
  it('reassembles a quantity that wraps across physical lines', () => {
    // -79 / 43. / 000 is ONE number, -7943. Read as its first fragment it books a hundredth of
    // the movement — the silent corruption this parser exists to prevent.
    const text = stockNote([
      row([0, '1'], [5, 'ТЕСТ БОЛТ М8'], [47, 'Б'], [52, '-79'], [59, '0.0'], [69, '0.0'], [79, '0.0'], [87, '-487.']),
      row([47, 'Р'], [52, '43.'], [59, '614'], [69, '383'], [79, '348'], [89, '70']),
      row([52, '000']),
    ], -487.70)

    const r = parseTable(text)
    expect(r.ok).toBe(true)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].quantity).toBe(-7943)
    expect(r.lines[0].unitPrice).toBe(0.0614)
    expect(r.lines[0].total).toBe(-487.7)
    expect(r.lines[0].prices).toEqual({ 'Цена': 0.0614, 'Цена 1': 0.0383, 'Цена 2': 0.0348 })
  })

  it('rejoins a product name that wraps, instead of running two words together', () => {
    // "… - М12 - НОРД" / "ЛОК" must not become "НОРДЛОК", which matches nothing in the catalog.
    const text = stockNote([
      row([0, '1'], [5, 'ШАЙБА - ЗАКОНТРЯЩА - М12 - НОРД'], [47, 'Б'], [52, '200'], [59, '1.0'], [69, '0.7'], [79, '0.5'], [87, '217.']),
      row([0, '5'], [5, 'ЛОК'], [47, 'Р'], [52, '.00'], [59, '891'], [69, '823'], [79, '369'], [89, '82']),
    ], 217.82)

    const r = parseTable(text)
    expect(r.ok).toBe(true)
    expect(r.lines[0].description).toBe('ШАЙБА - ЗАКОНТРЯЩА - М12 - НОРД ЛОК')
    expect(r.lines[0].quantity).toBe(200)
    expect(r.lines[0].total).toBe(217.82)
  })

  it('refuses the document when a line does not reconcile', () => {
    const text = stockNote([
      row([0, '1'], [5, 'ТЕСТ ГАЙКА'], [47, 'Б'], [52, '10'], [59, '1.0'], [87, '999.']),
      row([47, 'Р'], [59, '000'], [89, '99']),
    ], 999.99)   // 10 x 1.0 = 10, not 999.99

    const r = parseTable(text)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('reconcile')
    expect(draftFromLayoutText(text, 'goods_receipt')).toBeNull()   // → sidecar fallback
  })

  it('reads the exact unit price on a document that prints it rounded', () => {
    // A фактура prints Цена to 2 dp: 1000 x 0.01 = 10.00, but the line total is 7.70. Deriving the
    // quantity from the printed price is what booked 770 units instead of 1000 in production.
    const text = [
      row([70, 'ФАКТУРА'], [100, 'Номер:']),
      row([102, 'Дата:']),
      row([110, '3000099002']),
      row([110, '14.08.2026']),
      row([0, 'ПОЛУЧАТЕЛ'], [17, 'ТЕСТ КЛИЕНТ ООД'], [77, 'ДОСТАВЧИК'], [95, 'ТЕСТ ДОСТАВЧИК ООД']),
      row([0, 'ЕИК'], [17, '208610694'], [77, 'ЕИК'], [95, '112500982']),
      row([4, 'No'], [33, 'Име'], [66, 'Мяр'], [78, 'Кол'], [92, 'Цена'], [106, 'ТО'], [117, 'Стойност']),
      row([0, '1'], [13, 'ТЕСТ ВИНТ 4.2Х16'], [66, 'БР'], [79, '1000'], [92, '0.01'], [124, '7.70']),
      row([0, 'Словом : тест'], [80, 'Данъчна основа'], [120, '7.70 €']),
    ].join('\n')

    const r = parseTable(text)
    expect(r.ok).toBe(true)
    expect(r.lines[0].quantity).toBe(1000)
    expect(r.lines[0].printedPrice).toBe(0.01)      // what the document shows
    expect(r.lines[0].unitPrice).toBe(0.0077)       // what it actually means
    expect(r.lines[0].total).toBe(7.7)

    const draft = draftFromLayoutText(text, 'invoice')
    expect(draft?.extraction.document_number).toBe('3000099002')
    expect(draft?.extraction.issue_date).toBe('2026-08-14')
    expect(draft?.extraction.customer?.name).toBe('ТЕСТ КЛИЕНТ ООД')
    expect(draft?.extraction.supplier?.name).toBe('ТЕСТ ДОСТАВЧИК ООД')
    expect(draft?.extraction.line_items[0].quantity).toBe(1000)
  })

  it('carries the стокова разписка header into the draft', () => {
    const text = stockNote([
      row([0, '1'], [5, 'ТЕСТ БОЛТ'], [47, 'Б'], [52, '100'], [59, '0.5'], [87, '50.0']),
      row([47, 'Р'], [59, '000'], [89, '0']),
    ], 50.00)

    const draft = draftFromLayoutText(text, 'correction')
    expect(draft).not.toBeNull()
    expect(draft!.extraction.document_number).toBe('3000099001')
    expect(draft!.extraction.issue_date).toBe('2026-08-27')
    expect(draft!.extraction.correction).toBe(true)          // "2000 КОРЕКЦИЯ" supplier
    expect(draft!.extraction.warehouse_to).toBe('ТЕСТ СКЛАД')
    expect(draft!.engine).toBe('deterministic')              // never reached the sidecar
    expect(draft!.validation.status).toBe('valid')
  })

  it('parses a multi-page export whose header repeats with different geometry', () => {
    const page1 = stockNote([
      row([0, '1'], [5, 'ТЕСТ ПЪРВИ'], [47, 'Б'], [52, '10'], [59, '2.0'], [87, '20.0']),
      row([47, 'Р'], [59, '000'], [89, '0']),
    ], 20.00).split('\nСловом')[0]
    // page 2 is laid out two characters wider — pdftotext re-derives geometry per page
    const page2 = [
      row([0, 'N'], [25, 'Име'], [49, 'М'], [54, 'Кол'], [61, 'Цен'], [71, 'Цен'], [81, 'Цен'], [89, 'Стой']),
      row([0, 'o'], [49, 'я'], [62, 'а'], [72, 'а1'], [82, 'а2'], [89, 'ност']),
      row([0, '2'], [5, 'ТЕСТ ВТОРИ'], [49, 'Б'], [54, '5'], [61, '4.0'], [89, '20.0']),
      row([49, 'Р'], [61, '000'], [91, '0']),
      row([0, 'Словом: тест'], [70, 'Данъчна основа'], [90, '40.00']),
    ].join('\n')

    const r = parseTable(page1 + '\f' + page2)
    expect(r.ok).toBe(true)
    expect(r.lines.map(l => l.description)).toEqual(['ТЕСТ ПЪРВИ', 'ТЕСТ ВТОРИ'])
    expect(r.footer).toBe(40)
  })

  it('closes rows on the No column, so one wrapped name cannot swallow the rest of the table', () => {
    // Row 1's name wraps. Its FIRST physical line already reconciles (-1 x 2.8 = 2.80 is true
    // whether the digits continue "000" or not), so arithmetic alone closed the row early — and
    // the continuation digits then seeded a junk row that absorbed every line after it.
    const text = stockNote([
      row([0, '1'], [5, 'ТЕСТ МИСТРИЯ - 200ММ - ПЛ.ДР.-'], [47, 'Б'], [52, '-1.'], [59, '2.8'], [69, '2.5'], [87, '-2.80']),
      row([5, 'ОБЛА'], [47, 'Р'], [52, '000'], [59, '000'], [69, '000']),
      row([0, '2'], [5, 'ТЕСТ ВТОРИ'], [47, 'Б'], [52, '-1.'], [59, '2.5'], [69, '2.2'], [87, '-2.52']),
      row([47, 'Р'], [52, '000'], [59, '159'], [69, '497']),
    ], -5.32)

    const r = parseTable(text)
    expect(r.ok).toBe(true)
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0].description).toBe('ТЕСТ МИСТРИЯ - 200ММ - ПЛ.ДР.- ОБЛА')
    expect(r.lines[0].quantity).toBe(-1)
    expect(r.lines[1].description).toBe('ТЕСТ ВТОРИ')
    expect(r.lines[1].unitPrice).toBe(2.5159)
  })

  it('allows the rounding the printed price itself carries', () => {
    // 3000 x 0.0213 = 63.90, and the document prints 64.00 — because 0.0213 is a 4-dp rounding of
    // the real price. A half-ulp of the printed price, times the quantity, is legitimate slack.
    const text = stockNote([
      row([0, '1'], [5, 'ТЕСТ ШАЙБА'], [47, 'Б'], [52, '300'], [59, '0.0'], [87, '64.0']),
      row([47, 'Р'], [52, '0'], [59, '213'], [89, '0']),
    ], 64.00)

    const r = parseTable(text)
    expect(r.ok).toBe(true)
    expect(r.lines[0].quantity).toBe(3000)
    expect(r.lines[0].total).toBe(64)

    // …but the slack is proportional, so a genuinely wrong quantity is still refused: reading 300
    // instead of 3000 leaves a 57.61 gap against a tolerance of well under one lev.
    const wrong = stockNote([
      row([0, '1'], [5, 'ТЕСТ ШАЙБА'], [47, 'Б'], [52, '300'], [59, '0.0'], [87, '64.0']),
      row([47, 'Р'], [59, '213'], [89, '0']),
    ], 64.00)
    expect(parseTable(wrong).ok).toBe(false)
  })

  it('keeps a name that wraps under a single-row table, instead of reading it as a second row', () => {
    // The row reconciles on its FIRST physical line (2 x 3.13 = 6.26), so arithmetic alone closes
    // it and the rest of the name — "ABRE.D600", part of the product's identity — becomes a row of
    // its own. There is no row 2 to confirm the numbering with, so row 1 has to be enough.
    const text = [
      row([70, 'ФАКТУРА'], [100, 'Номер:']),
      row([102, 'Дата:']),
      row([110, '3000099003']),
      row([110, '14.08.2026']),
      row([0, 'ПОЛУЧАТЕЛ'], [17, 'ТЕСТ КЛИЕНТ ООД'], [77, 'ДОСТАВЧИК'], [95, 'ТЕСТ ДОСТАВЧИК ООД']),
      row([4, 'No'], [33, 'Име'], [66, 'Мяр'], [78, 'Кол'], [92, 'Цена'], [117, 'Стойност']),
      row([0, '1'], [13, 'ТЕСТ СПРЕЙ - ОБЕЗМАСЛЯВАНЕ -'], [66, 'БР'], [79, '2'], [92, '3.13'], [124, '6.26']),
      row([13, 'ABRE.D600']),
      row([0, 'Словом : тест'], [80, 'Данъчна основа'], [120, '6.26 €']),
    ].join('\n')

    const r = parseTable(text)
    expect(r.ok).toBe(true)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].description).toBe('ТЕСТ СПРЕЙ - ОБЕЗМАСЛЯВАНЕ - ABRE.D600')
    expect(r.lines[0].quantity).toBe(2)
  })

  it('follows the row numbering even when the number itself wraps down the column', () => {
    // The No column is narrow, so "10" arrives as "1" then "0" — read naively the sequence reads
    // 1, 2, …, 9, 1, 0 and stops looking numbered, which is what silently disabled the delimiter
    // on every document with ten or more lines.
    const body: string[] = []
    for (let n = 1; n <= 11; n++) {
      const wrapped = n >= 10
      body.push(row([0, wrapped ? '1' : String(n)], [5, `ТЕСТ ${n}`], [47, 'Б'], [52, '10'], [59, '1.0'], [87, '10.0']))
      body.push(row(...(wrapped ? [[0, String(n % 10)] as [number, string]] : []), [47, 'Р'], [59, '000'], [89, '0']))
    }
    const r = parseTable(stockNote(body, 110))
    expect(r.ok).toBe(true)
    expect(r.lines).toHaveLength(11)
    expect(r.lines[10].description).toBe('ТЕСТ 11')
    expect(r.lines.every((l) => l.quantity === 10)).toBe(true)
  })

  it('ignores a document it does not recognise', () => {
    expect(draftFromLayoutText('just some text with no table', 'invoice')).toBeNull()
    expect(draftFromLayoutText('', 'invoice')).toBeNull()
  })
})

/**
 * The 2026-08-31 export widened the разписка with two more price columns („Прод. цена" and
 * „Цена на едро"). Every remaining column got narrower, so pdftotext wrapped the HEADINGS across
 * five rows — „Кол" itself broke into „Ко"+„л" — and split each row's NUMBERS across up to three
 * lines. The parser found no columns at all and every receipt fell through to the model
 * (~53 s each; a 42-document day took ~37 minutes instead of a second).
 */
describe('стокова разписка — the wide layout with Прод. цена + Цена на едро', () => {
  const wide = [
    'N                      Име                       М     Ко     Це    Про    Це    Це       Це      Це    Це    Сто    Забележка',
    'o                                                я     л      на    д.     на    на       на      на    на    йнос',
    '                                                 р                  це     на    1        2       4     5       т',
    '                                                 .                  на     ед',
    '                                                                           ро',
    '1      ШЕГЕЛ - ОМЕГА - 8.5Т                       Б    4.0    13.   13.    16.   11.                          52.0',
    '                                                  Р    00     00    60     32    05                              0',
    '                                                              00                 00',
    '',
    'Словом: петдесет и две евро                                                               Данъчна основа                   52.00',
  ].join('\n')

  it('reads the wrapped headings and re-assembles the numbers split across rows', () => {
    const draft = draftFromLayoutText(wide, 'goods_receipt')
    expect(draft).not.toBeNull()
    const items = draft!.extraction.line_items!
    expect(items).toHaveLength(1)
    const it0: any = items[0]
    expect(it0.description).toBe('ШЕГЕЛ - ОМЕГА - 8.5Т')
    expect(it0.quantity).toBe(4)          // "4.0" + "00"
    expect(it0.unit_price).toBe(13)       // "13." + "00" + "00"
    expect(it0.total).toBe(52)            // and 4 × 13 = 52, which is what the document prints
  })

  it('keeps every price column apart, so the numbered tiers stay addressable', () => {
    const prices: any = (draftFromLayoutText(wide, 'goods_receipt')!.extraction.line_items![0] as any).prices
    expect(prices['Цена']).toBe(13)       // the delivery price — Цена × Кол = Стойност
    expect(prices['Цена 1']).toBe(11.05)  // the numbered sale tiers map straight onto the catalog slots
    // The two new columns are read as their own values, not folded into a neighbour.
    const wholesale = prices['Цена на едро'] ?? prices['Ценанаедро']
    const selling = prices['Прод. цена'] ?? prices['Прод.цена']
    expect(wholesale ?? selling).toBeGreaterThan(13)
  })
})

/**
 * What each price column MEANS, verified against the live catalog on 2026-08-31: „Цена" is the
 * Excel's „Дост. цена" (it equals the product's purchasePrice, avgCost and Доставна цена slot),
 * „Прод. цена" is what we sell for, and „Цена на едро" is the wholesale slot. Anchoring the price
 * columns on /^Цена/ dropped „Прод. цена" — the only column carrying the selling price.
 */
describe('разписка price columns', () => {
  const wide = [
    'N                      Име                       М     Ко     Це    Про    Це    Це       Це      Це    Це    Сто    Забележка',
    'o                                                я     л      на    д.     на    на       на      на    на    йнос',
    '                                                 р                  це     на    1        2       4     5       т',
    '                                                 .                  на     ед',
    '                                                                           ро',
    '1      ГАЙКА М8 - DIN 557 - КВАДР. - A2           Б    50.    0.0   0.0    0.0   0.0      0.0                  2.20',
    '                                                  Р    000    44    6      8     347      289',
    '',
    'Словом: два евро                                                                          Данъчна основа                    2.20',
  ].join('\n')

  it('captures Прод. цена alongside Цена and Цена на едро', () => {
    const prices: any = (draftFromLayoutText(wide, 'goods_receipt')!.extraction.line_items![0] as any).prices
    expect(prices['Цена']).toBe(0.044)        // Дост. цена — 50 × 0.044 = 2.20, the printed total
    expect(prices['Прод.цена']).toBe(0.06)    // what we sell for
    expect(prices['Ценанаедро']).toBe(0.08)   // the wholesale slot
    expect(prices['Цена 1']).toBe(0.0347)
    expect(prices['Цена 2']).toBe(0.0289)
  })
})

/**
 * The 2026-09-01 export moved again: the tier number is SPACED (`Цена 1`, not `Цена1`), some
 * корекция variants carry no Стойност column at all, and right-aligned figures drift so far past
 * their heading that the quantity lands inside the price cell.
 */
describe('стокова разписка — the spaced-tier layout with no Стойност column', () => {
  const spaced = [
    'No                    Име                    Мяр         Кол       Цена     Прод.      Цена     Цена 1       Цена 2   Забележка',
    '                                              .                             цена        на',
    '                                                                                       едро',
    '1      ПЛОМБИ                                КГ            4.374   13.850   14.580     17.50     11.400      11.700',
    '',
    'Словом: шестдесет евро и 58 цента                                                       Данъчна основа                      60.58',
  ].join(String.fromCharCode(10))

  it('keeps „Цена 1" as one heading instead of splitting it into two columns', () => {
    const draft = draftFromLayoutText(spaced, 'goods_receipt')
    expect(draft).not.toBeNull()
    const prices: any = (draft!.extraction.line_items![0] as any).prices
    expect(prices['Цена']).toBe(13.85)
    expect(prices['Цена 1']).toBe(11.4)
    expect(prices['Цена 2']).toBe(11.7)
  })

  it('derives the line value it does not print, and still checks it against the document total', () => {
    const items = draftFromLayoutText(spaced, 'goods_receipt')!.extraction.line_items!
    const it0: any = items[0]
    expect(it0.quantity).toBe(4.374)      // КГ — a fractional quantity is legitimate here
    expect(it0.unit_price).toBe(13.85)
    expect(it0.total).toBe(60.58)         // 4.374 x 13.85, and the document prints 60.58
  })
})

describe('фактура — a quantity that drifts into the price column', () => {
  const drifted = [
    '       No                              Име                               Мяр             Кол           Цена            Стойност',
    '1               ШПИЛКА - М36 - DIN 975 - K 8.8 - ZN                      БР                       1      33.3192              33.32',
    '2               ШАЙБА - М36 - DIN 125 - ZN                               БР                       4       0.4244               1.70',
    '',
    'Словом : тридесет и пет евро и 2 цента                                          Данъчна основа                              35.02',
  ].join(String.fromCharCode(10))

  it('splits „1      33.3192" back into a quantity and a price', () => {
    const items = draftFromLayoutText(drifted, 'invoice')!.extraction.line_items!
    expect(items).toHaveLength(2)
    expect((items[0] as any).quantity).toBe(1)        // not null, and the price is not 133.3192
    expect((items[0] as any).unit_price).toBe(33.3192)
    expect((items[1] as any).quantity).toBe(4)
    expect((items[1] as any).unit_price).toBe(0.4244)
  })
})

describe('a document that runs over two pages', () => {
  // Rows 1-2 on page one, rows 3-4 on page two, split by a form feed. Page one ends with the page
  // counter "1/2" — sitting under the Цена column, and with no totals line above it to stop the body.
  const twoPages = [
    '  No                Име                Мяр       Кол        Цена      Цена 1     Цена 2',
    '1     ВИНТ - 4.8Х32 - DIN 7504 К       БР      -507.000    0.0230     0.026     0.03',
    '2     ВИНТ - 5.5Х22 - DIN 7504 К       БР       -50.000    0.0373     0.041     0.05',
    '',
    '                                                 1/2',
    '\f  No                Име                Мяр       Кол        Цена      Цена 1     Цена 2',
    '3     ВИНТ - 6.3Х19 - DIN 7504 К       БР      -100.000    0.0300     0.034     0.04',
    '4     ВИНТ - 6.3Х25 - DIN 7504 К       БР        50.000    0.0500     0.056     0.06',
    '',
    'Словом : минус четиринадесет евро и 2 цента              Данъчна основа           -14.02',
  ].join(String.fromCharCode(10))

  it('reads the continuation page, whose rows are numbered from where page one stopped', () => {
    const items = draftFromLayoutText(twoPages, 'goods_receipt')!.extraction.line_items!
    expect(items).toHaveLength(4)                          // not 2 — page two was dropped entirely
    expect((items[2] as any).quantity).toBe(-100)
    expect((items[3] as any).quantity).toBe(50)
  })

  it('does not swallow the page counter into the last row of the page', () => {
    const items = draftFromLayoutText(twoPages, 'goods_receipt')!.extraction.line_items!
    // "0.0373" + "1/2" read as no price at all, and this row's value vanished from the sum.
    expect((items[1] as any).unit_price).toBe(0.0373)
    expect((items[1] as any).total).toBe(-1.86)
  })

  it('reconciles against the printed total once both pages are read', () => {
    const draft = draftFromLayoutText(twoPages, 'goods_receipt')
    expect(draft).not.toBeNull()                           // the arithmetic gate passed
    const sum = draft!.extraction.line_items!.reduce((a, l: any) => a + (l.total ?? 0), 0)
    expect(+sum.toFixed(2)).toBe(-14.02)
  })
})
