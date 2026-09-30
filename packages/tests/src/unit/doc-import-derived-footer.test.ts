/**
 * On a layout with no „Стойност" column the line values are DERIVED as `round2(qty × Цена)`, while
 * PlusMinus totals the products of its own UNROUNDED prices. Each line can therefore differ from
 * the document by the quantity times half a unit of the last place the price printed — which for a
 * big quantity is not a rounding artifact but pounds:
 *
 *   стокова разписка 3000016465 prints 16000 × 0.014 and 2400 × 0.0721, sums to 397.04 and states
 *   396.97. Sixteen thousand units at three decimal places are worth up to 8.00 of legitimate
 *   rounding; the document was refused over 0.07 against a flat allowance of 0.06. It was the fifth
 *   document in eight days lost to that one bound, and the only one that could not fall back either
 *   — the OCR sidecar answered 502 — so the day could not be booked at all.
 *
 * ⚠ The widened allowance costs the sum its role as a completeness check, so it is only granted
 * where something else provides one. `numbered` means the No column really spelled 1, 2, 3 … in
 * order, and the row walk opens a row only when the next number appears, so a dropped line breaks
 * the sequence and is caught structurally. An UNNUMBERED derived table keeps the tight allowance,
 * because there the sum is the only completeness check there is.
 */
import { describe, it, expect } from 'bun:test'
import { parseTable } from 'services/biz/doc-import/parse-table'

function row(...cells: Array<[number, string]>): string {
  let out = ''
  for (const [at, text] of cells) {
    if (out.length > at) throw new Error(`fixture overlap at ${at}: "${out}"`)
    out = out.padEnd(at, ' ') + text
  }
  return out
}

/** A разписка with NO Стойност column — quantity and price only, then the printed total. */
const derived = (footer: number, numbered = true) => [
  row([0, 'No'], [7, 'Име'], [40, 'Мяр'], [48, 'Кол'], [60, 'Цена'], [74, 'Прод.']),
  row([40, '.'], [74, 'цена']),
  row(...([numbered ? [0, '1'] : [0, '']] as Array<[number, string]>), [7, 'ВИНТ 5Х40'], [40, 'БР'], [48, '16000.000'], [60, '0.014'], [74, '0.030']),
  row(...([numbered ? [0, '2'] : [0, '']] as Array<[number, string]>), [7, 'ВИНТ - САМОПР. - 5.5Х90 - ПОКР.'], [40, 'БР'], [48, '2400.000'], [60, '0.0721'], [74, '0.140']),
  '',
  row([60, 'Крайна сума'], [80, footer.toFixed(2)]),
].join('\n')

describe('a derived-value table against its printed total', () => {
  it('accepts the rounding a big quantity at three decimal places really carries', () => {
    const t = parseTable(derived(396.97))
    expect(t.ok).toBe(true)
    expect(t.noTotals).toBe(true)
    expect(t.numbered).toBe(true)
    expect(t.lines.map(l => l.quantity)).toEqual([16000, 2400])
    // the sum the parser derives is 397.04; the document says 396.97 and both are right
    expect(t.lines.reduce((s, l) => s + (l.total ?? 0), 0)).toBeCloseTo(397.04, 2)
    expect(t.footer).toBeCloseTo(396.97, 2)
  })

  it('still refuses a total no amount of price rounding can reach', () => {
    // 16000 × 0.0005 + 2400 × 0.00005 is ~8.12; a footer 40 below the sum is a missing LINE
    const t = parseTable(derived(357.04))
    expect(t.ok).toBe(false)
    expect(t.reason).toMatch(/lines sum to/)
  })

  it('keeps the tight allowance when the rows are NOT numbered', () => {
    // nothing then vouches for completeness but the sum, so it may not be relaxed
    const t = parseTable(derived(396.97, false))
    expect(t.numbered).toBeFalsy()
    expect(t.ok).toBe(false)
  })

  it('leaves a table that PRINTS its values exact to the cent', () => {
    const printed = [
      row([0, 'No'], [7, 'Име'], [40, 'Мяр'], [48, 'Кол'], [60, 'Цена'], [80, 'Стойност']),
      row([0, '1'], [7, 'ВИНТ 5Х40'], [40, 'БР'], [48, '16000.000'], [60, '0.014'], [80, '224.00']),
      '',
      row([60, 'Крайна сума'], [80, '224.07']),
    ].join('\n')
    const t = parseTable(printed)
    expect(t.noTotals).toBeFalsy()
    // 0.07 off a PRINTED value is a real disagreement — the flat 0.05 still governs
    expect(t.ok).toBe(false)
  })
})
