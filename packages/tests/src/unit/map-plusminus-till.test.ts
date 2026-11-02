/**
 * `aggregateTillDay` against two till transactions in the regal-sf shape (`storeOperations_624499`
 * and `storeOperations_624472`) plus the gap the second one exposed: one line in 200 carried no
 * `sum` at all.
 */
import { describe, it, expect } from 'bun:test'
import { aggregateTillDay } from 'services/biz/doc-import/map-plusminus-till'
import type { PlusMinusDocument } from 'services/biz/doc-import/map-plusminus-invoice'

/** storeOperations_624499.json — one line, ordinary case. */
const TXN_624499: PlusMinusDocument = {
  date: '20261027',
  num: '00000515',
  header: { vatPercent: '20', docDate: '20261027', vatRate: '20', vat: '0.3', docNumber: '624499', doc: 'СР', paid: '1.8', sum: '1.8' },
  lines: [
    { item: 'СТОКИ:Гайка М12х36 - DIN6334 Zn - дълга', no: '1', name: 'Гайка М12х36 - DIN6334 Zn - дълга', quantity: '3', measure: 'БР', sum: '1.5', price: '0.5', sumWithVat: '1.8' },
  ],
}

/** storeOperations_624472.json — its first line has NO sum/price/sumWithVat at all
 * (a giveaway); the transaction's header.sum is fully accounted for by its second line alone. */
const TXN_624472_WITH_ZERO_LINE: PlusMinusDocument = {
  date: '20261027',
  num: '00000099',
  header: { vatPercent: '20', docDate: '20261027', vatRate: '20', vat: '0.15', docNumber: '624472', doc: 'СР', paid: '0.9', sum: '0.9' },
  lines: [
    { item: 'СТОКИ:ВИНТ - САВОПР. - 4.2Х45 - DIN 7504 N', no: '1', name: 'ВИНТ - САВОПР. - 4.2Х45 - DIN 7504 N', quantity: '20', measure: 'БР' },
    { item: 'СТОКИ:ВИНТ 4.2Х19 ШИР.ПЕР.', no: '2', name: 'ВИНТ 4.2Х19 ШИР.ПЕР.', quantity: '30', measure: 'БР', sum: '0.75', price: '0.025', sumWithVat: '0.9' },
  ],
}

/** A second transaction selling the SAME product as TXN_624499, to prove aggregation sums rather than overwrites. */
const TXN_REPEAT_PRODUCT: PlusMinusDocument = {
  date: '20261027',
  num: '00000900',
  header: { vatPercent: '20', docDate: '20261027', vat: '0.4', doc: 'СР', sum: '2.4' },
  lines: [
    { item: 'СТОКИ:Гайка М12х36 - DIN6334 Zn - дълга', name: 'Гайка М12х36 - DIN6334 Zn - дълга', quantity: '4', sum: '2' },
  ],
}

describe('aggregateTillDay', () => {
  it('returns an empty aggregate for an empty day, without throwing', () => {
    expect(aggregateTillDay([])).toEqual({ rows: [], totalQty: 0, totalValueNet: 0, totalValueGross: 0 })
  })

  it('aggregates one transaction into one row per product', () => {
    const agg = aggregateTillDay([TXN_624499])
    expect(agg.rows).toEqual([{ name: 'Гайка М12х36 - DIN6334 Zn - дълга', qty: 3, value: 1.5 }])
    expect(agg.totalValueGross).toBe(1.8)
  })

  it('sums quantity and value across transactions selling the same product, rather than overwriting', () => {
    const agg = aggregateTillDay([TXN_624499, TXN_REPEAT_PRODUCT])
    expect(agg.rows).toEqual([{ name: 'Гайка М12х36 - DIN6334 Zn - дълга', qty: 7, value: 3.5 }])
  })

  it('treats a line with no sum field as value 0, without dropping its quantity', () => {
    const agg = aggregateTillDay([TXN_624472_WITH_ZERO_LINE])
    const giveaway = agg.rows.find(r => r.name === 'ВИНТ - САВОПР. - 4.2Х45 - DIN 7504 N')
    expect(giveaway).toEqual({ name: 'ВИНТ - САВОПР. - 4.2Х45 - DIN 7504 N', qty: 20, value: 0 })
    // the transaction's own header.sum (0.9) is still fully explained by the OTHER line alone
    expect(agg.totalValueGross).toBe(0.9)
  })

  it('refuses a mix of VAT rates in one batch rather than averaging them in', () => {
    const wrongRate: PlusMinusDocument = { ...TXN_REPEAT_PRODUCT, header: { ...TXN_REPEAT_PRODUCT.header, vatPercent: '9' } }
    expect(() => aggregateTillDay([TXN_624499, wrongRate])).toThrow(/mixed VAT rates/)
  })

  it('refuses a document whose header.doc is not a Продажби (СР) sale', () => {
    const transfer: PlusMinusDocument = { ...TXN_624499, header: { ...TXN_624499.header, doc: 'СТ', docNumber: 'x' } }
    expect(() => aggregateTillDay([transfer])).toThrow(/non-sale document/)
  })

  it('refuses when the aggregated net rows cannot reproduce the transactions\' own gross total', () => {
    const corrupted: PlusMinusDocument = { ...TXN_624499, header: { ...TXN_624499.header, sum: '999' } }
    expect(() => aggregateTillDay([corrupted])).toThrow(/Cross-check FAILED/)
  })
})
