/**
 * A legal number issued twice (FR-20.51, AC 51; spec §5.5): "the later document is annulled by a
 * credit note and re-issued under a new number. That is ЗДДС 116's remedy for a wrong invoice ... A
 * collision is never resolved by editing or deleting either document."
 *
 * How a pair arises: a server cut off from lgrai.app sells on (the fenced import, P3-6e), or a server
 * whose database went back issues again a number lgrai.app's copy holds (the re-seed's kept import,
 * P3-7g). Both documents exist on paper, so both are in the books under the one number. The second
 * one to reach this database carries `numberClash {withId, withNumber, source, at}` (the unique key is
 * `{orgId, invoiceNumber, numberClash.withId}`).
 *
 * - **The list**: every pair of the org, which of the two is the later, and how far its correction is.
 * - **The correction**, prepared once by a person with the right to write invoices: two drafts, never
 *   issued here, for a person to check and issue as any other.
 *   - a credit note annulling the LATER document whole, pointing at it (`relatedInvoiceId`);
 *   - its re-issue under the next number, as it was.
 *
 *   Neither moves stock (`stockSource.marker`): the goods left once, with the document annulled, and
 *   the credit note and its re-issue only correct its number. The payments stay where they were
 *   recorded, and a person allocates them.
 * - ⚠ Only an outgoing invoice is prepared here. A cash sale's legal number is its УНП, and a note
 *   follows its invoice, so those pairs are corrected by a person.
 */
import { mongoose } from 'db/connection'
import { Contact, Invoice } from 'db/models'
import { getRepos } from '../context.js'
import { recordAuditEntry } from './audit-log.service.js'
import { getNextDraftInvoiceNumber } from './invoice-numbering.service.js'

type Doc = Record<string, any>

export class NumberClashError extends Error {
  constructor(readonly statusCode: 404 | 409 | 422, readonly code: string, message: string) {
    super(message)
  }
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v)
const time = (v: unknown) => (v ? new Date(v as any).getTime() : 0)
const day = (v: unknown) => (v ? new Date(v as any).toISOString().slice(0, 10) : '?')

/** When a document got its number: sent, else made, else its id's own moment (a site's raw row has neither). */
function issuedAt(d: Doc): number {
  const id = d._id && typeof d._id.getTimestamp === 'function' ? d._id.getTimestamp().getTime() : 0
  return time(d.sentAt) || time(d.createdAt) || id
}

/**
 * The later of a pair: by the day it carries, then by when it got its number, then by id. ⚠ The
 * issue date is a calendar date (the form sends `YYYY-MM-DD`, midnight), so two documents of one day
 * are told apart by the moment, never by that midnight.
 */
export function laterOf(a: Doc, b: Doc): Doc {
  const by = [day(a.issueDate).localeCompare(day(b.issueDate)), issuedAt(a) - issuedAt(b), String(a._id).localeCompare(String(b._id))]
  for (const d of by) if (d !== 0) return d > 0 ? a : b
  return a
}

function summary(d: Doc, contacts: Map<string, string>) {
  return {
    id: String(d._id),
    invoiceNumber: d.invoiceNumber,
    type: d.type,
    direction: d.direction,
    status: d.status,
    issueDate: d.issueDate ?? null,
    total: d.total ?? 0,
    currency: d.currency ?? null,
    contact: d.contactId ? contacts.get(String(d.contactId)) ?? null : null,
    importedFrom: d.importedFrom?.kind ?? null,
  }
}

/** Every number of the org issued twice, with which of the pair is the later, and its correction. */
export async function listNumberClashes(orgId: string) {
  if (!isId(orgId)) return []
  const org = oid(orgId)
  const flagged: Doc[] = await Invoice.find({ orgId: org, 'numberClash.withId': { $exists: true } }).sort({ issueDate: -1 }).limit(500).lean()
  const others: Doc[] = flagged.length ? await Invoice.find({ orgId: org, _id: { $in: flagged.map(f => f.numberClash.withId) } }).lean() : []
  const byId = new Map(others.map(o => [String(o._id), o]))
  const corrections = flagged.flatMap(f => (f.numberClash.correction ? [f.numberClash.correction.creditNoteId, f.numberClash.correction.reissueId] : []))
  const made: Doc[] = corrections.length ? await Invoice.find({ orgId: org, _id: { $in: corrections } }, { invoiceNumber: 1, status: 1 }).lean() : []
  const madeById = new Map(made.map(m => [String(m._id), m]))
  const contactIds = [...flagged, ...others].map(d => d.contactId).filter(Boolean)
  const contacts = new Map(((contactIds.length ? await Contact.find({ orgId: org, _id: { $in: contactIds } }, { companyName: 1, firstName: 1, lastName: 1 }).lean() : []) as Doc[])
    .map(c => [String(c._id), c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || '']))
  return flagged.map(f => {
    const other = byId.get(String(f.numberClash.withId)) ?? null
    const later = other ? laterOf(f, other) : f
    const c = f.numberClash.correction
    const cn = c ? madeById.get(String(c.creditNoteId)) : null
    const re = c ? madeById.get(String(c.reissueId)) : null
    const issued = (d: Doc | null | undefined) => !!d && d.status !== 'draft'
    return {
      id: String(f._id),
      number: f.numberClash.withNumber,
      source: f.numberClash.source,
      at: f.numberClash.at,
      flagged: summary(f, contacts),
      other: other ? summary(other, contacts) : null,
      later: String(later._id) === String(f._id) ? 'flagged' : 'other',
      correctable: later.type === 'invoice' && later.direction === 'outgoing',
      correction: c
        ? {
            target: String(c.target),
            preparedAt: c.preparedAt,
            creditNote: cn ? { id: String(cn._id), number: cn.invoiceNumber, status: cn.status } : null,
            reissue: re ? { id: String(re._id), number: re.invoiceNumber, status: re.status } : null,
          }
        : null,
      // Done once both drafts are issued: the annulment and the new number are on paper.
      resolved: issued(cn) && issued(re),
    }
  })
}

/** The two drafts that correct a pair: the later document annulled by a credit note, and re-issued. */
export async function prepareClashCorrection(orgId: string, invoiceId: string, by: { id: string; operatorCode?: string }) {
  if (!isId(orgId) || !isId(invoiceId)) throw new NumberClashError(404, 'not_found', 'No such number clash.')
  const org = oid(orgId)
  const flagged: Doc | null = await Invoice.findOne({ _id: oid(invoiceId), orgId: org, 'numberClash.withId': { $exists: true } }).lean()
  if (!flagged) throw new NumberClashError(404, 'not_found', 'No such number clash.')
  if (flagged.numberClash.correction) throw new NumberClashError(409, 'already_prepared', 'This number clash\'s correction was already prepared.')
  const other: Doc | null = await Invoice.findOne({ _id: flagged.numberClash.withId, orgId: org }).lean()
  if (!other) throw new NumberClashError(409, 'pair_missing', 'The other document of this number is not here.')
  const target = laterOf(flagged, other)
  if (target.type !== 'invoice' || target.direction !== 'outgoing') {
    throw new NumberClashError(422, 'not_correctable_here', 'Only an outgoing invoice is corrected here: a cash sale\'s legal number is its УНП, and a note follows its invoice. A person corrects this one.')
  }
  const number = String(target.invoiceNumber)
  const now = new Date()
  const r = getRepos()
  const marker = { marker: `number_clash:${String(target._id)}`, docNumber: number, movementIds: [], detectedBy: 'number_clash', linkedAt: now }
  const history = (reason: string) => [{ status: 'draft', changedAt: now, changedBy: by.id, reason }]
  const copy = {
    orgId,
    direction: 'outgoing',
    contactId: target.contactId,
    issueDate: now,
    dueDate: target.dueDate ?? now,
    currency: target.currency,
    exchangeRate: target.exchangeRate ?? 1,
    // Without the order links: the annulled document still holds its reservations, and a person moves them.
    lines: (target.lines ?? []).map((l: Doc) => {
      const { _id, orderRef, ...rest } = l
      return rest
    }),
    subtotal: target.subtotal,
    discountTotal: target.discountTotal,
    taxTotal: target.taxTotal,
    total: target.total,
    totalBase: target.totalBase,
    amountPaid: 0,
    amountDue: target.total,
    paymentMethod: target.paymentMethod,
    placeOfTransaction: target.placeOfTransaction,
    // An invoice made without one keeps none (an empty address is minimised away): required here.
    billingAddress: target.billingAddress ?? {},
    shippingAddress: target.shippingAddress,
    tags: target.tags ?? [],
    stockSource: marker,
    status: 'draft',
    createdBy: by.id,
  }
  const cnNumber = await getNextDraftInvoiceNumber(orgId, 'outgoing', 'credit_note')
  const reNumber = await getNextDraftInvoiceNumber(orgId, 'outgoing', 'invoice')
  if (!cnNumber || !reNumber) throw new NumberClashError(409, 'no_draft_series', 'The organization has no draft series for credit notes or invoices.')
  const creditNote: any = await r.invoices.create({
    ...copy,
    type: 'credit_note',
    invoiceNumber: cnNumber,
    numberHistory: [{ number: cnNumber, allocatedAt: now, status: 'draft' }],
    relatedInvoiceId: target._id,
    notes: `Annuls ${number} of ${day(target.issueDate)}: that number was issued twice (ЗДДС чл. 116; FR-20.51). Moves no stock.`,
    statusHistory: history(`number clash: annuls ${number}`),
  } as any)
  const reissue: any = await r.invoices.create({
    ...copy,
    type: 'invoice',
    invoiceNumber: reNumber,
    numberHistory: [{ number: reNumber, allocatedAt: now, status: 'draft' }],
    reference: target.reference,
    notes: `Re-issues ${number} of ${day(target.issueDate)} under a new number: that number was issued twice (ЗДДС чл. 116; FR-20.51). Moves no stock; its payments stay on ${number} until allocated.`,
    statusHistory: history(`number clash: re-issues ${number}`),
  } as any)
  const done = await Invoice.updateOne(
    { _id: flagged._id, orgId: org, 'numberClash.correction': { $exists: false } },
    { $set: { 'numberClash.correction': { target: target._id, creditNoteId: oid(creditNote.id), reissueId: oid(reissue.id), preparedAt: now, preparedBy: oid(by.id) } } },
  )
  if (!done.modifiedCount) {
    // Another person prepared it meanwhile: these two are not needed.
    await Invoice.deleteMany({ _id: { $in: [oid(creditNote.id), oid(reissue.id)] }, orgId: org, status: 'draft' })
    throw new NumberClashError(409, 'already_prepared', 'This number clash\'s correction was already prepared.')
  }
  await recordAuditEntry({
    orgId, userId: by.id, operatorCode: by.operatorCode, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: String(target._id), entityName: number,
    changes: [{ field: 'numberClash', oldValue: `issued twice (${String(flagged._id)} and ${String(other._id)})`, newValue: `correction prepared: credit note ${cnNumber}, re-issue ${reNumber}` }],
  })
  return { target: String(target._id), creditNote: { id: creditNote.id, number: cnNumber }, reissue: { id: reissue.id, number: reNumber } }
}
