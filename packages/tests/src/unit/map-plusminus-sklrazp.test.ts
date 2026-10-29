/**
 * `mapSklrazpDoc` against real regal-pz pulls (2026-10-28/29): a one-line and a many-line
 * transfer to regal-sf, plus the negative-quantity refusal (never seen live, kept as a guard).
 */
import { describe, it, expect } from 'bun:test'
import { mapSklrazpDoc } from 'services/biz/doc-import/map-plusminus-sklrazp'
import type { PlusMinusDocument } from 'services/biz/doc-import/map-plusminus-invoice'

/** sklrazp_12810.json verbatim. */
const ONE_LINE: PlusMinusDocument = {
  date: '20261029',
  num: '00000496',
  header: { docDate: '20261029', docNumber: '12810', doc: 'СР', partner: 'ПАРТНЬОРИ:МАГАЗИН- РЕГАЛ - СОФИЯ', sum: '10.61' },
  lines: [
    { name: 'ГАЙКА М36 - DIN 985 -10 - ZN', quantity: '6', sum: '10.61' },
  ],
}

/** sklrazp_12809.json verbatim (trimmed to 3 of its 23 lines). */
const MANY_LINES: PlusMinusDocument = {
  date: '20261029',
  num: '00000495',
  header: { docDate: '20261029', docNumber: '12809', doc: 'СР', partner: 'ПАРТНЬОРИ:МАГАЗИН- РЕГАЛ - СОФИЯ', sum: '1203.64' },
  lines: [
    { name: 'БОЛТ М10Х45 - DIN 7991 - K8.8 - BL', quantity: '100', sum: '13.8' },
    { name: 'ИМБУС М6Х80 - DIN 912 - K8.8 - BL', quantity: '50', sum: '3.46' },
    { name: 'ИМБУС М8Х30 - DIN 912 - K12.9 - BL', quantity: '400', sum: '28.64' },
  ],
}

describe('mapSklrazpDoc', () => {
  it('maps a one-line transfer, stripping the ПАРТНЬОРИ: prefix for destination', () => {
    const m = mapSklrazpDoc(ONE_LINE)
    expect(m).toEqual({
      number: '12810', date: '2026-10-29', destination: 'МАГАЗИН- РЕГАЛ - СОФИЯ', total: 10.61,
      lines: [{ name: 'ГАЙКА М36 - DIN 985 -10 - ZN', qty: 6, value: 10.61 }],
    })
  })

  it('maps every line of a multi-line transfer', () => {
    const m = mapSklrazpDoc(MANY_LINES)
    expect(m.lines).toEqual([
      { name: 'БОЛТ М10Х45 - DIN 7991 - K8.8 - BL', qty: 100, value: 13.8 },
      { name: 'ИМБУС М6Х80 - DIN 912 - K8.8 - BL', qty: 50, value: 3.46 },
      { name: 'ИМБУС М8Х30 - DIN 912 - K12.9 - BL', qty: 400, value: 28.64 },
    ])
    expect(m.total).toBe(1203.64)
  })

  it('refuses a negative-quantity line rather than guessing a direction', () => {
    const negative: PlusMinusDocument = { ...ONE_LINE, lines: [{ name: 'X', quantity: '-6', sum: '10.61' }] }
    expect(() => mapSklrazpDoc(negative)).toThrow(/negative quantity/)
  })

  it('refuses a document with no nonzero-quantity lines', () => {
    const empty: PlusMinusDocument = { ...ONE_LINE, lines: [{ name: 'X', quantity: '0', sum: '0' }] }
    expect(() => mapSklrazpDoc(empty)).toThrow(/no lines with a nonzero quantity/)
  })

  it('refuses a document with no header.docNumber', () => {
    const bad: PlusMinusDocument = { date: '20261027', num: '1', header: { docDate: '20261027' }, lines: [] }
    expect(() => mapSklrazpDoc(bad)).toThrow(/no header\.docNumber/)
  })
})
