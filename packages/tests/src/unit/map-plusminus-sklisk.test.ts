/**
 * `mapSkliskDoc` against the shapes of real regal-pz write-offs (СИ, 2026-11-01 pull): a plain
 * document, a line with a decimal-comma price and NO `sum`, and the same refusals the transfer
 * mapper has (negative quantity, empty, no number).
 */
import { describe, it, expect } from 'bun:test'
import { mapSkliskDoc } from 'services/biz/doc-import/map-plusminus-sklisk'
import type { PlusMinusDocument } from 'services/biz/doc-import/map-plusminus-invoice'

const PLAIN: PlusMinusDocument = {
  date: '20261030',
  num: '00000001',
  header: { docDate: '20261030', docNumber: '135', doc: 'СИ', sum: '58.46' },
  lines: [
    { name: 'ТИКСО - ПРОЗР.', quantity: '12', measure: 'БР', price: '1', sum: '12' },
    { name: 'СТРЕЧ - ФОЛИО', quantity: '12', measure: 'БР', price: '3.8716500935', sum: '46.46' },
  ],
}

describe('mapSkliskDoc', () => {
  it('maps a plain write-off, keeping the number unpadded as PlusMinus stores it', () => {
    expect(mapSkliskDoc(PLAIN)).toEqual({
      number: '135', date: '2026-10-30', total: 58.46,
      lines: [
        { name: 'ТИКСО - ПРОЗР.', qty: 12, value: 12 },
        { name: 'СТРЕЧ - ФОЛИО', qty: 12, value: 46.46 },
      ],
    })
  })

  it('counts a line with no sum as zero value — PlusMinus\'s own header total does too', () => {
    // Real shape (СИ 135): the header total is the sum of the OTHER lines; the decimal-comma-priced
    // line has no sum and is not in it. Deriving price × qty = 0.8 would put Σvalue 0.8 over the
    // total and trip adjust-stock.ts's ±0.5 guard.
    const noSum: PlusMinusDocument = {
      ...PLAIN,
      header: { ...PLAIN.header, sum: '12' },
      lines: [
        { name: 'ТИКСО - ПРОЗР.', quantity: '12', price: '1', sum: '12' },
        { name: 'НОЖ   ТЕХНИЧЕСКИ   -   РЕЗЕРВ.   /10 бр./', quantity: '1', price: '0,8' },
      ],
    }
    const m = mapSkliskDoc(noSum)
    expect(m.lines[1]).toEqual({ name: 'НОЖ   ТЕХНИЧЕСКИ   -   РЕЗЕРВ.   /10 бр./', qty: 1, value: 0 })
    expect(m.lines.reduce((s, l) => s + l.value, 0)).toBeCloseTo(m.total, 2)
  })

  it('still moves the quantity of a line whose value is unknown', () => {
    const bare: PlusMinusDocument = { ...PLAIN, lines: [{ name: 'X', quantity: '3' }] }
    expect(mapSkliskDoc(bare).lines).toEqual([{ name: 'X', qty: 3, value: 0 }])
  })

  it('reads a decimal-comma sum', () => {
    const comma: PlusMinusDocument = { ...PLAIN, lines: [{ name: 'X', quantity: '2', sum: '0,8' }] }
    expect(mapSkliskDoc(comma).lines).toEqual([{ name: 'X', qty: 2, value: 0.8 }])
  })

  it('skips zero-quantity lines', () => {
    const withZero: PlusMinusDocument = { ...PLAIN, lines: [...PLAIN.lines, { name: 'Y', quantity: '0', sum: '0' }] }
    expect(mapSkliskDoc(withZero).lines.map(l => l.name)).toEqual(['ТИКСО - ПРОЗР.', 'СТРЕЧ - ФОЛИО'])
  })

  it('refuses a negative-quantity line rather than guessing a direction', () => {
    const negative: PlusMinusDocument = { ...PLAIN, lines: [{ name: 'X', quantity: '-6', sum: '10.61' }] }
    expect(() => mapSkliskDoc(negative)).toThrow(/negative quantity/)
  })

  it('refuses a document with no nonzero-quantity lines', () => {
    const empty: PlusMinusDocument = { ...PLAIN, lines: [{ name: 'X', quantity: '0', sum: '0' }] }
    expect(() => mapSkliskDoc(empty)).toThrow(/no lines with a nonzero quantity/)
  })

  it('refuses a document with no header.docNumber', () => {
    const bad: PlusMinusDocument = { date: '20261027', num: '1', header: { docDate: '20261027' }, lines: [] }
    expect(() => mapSkliskDoc(bad)).toThrow(/no header\.docNumber/)
  })

  it('refuses an unparseable date', () => {
    const bad: PlusMinusDocument = { ...PLAIN, header: { ...PLAIN.header, docDate: '30.10.2026' } }
    expect(() => mapSkliskDoc(bad)).toThrow(/unparseable docDate/)
  })

  it('matches a line on its stock ITEM, not the display alias', () => {
    const aliased: PlusMinusDocument = { ...PLAIN, lines: [{ name: 'alias text', item: 'СТОКИ:ТИКСО - ПРОЗР.', quantity: '2', sum: '2' }] }
    expect(mapSkliskDoc(aliased).lines[0].name).toBe('ТИКСО - ПРОЗР.')
  })
})
