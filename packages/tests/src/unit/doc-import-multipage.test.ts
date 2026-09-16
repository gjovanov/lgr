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
