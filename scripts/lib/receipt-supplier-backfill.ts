/**
 * FR-28.12, for the receipts booked before it: name the supplier of a goods receipt that names none.
 *
 * The supplier facts of FR-28.1 read `StockMovement.contactId`. A receipt booked before the importers looked the
 * partner up (or while its supplier was not a contact yet) names nobody, so the article it brought in has no
 * supplier in the Products list, the Supplier filter and the order dialog. The partner's NAME is still there:
 *
 *   - in the receipt's own notes, where the API importers put it (`deliveryNote`: "Доставки — <date> — <partner>
 *     (<marker>)"), read back by `deliveryNotePartner`;
 *   - in the analysis of the Files document that booked it, as the warning "the document names „…" as partner and
 *     no contact matches" (`unmatchedPartnerOf`).
 *
 * It is resolved by the one rule the importers use (`pickSupplierByName`): the exact normalized name, among ACTIVE
 * contacts of type supplier or both, exactly one of them. Nothing is created and nothing is guessed: a name that
 * matches no supplier, or several, is reported with its receipts so a person can fix the contact and run it again.
 *
 * What it leaves alone, each counted:
 *   - a receipt that says it is no delivery (a correction, a reconcile delta, a day's aggregate, goods coming back on
 *     a transfer or a write-off note, the mirror of a removed document): `noteSaysNoDelivery`;
 *   - a receipt that was rolled back, or is for the record only: the facts do not read it;
 *   - a receipt a document holds (`invoiceId`): a bill names its own supplier;
 *   - a receipt whose partner is written nowhere in LGR.
 *
 * The write is what making a bill from a receipt already does to a receipt that names nobody
 * (`receipt-bill.service.ts#claimReceipts`): `contactId` and nothing else, guarded on the receipt still naming
 * nobody and still being free, with an audit entry. No quantity, cost or stock level changes.
 */
import { deliveryNotePartner, isRemovalReversalNote, noteSaysNoDelivery } from '../../packages/config/src/movement-notes.js'
import { Contact, DocFile, StockMovement } from '../../packages/db/src/models/index.js'
import { recordAuditEntry } from '../../packages/services/src/biz/audit-log.service.js'
import {
  normalizeName, partnerOf, pickSupplierByName, unmatchedPartnerOf, type SupplierCandidate,
} from '../../packages/services/src/biz/doc-import/supplier-name.js'

export interface ReceiptSupplierPlan {
  movementId: string
  movementNumber: string
  contactId: string
  /** The supplier's name as its contact has it. */
  supplierName: string
  /** Where the partner's name was read: the receipt's notes, or the analysis of the document that booked it. */
  source: 'notes' | 'document'
}

export interface UnresolvedPartnerName {
  name: string
  reason: 'none' | 'ambiguous'
  /** How many active suppliers share the name, when `reason` is `ambiguous`. */
  candidates?: number
  /** Contacts that carry the name and are no active supplier ("customer", "deactivated supplier"): why it missed. */
  heldBy?: string
  /** The receipts that name it, by movement number. */
  receipts: string[]
}

export interface ReceiptSupplierCounts {
  /** Completed receipts that name no supplier: everything below adds up to this. */
  receipts: number
  /** Rolled back, or for the record only. */
  notCounted: number
  notADelivery: number
  heldByADocument: number
  noPartnerKnown: number
  /** Receipts whose partner's name matched no single active supplier. */
  unresolved: number
  /** Receipts that will name their supplier: `plans.length`. */
  resolved: number
}

export interface ReceiptSupplierBackfill {
  counts: ReceiptSupplierCounts
  plans: ReceiptSupplierPlan[]
  /** Each unresolved name once, the one on most receipts first. */
  unresolved: UnresolvedPartnerName[]
}

const kindOf = (c: SupplierCandidate) => `${c.isActive === false ? 'deactivated ' : ''}${c.type || 'contact'}`

/** What a run would write for this organization, and why it would leave the rest. Reads only. */
export async function planReceiptSupplierBackfill(orgId: string): Promise<ReceiptSupplierBackfill> {
  // Every contact by its normalized name: the rule keeps the active suppliers, the rest explain a miss.
  const byName = new Map<string, SupplierCandidate[]>()
  for await (const c of Contact.find({ orgId } as any, { companyName: 1, type: 1, isActive: 1 }).lean().cursor() as AsyncIterable<any>) {
    const key = normalizeName(c.companyName)
    if (!key) continue
    const list = byName.get(key) ?? []
    list.push({ id: String(c._id), companyName: c.companyName, type: c.type, isActive: c.isActive })
    byName.set(key, list)
  }

  // The partner a Files document named and no contact matched, by the movements that document booked.
  const fromDocument = new Map<string, string>()
  const docs = DocFile.find(
    { orgId, docType: 'goods_receipt', 'committedIds.0': { $exists: true } } as any,
    { committedIds: 1, 'analysis.diagnostics.warnings': 1 },
  ).lean().cursor() as AsyncIterable<any>
  for await (const d of docs) {
    const warnings = d.analysis?.diagnostics?.warnings
    if (!Array.isArray(warnings)) continue
    const name = warnings.map(unmatchedPartnerOf).find(Boolean)
    if (name) for (const id of d.committedIds || []) fromDocument.set(String(id), name)
  }

  const counts: ReceiptSupplierCounts = { receipts: 0, notCounted: 0, notADelivery: 0, heldByADocument: 0, noPartnerKnown: 0, unresolved: 0, resolved: 0 }
  const plans: ReceiptSupplierPlan[] = []
  const missed = new Map<string, UnresolvedPartnerName>()
  // `contactId: null` matches a receipt with no such field too.
  const receipts = StockMovement.find(
    { orgId, type: 'receipt', status: 'completed', contactId: null } as any,
    { movementNumber: 1, notes: 1, invoiceId: 1, recordOnly: 1, reversedBy: 1 },
  ).sort({ date: 1, _id: 1 }).lean().cursor() as AsyncIterable<any>
  for await (const m of receipts) {
    counts.receipts++
    if (m.reversedBy || m.recordOnly === true) { counts.notCounted++; continue }
    if (isRemovalReversalNote(m.notes) || noteSaysNoDelivery(m.notes)) { counts.notADelivery++; continue }
    if (m.invoiceId) { counts.heldByADocument++; continue }
    // The notes first: they are the receipt's own. The document only when they name nobody.
    const inNotes = partnerOf(deliveryNotePartner(m.notes))
    const partner = inNotes.kind === 'nobody' ? partnerOf(fromDocument.get(String(m._id))) : inNotes
    if (partner.kind === 'correction') { counts.notADelivery++; continue }
    if (partner.kind === 'nobody') { counts.noPartnerKnown++; continue }
    const key = normalizeName(partner.name)
    const sameName = byName.get(key) ?? []
    const match = pickSupplierByName(partner.name, sameName)
    if (match.status === 'matched') {
      counts.resolved++
      plans.push({
        movementId: String(m._id), movementNumber: String(m.movementNumber || ''), contactId: match.contactId,
        supplierName: match.name, source: inNotes.kind === 'nobody' ? 'document' : 'notes',
      })
      continue
    }
    counts.unresolved++
    const reason = match.status === 'ambiguous' ? 'ambiguous' : 'none'
    const entry = missed.get(key) ?? {
      name: partner.name, reason,
      ...(match.status === 'ambiguous' ? { candidates: match.count } : {}),
      ...(reason === 'none' && sameName.length ? { heldBy: [...new Set(sameName.map(kindOf))].sort().join(', ') } : {}),
      receipts: [],
    }
    entry.receipts.push(String(m.movementNumber || m._id))
    missed.set(key, entry)
  }
  const unresolved = [...missed.values()].sort((a, b) => b.receipts.length - a.receipts.length || a.name.localeCompare(b.name, 'bg'))
  return { counts, plans, unresolved }
}

const audit = (orgId: string, by: unknown, entry: { movementId: string; movementNumber: string }, oldValue: string | null, newValue: string | null, reason: string) =>
  recordAuditEntry({
    orgId, userId: String(by), action: 'update', module: 'warehouse', entityType: 'stock_movement',
    entityId: entry.movementId, entityName: entry.movementNumber,
    changes: [{ field: 'contactId', oldValue, newValue }, { field: 'reason', oldValue: null, newValue: reason }],
  })

/**
 * Name the supplier of one planned receipt. False, and nothing written, when the receipt is no longer what the
 * plan read: it names a supplier now, a document claimed it, or it is gone.
 */
export async function applyReceiptSupplier(orgId: string, plan: ReceiptSupplierPlan, by: unknown, reason: string): Promise<boolean> {
  const res = await StockMovement.updateOne(
    { _id: plan.movementId, orgId, type: 'receipt', status: 'completed', contactId: null, invoiceId: null } as any,
    { $set: { contactId: plan.contactId } },
  ).exec()
  if (res.modifiedCount !== 1) return false
  // A change to a booked document is not done until its audit row is: a failed one stops the run.
  if (!await audit(orgId, by, plan, null, plan.contactId, reason)) throw new Error(`the audit row for ${plan.movementNumber} was not written; the change itself was`)
  return true
}

/**
 * Take back a supplier a run wrote, from its manifest line. Only while the receipt still names THAT supplier and
 * no document holds it: a receipt billed since, or given another supplier by a person, is not this run's any more.
 */
export async function undoReceiptSupplier(orgId: string, entry: Pick<ReceiptSupplierPlan, 'movementId' | 'movementNumber' | 'contactId'>, by: unknown, reason: string): Promise<boolean> {
  const res = await StockMovement.updateOne(
    { _id: entry.movementId, orgId, type: 'receipt', contactId: entry.contactId, invoiceId: null } as any,
    { $unset: { contactId: 1 } },
  ).exec()
  if (res.modifiedCount !== 1) return false
  if (!await audit(orgId, by, entry, entry.contactId, null, reason)) throw new Error(`the audit row for ${entry.movementNumber} was not written; the change itself was`)
  return true
}

/** How many of a manifest's receipts an undo would still change. */
export async function countUndoable(orgId: string, entries: Pick<ReceiptSupplierPlan, 'movementId' | 'contactId'>[]): Promise<number> {
  let n = 0
  for (const e of entries) {
    n += await StockMovement.countDocuments({ _id: e.movementId, orgId, type: 'receipt', contactId: e.contactId, invoiceId: null } as any).exec()
  }
  return n
}
