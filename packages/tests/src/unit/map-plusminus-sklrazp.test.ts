/**
 * `mapSklrazpDoc` against the shape of regal-pz pulls: a one-line and a many-line
 * transfer to regal-sf, plus the negative-quantity refusal (never seen live, kept as a guard).
 */
import { describe, it, expect } from 'bun:test'
import { mapSklrazpDoc } from 'services/biz/doc-import/map-plusminus-sklrazp'
import type { PlusMinusDocument } from 'services/biz/doc-import/map-plusminus-invoice'

/** sklrazp_615810.json. */
const ONE_LINE: PlusMinusDocument = {
  date: '20261029',
  num: '00000496',
  header: { docDate: '20261029', docNumber: '615810', doc: 'СР', partner: 'ПАРТНЬОРИ:МАГАЗИН- ПРОБА - СОФИЯ', sum: '9.5' },
  lines: [
    { name: 'ГАЙКА М36 - DIN 985 -10 - ZN', quantity: '5', sum: '9.5' },
  ],
}

/** sklrazp_615809.json, 3 lines of a longer document. */
const MANY_LINES: PlusMinusDocument = {
  date: '20261029',
  num: '00000495',
  header: { docDate: '20261029', docNumber: '615809', doc: 'СР', partner: 'ПАРТНЬОРИ:МАГАЗИН- ПРОБА - СОФИЯ', sum: '900' },
  lines: [
    { name: 'БОЛТ М10Х45 - DIN 7991 - K8.8 - BL', quantity: '80', sum: '12' },
    { name: 'ИМБУС М6Х80 - DIN 912 - K8.8 - BL', quantity: '40', sum: '3' },
    { name: 'ИМБУС М8Х30 - DIN 912 - K12.9 - BL', quantity: '300', sum: '24' },
  ],
}

describe('mapSklrazpDoc', () => {
  it('maps a one-line transfer, stripping the ПАРТНЬОРИ: prefix for destination', () => {
    const m = mapSklrazpDoc(ONE_LINE)
    expect(m).toEqual({
      number: '615810', date: '2026-10-29', destination: 'МАГАЗИН- ПРОБА - СОФИЯ', total: 9.5,
      lines: [{ name: 'ГАЙКА М36 - DIN 985 -10 - ZN', qty: 5, value: 9.5 }],
    })
  })

  it('maps every line of a multi-line transfer', () => {
    const m = mapSklrazpDoc(MANY_LINES)
    expect(m.lines).toEqual([
      { name: 'БОЛТ М10Х45 - DIN 7991 - K8.8 - BL', qty: 80, value: 12 },
      { name: 'ИМБУС М6Х80 - DIN 912 - K8.8 - BL', qty: 40, value: 3 },
      { name: 'ИМБУС М8Х30 - DIN 912 - K12.9 - BL', qty: 300, value: 24 },
    ])
    expect(m.total).toBe(900)
  })

  it('refuses a negative-quantity line rather than guessing a direction', () => {
    const negative: PlusMinusDocument = { ...ONE_LINE, lines: [{ name: 'X', quantity: '-6', sum: '9.5' }] }
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

  it('matches a line on its stock ITEM — an alias missing the trailing dot must not leave the line unbooked', () => {
    const aliased: PlusMinusDocument = {
      ...ONE_LINE,
      lines: [{ name: 'ШАЙБА - ПОДЛ. - Ф6Х24 - Ш.П', item: 'СТОКИ:ШАЙБА - ПОДЛ. - Ф6Х24 - Ш.П.', quantity: '1000', sum: '10' }],
    }
    expect(mapSklrazpDoc(aliased).lines[0].name).toBe('ШАЙБА - ПОДЛ. - Ф6Х24 - Ш.П.')
  })
})
