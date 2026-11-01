/**
 * `mapStokrazpDoc` against real PlusMinus pulls: a plain receipt (regal-sf, tier fields
 * `price0`/`price9`), a mixed "2000 КОРЕКЦИЯ" receipt+correction (regal-pz, tier fields
 * `price1`/`price2`), and a whole-document return with an ordinary partner name (regal-sf).
 */
import { describe, it, expect } from 'bun:test'
import { mapStokrazpDoc } from 'services/biz/doc-import/map-plusminus-stokrazp'
import type { PlusMinusDocument } from 'services/biz/doc-import/map-plusminus-invoice'

/** stokrazp_2222036233.json verbatim (trimmed to 2 of its 4 lines) — regal-sf, price0/price9 tiers. */
const PLAIN_RECEIPT: PlusMinusDocument = {
  date: '20261027',
  num: '00000005',
  header: { docDate: '20261027', docNumber: '2222036233', doc: 'СТ', partner: 'ПАРТНЬОРИ:МАКСИМУМ СЕНТЕР ЕООД', sum: '132.11' },
  lines: [
    { item: 'СТОКИ:Стом. въже ф5 inox', name: 'Стом. въже ф5 inox', quantity: '30', measure: 'М', sum: '53.4', price: '1.78', price0: '1.78', price9: '0.76', retailPrice: '2', wholesalePrice: '2.4' },
    { item: 'СТОКИ:Полиестерен сапан 1т/3м', name: 'Полиестерен сапан 1т/3м', quantity: '4', measure: 'БР', sum: '18', price: '4.5', price0: '3.7', price9: '2.7', retailPrice: '5.25', wholesalePrice: '6.3' },
  ],
}

/** stokrazp_3000016618.json verbatim — regal-pz, "2000 КОРЕКЦИЯ" partner, mixed signs, price1/price2 tiers. */
const MIXED_CORRECTION: PlusMinusDocument = {
  date: '20261029',
  num: '00000064',
  header: { docDate: '20261029', docNumber: '3000016618', doc: 'СТ', partner: 'ПАРТНЬОРИ:2000 КОРЕКЦИЯ', sum: '-15.11' },
  lines: [
    { item: 'СТОКИ:БОЛТ М10Х150 - DIN 933 - А2', name: 'БОЛТ М10Х150 - DIN 933 - А2', quantity: '70', measure: 'БР', sum: '29.4', price: '0.42', price1: '0.3286', price2: '0.274', retailPrice: '0.46', wholesalePrice: '0.51' },
    { item: 'СТОКИ:БОЛТ М10Х160 - DIN 933 - A2', name: 'БОЛТ М10Х160 - DIN 933 - A2', quantity: '-50', measure: 'БР', sum: '-29.91', price: '0.5982', price1: '0.477', price2: '0.3988', retailPrice: '0.6647', wholesalePrice: '0.7976' },
    { item: 'СТОКИ:БОЛТ М10Х200 - DIN 933 - А2', name: 'БОЛТ М10Х200 - DIN 933 - А2', quantity: '-20', measure: 'БР', sum: '-14.6', price: '0.73', price1: '0.582', price2: '0.485', retailPrice: '0.8', wholesalePrice: '0.96' },
  ],
}

/** stokrazp_2222036216.json verbatim — regal-sf, ordinary partner "ДЕЧКО", ALL lines negative
 *  (a return to the supplier) — no "КОРЕКЦИЯ" text anywhere on the document. */
const WHOLE_DOC_RETURN: PlusMinusDocument = {
  date: '20261026',
  num: '00000001',
  header: { docDate: '20261026', docNumber: '2222036216', doc: 'СТ', partner: 'ПАРТНЬОРИ:ДЕЧКО', sum: '-33.23' },
  lines: [
    { name: 'СВРЕДЛО Ф13 - КОБАЛТ', quantity: '-1', price: '14.56671', sum: '-14.57' },
    { name: 'СВРЕДЛО Ф6 - КОБАЛТ', quantity: '-1', price: '2.81211', sum: '-2.81' },
  ],
}

describe('mapStokrazpDoc', () => {
  it('maps a plain receipt into receiptItems, with generic price<N> tiers and no adjustment lines', () => {
    const m = mapStokrazpDoc(PLAIN_RECEIPT)
    expect(m.docNumber).toBe('2222036233')
    expect(m.date).toBe('2026-10-27')
    expect(m.adjustmentLines).toEqual([])
    expect(m.receiptItems).toEqual([
      { name: 'Стом. въже ф5 inox', qty: 30, unit: 'm', cost: 1.78, selling: 2, tiers: { 'Цена 0': 1.78, 'Цена 9': 0.76, 'Цена на едро': 2.4 } },
      { name: 'Полиестерен сапан 1т/3м', qty: 4, unit: 'pcs', cost: 4.5, selling: 5.25, tiers: { 'Цена 0': 3.7, 'Цена 9': 2.7, 'Цена на едро': 6.3 } },
    ])
  })

  it('splits a mixed-sign document into receiptItems (positive) and adjustmentLines (negative, made positive), same docNumber for both halves', () => {
    const m = mapStokrazpDoc(MIXED_CORRECTION)
    expect(m.docNumber).toBe('3000016618')
    expect(m.receiptItems).toEqual([
      { name: 'БОЛТ М10Х150 - DIN 933 - А2', qty: 70, unit: 'pcs', cost: 0.42, selling: 0.46, tiers: { 'Цена 1': 0.3286, 'Цена 2': 0.274, 'Цена на едро': 0.51 } },
    ])
    expect(m.adjustmentLines).toEqual([
      { name: 'БОЛТ М10Х160 - DIN 933 - A2', qty: 50, value: 29.91 },
      { name: 'БОЛТ М10Х200 - DIN 933 - А2', qty: 20, value: 14.6 },
    ])
  })

  it('treats a whole document of negative lines as pure adjustmentLines, independent of the partner name', () => {
    const m = mapStokrazpDoc(WHOLE_DOC_RETURN)
    expect(m.receiptItems).toEqual([])
    expect(m.adjustmentLines).toEqual([
      { name: 'СВРЕДЛО Ф13 - КОБАЛТ', qty: 1, value: 14.57 },
      { name: 'СВРЕДЛО Ф6 - КОБАЛТ', qty: 1, value: 2.81 },
    ])
  })

  it('refuses a document with no header.docNumber', () => {
    const bad: PlusMinusDocument = { date: '20261027', num: '1', header: { docDate: '20261027' }, lines: [] }
    expect(() => mapStokrazpDoc(bad)).toThrow(/no header\.docNumber/)
  })

  it('drops a zero-quantity line without putting it on either side', () => {
    const doc: PlusMinusDocument = {
      ...PLAIN_RECEIPT,
      lines: [{ name: 'Note line', quantity: '0', price: '1' } as any],
    }
    const m = mapStokrazpDoc(doc)
    expect(m.receiptItems).toEqual([])
    expect(m.adjustmentLines).toEqual([])
  })

  it('books a line on its stock ITEM, not on the display alias typed over it', () => {
    const doc: PlusMinusDocument = {
      ...PLAIN_RECEIPT,
      lines: [
        { name: 'ГАЙКА М10 - DIN 985 - А2 - Gleitmo', item: 'СТОКИ:ГАЙКА М10 - DIN 985 - А2', quantity: '200', price: '0.05' } as any,
        { name: 'ПLAIN', quantity: '1', price: '1' } as any, // no item: the name is the fallback
      ],
    }
    const m = mapStokrazpDoc(doc)
    expect(m.receiptItems.map(i => i.name)).toEqual(['ГАЙКА М10 - DIN 985 - А2', 'ПLAIN'])
  })
})
