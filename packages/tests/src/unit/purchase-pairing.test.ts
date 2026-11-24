import { describe, expect, it } from 'bun:test'
import {
  billAmounts, billPeriod, compareAmounts, numberKey, pairPurchases, partnerKey, shiftPeriod,
  type FiledPurchaseRow, type LgrBill,
} from 'services/biz/accounting-books/purchases/pairing'

/** FR-25 R4, slice 1: the filed purchase register against LGR's bills. Made-up partners, numbers and amounts only. */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const PERIOD = '202609'
const SUPPLIER = 'BG999000191'

const filed = (over: Partial<FiledPurchaseRow> = {}): FiledPurchaseRow => ({
  period: PERIOD, docTypeCode: '01', docNumber: '0000000101', docDate: day('2026-09-10'), partnerVat: SUPPLIER,
  cells: { '03-31': 1000, '03-41': 200 }, ...over,
})

const bill = (over: Partial<LgrBill> = {}): LgrBill => ({
  org: 'PZ', label: 'BILL-1', type: 'invoice', status: 'received', number: '0000000101', issueDate: day('2026-09-10'),
  currency: 'EUR', total: 12, taxTotal: 2, partnerIds: ['999000191'], ...over,
})

const pair = (rows: FiledPurchaseRow[], bills: LgrBill[], otherRows: FiledPurchaseRow[] = []) => pairPurchases({ period: PERIOD, rows, bills, otherRows })

describe('the keys a row and a bill are paired on', () => {
  it('reads a partner the same with or without BG, and a branch БУЛСТАТ as its company', () => {
    expect(partnerKey('BG999000191')).toBe('999000191')
    expect(partnerKey(' bg 999 000 191 ')).toBe('999000191')
    expect(partnerKey('999000191')).toBe('999000191')
    expect(partnerKey('BG9990001910012')).toBe('999000191')
    expect(partnerKey('DE999999999')).toBe('DE999999999')
    expect(partnerKey('999999999999999')).toBe('')
    expect(partnerKey(undefined)).toBe('')
  })

  it('reads a number by its digits, leading zeros and prefixes dropped', () => {
    expect(numberKey('0000000101')).toBe('101')
    expect(numberKey('№ 101')).toBe('101')
    expect(numberKey('INV-0000000101')).toBe('101')
    expect(numberKey('000')).toBe('0')
    expect(numberKey('')).toBe('')
    expect(numberKey('ABC')).toBe('ABC')
  })

  it("takes a bill's VAT period from vatPeriod, else its tax event, else its issue, in Sofia", () => {
    expect(billPeriod({ issueDate: day('2026-09-30') })).toBe('202609')
    expect(billPeriod({ issueDate: new Date('2026-09-30T22:30:00.000Z') })).toBe('202610')
    expect(billPeriod({ issueDate: day('2026-09-30'), taxEventDate: day('2026-08-31') })).toBe('202608')
    expect(billPeriod({ issueDate: day('2026-08-03'), vatPeriod: '202609' })).toBe('202609')
    expect(shiftPeriod('202601', -1)).toBe('202512')
    expect(shiftPeriod('202612', 1)).toBe('202701')
    expect(shiftPeriod('202609', -12)).toBe('202509')
  })

  it("signs a credit note's amounts negative, and converts leva in a euro period", () => {
    expect(billAmounts(bill({ type: 'credit_note' }), 'EUR')).toEqual({ base: -1000, vat: -200, converted: false })
    expect(billAmounts(bill({ currency: 'BGN', total: 19.56, taxTotal: 3.26 }), 'EUR')).toEqual({ base: 833, vat: 167, converted: true })
    expect(billAmounts(bill({ currency: 'USD' }), 'EUR')).toBeNull()
  })

  it('compares amounts to a cent, and a row with no credit right against the gross', () => {
    expect(compareAmounts({ '03-31': 1001, '03-41': 199 }, bill(), 'EUR')).toBe('equal')
    expect(compareAmounts({ '03-31': 1002, '03-41': 200 }, bill(), 'EUR')).toBe('amount')
    expect(compareAmounts({ '03-31': -1000, '03-41': -200 }, bill(), 'EUR')).toBe('sign')
    expect(compareAmounts({ '03-30': 1200 }, bill(), 'EUR')).toBe('equal')
    expect(compareAmounts({ '03-30': 1000 }, bill({ total: 10, taxTotal: 0 }), 'EUR')).toBe('equal')
    expect(compareAmounts({ '03-30': 200, '03-31': 800, '03-41': 200 }, bill(), 'EUR')).toBe('equal')
    expect(compareAmounts({}, bill({ currency: 'USD' }), 'EUR')).toBe('currency')
  })
})

describe('pairing one month', () => {
  it('pairs exactly on partner and number', () => {
    const r = pair([filed()], [bill()])
    expect(r.rows).toEqual({ total: 1, byType: { '01': 1 } })
    expect(r.bills.inPeriod).toBe(1)
    expect(r.paired.exactly).toBe(1)
    expect(r.paired.withDifferences).toBe(0)
    expect(r.rowsWithoutBill.total).toBe(0)
    expect(r.billsWithoutRow.total).toBe(0)
    expect(r.details).toEqual([])
  })

  it("pairs a credit note, whose register cells are negative and whose LGR amounts are positive", () => {
    const r = pair(
      [filed({ docTypeCode: '03', docNumber: '0000000102', cells: { '03-31': -500, '03-41': -100 } })],
      [bill({ type: 'credit_note', number: '0000000102', total: 6, taxTotal: 1 })],
    )
    expect(r.paired.exactly).toBe(1)
    expect(r.bills.byType).toEqual({ '03': 1 })
  })

  it('counts each kind of difference', () => {
    const r = pair(
      [
        filed({ docNumber: '0000000201', cells: { '03-31': 1500, '03-41': 300 } }),
        filed({ docNumber: '0000000202', docDate: day('2026-09-12') }),
        filed({ docNumber: '0000000203', docTypeCode: '02' }),
        filed({ docNumber: '0000000204' }),
        filed({ docNumber: '0000000205', cells: { '03-31': -1000, '03-41': -200 } }),
      ],
      [
        bill({ number: '0000000201' }),
        bill({ number: '0000000202' }),
        bill({ number: '0000000203' }),
        bill({ number: '204' }),
        bill({ number: '0000000205' }),
      ],
    )
    expect(r.paired.exactly).toBe(0)
    expect(r.paired.withDifferences).toBe(5)
    expect(r.paired.byKind).toMatchObject({ amount: 1, date: 1, type: 1, 'number format': 1, sign: 1, period: 0, number: 0, partner: 0 })
    expect(r.details).toHaveLength(5)
  })

  it('pairs a row whose number LGR read otherwise on partner, day and amounts, only when one fits each way', () => {
    const one = pair([filed({ docNumber: '0000000301' })], [bill({ number: '0000000391' })])
    expect(one.paired.byKind.number).toBe(1)
    expect(one.paired.withDifferences).toBe(1)
    // Two bills of the same partner, day and amounts: neither is guessed.
    const two = pair([filed({ docNumber: '0000000301' })], [bill({ number: '0000000391' }), bill({ number: '0000000392', label: 'BILL-2' })])
    expect(two.paired.withDifferences).toBe(0)
    expect(two.rowsWithoutBill.total).toBe(1)
    expect(two.billsWithoutRow.total).toBe(2)
  })

  it('pairs a bill whose supplier has no number on number and amounts, as a partner difference', () => {
    const r = pair([filed()], [bill({ partnerIds: [] })])
    expect(r.paired.byKind.partner).toBe(1)
    expect(r.bills.noPartner).toBe(1)
  })

  it('pairs a row declared late with the bill of its own earlier period, and says so', () => {
    const r = pair([filed({ docDate: day('2026-06-20') })], [bill({ issueDate: day('2026-06-20') })])
    expect(r.bills.inPeriod).toBe(0)
    expect(r.paired.byKind.period).toBe(1)
    expect(r.paired.billOfEarlierPeriod).toBe(1)
    expect(r.billsWithoutRow.total).toBe(0)
  })

  it('takes a bill whose vatPeriod names the month as the month\'s, whatever its day', () => {
    const r = pair([filed({ docDate: day('2026-08-28') })], [bill({ issueDate: day('2026-08-28'), vatPeriod: PERIOD })])
    expect(r.bills.inPeriod).toBe(1)
    expect(r.paired.exactly).toBe(1)
  })

  it('counts the protocols and customs declarations no bill takes by type: R4 still has to create them', () => {
    const r = pair(
      [
        filed({ docTypeCode: '09', docNumber: '0000000011', partnerVat: 'DE999999999', cells: { '03-31': 1000, '03-41': 200 } }),
        filed({ docTypeCode: '07', docNumber: '26BG000000000001', partnerVat: '999999999999999', cells: { '03-31': 1000, '03-41': 200 } }),
        filed({ docNumber: '0000000401' }),
      ],
      [],
    )
    expect(r.rowsWithoutBill).toEqual({ total: 3, byType: { '01': 1, '07': 1, '09': 1 }, draftOnly: 0, voidedOnly: 0 })
  })

  it('names a row whose only LGR bill is a draft or voided, and pairs a blank row with a voided bill', () => {
    const r = pair(
      [filed({ docNumber: '0000000501' }), filed({ docNumber: '0000000502' }), filed({ docNumber: '0000000503', cells: {} })],
      [bill({ number: '0000000501', status: 'draft' }), bill({ number: '0000000502', status: 'voided' }), bill({ number: '0000000503', status: 'voided' })],
    )
    expect(r.bills).toMatchObject({ inPeriod: 0, drafts: 1, voided: 2 })
    expect(r.rowsWithoutBill).toMatchObject({ total: 2, draftOnly: 1, voidedOnly: 1 })
    expect(r.paired).toMatchObject({ exactly: 1, annulledBoth: 1 })
  })

  it("finds where the bills no row took were declared: an earlier register, a later one, or none", () => {
    const r = pair(
      [],
      [bill({ number: '0000000601' }), bill({ number: '0000000602' }), bill({ number: '0000000603' })],
      [filed({ period: '202608', docNumber: '0000000601' }), filed({ period: '202610', docNumber: '0000000602' })],
    )
    expect(r.billsWithoutRow).toEqual({ total: 3, byType: { '01': 3 }, inEarlierRegister: 1, inLaterRegister: 1, inNoRegister: 1 })
  })

  it('counts bills by org, OCR and missing numbers; ignores proformas and bills outside the window', () => {
    const r = pair([], [
      bill({ org: 'PZ', ocr: true }),
      bill({ org: 'SF', number: undefined }),
      bill({ org: 'SF', type: 'proforma' }),
      bill({ org: 'SF', issueDate: day('2025-01-10') }),
    ])
    expect(r.bills).toMatchObject({ inPeriod: 2, byOrg: { PZ: 1, SF: 1 }, ocr: 1, noNumber: 1 })
  })

  it('takes, of several bills under one key, the one whose amounts agree, and counts the key', () => {
    const r = pair([filed()], [bill({ total: 99, taxTotal: 1, label: 'BILL-A' }), bill({ label: 'BILL-B' })])
    expect(r.paired.exactly).toBe(1)
    expect(r.paired.severalBills).toBe(1)
    expect(r.billsWithoutRow.total).toBe(1)
  })

  it('keeps every identifier out of everything but the details', () => {
    const r = pair([filed({ docNumber: '0000000701' })], [bill({ number: '0000000799', total: 50 })])
    const { details, ...counts } = r
    expect(JSON.stringify(counts)).not.toContain('0000000')
    expect(JSON.stringify(counts)).not.toContain('999000191')
    expect(details.length).toBeGreaterThan(0)
  })
})
