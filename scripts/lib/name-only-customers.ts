/**
 * FR-25 R3: a customer kept twice, once by its name alone and once with its company number, and the documents that
 * landed on the first; and their repair (`scripts/relink-name-only-customers.ts`).
 *
 * PlusMinus's invoice header names the customer and nothing else, so the API import found it by name, and with
 * `--convert` made a contact of the bare name when none matched. When the contacts import (#717) or the books later
 * filed the same company with its number, the name-only contact stayed, and the import's name rule kept choosing it:
 * the older of two contacts of the same name, and before any contact keeping the name as one of its other names. Its
 * documents carry no partner number, so each is a row of the derived sales register whose partner differs from the
 * filed one. The import now gives way to the contact holding a number (`matching.ts#matchContactByName`); this moves
 * the documents that came before.
 *
 * A contact is such a twin when all of these hold:
 * - it holds no company number (no ЕИК, VAT number or tax number), and outgoing documents name it;
 * - exactly ONE other active customer contact of the org holds a number and carries its name: named exactly so
 *   (`companyNameLower`, as the import compares it), or keeping it as one of its other names (`aliasesLower`, a
 *   person's word, or the contacts import's). Two such contacts are refused, not picked from.
 * Each invoice, credit or debit note and proforma of the twin moves to that contact, with the stock movement it made. Its
 * address stays as the document has it. Left alone and counted: a document a till holds (a session, a receipt holding it,
 * a receipt that paid it, a cash sale naming the twin), one whose own journal entry names the twin, and one the books
 * file under another contact or under a partner card linked to none.
 * Never written: a contact (the twin stays as it is, with nothing naming it), a cash sale or a receipt (an issued sale
 * never is, FR-20.51), a journal entry, a VAT register row, a tax return.
 */
import { AccountingAnalytic, Contact, Invoice, JournalEntry, StockMovement } from '../../packages/db/src/models/index.js'
import { normalizeName } from '../../packages/services/src/biz/doc-import/supplier-name.js'
import { registerNumber } from '../../packages/services/src/biz/vat-files/sales-register.js'
import { auditRun, manifestHead, oid, parseManifestOf, type ManifestHead } from './repair-run.js'

export const NAME = 'relink-name-only-customers'
export const SCRIPT = `scripts/${NAME}.ts`

const CUSTOMER = { $in: ['customer', 'both'] }
/** The documents that name a customer and may be re-pointed. A cash sale or a receipt is never rewritten. */
const DOC_TYPES = ['invoice', 'credit_note', 'debit_note', 'proforma']
const clean = (v: unknown) => String(v ?? '').trim()
const unpadded = (n: string) => n.replace(/^0+/, '')

/** A contact holds a company number when any of its three number fields holds a digit. */
export const holdsNumber = (c: { taxId?: unknown; taxNumber?: unknown; vatNumber?: unknown }) =>
  [c.taxId, c.taxNumber, c.vatNumber].some(v => /\d/.test(String(v ?? '')))

export interface MovedDocument { id: string; invoiceNumber: string }

export interface Twin {
  /** The contact of the bare name. */
  fromId: string
  /** The contact holding the number. */
  toId: string
  documents: MovedDocument[]
  /** The stock movements those documents made, naming the twin. */
  movements: string[]
}

export interface TwinCounts {
  /** Contacts of no number that outgoing documents name. */
  nameOnly: number
  twins: number
  /** No other contact holding a number carries the name. */
  none: number
  /** Several do: a person chooses. */
  several: number
  documents: number
  /** Of the documents to move, those the books file under the contact they move to, and those not in the books yet. */
  booksAgree: number
  notInBooks: number
  movements: number
  left: Record<string, number>
}

export interface TwinPlan { orgId: string; twins: Twin[]; counts: TwinCounts }

/** The org's name-only customers, the one contact holding a number each is kept twice as, and what would move. Reads only. */
export async function planNameOnlyCustomers(orgId: string): Promise<TwinPlan> {
  const org = oid(orgId)
  const counts: TwinCounts = { nameOnly: 0, twins: 0, none: 0, several: 0, documents: 0, booksAgree: 0, notInBooks: 0, movements: 0, left: {} }
  const leave = (k: string, n = 1) => { if (n > 0) counts.left[k] = (counts.left[k] ?? 0) + n }
  const twins: Twin[] = []

  const named = await Invoice.distinct('contactId', { orgId: org, direction: 'outgoing', type: { $in: DOC_TYPES } }).exec()
  const contacts: any[] = await Contact.find({ orgId: org, _id: { $in: named }, type: CUSTOMER })
    .select('companyName taxId taxNumber vatNumber').sort({ _id: 1 }).lean().exec()
  for (const a of contacts.filter(c => !holdsNumber(c) && clean(c.companyName))) {
    counts.nameOnly++
    const name = clean(a.companyName)
    const carriers: any[] = await Contact.find({
      orgId: org, _id: { $ne: a._id }, type: CUSTOMER, isActive: { $ne: false },
      $or: [{ companyNameLower: name.toLocaleLowerCase('bg') }, { aliasesLower: normalizeName(name) }],
    }).select('taxId taxNumber vatNumber').lean().exec()
    const numbered = carriers.filter(holdsNumber)
    if (!numbered.length) { counts.none++; continue }
    if (numbered.length > 1) { counts.several++; continue }
    const b = String(numbered[0]._id)

    leave('a cash sale or a receipt naming the contact: never rewritten',
      await Invoice.countDocuments({ orgId: org, contactId: a._id, type: { $nin: DOC_TYPES } }).exec())
    const docs: any[] = await Invoice.find({ orgId: org, contactId: a._id, direction: 'outgoing', type: { $in: DOC_TYPES } })
      .select('invoiceNumber register receiptHolds cashSaleRef').sort({ _id: 1 }).lean().exec()
    const ids = docs.map(d => d._id)
    // A document's own entry naming the twin, and the partner the books file each document's number under.
    const ownEntries = new Set((await JournalEntry.find({ orgId: org, sourceId: { $in: ids }, 'lines.contactId': a._id }, { sourceId: 1 }).lean().exec() as any[])
      .map(e => String(e.sourceId)))
    const numbers = [...new Set(docs.map(d => registerNumber(d.invoiceNumber)).filter((n): n is string => !!n))]
    // An entry naming no partner says nothing about one; a partner card linked to no contact says "none" ('').
    const books: any[] = numbers.length
      ? await JournalEntry.find({
        orgId: org, ledger: 'books', docNumber: { $in: [...numbers, ...numbers.map(unpadded)] }, partnerAnalyticId: { $type: 'objectId' },
      }, { docNumber: 1, partnerAnalyticId: 1 }).lean().exec()
      : []
    const analytics = new Map((await AccountingAnalytic.find({ orgId: org, _id: { $in: books.map(e => e.partnerAnalyticId) } }, { contactId: 1 }).lean().exec() as any[])
      .map(x => [String(x._id), x.contactId ? String(x.contactId) : '']))
    const booksSay = (n: string | null) => new Set(books.filter(e => n && unpadded(String(e.docNumber)) === unpadded(n))
      .map(e => analytics.get(String(e.partnerAnalyticId)) ?? ''))

    const moved: MovedDocument[] = []
    for (const d of docs) {
      if (d.register?.sessionId) { leave('in a till session'); continue }
      if ((d.receiptHolds ?? []).length) { leave('held by a payment receipt'); continue }
      if (d.cashSaleRef?.contactId && String(d.cashSaleRef.contactId) === String(a._id)) { leave('its cash sale names the same contact'); continue }
      if (await Invoice.exists({ orgId: org, type: 'payment_receipt', 'register.paidInvoiceId': d._id })) { leave('paid through a till receipt'); continue }
      if (ownEntries.has(String(d._id))) { leave('its own journal entry names the contact'); continue }
      const said = booksSay(registerNumber(d.invoiceNumber))
      if (said.has('')) { leave('the books file it under a partner card linked to no contact'); continue }
      if ([...said].some(id => id !== b)) { leave('the books file it under another contact'); continue }
      if (said.size) counts.booksAgree++
      else counts.notInBooks++
      moved.push({ id: String(d._id), invoiceNumber: d.invoiceNumber })
    }
    if (!moved.length) continue
    const movedIds = new Set(moved.map(d => d.id))
    const movements = await StockMovement.find({ orgId: org, contactId: a._id }, { invoiceId: 1 }).lean().exec() as any[]
    const theirs = movements.filter(m => m.invoiceId && movedIds.has(String(m.invoiceId))).map(m => String(m._id))
    leave('a stock movement of the contact that is no moved document\'s', movements.length - theirs.length)
    twins.push({ fromId: String(a._id), toId: b, documents: moved, movements: theirs })
    counts.twins++
    counts.documents += moved.length
    counts.movements += theirs.length
  }
  return { orgId, twins, counts }
}

// ── The manifest ────────────────────────────────────────────────────────────────────────────────

export interface TwinManifest extends ManifestHead { twins: Twin[] }

export const manifestOf = (plan: TwinPlan, slug: string): TwinManifest => ({ ...manifestHead(NAME, plan.orgId, slug), twins: plan.twins })

export function parseManifest(text: string, orgId: string): TwinManifest {
  const valid = (m: any) => Array.isArray(m.twins) && m.twins.every((t: any) =>
    t?.fromId && t.toId && Array.isArray(t.documents) && Array.isArray(t.movements) && t.documents.every((d: any) => d?.id))
  const m = parseManifestOf(text, NAME, orgId, valid)
  return {
    script: NAME, version: 1, orgId: String(m.orgId), slug: String(m.slug), at: String(m.at),
    twins: m.twins.map((t: any) => ({
      fromId: String(t.fromId),
      toId: String(t.toId),
      documents: t.documents.map((d: any) => ({ id: String(d.id), invoiceNumber: String(d.invoiceNumber ?? '') })),
      movements: t.movements.map(String),
    })),
  }
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────

/** A document naming `contact`: the condition of every write. */
const naming = (orgId: string, id: string, contact: string) => ({ _id: oid(id), orgId: oid(orgId), contactId: oid(contact) })

export interface TwinResult { twins: number; documents: number; movements: number; failed: string[] }

/**
 * Move each twin's documents and their movements. Every write is conditional on the document still naming the twin: one
 * changed since is left as it was set, and reported.
 */
export async function applyNameOnlyCustomers(plan: TwinPlan): Promise<TwinResult> {
  const result: TwinResult = { twins: 0, documents: 0, movements: 0, failed: [] }
  for (const t of plan.twins) {
    if (!await Contact.exists({ _id: oid(t.toId), orgId: oid(plan.orgId), isActive: { $ne: false } })) {
      result.failed.push(`contact ${t.toId}: gone or switched off since the dry run; its twin's documents left alone`)
      continue
    }
    let moved = 0
    for (const d of t.documents) {
      const r = await Invoice.updateOne(naming(plan.orgId, d.id, t.fromId), { $set: { contactId: oid(t.toId) } }).exec()
      if (r.modifiedCount) moved++
      else result.failed.push(`document ${d.id}: no longer names the contact the dry run saw; left alone`)
    }
    if (t.movements.length) {
      result.movements += (await StockMovement.updateMany(
        { orgId: oid(plan.orgId), _id: { $in: t.movements.map(oid) }, contactId: oid(t.fromId) },
        { $set: { contactId: oid(t.toId) } },
      ).exec()).modifiedCount
    }
    result.documents += moved
    if (moved) result.twins++
  }
  if (result.documents) {
    await auditRun(plan.orgId, SCRIPT, 'invoice', `documents of a name-only customer moved to the contact holding its number (${SCRIPT})`, {
      twins: result.twins, documents: result.documents, movements: result.movements,
    })
  }
  return result
}

export interface TwinUndo { documents: number; back: number; changed: number; movements: number; gone: number }

/** What `--undo` takes back, or takes back with `execute`: the documents and movements that still read as the run left them. */
export async function undoNameOnlyCustomers(m: TwinManifest, execute: boolean): Promise<TwinUndo> {
  const counts: TwinUndo = { documents: 0, back: 0, changed: 0, movements: 0, gone: 0 }
  for (const t of m.twins) {
    counts.documents += t.documents.length
    // Never pointed at nothing.
    if (!await Contact.exists({ _id: oid(t.fromId), orgId: oid(m.orgId) })) { counts.gone += t.documents.length; continue }
    for (const d of t.documents) {
      const left = naming(m.orgId, d.id, t.toId)
      const n = execute
        ? (await Invoice.updateOne(left, { $set: { contactId: oid(t.fromId) } }).exec()).modifiedCount
        : await Invoice.countDocuments(left).exec()
      if (n) counts.back++
      else counts.changed++
    }
    if (!t.movements.length) continue
    const theirs = { orgId: oid(m.orgId), _id: { $in: t.movements.map(oid) }, contactId: oid(t.toId) }
    counts.movements += execute
      ? (await StockMovement.updateMany(theirs, { $set: { contactId: oid(t.fromId) } }).exec()).modifiedCount
      : await StockMovement.countDocuments(theirs).exec()
  }
  if (execute && (counts.back || counts.movements)) {
    await auditRun(m.orgId, SCRIPT, 'invoice', `documents of a name-only customer moved back (${SCRIPT} --undo)`, {
      documents: counts.back, movements: counts.movements,
    })
  }
  return counts
}
