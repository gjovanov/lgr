import { CORRECTION_PARTNER, isRemovalReversalNote, noteSaysNoDelivery } from 'config/movement-notes'
import { sofiaDay, sofiaPeriod } from '../../vat-files/sales-register.js'
import { partnerKey, rowAmounts, type FiledPurchaseRow } from './pairing.js'

/**
 * FR-25 R4, slice 2, option (c): a filed month's purchase register (`POKUPKI`, R2's `VatRegisterEntry` rows with
 * `side: 'purchase'`) against the stores' GOODS RECEIPTS, since LGR holds almost no incoming bills. Import-pure: the
 * service (`receipt-pairing.service.ts`) loads, this pairs, and `scripts/pair-purchase-receipts.ts` prints counts
 * only. Nothing here writes. The method is the owner's (#471):
 *
 * - **Partner, day and amount, never the number.** A receipt's `reference` is the store program's own document number
 *   (`stokrazp:…`), never the supplier's invoice number, and a receipt has no field for one.
 * - **A receipt is net.** Its value (`totalAmount`, the разписка's delivery prices) carries no VAT, so it is compared
 *   with a row's credit base (`03-31` + `03-32`). One that agrees only with the row's gross (base + VAT) is counted
 *   apart, in case a store keyed some with VAT.
 * - **What is no supplier's delivery is left out, each counted:** a receipt not booked, or rolled back; one whose
 *   `invoiceId` names an OUTGOING document (a sale taken back: the reverse branch of `invoicing.service.ts`); one whose
 *   `invoiceId` names nothing; the mirror of a removed document; one with no supplier (a correction under the
 *   placeholder partner, or a delivery between the two stores, which one company does not invoice itself); one whose
 *   supplier is the company itself; one whose supplier has no VAT number or ЕИК to pair on.
 * - **A return to the supplier** is the negative lines of a разписка, booked as an `adjustment` under the same
 *   `stokrazp:` marker (`scripts/receive-stock-api.ts`, `doc-import/map-movement.ts`), or a hand-booked `return` out
 *   of a warehouse. It takes the supplier of the receipt that carries its marker, and pairs with a credit note (`03`).
 * - **Three tiers, each counted:** (1) a partner's month, the rows' total against the receipts' less the returns;
 *   (2) one row to one receipt, one to one both ways; (3) one row to the partner's receipts of a few days, summed, a
 *   single run of them in date order. Then the receipts of the month no row took are looked for in the filed
 *   registers AFTER the period (declared late), with the same tiers.
 * - **A receipt takes the period of the row it pairs with**; one that pairs with none is "not declared", never guessed.
 */

export const DAY_MS = 86_400_000
/** How far, either way, a delivery's day and its invoice's day may be apart and still pair one to one. */
export const DAY_WINDOW = 3
/** How many days before its invoice a delivery summed into it (tier 3) may be. */
export const SUM_DAYS = 10
/** How many days after a return its credit note may come. */
export const RETURN_DAYS = 45
/** The longest run of receipts tier 3 sums. */
const MAX_RUN = 25
/** A cent per document either way, and at least 0.05% of the amount: a разписка rounds per line, an invoice per document. */
const CENTS_PER_DOC = 1
const SHARE = 0.0005

export const RECEIPT_EXCLUSIONS = [
  'not booked', 'rolled back', 'sale taken back', 'names a document that is gone', 'mirror of a removed document',
  'correction', 'no supplier', 'the company itself', 'supplier with no number',
] as const
export type ReceiptExclusion = (typeof RECEIPT_EXCLUSIONS)[number]

export const RETURN_EXCLUSIONS = [
  'not booked', 'rolled back', 'sale taken back', 'names a document that is gone', 'correction', 'no supplier named',
  'the company itself', 'supplier with no number',
] as const
export type ReturnExclusion = (typeof RETURN_EXCLUSIONS)[number]

/** A stock movement of a store, as the service reads it. */
export interface StoreMovement {
  /** The store: the branch code, or the org's slug. */
  org: string
  /** LGR's own number, `MOV-…`: for `--details` only. */
  label?: string
  /** `receipt`; `adjustment` (the negative half of a разписка, by its marker); `return` out of a warehouse. */
  type: string
  status: string
  date: Date
  /** `totalAmount`, in the org's currency: what the movement is worth at its lines' unit cost. */
  amount: number
  notes?: string
  hasSupplier: boolean
  /** The supplier's numbers as its contact holds them: VAT number, ЕИК. */
  partnerIds: readonly string[]
  /** What its `invoiceId` names: an outgoing or an incoming document, or an id that names none. Absent: no `invoiceId`. */
  invoice?: 'outgoing' | 'incoming' | 'gone'
  reversed?: boolean
  recordOnly?: boolean
}

export interface ReceiptPairingInput {
  period: string
  /** The filed purchase register of `period`. */
  rows: readonly FiledPurchaseRow[]
  /** The filed purchase registers of the periods after it: where a receipt of the month no row takes was declared. */
  laterRows: readonly FiledPurchaseRow[]
  /** The stores' receipts and returns, from twelve months before `period` to the end of its year and the later registers. */
  movements: readonly StoreMovement[]
  /** The company's own numbers (every org of the split): a supplier with one of them is a delivery between the stores. */
  ownIds: readonly string[]
}

type Kind = 'delivery' | 'return'
type By = 'net' | 'gross'

export interface ReceiptPairing {
  period: string
  rows: {
    total: number
    byType: Record<string, number>
    /** Rows whose document's day (Sofia) is in a month before their period, or after it. */
    datedEarlier: number
    datedLater: number
  }
  /** The movements of the period's month (Sofia). */
  month: {
    receipts: number
    receiptsByOrg: Record<string, number>
    excluded: Record<ReceiptExclusion, number>
    deliveries: number
    deliveriesByOrg: Record<string, number>
    /** Of the deliveries, those an incoming document (a bill) holds by its `invoiceId`. */
    heldByBill: number
    returns: number
    returnsExcluded: Record<ReturnExclusion, number>
    returnsKept: number
  }
  /** Tier 1: a partner's month, the rows of the period against the deliveries of the month less the returns. */
  partners: {
    withRows: number
    withReceipts: number
    inBoth: number
    equalNet: number
    equalGross: number
    differ: number
    rowsOnly: number
    receiptsOnly: number
    /** Rows of the partners whose month agrees, net or gross. */
    rowsOfEqual: number
    /** Partners whose deliveries of the month are in more than one store. */
    severalStores: number
  }
  /** Tiers 2 and 3, rows of the period. */
  paired: {
    total: number
    oneToOne: Record<By, number>
    summed: Record<By, number>
    /** Of the pairs, credit notes (`03`) paired with returns: one to one, and summed. */
    creditOneToOne: number
    creditSummed: number
    /** Of the one-to-one pairs, on the same day. */
    sameDay: number
    /** Rows paired with receipts of more than one store. */
    acrossStores: number
    /** Rows paired with receipts of a month before the period (declared late), or after it. */
    receiptsOfEarlierMonth: number
    receiptsOfLaterMonth: number
  }
  rowsUnpaired: {
    total: number
    byType: Record<string, number>
    /** Of the invoices, debit and credit notes left, how many name a partner with a delivery or return in the year. */
    partnerHasReceipts: number
    partnerHasNone: number
    noPartner: number
    /** Left because several receipts, or several runs of them, fit: one would be a guess. */
    ambiguous: number
  }
  /** The deliveries, and the returns, of the period's month: where each was declared. */
  receiptsOfMonth: { inPeriod: number; later: number; notDeclared: number }
  returnsOfMonth: { inPeriod: number; later: number; notDeclared: number }
  /** One line per row or receipt not paired, or paired with a difference, for a person's private look. */
  details: { key: string; outcome: string }[]
}

const cents = (v: unknown) => Math.sign(Number(v) || 0) * Math.round(Math.abs(Number(v) || 0) * 100)
const dayOf = (d: Date) => sofiaDay(new Date(d)).getTime()
const typeOf = (row: FiledPurchaseRow) => row.docTypeCode || '??'
const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1 }

/** Two amounts, in cents, agree: within a cent per document, and at least 0.05% of the larger. */
export function amountsNear(a: number, b: number, docs: number): boolean {
  return Math.abs(a - b) <= Math.max(CENTS_PER_DOC * docs, Math.round(SHARE * Math.max(Math.abs(a), Math.abs(b))))
}

/** The `stokrazp:` marker a movement's notes carry, or ''. */
export function receiptMarker(notes: unknown): string {
  return /stokrazp:([^\s()]+)/.exec(String(notes ?? ''))?.[1] ?? ''
}

const booked = (m: StoreMovement) => m.status === 'completed' || m.status === 'confirmed'

/** Why a receipt is no supplier's delivery, or `null` when it is one. */
export function receiptExclusion(m: StoreMovement, own: ReadonlySet<string>): ReceiptExclusion | null {
  if (!booked(m)) return 'not booked'
  if (m.reversed || m.recordOnly) return 'rolled back'
  if (m.invoice === 'outgoing') return 'sale taken back'
  if (m.invoice === 'gone') return 'names a document that is gone'
  if (isRemovalReversalNote(m.notes)) return 'mirror of a removed document'
  if (!m.hasSupplier) return noteSaysNoDelivery(m.notes) || CORRECTION_PARTNER.test(String(m.notes ?? '')) ? 'correction' : 'no supplier'
  const keys = m.partnerIds.map(partnerKey).filter(Boolean)
  if (keys.some(k => own.has(k))) return 'the company itself'
  if (!keys.length) return 'supplier with no number'
  return null
}

interface Mv {
  m: StoreMovement
  kind: Kind
  partner: string
  day: number
  month: string
  value: number
  used: boolean
  pairedIn?: 'period' | 'later'
}

interface Rw {
  row: FiledPurchaseRow
  kind: Kind | null
  partner: string
  day: number
  net: number
  gross: number
  netKnown: boolean
  ambiguous?: boolean
  pair?: { tier: 2 | 3; by: By; mvs: Mv[] }
}

const prepareRow = (row: FiledPurchaseRow): Rw => {
  const a = rowAmounts(row.cells)
  const type = typeOf(row)
  return {
    row,
    kind: type === '01' || type === '02' ? 'delivery' : type === '03' ? 'return' : null,
    partner: partnerKey(row.partnerVat),
    day: dayOf(row.docDate),
    net: Math.abs(a.base),
    gross: Math.abs(a.base + a.vat + a.noCredit),
    netKnown: a.base !== 0,
  }
}

function fit(r: Rw, value: number, docs: number): By | null {
  if (r.netKnown && amountsNear(r.net, value, docs)) return 'net'
  if (amountsNear(r.gross, value, docs)) return 'gross'
  return null
}

/** Whether a movement's day sits where the row's document can take it, one to one (tier 2). */
function dayFits(r: Rw, mv: Mv): boolean {
  const d = (r.day - mv.day) / DAY_MS
  return r.kind === 'return' ? d >= -DAY_WINDOW && d <= RETURN_DAYS : Math.abs(d) <= DAY_WINDOW
}

/** Tiers 2 and 3 over `rows`, taking from `pool` what is still free. Marks each movement taken with `stage`. */
function pairTiers(rows: Rw[], pool: Mv[], stage: 'period' | 'later'): void {
  const byPartner = new Map<string, Mv[]>()
  for (const mv of pool) byPartner.set(mv.partner, [...(byPartner.get(mv.partner) ?? []), mv])
  const take = (r: Rw, tier: 2 | 3, by: By, mvs: Mv[]) => {
    for (const mv of mvs) { mv.used = true; mv.pairedIn = stage }
    r.pair = { tier, by, mvs }
    r.ambiguous = false
  }

  // 2. One row, one receipt: the only one that fits the row, and the only row it fits.
  const open = rows.filter(r => r.kind && r.partner && !r.pair)
  const ofRow = new Map<Rw, Mv[]>()
  const ofMv = new Map<Mv, number>()
  for (const r of open) {
    const c = (byPartner.get(r.partner) ?? []).filter(mv => !mv.used && mv.kind === r.kind && dayFits(r, mv) && fit(r, mv.value, 2))
    ofRow.set(r, c)
    for (const mv of c) ofMv.set(mv, (ofMv.get(mv) ?? 0) + 1)
  }
  for (const r of open) {
    const c = ofRow.get(r) ?? []
    if (c.length === 1 && ofMv.get(c[0]) === 1 && !c[0].used) take(r, 2, fit(r, c[0].value, 2)!, c)
    else if (c.length) r.ambiguous = true
  }

  // 3. One row, a run of the partner's receipts of a few days in date order, summed: only when a single run fits.
  for (const r of [...open].filter(x => !x.pair).sort((a, b) => a.day - b.day)) {
    const before = (r.kind === 'return' ? RETURN_DAYS : SUM_DAYS) * DAY_MS
    const c = (byPartner.get(r.partner) ?? [])
      .filter(mv => !mv.used && mv.kind === r.kind && mv.day >= r.day - before && mv.day <= r.day + DAY_WINDOW * DAY_MS)
      .sort((a, b) => a.day - b.day || a.m.org.localeCompare(b.m.org) || a.value - b.value)
    const runs: { by: By; mvs: Mv[] }[] = []
    for (let i = 0; i < c.length; i++) {
      let sum = c[i].value
      for (let j = i + 1; j < c.length && j - i < MAX_RUN; j++) {
        sum += c[j].value
        const by = fit(r, sum, j - i + 2)
        if (by) runs.push({ by, mvs: c.slice(i, j + 1) })
      }
    }
    if (runs.length === 1) take(r, 3, runs[0].by, runs[0].mvs)
    else if (runs.length) r.ambiguous = true
  }
}

const rowLabel = (r: FiledPurchaseRow) => `row ${typeOf(r)}:${r.docNumber}:${r.partnerVat ?? ''}`
const mvLabel = (m: StoreMovement) => `${m.type} ${m.org}:${m.label ?? ''}`

/** One month's filed purchase register against the stores' receipts. Counts, and `details` for a private look. */
export function pairPurchaseReceipts(input: ReceiptPairingInput): ReceiptPairing {
  const { period } = input
  const own = new Set(input.ownIds.map(partnerKey).filter(Boolean))
  const details: ReceiptPairing['details'] = []
  const year = period.slice(0, 4)

  // The movements: each delivery or return kept, or why not.
  const month: ReceiptPairing['month'] = {
    receipts: 0, receiptsByOrg: {}, excluded: zeros(RECEIPT_EXCLUSIONS), deliveries: 0, deliveriesByOrg: {}, heldByBill: 0,
    returns: 0, returnsExcluded: zeros(RETURN_EXCLUSIONS), returnsKept: 0,
  }
  const receipts = input.movements.filter(m => m.type === 'receipt')
  const receiptReason = new Map(receipts.map(m => [m, receiptExclusion(m, own)]))
  // The receipt that carries a return's marker, per store: a correction's, or a supplier's delivery.
  const byMarker = new Map<string, StoreMovement>()
  for (const m of receipts) {
    const key = receiptMarker(m.notes)
    if (!key) continue
    const at = `${m.org}|${key}`
    const held = byMarker.get(at)
    if (!held || (receiptReason.get(held) && !receiptReason.get(m))) byMarker.set(at, m)
  }
  const returnOf = (m: StoreMovement): { reason: ReturnExclusion | null; partnerIds: readonly string[] } => {
    if (!booked(m)) return { reason: 'not booked', partnerIds: [] }
    if (m.reversed || m.recordOnly) return { reason: 'rolled back', partnerIds: [] }
    if (m.invoice === 'outgoing') return { reason: 'sale taken back', partnerIds: [] }
    if (m.invoice === 'gone') return { reason: 'names a document that is gone', partnerIds: [] }
    let ids = m.partnerIds
    if (m.type === 'adjustment') {
      const receipt = byMarker.get(`${m.org}|${receiptMarker(m.notes)}`)
      const why = receipt ? receiptReason.get(receipt) : null
      if (why === 'correction' || CORRECTION_PARTNER.test(String(m.notes ?? ''))) return { reason: 'correction', partnerIds: [] }
      if (!receipt || !receipt.hasSupplier) return { reason: 'no supplier named', partnerIds: [] }
      ids = receipt.partnerIds
    } else if (!m.hasSupplier) return { reason: 'no supplier named', partnerIds: [] }
    const keys = ids.map(partnerKey).filter(Boolean)
    if (keys.some(k => own.has(k))) return { reason: 'the company itself', partnerIds: [] }
    if (!keys.length) return { reason: 'supplier with no number', partnerIds: [] }
    return { reason: null, partnerIds: ids }
  }

  const pool: Mv[] = []
  const yearPartners = new Set<string>()
  for (const m of input.movements) {
    const day = dayOf(m.date)
    const mmonth = sofiaPeriod(new Date(day))
    const inMonth = mmonth === period
    let kind: Kind, ids: readonly string[]
    if (m.type === 'receipt') {
      const why = receiptReason.get(m) ?? null
      if (inMonth) {
        month.receipts++
        bump(month.receiptsByOrg, m.org)
        if (why) month.excluded[why]++
      }
      if (why) continue
      kind = 'delivery'
      ids = m.partnerIds
      if (inMonth) {
        month.deliveries++
        bump(month.deliveriesByOrg, m.org)
        if (m.invoice === 'incoming') month.heldByBill++
      }
    } else {
      const r = returnOf(m)
      if (inMonth) {
        month.returns++
        if (r.reason) month.returnsExcluded[r.reason]++
        else month.returnsKept++
      }
      if (r.reason) continue
      kind = 'return'
      ids = r.partnerIds
    }
    const partner = ids.map(partnerKey).find(Boolean) ?? ''
    if (mmonth.slice(0, 4) === year) for (const k of ids.map(partnerKey).filter(Boolean)) yearPartners.add(k)
    pool.push({ m, kind, partner, day, month: mmonth, value: Math.abs(cents(m.amount)), used: false })
  }

  // The rows of the period.
  const rows = input.rows.map(prepareRow)
  const rowsSummary: ReceiptPairing['rows'] = { total: rows.length, byType: {}, datedEarlier: 0, datedLater: 0 }
  for (const r of rows) {
    bump(rowsSummary.byType, typeOf(r.row))
    const dated = sofiaPeriod(new Date(r.day))
    if (dated < r.row.period) rowsSummary.datedEarlier++
    else if (dated > r.row.period) rowsSummary.datedLater++
  }

  // 1. A partner's month: the rows' total against the deliveries less the returns of the month.
  const partners: ReceiptPairing['partners'] = {
    withRows: 0, withReceipts: 0, inBoth: 0, equalNet: 0, equalGross: 0, differ: 0, rowsOnly: 0, receiptsOnly: 0, rowsOfEqual: 0, severalStores: 0,
  }
  type Side = { rows: number; net: number; gross: number; mvs: number; value: number; orgs: Set<string> }
  const sides = new Map<string, Side>()
  const side = (k: string): Side => {
    let s = sides.get(k)
    if (!s) sides.set(k, (s = { rows: 0, net: 0, gross: 0, mvs: 0, value: 0, orgs: new Set() }))
    return s
  }
  for (const r of rows) {
    if (!r.kind || !r.partner) continue
    const s = side(r.partner), sign = r.kind === 'return' ? -1 : 1
    s.rows++; s.net += sign * r.net; s.gross += sign * r.gross
  }
  for (const mv of pool) {
    if (mv.month !== period) continue
    const s = side(mv.partner)
    s.mvs++; s.value += mv.kind === 'return' ? -mv.value : mv.value
    if (mv.kind === 'delivery') s.orgs.add(mv.m.org)
  }
  for (const s of sides.values()) {
    if (s.rows) partners.withRows++
    if (s.mvs) partners.withReceipts++
    if (s.orgs.size > 1) partners.severalStores++
    if (!s.mvs) { partners.rowsOnly++; continue }
    if (!s.rows) { partners.receiptsOnly++; continue }
    partners.inBoth++
    const docs = s.rows + s.mvs
    if (amountsNear(s.net, s.value, docs)) partners.equalNet++
    else if (amountsNear(s.gross, s.value, docs)) partners.equalGross++
    else { partners.differ++; continue }
    partners.rowsOfEqual += s.rows
  }

  // 2 and 3: the period's rows, then the later registers' rows with what is left.
  pairTiers(rows, pool, 'period')
  pairTiers(input.laterRows.map(prepareRow), pool, 'later')

  const paired: ReceiptPairing['paired'] = {
    total: 0, oneToOne: { net: 0, gross: 0 }, summed: { net: 0, gross: 0 }, creditOneToOne: 0, creditSummed: 0,
    sameDay: 0, acrossStores: 0, receiptsOfEarlierMonth: 0, receiptsOfLaterMonth: 0,
  }
  const rowsUnpaired: ReceiptPairing['rowsUnpaired'] = { total: 0, byType: {}, partnerHasReceipts: 0, partnerHasNone: 0, noPartner: 0, ambiguous: 0 }
  for (const r of rows) {
    const p = r.pair
    if (p) {
      paired.total++
      ;(p.tier === 2 ? paired.oneToOne : paired.summed)[p.by]++
      if (r.kind === 'return' && p.tier === 2) paired.creditOneToOne++
      else if (r.kind === 'return') paired.creditSummed++
      if (p.tier === 2 && p.mvs[0].day === r.day) paired.sameDay++
      const stores = new Set(p.mvs.map(mv => mv.m.org))
      if (stores.size > 1) paired.acrossStores++
      if (p.mvs.every(mv => mv.month < r.row.period)) paired.receiptsOfEarlierMonth++
      else if (p.mvs.some(mv => mv.month > r.row.period)) paired.receiptsOfLaterMonth++
      const notes = [p.tier === 2 ? 'one to one' : `summed, ${p.mvs.length} receipts`, p.by === 'gross' ? 'agrees with the gross' : '', stores.size > 1 ? 'across stores' : '']
      details.push({ key: `${rowLabel(r.row)} = ${p.mvs.map(mv => mvLabel(mv.m)).join(' + ')}`, outcome: `paired, ${notes.filter(Boolean).join(', ')}` })
      continue
    }
    rowsUnpaired.total++
    bump(rowsUnpaired.byType, typeOf(r.row))
    if (r.ambiguous) rowsUnpaired.ambiguous++
    let outcome = r.kind ? 'no receipt' : 'not paired here (its type)'
    if (r.kind) {
      if (!r.partner) { rowsUnpaired.noPartner++; outcome = 'no receipt: the row names no partner' }
      else if (yearPartners.has(r.partner)) { rowsUnpaired.partnerHasReceipts++; outcome = `no receipt${r.ambiguous ? ' (several fit)' : ''}: its partner delivered in the year` }
      else { rowsUnpaired.partnerHasNone++; outcome = 'no receipt: its partner delivered nothing in the year' }
    }
    details.push({ key: rowLabel(r.row), outcome })
  }

  const receiptsOfMonth = { inPeriod: 0, later: 0, notDeclared: 0 }
  const returnsOfMonth = { inPeriod: 0, later: 0, notDeclared: 0 }
  for (const mv of pool) {
    if (mv.month !== period) continue
    const into = mv.kind === 'delivery' ? receiptsOfMonth : returnsOfMonth
    if (mv.pairedIn === 'period') into.inPeriod++
    else if (mv.pairedIn === 'later') { into.later++; details.push({ key: mvLabel(mv.m), outcome: "in a later period's register" }) }
    else { into.notDeclared++; details.push({ key: mvLabel(mv.m), outcome: 'not declared in any register read' }) }
  }

  return { period, rows: rowsSummary, month, partners, paired, rowsUnpaired, receiptsOfMonth, returnsOfMonth, details }
}
