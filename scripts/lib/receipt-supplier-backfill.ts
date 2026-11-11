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
 *     no contact matches" (`unmatchedPartnerOf`). ⚠ Until 2026-11-11 the parser stored the items table header
 *     row there for a document that names nobody (`isItemsTableHeader`): such a "name" is nobody;
 *   - for a receipt that keeps neither (everything booked before the importers recorded a partner), in the source
 *     itself: `opts.partners`, the partner PlusMinus holds for each document number, collected from a pull of the
 *     period (`collectPartners`). The receipt says which document it is in its marker (`stokrazp:<number>`).
 *
 * It is resolved by the one rule the importers use (`pickSupplierByName`): the exact normalized name, else the same
 * words whatever punctuation stands between them, among ACTIVE contacts of type supplier or both, exactly one of
 * them. One more rule that needs every contact at hand, so it lives here: a name that is exactly a CUSTOMER's (the
 * documents print the partner as the customer list spells it) is the supplier that carries that customer's tax
 * number, when exactly one does: the same company, kept twice. Nothing is created and nothing is guessed: a name
 * that matches no supplier, or several, is reported with its receipts so a person can fix the contact and run it again.
 *
 * What it leaves alone, each counted:
 *   - a receipt that says it is no delivery (a correction, a reconcile delta, a day's aggregate, goods coming back on
 *     a transfer or a write-off note, the mirror of a removed document): `noteSaysNoDelivery`;
 *   - a receipt that was rolled back, or is for the record only: the facts do not read it;
 *   - a receipt a document holds (`invoiceId`): a bill names its own supplier;
 *   - a receipt whose partner is written nowhere in LGR, and that the given partners do not name either.
 *
 * The write is what making a bill from a receipt already does to a receipt that names nobody
 * (`receipt-bill.service.ts#claimReceipts`): `contactId` and nothing else, guarded on the receipt still naming
 * nobody and still being free, with an audit entry. No quantity, cost or stock level changes.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deliveryNotePartner, isRemovalReversalNote, MOVEMENT_MARKER_PREFIX, noteSaysNoDelivery } from '../../packages/config/src/movement-notes.js'
import { Contact, DocFile, StockMovement } from '../../packages/db/src/models/index.js'
import { recordAuditEntry } from '../../packages/services/src/biz/audit-log.service.js'
import { isItemsTableHeader } from '../../packages/services/src/biz/doc-import/parse-table.js'
import {
  foldName, normalizeName, partnerOf, pickSupplierByName, unmatchedPartnerOf, type SupplierCandidate,
} from '../../packages/services/src/biz/doc-import/supplier-name.js'

export interface ReceiptSupplierPlan {
  movementId: string
  movementNumber: string
  contactId: string
  /** The supplier's name as its contact has it. */
  supplierName: string
  /** Where the partner's name was read: the receipt's notes, the analysis of the document that booked it, or the partners given. */
  source: 'notes' | 'document' | 'given'
  /**
   * How the name became this supplier: its own name, the same words with other punctuation, or the tax number of the
   * contact that has exactly this name (a customer kept beside the supplier).
   */
  rule: 'name' | 'punctuation' | 'taxNumber'
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

/** A contact as the rules here read it: the name rule's part, and its tax numbers. */
interface KnownContact extends SupplierCandidate { tax: string[] }

/**
 * The numbers a company is known to the state by, as comparable keys: its ЕИК (digits), and its VAT number (letters
 * and digits). A Bulgarian VAT number is „BG" and the ЕИК, so it also gives the ЕИК. Too short to be either: ignored.
 */
function taxKeys(c: { taxId?: unknown; taxNumber?: unknown; vatNumber?: unknown }): string[] {
  const keys = new Set<string>()
  for (const v of [c.taxId, c.taxNumber]) {
    const digits = String(v ?? '').replace(/\D/g, '')
    if (digits.length >= 9) keys.add(`e:${digits}`)
  }
  const vat = String(c.vatNumber ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (vat.length >= 9) {
    keys.add(`v:${vat}`)
    if (/^BG\d{9,10}$/.test(vat)) keys.add(`e:${vat.slice(2)}`)
  }
  return [...keys]
}

/** A document number as a key: the digits PlusMinus prints, without the zeros some exports pad them with. */
const numberKey = (n: unknown) => String(n ?? '').trim().replace(/^0+(?=\d)/, '')

const RECEIPT_MARKER = new RegExp(`(?:^|[\\s(])${MOVEMENT_MARKER_PREFIX.goods_receipt}:([^\\s)]+)`)
const RECEIPT_REFERENCE = new RegExp(`^${MOVEMENT_MARKER_PREFIX.goods_receipt}_(\\S+)$`)

/** The стокова разписка a receipt was booked from: the number in its marker, else in its reference. */
export function receiptDocumentNumber(m: { notes?: unknown; reference?: unknown }): string | undefined {
  const hit = RECEIPT_MARKER.exec(String(m.notes ?? '')) ?? RECEIPT_REFERENCE.exec(String(m.reference ?? '').trim())
  return hit ? numberKey(hit[1]) || undefined : undefined
}

/**
 * The partner PlusMinus holds for each стокова разписка in a folder of pulled documents (`pull-api.ts --families
 * stokrazp`: one `stokrazp_<number>.json` each, `header.partner` as PlusMinus sends it), by document number. A
 * document that names nobody is in the answer with an empty name, so "the source names nobody" can be told from
 * "the source was not asked". Reads files only.
 */
export function collectPartners(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(join(d, e.name)); continue }
      const named = /^stokrazp_(.+)\.json$/i.exec(e.name)
      if (!named) continue
      const doc = JSON.parse(readFileSync(join(d, e.name), 'utf8').replace(/^\uFEFF/, ''))
      const key = numberKey(doc?.header?.docNumber ?? doc?.num ?? named[1])
      if (key) out[key] = String(doc?.header?.partner ?? '').trim()
    }
  }
  walk(dir)
  return out
}

export interface ReceiptSupplierOptions {
  /** Document number → the partner the source holds for it (empty: it names nobody). See `collectPartners`. */
  partners?: Record<string, string>
}

/** What a run would write for this organization, and why it would leave the rest. Reads only. */
export async function planReceiptSupplierBackfill(orgId: string, opts: ReceiptSupplierOptions = {}): Promise<ReceiptSupplierBackfill> {
  const given = new Map(Object.entries(opts.partners ?? {}).map(([n, p]) => [numberKey(n), p]))
  // Every contact by its normalized name (the rule keeps the active suppliers, the rest explain a miss), by its
  // words (the candidates of the name rule), and the active suppliers by their tax numbers.
  const byName = new Map<string, KnownContact[]>()
  const byWords = new Map<string, KnownContact[]>()
  const suppliersByTax = new Map<string, KnownContact[]>()
  const into = (map: Map<string, KnownContact[]>, key: string, c: KnownContact) => { if (key) map.set(key, [...(map.get(key) ?? []), c]) }
  const contacts = Contact.find({ orgId } as any, { companyName: 1, type: 1, isActive: 1, taxId: 1, taxNumber: 1, vatNumber: 1 }).lean().cursor() as AsyncIterable<any>
  for await (const row of contacts) {
    const c: KnownContact = { id: String(row._id), companyName: row.companyName, type: row.type, isActive: row.isActive, tax: taxKeys(row) }
    into(byName, normalizeName(c.companyName), c)
    into(byWords, foldName(c.companyName), c)
    if ((c.type === 'supplier' || c.type === 'both') && c.isActive !== false) for (const t of c.tax) into(suppliersByTax, t, c)
  }
  /** The one active supplier that carries a tax number of a contact named exactly `key`, if exactly one does. */
  const supplierOfTheSameCompany = (key: string): KnownContact | undefined => {
    const found = new Map<string, KnownContact>()
    for (const twin of byName.get(key) ?? []) for (const t of twin.tax) for (const sup of suppliersByTax.get(t) ?? []) found.set(sup.id, sup)
    return found.size === 1 ? [...found.values()][0] : undefined
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
    const name = warnings.map(unmatchedPartnerOf).find((n) => n && !isItemsTableHeader(n))
    if (name) for (const id of d.committedIds || []) fromDocument.set(String(id), name)
  }

  const counts: ReceiptSupplierCounts = { receipts: 0, notCounted: 0, notADelivery: 0, heldByADocument: 0, noPartnerKnown: 0, unresolved: 0, resolved: 0 }
  const plans: ReceiptSupplierPlan[] = []
  const missed = new Map<string, UnresolvedPartnerName>()
  // `contactId: null` matches a receipt with no such field too.
  const receipts = StockMovement.find(
    { orgId, type: 'receipt', status: 'completed', contactId: null } as any,
    { movementNumber: 1, notes: 1, reference: 1, invoiceId: 1, recordOnly: 1, reversedBy: 1 },
  ).sort({ date: 1, _id: 1 }).lean().cursor() as AsyncIterable<any>
  for await (const m of receipts) {
    counts.receipts++
    if (m.reversedBy || m.recordOnly === true) { counts.notCounted++; continue }
    if (isRemovalReversalNote(m.notes) || noteSaysNoDelivery(m.notes)) { counts.notADelivery++; continue }
    if (m.invoiceId) { counts.heldByADocument++; continue }
    // The notes first: they are the receipt's own. Then the document that booked it. The partners given only for a
    // receipt that keeps neither, by the number of the document it says it is.
    const stated: Array<[ReceiptSupplierPlan['source'], () => unknown]> = [
      ['notes', () => deliveryNotePartner(m.notes)],
      ['document', () => fromDocument.get(String(m._id))],
      ['given', () => { const n = receiptDocumentNumber(m); return n ? given.get(n) : undefined }],
    ]
    let partner = partnerOf(undefined)
    let source: ReceiptSupplierPlan['source'] = 'notes'
    for (const [from, read] of stated) {
      partner = partnerOf(read())
      if (partner.kind !== 'nobody') { source = from; break }
    }
    if (partner.kind === 'correction') { counts.notADelivery++; continue }
    if (partner.kind === 'nobody') { counts.noPartnerKnown++; continue }
    const key = normalizeName(partner.name)
    const sameName = byName.get(key) ?? []
    const match = pickSupplierByName(partner.name, byWords.get(foldName(partner.name)) ?? [])
    const twin = match.status === 'none' ? supplierOfTheSameCompany(key) : undefined
    if (match.status === 'matched' || twin) {
      counts.resolved++
      plans.push({
        movementId: String(m._id), movementNumber: String(m.movementNumber || ''),
        contactId: match.status === 'matched' ? match.contactId : twin!.id,
        supplierName: match.status === 'matched' ? match.name : String(twin!.companyName ?? '').trim(),
        source,
        rule: match.status === 'matched' ? (match.by ?? 'name') : 'taxNumber',
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
