/**
 * A PRICE-ONLY стокова разписка: an empty „Кол" column on every row and „Крайна сума 0.00".
 * PlusMinus issues these to restate prices — nothing is delivered.
 *
 * Every line failed the arithmetic gate (there is no quantity to reconcile against a value), so the
 * document was refused and handed to the model, which INVENTED quantities: stokrazp 3000016390 came
 * back with 1500 of each ИЗОЛИРБАНД against a real stock of ~13, and 29 of that day's 39 stock
 * differences were exactly those numbers.
 *
 * The fixture is built column-by-column, like the other parser fixtures, so the alignment the parser
 * depends on is explicit — and it reproduces the wide wrapping layout these documents actually use,
 * where every number is split across three physical rows.
 *
 * The booking side — that such a document produces NO movement — is asserted in
 * `integration/doc-import.flow.test.ts`, which has a database to match products against.
 */
import { describe, it, expect } from 'bun:test'
import { parseTable, draftFromLayoutText } from 'services/biz/doc-import/parse-table'

function row(...cells: Array<[number, string]>): string {
  let out = ''
  for (const [at, text] of cells) {
    if (out.length > at) throw new Error(`fixture overlap at ${at}: "${out}"`)
    out = out.padEnd(at, ' ') + text
  }
  return out
}

/** The real shape: headings stacked four rows deep, Кол empty, prices wrapping down their column. */
const PRICE_ONLY = [
  row([0, 'N'], [21, 'Име'], [46, 'М'], [52, 'Ко'], [59, 'Це'], [66, 'Про'], [77, 'Це'], [84, 'Сто']),
  row([0, 'o'], [46, 'я'], [52, 'л'], [59, 'на'], [66, 'д.'], [77, 'на'], [84, 'йнос']),
  row([46, 'р'], [66, 'це'], [77, '1'], [84, 'т']),
  row([46, '.'], [66, 'на']),
  row([0, '1'], [5, 'ИЗОЛИРБАНД - 20Х19 - ЖЪЛТО-ЗЕЛЕН'], [46, 'Б'], [59, '1.5'], [66, '1.5'], [77, '1.9']),
  row([46, 'Р'], [59, '00'], [66, '8'], [77, '65']),
  row([59, '0']),
  row([0, '2'], [5, 'ИЗОЛИРБАНД - 20Х19 - КАФЯВ'], [46, 'Б'], [59, '1.5'], [66, '1.5'], [77, '1.9']),
  row([46, 'Р'], [59, '00'], [66, '8'], [77, '65']),
  row([59, '0']),
  '',
  row([70, 'Крайна сума'], [90, '0.00']),
].join('\n')

/** The same table, but actually delivering something — must NOT be treated as price-only. */
const DELIVERS = [
  row([0, 'N'], [21, 'Име'], [46, 'М'], [52, 'Кол'], [59, 'Цена'], [84, 'Стойност']),
  row([0, 'o'], [46, 'я']),
  row([0, '1'], [5, 'ИЗОЛИРБАНД - 20Х19 - СИН'], [46, 'Б'], [52, '10'], [59, '1.5000'], [84, '15.00']),
  '',
  row([70, 'Крайна сума'], [90, '15.00']),
].join('\n')

describe('price-only стокова разписка', () => {
  it('is READ instead of refused, with every quantity zero', () => {
    const t = parseTable(PRICE_ONLY)
    expect(t.ok).toBe(true)
    expect(t.priceOnly).toBe(true)
    expect(t.reason).toBeUndefined()
    expect(t.lines).toHaveLength(2)
    expect(t.lines.map(l => l.quantity)).toEqual([0, 0])
    // the prices it exists to state are still read
    expect(t.lines[0].prices['Цена']).toBeCloseTo(1.5, 4)
  })

  it('produces a draft the pipeline can use, so the model is never called', () => {
    const draft = draftFromLayoutText(PRICE_ONLY, 'goods_receipt')
    expect(draft).not.toBeNull()
    expect(draft!.extraction.line_items).toHaveLength(2)
    expect(draft!.extraction.line_items!.every(l => l.quantity === 0)).toBe(true)
  })


  it('does not swallow a разписка that really delivers', () => {
    const t = parseTable(DELIVERS)
    expect(t.priceOnly).toBeFalsy()
    expect(t.ok).toBe(true)
    expect(t.lines[0].quantity).toBe(10)
  })

  it('stays refused when there is no footer to prove the document totals zero', () => {
    const noFooter = PRICE_ONLY.split('\n').filter(l => !/Крайна/.test(l)).join('\n')
    const t = parseTable(noFooter)
    expect(t.priceOnly).toBeFalsy()
    expect(t.ok).toBe(false)
    expect(draftFromLayoutText(noFooter, 'goods_receipt')).toBeNull()
  })
})
