/**
 * A RETURN on the cash register can arrive with its quantity cell left EMPTY instead of negative.
 *
 * regal-pz's 2026-09-28 register prints „СВРЕДЛО - Ф16.5" with a value of -11.25 and a „% Кол-во"
 * of -0.07 — one unit's share of the day, negative — and nothing at all in the quantity column.
 * Read as zero, the 90 item rows then sum to 1450 against the sheet's own „Общо" of 1449, the
 * cross-check refuses the file, and the entire day of till sales goes unbooked: 1449 units across
 * ~90 products, every one of which would then show as a difference against the next export.
 *
 * The document supplies the missing number itself — it is the residual that makes the items
 * reproduce „Общо" — so this is a derivation, not a guess. What keeps it safe is that it may only
 * run when it cannot be ambiguous, which is what the refusal cases below pin down.
 */
import { describe, it, expect } from 'bun:test'
import ExcelJS from 'exceljs'
import { parseSalesAnalysis, XlsxParseError } from 'services/biz/doc-import/xlsx'

/** `null` for a quantity leaves the CELL empty, which is the case under test. */
async function book(items: Array<[string, number | null, number]>, total: [number, number]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  ws.getRow(1).getCell(1).value = 'АРТИКУЛИ'
  ws.getRow(2).getCell(1).value = 'ПЕРИОД: ДНЕС'
  ws.getRow(9).getCell(1).value = 'Артикул'
  ws.getRow(9).getCell(2).value = 'Количество'
  ws.getRow(9).getCell(3).value = 'Стойност'
  let r = 10
  // the tree export opens with a „СТОКИ" roll-up, which must stay excluded as a group row
  ws.getRow(r).getCell(1).value = 'СТОКИ'
  ws.getRow(r).getCell(2).value = total[0]
  ws.getRow(r).getCell(3).value = total[1]
  r++
  for (const [name, qty, value] of items) {
    ws.getRow(r).getCell(1).value = name
    if (qty !== null) ws.getRow(r).getCell(2).value = qty
    ws.getRow(r).getCell(3).value = value
    r++
  }
  ws.getRow(r).getCell(1).value = 'Общо'
  ws.getRow(r).getCell(2).value = total[0]
  ws.getRow(r).getCell(3).value = total[1]
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const RETURN = 'СВРЕДЛО - Ф16.5'

describe('a register line whose quantity cell is blank', () => {
  it('takes the quantity that makes the items reproduce Общо', async () => {
    const r = await parseSalesAnalysis(await book(
      [['РЪКАВИЦИ - MANA - 11', 5, 12.5], [RETURN, null, -11.25], ['ШКУРКА - ВОДНА - Р2000', 1, 0.46]],
      [5, 1.71],
    ))
    expect(r.rows).toHaveLength(3)
    expect(r.rows.find(x => x.name === RETURN)!.qty).toBe(-1)
    expect(r.rows.reduce((s, x) => s + x.qty, 0)).toBe(r.totalQty)
  })

  it('leaves a register with no blank cell exactly as it was', async () => {
    const r = await parseSalesAnalysis(await book(
      [['РЪКАВИЦИ - MANA - 11', 5, 12.5], [RETURN, -1, -11.25]], [4, 1.25],
    ))
    expect(r.rows.map(x => x.qty)).toEqual([5, -1])
  })

  it('refuses when TWO cells are blank — the split between them is unknowable', async () => {
    const p = parseSalesAnalysis(await book(
      [['РЪКАВИЦИ - MANA - 11', 5, 12.5], [RETURN, null, -11.25], ['ШКУРКА - ВОДНА - Р2000', null, -0.46]],
      [3, 0.79],
    ))
    let err: unknown
    try { await p } catch (e) { err = e }
    expect(err).toBeInstanceOf(XlsxParseError)
  })

  it('refuses when the residual contradicts the line it would be assigned to', async () => {
    // the value is NEGATIVE (a return), so a positive residual would make the sum work out for
    // the wrong reason — some other row is misread and this one is not the explanation
    const p = parseSalesAnalysis(await book(
      [['РЪКАВИЦИ - MANA - 11', 5, 12.5], [RETURN, null, -11.25]], [8, 1.25],
    ))
    let err: unknown
    try { await p } catch (e) { err = e }
    expect(err).toBeInstanceOf(XlsxParseError)
  })

  it('refuses when the VALUE column does not reconcile either', async () => {
    // then the quantity residual is not the only thing in doubt, so deriving it proves nothing
    const p = parseSalesAnalysis(await book(
      [['РЪКАВИЦИ - MANA - 11', 5, 12.5], [RETURN, null, -11.25]], [4, 99.99],
    ))
    let err: unknown
    try { await p } catch (e) { err = e }
    expect(err).toBeInstanceOf(XlsxParseError)
  })
})
