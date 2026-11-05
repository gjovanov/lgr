/**
 * `mapStokrazpDoc` against the shapes of PlusMinus pulls: a plain receipt (regal-sf, tier fields
 * `price0`/`price9`), a mixed "2000 КОРЕКЦИЯ" receipt+correction (regal-pz, tier fields
 * `price1`/`price2`), and a whole-document return with an ordinary partner name (regal-sf).
 */
import { describe, it, expect } from 'bun:test'
import { mapStokrazpDoc } from 'services/biz/doc-import/map-plusminus-stokrazp'
import type { PlusMinusDocument } from 'services/biz/doc-import/map-plusminus-invoice'

/** stokrazp_2222639233.json, 2 lines — regal-sf shape, price0/price9 tiers. */
const PLAIN_RECEIPT: PlusMinusDocument = {
  date: '20261027',
  num: '00000005',
  header: { docDate: '20261027', docNumber: '2222639233', doc: 'СТ', partner: 'ПАРТНЬОРИ:ТЕСТ СЕНТЕР ЕООД', sum: '60' },
  lines: [
    { item: 'СТОКИ:Стом. въже ф5 inox', name: 'Стом. въже ф5 inox', quantity: '20', measure: 'М', sum: '30', price: '1.5', price0: '1.5', price9: '0.7', retailPrice: '1.8', wholesalePrice: '2.1' },
    { item: 'СТОКИ:Полиестерен сапан 1т/3м', name: 'Полиестерен сапан 1т/3м', quantity: '5', measure: 'БР', sum: '20', price: '4', price0: '3.2', price9: '2.4', retailPrice: '4.8', wholesalePrice: '5.6' },
  ],
}

/** stokrazp_3000619618.json — regal-pz shape, "2000 КОРЕКЦИЯ" partner, mixed signs, price1/price2 tiers. */
const MIXED_CORRECTION: PlusMinusDocument = {
  date: '20261029',
  num: '00000064',
  header: { docDate: '20261029', docNumber: '3000619618', doc: 'СТ', partner: 'ПАРТНЬОРИ:2000 КОРЕКЦИЯ', sum: '-20' },
  lines: [
    { item: 'СТОКИ:БОЛТ М10Х150 - DIN 933 - А2', name: 'БОЛТ М10Х150 - DIN 933 - А2', quantity: '50', measure: 'БР', sum: '20', price: '0.4', price1: '0.3', price2: '0.25', retailPrice: '0.44', wholesalePrice: '0.5' },
    { item: 'СТОКИ:БОЛТ М10Х160 - DIN 933 - A2', name: 'БОЛТ М10Х160 - DIN 933 - A2', quantity: '-40', measure: 'БР', sum: '-24', price: '0.6', price1: '0.48', price2: '0.4', retailPrice: '0.66', wholesalePrice: '0.8' },
    { item: 'СТОКИ:БОЛТ М10Х200 - DIN 933 - А2', name: 'БОЛТ М10Х200 - DIN 933 - А2', quantity: '-20', measure: 'БР', sum: '-16', price: '0.8', price1: '0.64', price2: '0.5', retailPrice: '0.88', wholesalePrice: '1' },
  ],
}

/** stokrazp_2222639216.json — regal-sf shape, ordinary partner "ПРИМЕРЕН ДОСТАВЧИК", ALL lines negative
 *  (a return to the supplier) — no "КОРЕКЦИЯ" text anywhere on the document. */
const WHOLE_DOC_RETURN: PlusMinusDocument = {
  date: '20261026',
  num: '00000001',
  header: { docDate: '20261026', docNumber: '2222639216', doc: 'СТ', partner: 'ПАРТНЬОРИ:ПРИМЕРЕН ДОСТАВЧИК', sum: '-15' },
  lines: [
    { name: 'СВРЕДЛО Ф13 - КОБАЛТ', quantity: '-1', price: '12.34567', sum: '-12.35' },
    { name: 'СВРЕДЛО Ф6 - КОБАЛТ', quantity: '-1', price: '2.65432', sum: '-2.65' },
  ],
}

/** A price-only разписка: no `quantity` at all, and a zero total. Regal-pz's shape, made up. */
const PRICE_ONLY: PlusMinusDocument = {
  date: '20261102',
  num: '00000001',
  header: { docDate: '20261102', docNumber: '3000619634', doc: 'СТ', sum: '0' },
  lines: [
    { item: 'СТОКИ:ПОП-НИТ 4х16', name: 'ПОП-НИТ 4х16', measure: 'БР', sum: '0', price: '0.11', price1: '0.09', price2: '0.08', retailPrice: '0.25', wholesalePrice: '0.3' },
    { item: 'СТОКИ:ПОП-НИТ 4х20', name: 'ПОП-НИТ 4х20', measure: 'БР', sum: '0', price: '0.12' },
  ],
}

describe('mapStokrazpDoc', () => {
  it('keeps a line with no quantity when it restates a selling price or a tier, and says nothing else', () => {
    const m = mapStokrazpDoc(PRICE_ONLY)
    expect(m.receiptItems).toEqual([])
    expect(m.adjustmentLines).toEqual([])
    expect(m.priceOnlyItems).toEqual([
      { name: 'ПОП-НИТ 4х16', qty: 0, unit: 'pcs', cost: 0.11, selling: 0.25, tiers: { 'Цена 1': 0.09, 'Цена 2': 0.08, 'Цена на едро': 0.3 } },
    ])
  })

  it('a document with quantities has no price-only lines unless a line lacks one', () => {
    expect(mapStokrazpDoc(PLAIN_RECEIPT).priceOnlyItems).toEqual([])
    const mixed = mapStokrazpDoc({ ...PRICE_ONLY, lines: [...PRICE_ONLY.lines, { name: 'БОЛТ', quantity: '5', price: '1', retailPrice: '2' }] })
    expect(mixed.receiptItems.map(i => i.name)).toEqual(['БОЛТ'])
    expect(mixed.priceOnlyItems.map(i => i.name)).toEqual(['ПОП-НИТ 4х16'])
  })

  it('maps a plain receipt into receiptItems, with generic price<N> tiers and no adjustment lines', () => {
    const m = mapStokrazpDoc(PLAIN_RECEIPT)
    expect(m.docNumber).toBe('2222639233')
    expect(m.date).toBe('2026-10-27')
    expect(m.adjustmentLines).toEqual([])
    expect(m.receiptItems).toEqual([
      { name: 'Стом. въже ф5 inox', qty: 20, unit: 'm', cost: 1.5, selling: 1.8, tiers: { 'Цена 0': 1.5, 'Цена 9': 0.7, 'Цена на едро': 2.1 } },
      { name: 'Полиестерен сапан 1т/3м', qty: 5, unit: 'pcs', cost: 4, selling: 4.8, tiers: { 'Цена 0': 3.2, 'Цена 9': 2.4, 'Цена на едро': 5.6 } },
    ])
  })

  it('splits a mixed-sign document into receiptItems (positive) and adjustmentLines (negative, made positive), same docNumber for both halves', () => {
    const m = mapStokrazpDoc(MIXED_CORRECTION)
    expect(m.docNumber).toBe('3000619618')
    expect(m.receiptItems).toEqual([
      { name: 'БОЛТ М10Х150 - DIN 933 - А2', qty: 50, unit: 'pcs', cost: 0.4, selling: 0.44, tiers: { 'Цена 1': 0.3, 'Цена 2': 0.25, 'Цена на едро': 0.5 } },
    ])
    expect(m.adjustmentLines).toEqual([
      { name: 'БОЛТ М10Х160 - DIN 933 - A2', qty: 40, value: 24 },
      { name: 'БОЛТ М10Х200 - DIN 933 - А2', qty: 20, value: 16 },
    ])
  })

  it('treats a whole document of negative lines as pure adjustmentLines, independent of the partner name', () => {
    const m = mapStokrazpDoc(WHOLE_DOC_RETURN)
    expect(m.receiptItems).toEqual([])
    expect(m.adjustmentLines).toEqual([
      { name: 'СВРЕДЛО Ф13 - КОБАЛТ', qty: 1, value: 12.35 },
      { name: 'СВРЕДЛО Ф6 - КОБАЛТ', qty: 1, value: 2.65 },
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

  it('leaves a line whose prices agree with each other alone', () => {
    for (const doc of [PLAIN_RECEIPT, MIXED_CORRECTION, PRICE_ONLY]) expect(mapStokrazpDoc(doc).priceWarnings).toEqual([])
  })

  it('does not write a tier the item card holds with a leading-zero typo, and says so', () => {
    // "0150" was meant as 0.150; Number() reads 150. Made-up values, the shape of a real card.
    const m = mapStokrazpDoc({
      ...PLAIN_RECEIPT,
      lines: [{ name: 'БОЛТ М10Х80 - DIN 933 - 10.9 - BL', quantity: '200', measure: 'БР', price: '0.2', price1: '0150', price2: '0.13', retailPrice: '0.22', wholesalePrice: '0.26' } as any],
    })
    expect(m.receiptItems).toEqual([
      { name: 'БОЛТ М10Х80 - DIN 933 - 10.9 - BL', qty: 200, unit: 'pcs', cost: 0.2, selling: 0.22, tiers: { 'Цена 2': 0.13, 'Цена на едро': 0.26 } },
    ])
    // The median of 0.13, 0.2, 0.22, 0.26 and 150.
    expect(m.priceWarnings).toEqual([
      { name: 'БОЛТ М10Х80 - DIN 933 - 10.9 - BL', field: 'price1', raw: '0150', value: 150, reference: 0.22, ratio: 150 / 0.22, held: true },
    ])
  })

  it('holds a selling price or a tier that is a decimal point too LOW as well', () => {
    const m = mapStokrazpDoc({
      ...PLAIN_RECEIPT,
      lines: [
        { name: 'ВИНТ 4Х70', quantity: '1000', price: '0.013', price0: '0.0002', price1: '0.012', price2: '0.009', retailPrice: '0.025', wholesalePrice: '0.03' } as any,
        { name: 'ВИНТ 5.5Х45 - DIN 7981', quantity: '500', price: '0.05', price1: '0.04', price2: '0.035', retailPrice: '0055', wholesalePrice: '0.066' } as any,
      ],
    })
    const [a, b] = m.receiptItems
    expect(a.selling).toBe(0.025)
    expect(a.tiers).toEqual({ 'Цена 1': 0.012, 'Цена 2': 0.009, 'Цена на едро': 0.03 })
    expect(b.selling).toBeUndefined() // "0055": the product keeps its selling price
    expect(b.tiers).toEqual({ 'Цена 1': 0.04, 'Цена 2': 0.035, 'Цена на едро': 0.066 })
    expect(m.priceWarnings.map(w => [w.name, w.field, w.held])).toEqual([
      ['ВИНТ 4Х70', 'price0', true],
      ['ВИНТ 5.5Х45 - DIN 7981', 'retailPrice', true],
    ])
  })

  it('reports a delivery price that is off but keeps it, since it is the receipt unit cost', () => {
    const m = mapStokrazpDoc({
      ...PLAIN_RECEIPT,
      lines: [{ name: 'ВИНТ 5Х50 - ТХ', quantity: '100', price: '0.3', price1: '0.025', price2: '0.02', retailPrice: '0.04', wholesalePrice: '0.048' } as any],
    })
    expect(m.receiptItems[0].cost).toBe(0.3)
    expect(m.receiptItems[0].selling).toBe(0.04)
    expect(m.priceWarnings).toHaveLength(1)
    expect(m.priceWarnings[0]).toMatchObject({ field: 'price', held: false })
    expect(m.priceWarnings[0].ratio).toBeCloseTo(0.3 / 0.04, 6)
  })

  it('with only two prices, judges the selling price against the delivery price', () => {
    const m = mapStokrazpDoc({ ...PLAIN_RECEIPT, lines: [{ name: 'ШАЙБА М6', quantity: '10', price: '0.05', retailPrice: '0055' } as any] })
    expect(m.receiptItems[0].selling).toBeUndefined()
    expect(m.priceWarnings).toMatchObject([{ field: 'retailPrice', reference: 0.05, held: true }])
    // A single price has nothing to be judged against.
    expect(mapStokrazpDoc({ ...PLAIN_RECEIPT, lines: [{ name: 'ШАЙБА М6', quantity: '10', price: '55' } as any] }).priceWarnings).toEqual([])
  })

  it('still drops a price-only line once every price on it is held', () => {
    const m = mapStokrazpDoc({ ...PRICE_ONLY, lines: [{ name: 'ПОП-НИТ 4х16', sum: '0', price: '0.11', price1: '0.09', retailPrice: '11' } as any] })
    expect(m.priceOnlyItems).toEqual([{ name: 'ПОП-НИТ 4х16', qty: 0, unit: 'pcs', cost: 0.11, tiers: { 'Цена 1': 0.09 } }])
    expect(m.priceWarnings.map(w => w.field)).toEqual(['retailPrice'])
    const allHeld = mapStokrazpDoc({ ...PRICE_ONLY, lines: [{ name: 'ПОП-НИТ 4х20', sum: '0', price: '0.12', retailPrice: '12' } as any] })
    expect(allHeld.priceOnlyItems).toEqual([])
    expect(allHeld.priceWarnings).toHaveLength(1)
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
