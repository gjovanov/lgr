import { mongoose } from 'db/connection'
import { Contact, Invoice, Org, StockMovement, VatRegisterEntry } from 'db/models'
import { shiftPeriod, type FiledPurchaseRow } from './pairing.js'
import { PurchasePairingError, purchaseOrgsOf } from './pairing.service.js'
import { DAY_MS, RETURN_DAYS, SUM_DAYS, pairPurchaseReceipts, type ReceiptPairing, type StoreMovement } from './receipt-pairing.js'

/**
 * FR-25 R4, slice 2, option (c): one filed month's purchase register against the stores' goods receipts, read-only.
 * The pairing is `receipt-pairing.ts`, which boots nothing; `scripts/pair-purchase-receipts.ts` prints its counts.
 * Nothing here writes.
 *
 * Where it reads (R7): the filed purchase register (`VatRegisterEntry`, `ledger: 'books'`, `side: 'purchase'`) in the
 * HOME of the split, the month's and the twelve after it; the receipts and returns (`StockMovement`) in EVERY org of
 * the split, the home and each store of `branches`, each counted under its org; what a movement's `invoiceId` names
 * (`Invoice.direction`) and its supplier's numbers (`Contact.vatNumber`, `taxId`); the company's own numbers
 * (`Org.taxNumber`, `vatNumber`) of every org of the split.
 */

export interface ReceiptPairingOf extends ReceiptPairing {
  home: string
  /** The orgs whose movements were read, by branch code or slug. */
  stores: string[]
  /** The later registers read: first and last period that holds rows, and how many rows. */
  laterPeriods: { first: string; last: string; rows: number }
  movementsRead: number
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
/** The later registers read: as far as a purchase can be declared late (§7.1). */
const LATER_PERIODS = 12
/** The earlier months whose receipts a row may take: a row can be dated up to twelve periods before its own. */
const EARLIER_MONTHS = 12

const periodStart = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(4)) - 1, 1))

interface MovementDoc {
  orgId: unknown
  movementNumber?: string
  type: string
  status: string
  date: Date
  totalAmount?: number
  lines?: { totalCost?: number }[]
  notes?: string
  contactId?: unknown
  invoiceId?: unknown
  reversedBy?: unknown
  recordOnly?: boolean
}

export async function pairPurchaseReceiptsOf(orgId: string, period: string): Promise<ReceiptPairingOf> {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(period)) throw new PurchasePairingError(`Not a period: ${period} (YYYYMM)`, 'bad_period')
  const { home, billOrgs } = await purchaseOrgsOf(orgId)
  const homeOid = oid(home.id)
  const orgOids = billOrgs.map(o => oid(o.id))

  const rowSelect = 'period docTypeCode docNumber docDate partnerVat cells'
  const rows = await VatRegisterEntry.find({ orgId: homeOid, ledger: 'books', side: 'purchase', period }).select(rowSelect).sort({ rowNo: 1 }).lean<FiledPurchaseRow[]>()
  const later: string[] = []
  for (let n = 1; n <= LATER_PERIODS; n++) later.push(shiftPeriod(period, n))
  const laterRows = await VatRegisterEntry.find({ orgId: homeOid, ledger: 'books', side: 'purchase', period: { $in: later } }).select(rowSelect).sort({ period: 1, rowNo: 1 }).lean<FiledPurchaseRow[]>()
  const laterFiled = [...new Set(laterRows.map(r => r.period))].sort()

  // From twelve months back, to the end of the period's year or of the last later register, whichever is later; a
  // window's days either side, and a day for Sofia's zone. Indexed on { orgId, type, date }.
  const lastPeriod = [laterFiled[laterFiled.length - 1] ?? period, `${period.slice(0, 4)}12`].sort()[1]
  const from = new Date(periodStart(shiftPeriod(period, -EARLIER_MONTHS)).getTime() - (Math.max(SUM_DAYS, RETURN_DAYS) + 1) * DAY_MS)
  const to = new Date(periodStart(shiftPeriod(lastPeriod, 1)).getTime() + (Math.max(SUM_DAYS, RETURN_DAYS) + 1) * DAY_MS)
  const docs = await StockMovement.find({
    orgId: { $in: orgOids },
    date: { $gte: from, $lt: to },
    $or: [
      { type: 'receipt' },
      // The negative half of a разписка: an adjustment under its `stokrazp:` marker (ASCII, so a regex is safe from Bun).
      { type: 'adjustment', notes: /stokrazp:/ },
      // A return booked by hand: out of a warehouse, into none.
      { type: 'return', fromWarehouseId: { $ne: null }, toWarehouseId: null },
    ],
  }).select('orgId movementNumber type status date totalAmount lines.totalCost notes contactId invoiceId reversedBy recordOnly').lean<MovementDoc[]>()

  const invoiceIds = [...new Set(docs.map(d => d.invoiceId).filter(Boolean).map(String))]
  const directions = new Map((await Invoice.find({ orgId: { $in: orgOids }, _id: { $in: invoiceIds.map(oid) } })
    .select('direction').lean<{ _id: unknown; direction?: string }[]>()).map(i => [String(i._id), i.direction]))
  const contactIds = [...new Set(docs.map(d => d.contactId).filter(Boolean).map(String))]
  const contacts = new Map((await Contact.find({ orgId: { $in: orgOids }, _id: { $in: contactIds.map(oid) } })
    .select('vatNumber taxId').lean<{ _id: unknown; vatNumber?: string; taxId?: string }[]>()).map(c => [String(c._id), c]))
  const ownIds = (await Org.find({ _id: { $in: orgOids } }).select('taxNumber vatNumber').lean<{ taxNumber?: string; vatNumber?: string }[]>())
    .flatMap(o => [o.taxNumber, o.vatNumber]).filter((v): v is string => !!v)

  const labelOf = new Map(billOrgs.map(o => [o.id, o.label]))
  const movements: StoreMovement[] = docs.map(d => {
    const c = d.contactId ? contacts.get(String(d.contactId)) : undefined
    const direction = d.invoiceId ? directions.get(String(d.invoiceId)) : undefined
    const amount = Number(d.totalAmount) || (d.lines ?? []).reduce((s, l) => s + (Number(l.totalCost) || 0), 0)
    return {
      org: labelOf.get(String(d.orgId)) ?? String(d.orgId),
      label: String(d.movementNumber ?? ''),
      type: d.type, status: d.status, date: d.date, amount, notes: d.notes,
      hasSupplier: !!d.contactId,
      partnerIds: [c?.vatNumber, c?.taxId].filter((v): v is string => !!v),
      ...(d.invoiceId ? { invoice: direction === 'outgoing' ? 'outgoing' as const : direction === 'incoming' ? 'incoming' as const : 'gone' as const } : {}),
      ...(d.reversedBy ? { reversed: true } : {}),
      ...(d.recordOnly ? { recordOnly: true } : {}),
    }
  })

  return {
    ...pairPurchaseReceipts({ period, rows, laterRows, movements, ownIds }),
    home: home.label,
    stores: billOrgs.map(o => o.label),
    laterPeriods: { first: laterFiled[0] ?? '', last: laterFiled[laterFiled.length - 1] ?? '', rows: laterRows.length },
    movementsRead: docs.length,
  }
}
