import { describe, it, expect } from 'bun:test'
import { matchSnapshot, snapshotRows } from '../../../../scripts/lib/snapshot-match'

type P = { name: string; sku: string; qty: number }
const product = (name: string, sku: string, qty: number): P => ({ name, sku, qty })
const run = (rows: Array<[string, number]>, products: P[]) =>
  matchSnapshot(rows.map(([name, qty]) => ({ name, qty })), products, p => p.qty)
const diffs = (m: ReturnType<typeof run>) =>
  Object.fromEntries(m.lines.filter(l => l.diff !== 0).map(l => [l.product.sku, l.diff]))

describe('snapshotRows', () => {
  it('drops the СТОКИ: prefix, keeps any other label, and reads a missing quantity as 0', () => {
    expect(snapshotRows({
      'СТОКИ:Болт М8': { quantity: '12.5' },
      'УСЛУГИ:Рязане': { quantity: '1' },
      'СТОКИ:Гайка М8': {},
    })).toEqual([
      { name: 'Болт М8', qty: 12.5 },
      { name: 'УСЛУГИ:Рязане', qty: 1 },
      { name: 'Гайка М8', qty: 0 },
    ])
  })
})

describe('matchSnapshot', () => {
  it('compares one product with its row, folding spacing and case', () => {
    const m = run([['БОЛТ  М8', 10]], [product('болт м8', 'A', 7)])
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0]).toMatchObject({ snapshotQty: 10, lgrQty: 7, diff: 3 })
    expect(m.twinNames).toBe(0)
  })

  it('sums the spellings of a row when LGR has only one product for them', () => {
    const m = run([['БОЛТ   М8', 4], ['БОЛТ М8', 6]], [product('БОЛТ М8', 'A', 10)])
    expect(diffs(m)).toEqual({})
    expect(m.lines[0].snapshotQty).toBe(10)
  })

  it('finds no difference on twins that each match their own spelling', () => {
    const m = run(
      [['ГВОЗДЕИ   2.8/60', 40], ['ГВОЗДЕИ 2.8/60', 0]],
      [product('ГВОЗДЕИ   2.8/60', 'OLD', 40), product('ГВОЗДЕИ 2.8/60', 'NEW', 0)],
    )
    expect(diffs(m)).toEqual({})
    expect(m.twinNames).toBe(1)
  })

  it('does not ask to raise the empty twin to the sum, whichever product comes last', () => {
    const rows: Array<[string, number]> = [['ГВОЗДЕИ   2.8/60', 40], ['ГВОЗДЕИ 2.8/60', 0]]
    const held = product('ГВОЗДЕИ   2.8/60', 'OLD', 40)
    const empty = product('ГВОЗДЕИ 2.8/60', 'NEW', 0)
    expect(diffs(run(rows, [held, empty]))).toEqual({})
    expect(diffs(run(rows, [empty, held]))).toEqual({})
  })

  it('shows a twin that was doubled, on the twin PlusMinus says is empty', () => {
    const m = run(
      [['ГВОЗДЕИ   2.8/60', 40], ['ГВОЗДЕИ 2.8/60', 0]],
      [product('ГВОЗДЕИ   2.8/60', 'OLD', 40), product('ГВОЗДЕИ 2.8/60', 'NEW', 40)],
    )
    expect(diffs(m)).toEqual({ NEW: -40 })
  })

  it('takes down an LGR fork of an article PlusMinus spells only one way', () => {
    const m = run([['Шайба М8', 100]], [product('Шайба М8', 'REAL', 60), product('шайба  м8', 'FORK', 40)])
    expect(diffs(m)).toEqual({ REAL: 40, FORK: -40 })
  })

  it('puts a row no product spells exactly on the biggest holder, once', () => {
    const m = run([['Шайба  М8', 100]], [product('шайба м8', 'SMALL', 10), product('ШАЙБА М8', 'BIG', 90)])
    expect(m.lines.find(l => l.product.sku === 'BIG')).toMatchObject({ snapshotQty: 100, diff: 10 })
    expect(m.lines.find(l => l.product.sku === 'SMALL')).toMatchObject({ snapshotQty: 0, diff: -10 })
  })

  it('gives a row to only one of two products spelled the same', () => {
    const m = run([['Шайба М8', 100]], [product('Шайба М8', 'A', 100), product('Шайба М8', 'B', 100)])
    expect(diffs(m)).toEqual({ B: -100 })
  })

  it('reports names only one side has, with the spellings of a missing name summed', () => {
    const m = run(
      [['Нов артикул', 5], ['Нов  артикул', 2], ['Общ', 1]],
      [product('Общ', 'A', 1), product('Стар артикул', 'B', 9), product('Стар  артикул', 'C', 3)],
    )
    expect(m.missing).toEqual([{ name: 'Нов артикул', qty: 7 }])
    expect(m.lgrOnly.map(p => p.sku)).toEqual(['B', 'C'])
    expect([...m.names].sort()).toEqual(['нов артикул', 'общ'])
  })

  it('rounds away float noise in a difference', () => {
    const m = run([['Тел', 0.3]], [product('Тел', 'A', 0.1 + 0.2)])
    expect(m.lines[0].diff).toBe(0)
  })
})
