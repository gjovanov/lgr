import { mongoose } from 'db/connection'
import { Contact, Invoice, Org, VatRegisterEntry } from 'db/models'
import { markedImported } from '../../vat-files/sales-register.service.js'
import { BILL_DOC_TYPES, PAIRING_WINDOW, pairPurchases, shiftPeriod, type FiledPurchaseRow, type LgrBill, type PurchasePairing } from './pairing.js'

/**
 * FR-25 R4, slice 1: one filed month's purchase register against LGR's bills, read-only. The pairing is `pairing.ts`,
 * which boots nothing; `scripts/pair-purchases.ts` prints its counts. Nothing here writes.
 *
 * Where it reads (R7, §12 question 15):
 *   - the filed purchase register in the HOME (`settings.accounting.books.split.homeOrgId`; outside a split the org
 *     itself), which holds the VAT files: `VatRegisterEntry` rows with `ledger: 'books'` and `side: 'purchase'`;
 *   - LGR's bills (`Invoice`, `direction: 'incoming'`, an invoice, a debit or a credit note) in EVERY org of the split:
 *     the home and each store of `branches`. The books keep every purchase in the home, but a store receives its own
 *     goods and enters its own bills, so a bill can be in any of them. Each is counted under its org.
 */

export class PurchasePairingError extends Error {
  constructor(message: string, readonly code: 'bad_period' | 'no_org') {
    super(message)
    this.name = 'PurchasePairingError'
  }
}

export interface PurchasePairingOf extends PurchasePairing {
  /** The org whose register was read. */
  home: string
  /** The orgs whose bills were read, by branch code or slug. */
  billOrgs: string[]
  /** The other periods whose registers were read, first and last. */
  otherPeriods: { first: string; last: string; rows: number }
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const BILL_TYPES = Object.keys(BILL_DOC_TYPES)
/** The other registers read: as far as a bill of the period can be declared late, and as far back. */
const OTHER_PERIODS = 12

interface BooksLink {
  mode?: string
  split?: { homeOrgId?: unknown }
  branches?: { orgId?: unknown; code?: string }[]
}

/** The home that holds the register, and every org whose bills belong to the same books, labelled. */
export async function purchaseOrgsOf(orgId: string): Promise<{ home: { id: string; label: string }; billOrgs: { id: string; label: string }[] }> {
  const org = await Org.findOne({ _id: oid(orgId) }).select('slug settings.accounting.books').lean<{ _id: unknown; slug: string; settings?: { accounting?: { books?: BooksLink } } }>()
  if (!org) throw new PurchasePairingError('No such org', 'no_org')
  const books = org.settings?.accounting?.books
  const homeId = books?.split?.homeOrgId ? String(books.split.homeOrgId) : String(org._id)
  const branches = books?.mode === 'books' ? (books.branches ?? []).filter(b => b.orgId) : []
  const ids = [...new Set([homeId, ...branches.map(b => String(b.orgId))])]
  const slugs = new Map((await Org.find({ _id: { $in: ids.map(oid) } }).select('slug').lean<{ _id: unknown; slug: string }[]>()).map(o => [String(o._id), o.slug]))
  const label = (id: string) => branches.find(b => String(b.orgId) === id)?.code || slugs.get(id) || id
  return { home: { id: homeId, label: slugs.get(homeId) ?? homeId }, billOrgs: ids.map(id => ({ id, label: label(id) })) }
}

const periodStart = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(4)) - 1, 1))

export async function pairPurchasesOf(orgId: string, period: string): Promise<PurchasePairingOf> {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(period)) throw new PurchasePairingError(`Not a period: ${period} (YYYYMM)`, 'bad_period')
  const { home, billOrgs } = await purchaseOrgsOf(orgId)
  const homeOid = oid(home.id)

  const rowSelect = 'period docTypeCode docNumber docDate partnerVat cells'
  const rows = await VatRegisterEntry.find({ orgId: homeOid, ledger: 'books', side: 'purchase', period }).select(rowSelect).sort({ rowNo: 1 }).lean<FiledPurchaseRow[]>()
  const others: string[] = []
  for (let n = -OTHER_PERIODS; n <= OTHER_PERIODS; n++) if (n) others.push(shiftPeriod(period, n))
  const otherRows = await VatRegisterEntry.find({ orgId: homeOid, ledger: 'books', side: 'purchase', period: { $in: others } }).select(rowSelect).lean<FiledPurchaseRow[]>()

  // A bill of the window's earliest period can carry a `vatPeriod` up to twelve periods after its own day (§7.1), and a
  // day either side covers Sofia's zone. Indexed on { orgId, direction, issueDate }.
  const from = new Date(periodStart(shiftPeriod(period, -PAIRING_WINDOW.before - 12)).getTime() - 86_400_000)
  const to = new Date(periodStart(shiftPeriod(period, PAIRING_WINDOW.after + 1)).getTime() + 86_400_000)
  const labelOf = new Map(billOrgs.map(o => [o.id, o.label]))
  const docs = await Invoice.find({
    orgId: { $in: billOrgs.map(o => oid(o.id)) }, direction: 'incoming', type: { $in: BILL_TYPES }, issueDate: { $gte: from, $lt: to },
  }).select('orgId invoiceNumber reference type status statusHistory tags issueDate taxEventDate vatPeriod currency total taxTotal contactId').lean<any[]>()

  const contactIds = [...new Set(docs.map(d => d.contactId).filter(Boolean).map(String))]
  const contacts = new Map((await Contact.find({ orgId: { $in: billOrgs.map(o => oid(o.id)) }, _id: { $in: contactIds.map(oid) } })
    .select('vatNumber taxId').lean<{ _id: unknown; vatNumber?: string; taxId?: string }[]>()).map(c => [String(c._id), c]))

  const bills: LgrBill[] = docs.map(d => {
    const c = d.contactId ? contacts.get(String(d.contactId)) : undefined
    return {
      org: labelOf.get(String(d.orgId)) ?? String(d.orgId),
      label: String(d.invoiceNumber ?? ''),
      type: d.type, status: d.status,
      number: String(d.reference ?? '').trim() || undefined,
      issueDate: d.issueDate,
      ...(d.taxEventDate ? { taxEventDate: d.taxEventDate } : {}),
      ...(d.vatPeriod ? { vatPeriod: String(d.vatPeriod) } : {}),
      currency: d.currency, total: d.total, taxTotal: d.taxTotal,
      partnerIds: [c?.vatNumber, c?.taxId].filter((v): v is string => !!v),
      ocr: markedImported(d),
    }
  })

  return {
    ...pairPurchases({ period, rows, otherRows, bills }),
    home: home.label,
    billOrgs: billOrgs.map(o => o.label),
    otherPeriods: { first: others[0], last: others[others.length - 1], rows: otherRows.length },
  }
}
