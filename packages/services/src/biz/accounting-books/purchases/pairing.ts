import { sofiaDay, sofiaPeriod } from '../../vat-files/sales-register.js'

/**
 * FR-25 R4, slice 1: the filed purchase register of one month (`POKUPKI`, imported by R2 as `VatRegisterEntry` rows with
 * `side: 'purchase'`) against LGR's bills, and how many of its rows pair with one. Import-pure: the service
 * (`pairing.service.ts`) loads, this pairs, and `scripts/pair-purchases.ts` prints counts only. Nothing here writes.
 *
 * A row and a bill pair, in this order, each pass only over what the passes before it left:
 *   1. **partner and number.** The same partner (VAT number or ЕИК, `partnerKey`) and the same number, its digits with
 *      leading zeros dropped (`numberKey`). Of several bills under one key, the one whose amounts, period, type and date
 *      agree most is taken, and the key is counted as holding several.
 *   2. **partner, day and amounts**, when the numbers differ: one row and one bill only, both ways. Counted as `number`.
 *   3. **number and amounts**, when the partners differ (or the bill names none): one row and one bill only. Counted as
 *      `partner`.
 * Everything a pass cannot pair stays unpaired and is counted, never guessed.
 *
 * What a pair can differ in (`DIFFERENCE_KINDS`): the amounts, past a cent (`amount`), or only by their sign (`sign`);
 * the bill's currency, neither the register's nor leva against euro (`currency`, amounts not compared); the document's
 * day (`date`); its type, `01` invoice, `02` debit note, `03` credit note (`type`); its number as written, the same
 * digits otherwise (`number format`); the bill's own VAT period (`period`: a purchase can be declared in any of the 12
 * periods after its own, §7.1); and the two the passes above name (`number`, `partner`).
 *
 * A bill's VAT period is its `vatPeriod` where set (§3.9), else the Sofia month of its tax event (`taxEventDate`, else
 * `issueDate`). A register row's amounts are its credit base (`03-31` + `03-32`) and VAT (`03-41` + `03-42`); a row
 * with no credit right (`03-30`, with `03-44`) carries base and VAT in one cell, so it is compared with the bill's gross,
 * or with its base when the bill carries no VAT. A credit note's cells are negative; LGR keeps a credit note positive and
 * its type is the sign.
 */

export const BILL_DOC_TYPES: Readonly<Record<string, string>> = { invoice: '01', debit_note: '02', credit_note: '03' }

/** What each register document type is, in the words the script prints (§7.1). */
export const ROW_TYPE_LABELS: Readonly<Record<string, string>> = {
  '01': 'invoice', '02': 'debit note', '03': 'credit note', '07': 'customs declaration', '09': 'protocol or other',
}

export const DIFFERENCE_KINDS = ['amount', 'sign', 'currency', 'date', 'type', 'number format', 'period', 'number', 'partner'] as const
export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number]

/** A bill's statuses that are no document received: a draft, one cancelled or voided, a quote converted. */
const NOT_ISSUED = new Set(['draft', 'cancelled', 'voided', 'converted'])
/** The leva per euro, fixed (§11). */
const LEVA_PER_EURO = 1.95583
/** A cent either way. */
const TOLERANCE = 1

export interface FiledPurchaseRow {
  /** `YYYYMM`, the period the row is declared in. */
  period: string
  docTypeCode: string
  docNumber: string
  docDate: Date
  partnerVat?: string
  /** Integer cents by official code (`03-31`, `03-41`). A blank row (annulled in its own period) has none. */
  cells: Readonly<Record<string, number>>
}

export interface LgrBill {
  /** Where the bill is: the branch code, or the org's slug. */
  org: string
  /** LGR's own number, `BILL-…`: for `--details` only. */
  label?: string
  type: string
  status: string
  /** The supplier's number, as the bill keeps it (`reference`). */
  number?: string
  issueDate: Date
  taxEventDate?: Date
  vatPeriod?: string
  currency?: string
  total?: number
  taxTotal?: number
  /** The supplier's numbers as its contact holds them: VAT number, ЕИК. */
  partnerIds: readonly string[]
  /** Drafted by the document import (the OCR pipeline): `ocr-import`, or a first status `ocr_import`. */
  ocr?: boolean
}

export interface PurchasePairingInput {
  period: string
  /** The filed purchase register of `period`. */
  rows: readonly FiledPurchaseRow[]
  /** The filed purchase registers of the periods around it: where a bill no row of `period` takes was declared. */
  otherRows: readonly FiledPurchaseRow[]
  /** LGR's bills of every status, of the periods `PAIRING_WINDOW` names around `period`, or more. */
  bills: readonly LgrBill[]
}

export interface PurchasePairing {
  period: string
  /** `BGN` up to 2025, `EUR` from 2026, as the filed files carry it. */
  currency: 'BGN' | 'EUR'
  rows: { total: number; byType: Record<string, number> }
  bills: {
    /** Received bills whose VAT period is `period`. */
    inPeriod: number
    byOrg: Record<string, number>
    byType: Record<string, number>
    /** Of those, drafted by the document import (OCR). */
    ocr: number
    /** Of those, with no supplier's number, or with a supplier that has no number. */
    noNumber: number
    noPartner: number
    /** Of those, in leva in a euro period (or in euro in a leva one): converted at the fixed rate. */
    converted: number
    /** Of the period, not received: left out of everything above. */
    drafts: number
    voided: number
  }
  paired: {
    exactly: number
    /** Of `exactly`: a blank row (annulled in its own period) and a voided bill. */
    annulledBoth: number
    withDifferences: number
    /** A pair can differ in several. */
    byKind: Record<DifferenceKind, number>
    /** Pairs whose bill's own VAT period is before `period` (declared late), or after it. */
    billOfEarlierPeriod: number
    billOfLaterPeriod: number
    /** Rows that found several bills under their partner and number. */
    severalBills: number
  }
  rowsWithoutBill: {
    total: number
    byType: Record<string, number>
    /** Of those, the only LGR bill under the partner and number is a draft, or a voided one. */
    draftOnly: number
    voidedOnly: number
  }
  billsWithoutRow: {
    total: number
    byType: Record<string, number>
    /** Of those, a row of another period's register, before or after, has the partner and number. */
    inEarlierRegister: number
    inLaterRegister: number
    inNoRegister: number
  }
  /** One line a row or bill that is not paired exactly, for a person's private look. Never printed by default. */
  details: { key: string; outcome: string }[]
}

/** The periods a register row can take a bill from: twelve before its own (§7.1) and one after (a day's zone). */
export const PAIRING_WINDOW = { before: 12, after: 1 } as const

/** `period` moved by `months`. */
export function shiftPeriod(period: string, months: number): string {
  const index = Number(period.slice(0, 4)) * 12 + Number(period.slice(4)) - 1 + months
  return `${Math.floor(index / 12)}${String((index % 12) + 1).padStart(2, '0')}`
}

const compact = (s: unknown) => String(s ?? '').normalize('NFKC').replace(/[\s.\-/]+/g, '').toUpperCase()

/**
 * A partner's number as the two sides can agree on it: `BG` and spaces dropped, so a VAT number equals the ЕИК it is
 * made of; a branch's thirteen-digit БУЛСТАТ written as a VAT number is its company's nine digits. A foreign VAT
 * number keeps its country. The register's `999999999999999` (no number, §7.1) is none.
 */
export function partnerKey(raw: unknown): string {
  const id = compact(raw)
  if (!id || /^9{9,}$/.test(id)) return ''
  const bg = /^BG(\d+)$/.exec(id)
  const digits = bg ? bg[1] : id
  return /^\d{13}$/.test(digits) ? digits.slice(0, 9) : digits
}

/**
 * A document's number as the two sides can agree on it: its digits, leading zeros dropped (`0000012345`, `№ 12345` and
 * `12345` are one). A number with no digit is itself, compacted. Empty is no number.
 */
export function numberKey(raw: unknown): string {
  const s = compact(raw)
  const digits = s.replace(/\D/g, '')
  if (digits) return digits.replace(/^0+/, '') || '0'
  return s
}

/** A bill's VAT period: its `vatPeriod`, else the Sofia month of its tax event, else of its issue. */
export function billPeriod(bill: Pick<LgrBill, 'vatPeriod' | 'taxEventDate' | 'issueDate'>): string {
  if (bill.vatPeriod && /^\d{4}(0[1-9]|1[0-2])$/.test(bill.vatPeriod)) return bill.vatPeriod
  return sofiaPeriod(bill.taxEventDate ?? bill.issueDate)
}

const cents = (v: unknown) => Math.sign(Number(v) || 0) * Math.round(Math.abs(Number(v) || 0) * 100)
const convert = (c: number, rate: number) => Math.sign(c) * Math.round(Math.abs(c) * rate)

/** The bill's base and VAT, signed as the register signs them, in `currency`'s cents; `null` for another currency. */
export function billAmounts(bill: Pick<LgrBill, 'type' | 'currency' | 'total' | 'taxTotal'>, currency: 'BGN' | 'EUR'): { base: number; vat: number; converted: boolean } | null {
  const own = String(bill.currency || 'EUR').toUpperCase()
  const rate = own === currency ? 1 : own === 'BGN' && currency === 'EUR' ? 1 / LEVA_PER_EURO : own === 'EUR' && currency === 'BGN' ? LEVA_PER_EURO : 0
  if (!rate) return null
  const sign = bill.type === 'credit_note' ? -1 : 1
  const vat = cents(bill.taxTotal)
  const base = cents(bill.total) - vat
  return { base: sign * convert(base, rate), vat: sign * convert(vat, rate), converted: rate !== 1 }
}

const cell = (cells: Readonly<Record<string, number>>, code: string) => Number(cells[code] ?? 0) || 0

/** A row's credit base, its VAT, and what it carries with no credit right (base and VAT in one). */
export function rowAmounts(cells: Readonly<Record<string, number>>): { base: number; vat: number; noCredit: number } {
  return {
    base: cell(cells, '03-31') + cell(cells, '03-32'),
    vat: cell(cells, '03-41') + cell(cells, '03-42'),
    noCredit: cell(cells, '03-30') + cell(cells, '03-44'),
  }
}

const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE

function amountsAgree(row: ReturnType<typeof rowAmounts>, bill: { base: number; vat: number }): boolean {
  if (!row.noCredit) return near(row.base, bill.base) && near(row.vat, bill.vat)
  if (!row.base && !row.vat) return near(row.noCredit, bill.base + bill.vat) || (!bill.vat && near(row.noCredit, bill.base))
  return near(row.noCredit + row.base + row.vat, bill.base + bill.vat)
}

/** `equal`, or how the amounts of a row and a bill differ. */
export function compareAmounts(cells: Readonly<Record<string, number>>, bill: Pick<LgrBill, 'type' | 'currency' | 'total' | 'taxTotal'>, currency: 'BGN' | 'EUR'): 'equal' | 'amount' | 'sign' | 'currency' {
  const b = billAmounts(bill, currency)
  if (!b) return 'currency'
  const row = rowAmounts(cells)
  if (amountsAgree(row, b)) return 'equal'
  if ((b.base || b.vat) && amountsAgree(row, { base: -b.base, vat: -b.vat })) return 'sign'
  return 'amount'
}

const typeOf = (row: FiledPurchaseRow) => row.docTypeCode || '??'
const dayMs = (d: Date) => new Date(d).getTime()

interface Prepared {
  bill: LgrBill
  period: string
  partners: Set<string>
  number: string
  day: number
  typeCode: string
  used: boolean
}

interface PreparedRow {
  row: FiledPurchaseRow
  partner: string
  number: string
  day: number
  bill?: Prepared
  pass?: 1 | 2 | 3
}

const rowLabel = (r: FiledPurchaseRow) => `row ${typeOf(r)}:${r.docNumber}:${r.partnerVat ?? ''}`
const billLabel = (b: LgrBill) => `bill ${b.org}:${b.label ?? ''}:${b.number ?? ''}`

/** One month's filed purchase register against LGR's bills. Counts, and `details` for a private look. */
export function pairPurchases(input: PurchasePairingInput): PurchasePairing {
  const { period } = input
  const currency: 'BGN' | 'EUR' = period < '202601' ? 'BGN' : 'EUR'
  const first = shiftPeriod(period, -PAIRING_WINDOW.before), last = shiftPeriod(period, PAIRING_WINDOW.after)
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1 }
  const details: PurchasePairing['details'] = []

  const prepared: Prepared[] = input.bills.map(bill => ({
    bill,
    period: billPeriod(bill),
    partners: new Set(bill.partnerIds.map(partnerKey).filter(Boolean)),
    number: numberKey(bill.number),
    day: dayMs(sofiaDay(bill.issueDate)),
    typeCode: BILL_DOC_TYPES[bill.type] ?? '',
    used: false,
  }))
  const received = prepared.filter(p => !NOT_ISSUED.has(p.bill.status) && p.typeCode)
  const pool = received.filter(p => p.period >= first && p.period <= last)
  const inPeriod = received.filter(p => p.period === period)

  const bills: PurchasePairing['bills'] = { inPeriod: inPeriod.length, byOrg: {}, byType: {}, ocr: 0, noNumber: 0, noPartner: 0, converted: 0, drafts: 0, voided: 0 }
  for (const p of inPeriod) {
    bump(bills.byOrg, p.bill.org)
    bump(bills.byType, p.typeCode)
    if (p.bill.ocr) bills.ocr++
    if (!p.number) bills.noNumber++
    if (!p.partners.size) bills.noPartner++
    if (billAmounts(p.bill, currency)?.converted) bills.converted++
  }
  for (const p of prepared) {
    if (p.period !== period || !p.typeCode) continue
    if (p.bill.status === 'draft') bills.drafts++
    else if (p.bill.status === 'voided') bills.voided++
  }

  const rowsSummary: PurchasePairing['rows'] = { total: input.rows.length, byType: {} }
  const rows: PreparedRow[] = input.rows.map(row => ({ row, partner: partnerKey(row.partnerVat), number: numberKey(row.docNumber), day: dayMs(row.docDate) }))
  for (const r of rows) bump(rowsSummary.byType, typeOf(r.row))

  const agrees = (r: PreparedRow, p: Prepared) => compareAmounts(r.row.cells, p.bill, currency) === 'equal'
  let severalBills = 0

  // 1. Partner and number.
  const byNumber = new Map<string, Prepared[]>()
  for (const p of pool) if (p.number) byNumber.set(p.number, [...(byNumber.get(p.number) ?? []), p])
  for (const r of rows) {
    if (!r.partner || !r.number) continue
    const candidates = (byNumber.get(r.number) ?? []).filter(p => !p.used && p.partners.has(r.partner))
    if (!candidates.length) continue
    if (candidates.length > 1) severalBills++
    const score = (p: Prepared) => (agrees(r, p) ? 8 : 0) + (p.period === period ? 4 : 0) + (p.typeCode === typeOf(r.row) ? 2 : 0) + (p.day === r.day ? 1 : 0)
    const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a))
    best.used = true
    r.bill = best
    r.pass = 1
  }

  // 2 and 3: one row and one bill only, both ways.
  const uniquely = (pass: 2 | 3, fits: (r: PreparedRow, p: Prepared) => boolean) => {
    const open = rows.filter(r => !r.bill)
    const free = pool.filter(p => !p.used)
    const ofRow = new Map<PreparedRow, Prepared[]>()
    const ofBill = new Map<Prepared, number>()
    for (const r of open) {
      const c = free.filter(p => fits(r, p))
      ofRow.set(r, c)
      for (const p of c) ofBill.set(p, (ofBill.get(p) ?? 0) + 1)
    }
    for (const r of open) {
      const c = ofRow.get(r) ?? []
      if (c.length !== 1 || ofBill.get(c[0]) !== 1 || c[0].used) continue
      c[0].used = true
      r.bill = c[0]
      r.pass = pass
    }
  }
  uniquely(2, (r, p) => !!r.partner && p.partners.has(r.partner) && p.day === r.day && agrees(r, p))
  uniquely(3, (r, p) => !!r.number && p.number === r.number && !(r.partner && p.partners.has(r.partner)) && agrees(r, p))

  // The pairs, and what each differs in.
  const byKind = Object.fromEntries(DIFFERENCE_KINDS.map(k => [k, 0])) as Record<DifferenceKind, number>
  const paired: PurchasePairing['paired'] = { exactly: 0, annulledBoth: 0, withDifferences: 0, byKind, billOfEarlierPeriod: 0, billOfLaterPeriod: 0, severalBills }
  for (const r of rows) {
    const p = r.bill
    if (!p) continue
    const kinds: DifferenceKind[] = []
    const amounts = compareAmounts(r.row.cells, p.bill, currency)
    if (amounts !== 'equal') kinds.push(amounts)
    if (p.day !== r.day) kinds.push('date')
    if (p.typeCode !== typeOf(r.row)) kinds.push('type')
    if (r.pass !== 2 && String(p.bill.number ?? '').trim() !== String(r.row.docNumber ?? '').trim()) kinds.push('number format')
    if (p.period !== period) kinds.push('period')
    if (r.pass === 2) kinds.push('number')
    if (r.pass === 3) kinds.push('partner')
    if (p.period < period) paired.billOfEarlierPeriod++
    if (p.period > period) paired.billOfLaterPeriod++
    if (!kinds.length) { paired.exactly++; continue }
    paired.withDifferences++
    for (const k of kinds) byKind[k]++
    details.push({ key: `${rowLabel(r.row)} = ${billLabel(p.bill)}`, outcome: `paired, differs in ${kinds.join(' + ')}` })
  }

  // The rows no bill took: by type, and whether a draft or a voided bill holds their partner and number.
  const rowsWithoutBill: PurchasePairing['rowsWithoutBill'] = { total: 0, byType: {}, draftOnly: 0, voidedOnly: 0 }
  const unreceived = prepared.filter(p => (p.bill.status === 'draft' || p.bill.status === 'voided') && p.typeCode)
  for (const r of rows) {
    if (r.bill) continue
    const other = r.partner && r.number ? unreceived.filter(p => p.number === r.number && p.partners.has(r.partner)) : []
    const voided = other.find(p => p.bill.status === 'voided')
    if (voided && !Object.keys(r.row.cells).length) {
      // Annulled on both sides: the register keeps the row blank (Annex 12), LGR the bill voided.
      paired.exactly++
      paired.annulledBoth++
      continue
    }
    rowsWithoutBill.total++
    bump(rowsWithoutBill.byType, typeOf(r.row))
    const outcome = voided ? 'no received bill: a voided one only' : other.length ? 'no received bill: a draft only' : 'no LGR bill'
    if (voided) rowsWithoutBill.voidedOnly++
    else if (other.length) rowsWithoutBill.draftOnly++
    details.push({ key: rowLabel(r.row), outcome })
  }

  // The bills of the period no row took: declared in another period's register, or in none read.
  const billsWithoutRow: PurchasePairing['billsWithoutRow'] = { total: 0, byType: {}, inEarlierRegister: 0, inLaterRegister: 0, inNoRegister: 0 }
  const others = input.otherRows.map(row => ({ row, partner: partnerKey(row.partnerVat), number: numberKey(row.docNumber) }))
  for (const p of inPeriod) {
    if (p.used) continue
    billsWithoutRow.total++
    bump(billsWithoutRow.byType, p.typeCode)
    const found = p.number && p.partners.size ? others.filter(o => o.number === p.number && p.partners.has(o.partner)) : []
    let outcome = 'no register row read'
    if (found.some(o => o.row.period < period)) { billsWithoutRow.inEarlierRegister++; outcome = "in an earlier period's register" }
    else if (found.length) { billsWithoutRow.inLaterRegister++; outcome = "in a later period's register" }
    else billsWithoutRow.inNoRegister++
    details.push({ key: billLabel(p.bill), outcome })
  }

  return { period, currency, rows: rowsSummary, bills, paired, rowsWithoutBill, billsWithoutRow, details }
}
