/**
 * `aggregateTillDay` against two REAL regal-sf till transactions (`storeOperations_21499` and
 * `storeOperations_21472`, pulled live 2026-10-27 by `pull-plusminus-api`) plus the gap the
 * second one exposed: one line in 200 carried no `sum` at all.
 */
import { describe, it, expect } from 'bun:test'
import { aggregateTillDay } from 'services/biz/doc-import/map-plusminus-till'
import type { PlusMinusDocument } from 'services/biz/doc-import/map-plusminus-invoice'

/** storeOperations_21499.json verbatim — one line, ordinary case. */
const TXN_21499: PlusMinusDocument = {
  date: '20261027',
  num: '00000515',
  header: { vatPercent: '20', docDate: '20261027', vatRate: '20', vat: '0.21', docNumber: '21499', doc: 'СР', paid: '1.25', sum: '1.25' },
  lines: [
    { item: 'СТОКИ:Гайка М12х36 - DIN6334 Zn - дълга', no: '1', name: 'Гайка М12х36 - DIN6334 Zn - дълга', quantity: '2', measure: 'БР', sum: '1.04', price: '0.52152', sumWithVat: '1.25' },
  ],
}

/** storeOperations_21472.json verbatim — its first line has NO sum/price/sumWithVat at all
 * (a giveaway); the transaction's header.sum is fully accounted for by its second line alone. */
const TXN_21472_WITH_ZERO_LINE: PlusMinusDocument = {
  date: '20261027',
  num: '00000099',
  header: { vatPercent: '20', docDate: '20261027', vatRate: '20', vat: '0.1', docNumber: '21472', doc: 'СР', paid: '0.61', sum: '0.61' },
  lines: [
    { item: 'СТОКИ:ВИНТ - САВОПР. - 4.2Х45 - DIN 7504 N', no: '1', name: 'ВИНТ - САВОПР. - 4.2Х45 - DIN 7504 N', quantity: '20', measure: 'БР' },
    { item: 'СТОКИ:ВИНТ 4.2Х19 ШИР.ПЕР.', no: '2', name: 'ВИНТ 4.2Х19 ШИР.ПЕР.', quantity: '25', measure: 'БР', sum: '0.51', price: '0.02045', sumWithVat: '0.61' },
  ],
}

/** A second transaction selling the SAME product as TXN_21499, to prove aggregation sums rather than overwrites. */
const TXN_REPEAT_PRODUCT: PlusMinusDocument = {
  date: '20261027',
  num: '00000900',
  header: { vatPercent: '20', docDate: '20261027', vat: '0.42', doc: 'СР', sum: '2.50' },
  lines: [
    { item: 'СТОКИ:Гайка М12х36 - DIN6334 Zn - дълга', name: 'Гайка М12х36 - DIN6334 Zn - дълга', quantity: '4', sum: '2.08' },
  ],
}

describe('aggregateTillDay', () => {
  it('returns an empty aggregate for an empty day, without throwing', () => {
    expect(aggregateTillDay([])).toEqual({ rows: [], totalQty: 0, totalValueNet: 0, totalValueGross: 0 })
  })

  it('aggregates one transaction into one row per product', () => {
    const agg = aggregateTillDay([TXN_21499])
    expect(agg.rows).toEqual([{ name: 'Гайка М12х36 - DIN6334 Zn - дълга', qty: 2, value: 1.04 }])
    expect(agg.totalValueGross).toBe(1.25)
  })

  it('sums quantity and value across transactions selling the same product, rather than overwriting', () => {
    const agg = aggregateTillDay([TXN_21499, TXN_REPEAT_PRODUCT])
    expect(agg.rows).toEqual([{ name: 'Гайка М12х36 - DIN6334 Zn - дълга', qty: 6, value: 3.12 }])
  })

  it('treats a line with no sum field as value 0, without dropping its quantity', () => {
    const agg = aggregateTillDay([TXN_21472_WITH_ZERO_LINE])
    const giveaway = agg.rows.find(r => r.name === 'ВИНТ - САВОПР. - 4.2Х45 - DIN 7504 N')
    expect(giveaway).toEqual({ name: 'ВИНТ - САВОПР. - 4.2Х45 - DIN 7504 N', qty: 20, value: 0 })
    // the transaction's own header.sum (0.61) is still fully explained by the OTHER line alone
    expect(agg.totalValueGross).toBe(0.61)
  })

  it('refuses a mix of VAT rates in one batch rather than averaging them in', () => {
    const wrongRate: PlusMinusDocument = { ...TXN_REPEAT_PRODUCT, header: { ...TXN_REPEAT_PRODUCT.header, vatPercent: '9' } }
    expect(() => aggregateTillDay([TXN_21499, wrongRate])).toThrow(/mixed VAT rates/)
  })

  it('refuses a document whose header.doc is not a Продажби (СР) sale', () => {
    const transfer: PlusMinusDocument = { ...TXN_21499, header: { ...TXN_21499.header, doc: 'СТ', docNumber: 'x' } }
    expect(() => aggregateTillDay([transfer])).toThrow(/non-sale document/)
  })

  it('refuses when the aggregated net rows cannot reproduce the transactions\' own gross total', () => {
    const corrupted: PlusMinusDocument = { ...TXN_21499, header: { ...TXN_21499.header, sum: '999' } }
    expect(() => aggregateTillDay([corrupted])).toThrow(/Cross-check FAILED/)
  })
})
