import { describe, it, expect } from 'bun:test'
import { parseTable } from 'services/biz/doc-import/parse-table'

/**
 * A MULTI-PAGE разписка in the wide layout, where the „Кол" heading wraps to „Ко" + „л".
 *
 * `parseTable` decided which pages hold a table by looking for the literal „Кол" — which that
 * header never spells on one line. No page matched, the multi-page branch was skipped, and the
 * whole document was parsed as ONE page, which stops at the first page trailer: page 1 was read and
 * every later page silently dropped (19 of stokrazp 3000016370's 37 rows). The document then failed
 * its own footer check — correctly — and fell to the model, which misread the wrapped quantities by
 * a factor of ten and put 12 products wrong on 2026-09-09.
 */
function row(...cells: Array<[number, string]>): string {
  let out = ''
  for (const [at, text] of cells) {
    if (out.length > at) throw new Error(`fixture overlap at ${at}: "${out}"`)
    out = out.padEnd(at, ' ') + text
  }
  return out
}

/** Header whose Кол/Цена/Стойност headings stack across rows, as the wide export prints them. */
const HEAD = [
  row([0, 'N'], [21, 'Име'], [46, 'М'], [52, 'Ко'], [60, 'Це'], [84, 'Сто']),
  row([0, 'o'], [46, 'я'], [52, 'л'], [60, 'на'], [84, 'йнос']),
  row([46, 'р'], [84, 'т']),
  row([46, '.']),
]
/** A row whose quantity wraps: "250" then "0.00" then "0" is 2500.000, not 250. */
const wrapped = (no: string, name: string, q1: string, q2: string, q3: string, price: string, val: string) => [
  row([0, no], [5, name], [46, 'Б'], [52, q1], [60, price], [84, val]),
  row([46, 'Р'], [52, q2]),
  row([52, q3]),
]

const PAGE1 = [
  ...HEAD,
  ...wrapped('1', 'БОЛТ М16Х80 - DIN 7991', '250', '0.00', '0', '0.8800', '2200.00'),
  '',
  row([64, '1/2']),
].join('\n')
const PAGE2 = [
  ...HEAD,
  ...wrapped('2', 'ШПЛЕНТ - 6.3Х45 - DIN94', '325', '0.00', '0', '0.1024', '332.80'),
  '',
  row([70, 'Крайна сума'], [90, '2532.80']),
].join('\n')
const TWO_PAGES = PAGE1 + '\f' + PAGE2

describe('multi-page разписка in the wide layout', () => {
  it('reads EVERY page, not just the first', () => {
    const t = parseTable(TWO_PAGES)
    expect(t.lines).toHaveLength(2)
    expect(t.lines.map(l => l.description)).toEqual([
      'БОЛТ М16Х80 - DIN 7991',
      'ШПЛЕНТ - 6.3Х45 - DIN94',
    ])
  })

  it('reassembles the wrapped quantities — 2500, not 250', () => {
    const t = parseTable(TWO_PAGES)
    expect(t.lines[0].quantity).toBe(2500)
    expect(t.lines[1].quantity).toBe(3250)
  })

  it('reconciles against the document total, so it never reaches the model', () => {
    const t = parseTable(TWO_PAGES)
    expect(t.ok).toBe(true)
    expect(t.reason).toBeUndefined()
    expect(t.footer).toBe(2532.80)
    const sum = t.lines.reduce((s, l) => s + (l.total ?? 0), 0)
    expect(+sum.toFixed(2)).toBe(2532.80)
  })

  it('still refuses when a page is genuinely unreadable', () => {
    // page 2 truncated mid-table: its value is missing, so the document cannot reconcile
    const broken = PAGE1 + '\f' + [...HEAD, row([0, '2'], [5, 'ШПЛЕНТ'], [46, 'Б'], [52, '325']), '', row([70, 'Крайна сума'], [90, '2532.80'])].join('\n')
    expect(parseTable(broken).ok).toBe(false)
  })
})

/**
 * A CONTINUATION page opens with the fragments of the row that straddles the page break: no name,
 * no complete row number — just digits sitting under the headings. Two things went wrong there.
 */
describe('a row straddling a page break', () => {
  /** Page 2 opens with a bare continuation fragment, then row 2. */
  const withOrphan = [
    ...HEAD,
    ...wrapped('1', 'БОЛТ М16Х80 - DIN 7991', '250', '0.00', '0', '0.8800', '2200.00'),
    '',
    row([64, '1/2']),
    '\f',
    ...HEAD,
    row([52, '0'], [60, '0']),                    // ← the orphan tail of the previous row
    ...wrapped('2', 'ШПЛЕНТ - 6.3Х45 - DIN94', '325', '0.00', '0', '0.1024', '332.80'),
    '',
    row([70, 'Крайна сума'], [90, '2532.80']),
  ].join('\n')

  it('does not fold the orphan digits into the HEADINGS', () => {
    // `Кол` became `Кол00` and `Цена` became `Цена9`, and since the price is looked up by the exact
    // label `Цена` it was then read as null — 47 of stokrazp 3000016398's 63 lines could not
    // reconcile, and the document fell to the model, which returned 18,695,071 units.
    const t = parseTable(withOrphan)
    expect(t.columns).toContain('Кол')
    expect(t.columns).toContain('Цена')
    expect(t.columns.some(c => /^Кол\d/.test(c) || /^Цена\d\d/.test(c))).toBe(false)
    expect(t.lines.every(l => l.printedPrice !== null)).toBe(true)
  })

  it('still numbers the rows, so they do not merge', () => {
    const t = parseTable(withOrphan)
    // Two distinct rows — not one row whose description is both names run together.
    expect(t.lines).toHaveLength(2)
    expect(t.lines[1].description).toBe('ШПЛЕНТ - 6.3Х45 - DIN94')
    expect(t.lines[1].quantity).toBe(3250)
  })
})

/**
 * A row that STRADDLES the page break. The printer does not care where a row ends: it fills the
 * page and finishes the same row at the top of the next one.
 */
describe('a row split across the page break is rejoined', () => {
  /**
   * Row 2 opens at the foot of page 1 — its number ("2") and first cells print there, the rest on
   * page 2. Read per page, its halves are nonsense: the tail has no name, and the head has only
   * part of its quantity.
   */
  const SPLIT = [
    ...HEAD,
    ...wrapped('1', 'БОЛТ М16Х80 - DIN 7991', '250', '0.00', '0', '0.8800', '2200.00'),
    // row 2 starts here and runs off the page: only its first physical line printed
    row([0, '2'], [5, 'ШПЛЕНТ - 6.3Х45 - DIN94'], [46, 'Б'], [52, '325'], [60, '0.1024'], [84, '332.80']),
    '',
    row([64, '1/2']),
    '\f',
    ...HEAD,
    row([46, 'Р'], [52, '0.00']),     // ← the rest of row 2's quantity: 325 + 0.00 + 0 = 3250.00
    row([52, '0']),
    '',
    row([70, 'Крайна сума'], [90, '2532.80']),
  ].join('\n')

  it('joins the halves into ONE row with the whole quantity', () => {
    const t = parseTable(SPLIT)
    expect(t.lines).toHaveLength(2)
    // not "ШПЛЕНТ …" with a truncated 325, and not a nameless extra row
    expect(t.lines[1].description).toBe('ШПЛЕНТ - 6.3Х45 - DIN94')
    expect(t.lines[1].quantity).toBe(3250)
  })

  it('reconciles the document, so it never reaches the model', () => {
    const t = parseTable(SPLIT)
    expect(t.ok).toBe(true)
    expect(t.reason).toBeUndefined()
    const sum = t.lines.reduce((s, l) => s + (l.total ?? 0), 0)
    expect(+sum.toFixed(2)).toBe(2532.80)
  })

  it('opens a row whose NUMBER is itself split by the break', () => {
    // Row 10's "1" prints at the foot of one page and its "0" at the head of the next. Without
    // this the row never opened and its line was appended to row 9, merging two products into one.
    const numberSplit = [
      ...HEAD,
      ...wrapped('9', 'БОЛТ М16Х80 - DIN 7991', '250', '0.00', '0', '0.8800', '2200.00'),
      row([0, '1'], [5, 'ШПЛЕНТ - 6.3Х45 - DIN94'], [46, 'Б'], [52, '325'], [60, '0.1024'], [84, '332.80']),
      '',
      row([64, '1/2']),
      '\f',
      ...HEAD,
      row([0, '0'], [46, 'Р'], [52, '0.00']),
      row([52, '0']),
      '',
      row([70, 'Крайна сума'], [90, '2532.80']),
    ].join('\n')
    const t = parseTable(numberSplit)
    expect(t.lines).toHaveLength(2)
    expect(t.lines[1].description).toBe('ШПЛЕНТ - 6.3Х45 - DIN94')
    expect(t.lines[1].quantity).toBe(3250)
    expect(t.ok).toBe(true)
  })

  it('leaves a page that opens with a real row alone', () => {
    const t = parseTable(TWO_PAGES)
    expect(t.lines).toHaveLength(2)
    expect(t.lines[0].quantity).toBe(2500)
    expect(t.lines[1].quantity).toBe(3250)
  })
})

describe('a document whose line values are DERIVED', () => {
  /**
   * Some корекция exports carry no Стойност column: each line value is qty × price, rounded to 2 dp,
   * while PlusMinus totals the unrounded products. Over 70 lines that is 0.07 of legitimate drift —
   * stokrazp 3000016398 was refused for exactly that, on a flat allowance of 0.05.
   */
  const noTotals = (rows: Array<[string, number, string]>, footer: string) => [
    row([0, 'N'], [21, 'Име'], [46, 'М'], [52, 'Кол'], [60, 'Цена'], [75, 'Забележка']),
    row([0, 'o'], [46, 'я']),
    ...rows.map(([name, i, qtyPrice], n) =>
      row([0, String(n + 1)], [5, name], [46, 'Б'], [52, qtyPrice.split('|')[0]], [60, qtyPrice.split('|')[1]])),
    '',
    row([60, 'Крайна сума'], [80, footer]),
  ].join('\n')

  // 3 × (3 × 0.015 = 0.045 → 0.05 printed) = 0.15, but the exact total is 0.135
  const DERIVED = noTotals([['ВИНТ А', 0, '3|0.0150'], ['ВИНТ Б', 0, '3|0.0150'], ['ВИНТ В', 0, '3|0.0150']], '0.14')

  it('allows half a cent of rounding per derived line', () => {
    const t = parseTable(DERIVED)
    expect(t.noTotals).toBe(true)
    expect(t.lines).toHaveLength(3)
    expect(t.ok).toBe(true)          // 0.15 vs 0.14 is 0.01 — inside 0.05 + 3 × 0.005
  })

  it('still refuses when the gap is more than rounding can explain', () => {
    const t = parseTable(noTotals([['ВИНТ А', 0, '3|0.0150']], '9.99'))
    expect(t.ok).toBe(false)
    expect(t.reason).toContain('document prints')
  })

  it('does NOT loosen a document that prints its line values', () => {
    // Стойност present: the sum must match the footer to the cent, which is what catches a
    // dropped line. 2532.80 vs a document printing 2533.00 is 0.20 — fine for derived values
    // over many lines, never fine here.
    const printed = [
      ...HEAD,
      ...wrapped('1', 'БОЛТ М16Х80 - DIN 7991', '250', '0.00', '0', '0.8800', '2200.00'),
      ...wrapped('2', 'ШПЛЕНТ - 6.3Х45 - DIN94', '325', '0.00', '0', '0.1024', '332.80'),
      '',
      row([70, 'Крайна сума'], [90, '2533.00']),
    ].join('\n')
    const t = parseTable(printed)
    expect(t.noTotals).toBeFalsy()
    expect(t.ok).toBe(false)
  })
})
