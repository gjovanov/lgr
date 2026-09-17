/**
 * A фактура that grants a discount prices its lines one way and charges another, and the parser
 * refused all three shapes of it — so every discounted invoice went to the model, which is where
 * invented quantities come from.
 *
 * PlusMinus has three, and they are NOT variations on one rule. Two of them move the money in
 * opposite directions, which is why a single "allow some slack" fix would have been wrong:
 *
 *   „ТО" column   (3000100960)  per line, printed beside the price. The VALUE is already net, so
 *                               the line fails its own arithmetic: 2 × 4.86 is 9.72, printed 9.23.
 *   „Отстъпка"    (3000101029)  once for the whole document, in the footer. Here the values are
 *                               GROSS, every line reconciles, and it is the document total that
 *                               fails: lines sum to 18.14 against a Данъчна основа of 16.32.
 *   nothing       (3000101088)  a customer tier price applied while the base price is printed.
 *                               No column, no footer line, no statement of any kind.
 *
 * All three are real documents of regal-pz, embedded verbatim from the table header to the last
 * footer row. The assertions are about the two things that must be true of any of them: the
 * QUANTITIES are what the paper says, and the line values sum to the total the paper charges.
 */
import { describe, it, expect } from 'bun:test'
import { parseTable } from 'services/biz/doc-import/parse-table'

/** фактура 3000100960 — 5% in a „ТО" column on every line. */
const TO_COLUMN = [
  "    No                              Име                               Мяр           Кол           Цена          ТО         Стойност",
  "1            260001 КОЗИ КРАК - 600ММ - ТМ                             БР                 1         11.25            5           10.69",
  "2            ЧЕТКА - ПЛАСТМ. - 1010- с дръжка                          БР                 1          3.20            5            3.04",
  "3            ЛОПАТА - ВЪГЛЕЩАРСКА - Г                                  БР                 2          4.86            5            9.23",
  "4            САП ЗА ЛОПАТА                                             БР                 2          3.83            5            7.29",
  "",
  "Словом : тридесет и шест евро и 30 цента                                        Данъчна основа                                 30.25 €",
  "                                                                                ДДС ( 20 % )                                    6.05 €",
  "                                                                                Сума за плащане                                36.30 €"
].join('\n')

/** фактура 3000101029 — one „Отстъпка ( 10.00% )" for the document. */
const FOOTER_DISCOUNT = [
  "    No                              Име                               Мяр           Кол            Цена          ТО         Стойност",
  "1            5476 ВИНКЕЛ - УСИЛЕН - 55Х70Х70                           БР                 10          0.68                         6.83",
  "2            8308160 СВРЕДЛО - SDS+ - 8Х160                            БР                  1          3.41                         3.41",
  "3            ВИНТ 5Х50                                                 БР                 50          0.02                         1.25",
  "4            ДЮБЕЛ - 8Х60                                              БР                 30          0.08                         2.50",
  "5            ГВОЗДЕИ 4.2/120                                           КГ                  3          1.38                         4.15",
  "",
  "Словом : деветнадесет евро и 59 цента                                           Сума преди отстъпка                              21.77",
  "                                                                                Отстъпка ( 10.00% )                               -2.18",
  "                                                                                Данъчна основа                                  16.32 €",
  "                                                                                ДДС ( 20 % )                                     3.27 €",
  "                                                                                Сума за плащане                                 19.59 €"
].join('\n')

/** фактура 3000101088 — 5% applied and stated nowhere. */
const UNSTATED = [
  "       No                              Име                               Мяр             Кол           Цена            Стойност",
  "1               ГРУНД - СЕЛТ - 22 кг - сив                               БР                       2      66.0419             125.48",
  "2               ДИСК - КАРБ. - 230Х2 - БУЛФЛЕКС                          БР                       7       1.4061               9.35",
  "",
  "Словом : сто шестдесет и едно евро и 80 цента                                   Данъчна основа                             134.83 €",
  "                                                                                ДДС ( 20 % )                                26.97 €",
  "                                                                                Сума за плащане                            161.80 €"
].join('\n')

const sum = (t: ReturnType<typeof parseTable>) => +t.lines.reduce((s, l) => s + (l.total ?? 0), 0).toFixed(2)

describe('a per-line „ТО" discount', () => {
  const t = parseTable(TO_COLUMN)

  it('is read instead of refused', () => {
    expect(t.ok).toBe(true)
    expect(t.reason).toBeUndefined()
    expect(t.discount).toEqual({ percent: 5, source: 'to' })
  })

  it('keeps the quantities the document prints', () => {
    expect(t.lines.map(l => l.quantity)).toEqual([1, 1, 2, 2])
  })

  it('charges the discounted value, not the price beside it', () => {
    // 2 × 4.86 would be 9.72; the document says 9.23 and that is what the customer owes
    expect(t.lines.map(l => l.total)).toEqual([10.69, 3.04, 9.23, 7.29])
    expect(t.lines[2].printedPrice).toBe(4.86)
    expect(t.lines[2].unitPrice).toBeCloseTo(4.615, 4)
  })

  it('adds up to the document total exactly', () => {
    expect(sum(t)).toBe(30.25)
    expect(t.footer).toBe(30.25)
  })
})

describe('a document-level „Отстъпка" in the footer', () => {
  const t = parseTable(FOOTER_DISCOUNT)

  it('is read instead of refused', () => {
    expect(t.ok).toBe(true)
    expect(t.discount).toEqual({ percent: 10, source: 'footer' })
  })

  it('is not fooled by „Сума преди отстъпка", which is pre-discount AND VAT-inclusive', () => {
    // 21.77 sits on the same physical line as „Словом" and would be a plausible-looking footer
    expect(t.footer).toBe(16.32)
  })

  it('keeps the quantities', () => {
    expect(t.lines.map(l => l.quantity)).toEqual([10, 1, 50, 30, 3])
  })

  it('spreads the reduction over the lines so they bill what the paper bills', () => {
    // undiscounted the lines are 6.83 + 3.41 + 1.25 + 2.50 + 4.15 = 18.14
    expect(sum(t)).toBe(16.32)
    expect(t.lines.every(l => (l.total ?? 0) > 0)).toBe(true)
  })
})

describe('a discount the document never states', () => {
  const t = parseTable(UNSTATED)

  it('is read, because one factor explains every line and the values still total', () => {
    expect(t.ok).toBe(true)
    expect(t.discount?.source).toBe('inferred')
    expect(t.discount?.percent).toBeCloseTo(5, 2)
  })

  it('keeps the quantities and the printed values', () => {
    expect(t.lines.map(l => l.quantity)).toEqual([2, 7])
    expect(t.lines.map(l => l.total)).toEqual([125.48, 9.35])
    expect(sum(t)).toBe(134.83)
  })

  it('reports the price actually charged, not the base price printed', () => {
    expect(t.lines[0].printedPrice).toBe(66.0419)
    expect(t.lines[0].unitPrice).toBeCloseTo(62.74, 4)
    expect(t.lines[1].unitPrice).toBeCloseTo(1.335714, 5)
  })

  it('refuses when only ONE line could vouch for the factor', () => {
    // a single line is trivially consistent with itself, so it proves nothing
    const oneLine = UNSTATED.split('\n').filter(l => !/^2\s/.test(l)).join('\n')
    expect(parseTable(oneLine).ok).toBe(false)
  })

  it('refuses when the lines do not agree on one factor', () => {
    // move a quantity: its line's ratio moves with it and no common factor survives
    const tampered = UNSTATED.replace(/(\s)7(\s+1\.4061)/, '$18$2')
    expect(tampered).not.toBe(UNSTATED)
    const bad = parseTable(tampered)
    expect(bad.ok).toBe(false)
    expect(bad.discount).toBeUndefined()
  })

  it('refuses when the lines no longer sum to the printed total', () => {
    // drop a line: the remaining one still has "a" factor, but the document total disagrees
    const short = UNSTATED.split('\n').filter(l => !/ДИСК - КАРБ/.test(l)).join('\n')
    expect(parseTable(short).ok).toBe(false)
  })
})

describe('the stated and the inferred rule agree', () => {
  /** 3000100960 with its „ТО" column blanked out — the same invoice, saying nothing about 5%. */
  const withoutTO = TO_COLUMN.split('\n')
    .map(l => (l.length > 122 ? l.slice(0, 110) + ' '.repeat(12) + l.slice(122) : l))
    .join('\n')

  it('reads the same invoice the same way whether or not it declares the discount', () => {
    const stated = parseTable(TO_COLUMN)
    const inferred = parseTable(withoutTO)
    expect(inferred.ok).toBe(true)
    expect(inferred.discount?.source).toBe('inferred')
    // the rate is recovered from rounded figures, so it lands near 5 rather than on it — but the
    // money, which is what is actually billed, comes out identical to the declared reading
    expect(inferred.discount?.percent).toBeCloseTo(5, 1)
    expect(inferred.lines.map(l => l.total)).toEqual(stated.lines.map(l => l.total))
    expect(inferred.lines.map(l => l.quantity)).toEqual(stated.lines.map(l => l.quantity))
  })
})

describe('what must NOT be mistaken for a discount', () => {
  it('never reads a ТО outside 0..100 as a percentage', () => {
    const silly = TO_COLUMN.replace(/(\s)5(\s+10\.69)/, '$1500$2')
    expect(silly).not.toBe(TO_COLUMN)
    expect(parseTable(silly).ok).toBe(false)
  })

  it('does not invent a discount for a document that simply fails to read', () => {
    // one value corrupted: no single factor explains the set, and nothing should paper over it
    const broken = UNSTATED.replace('125.48', '999.99')
    expect(broken).not.toBe(UNSTATED)
    const t = parseTable(broken)
    expect(t.ok).toBe(false)
    expect(t.discount).toBeUndefined()
  })
})
