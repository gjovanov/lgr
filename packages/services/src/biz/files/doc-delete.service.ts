import { DocFile, Invoice, StockMovement, Product, StockLevel } from 'db/models'
import { getRepos } from '../../context.js'
import { createAuditEntry } from '../audit-log.service.js'
import { reverseInvoiceStockMovement } from '../invoicing.service.js'
import { syncOrderForInvoice } from '../reservation.service.js'
import { confirmMovement } from '../warehouse.service.js'
import { stockMovementDao } from '../../dao/warehouse/stock-movement.dao.js'
import { trashDocumentFile } from './doc-store.service.js'

/**
 * Files app — batch removal of uploaded documents WITH rollback of everything their commit
 * created: issued invoices are voided (stock restored), stock movements are reversed by a
 * mirrored compensating movement, and products the import created are deactivated when nothing
 * else references them. The DocFile row is then hard-deleted (the unique {orgId,docType,docNumber}
 * index would otherwise block a corrected re-upload) and its bytes moved to `docs/_deleted/`.
 *
 * DRY-RUN by default: `planDeleteDocFiles` (and `deleteDocFiles` without `execute`) return the full
 * manifest — what would be voided, reversed, deactivated and deleted, plus the resulting stock
 * impact per product — and change nothing.
 *
 * ⚠ THE PROVENANCE GUARD is the important part. A document can be re-uploaded over a booking made
 * by an EARLIER version of itself (this happened on 2026-08-31: a day's worth of already-booked
 * 08-28 documents was re-uploaded by mistake, which re-dated the DocFile rows but left the real
 * invoices and movements untouched). Reversing then would destroy a legitimate accounting day.
 * So: when a booking was created BEFORE the current file version was uploaded, the plan marks it
 * `provenanceMismatch` and refuses to roll it back unless the caller passes `force`.
 */

export type DocDeleteAction = 'void' | 'reverse' | 'deactivate' | 'skip' | 'already_reversed' | 'in_use'

export interface PlannedInvoice { id: string; number: string; status: string; total: number; issueDate?: string; action: DocDeleteAction }
export interface PlannedMovement { id: string; number: string; type: string; status: string; date?: string; lineCount: number; action: DocDeleteAction }
export interface PlannedProduct { id: string; sku?: string; name?: string; action: DocDeleteAction; reason?: string }
export interface StockImpact { productId: string; sku?: string; name?: string; delta: number; current: number; after: number; negative: boolean }

export interface DocDeletePlan {
  docFileId: string; docNumber: string; docType: string; docDate: string; originalName: string
  status: string; version: number
  invoices: PlannedInvoice[]; movements: PlannedMovement[]; products: PlannedProduct[]
  warnings: string[]
  /** A booking predates this file's current version — the upload did not create it. */
  provenanceMismatch: boolean
  /** Set when the document cannot be processed as asked; nothing is touched. */
  blocked?: string
}

export interface DocDeleteResult {
  plans: DocDeletePlan[]
  stockImpact: StockImpact[]
  totals: { docs: number; invoices: number; movements: number; products: number; blocked: number }
  executed: boolean
  voided?: string[]; reversals?: string[]; deactivated?: string[]; deleted?: string[]
  warnings?: string[]
}

export interface DocDeleteOptions {
  /** Undo what the commit created. With `false` only the file + DocFile row go (bookings stay). */
  rollback?: boolean
  /** Deactivate products this import created, when nothing else references them. */
  removeProducts?: boolean
  /** Roll back even where the booking predates the current file version. Requires intent. */
  force?: boolean
  /** Perform it. Without this nothing is written. */
  execute?: boolean
}

const r2 = (v: number) => +v.toFixed(2)
const dstr = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : undefined)

/** Products the commit created: exact when recorded, else the analysis' new-product drafts by name. */
async function resolveCreatedProducts(orgId: string, doc: any): Promise<any[]> {
  const ids = (doc.createdProductIds || []).map(String)
  if (ids.length) return Product.find({ orgId, _id: { $in: ids } }).select('_id sku name').lean()
  const drafts = ((doc.analysis as any)?.mapped?.newProducts || []) as any[]
  const names = drafts.map((d) => String(d?.name || '').trim()).filter(Boolean)
  if (!names.length) return []
  const lowered = names.map((n) => n.toLocaleLowerCase('bg'))
  return Product.find({ orgId, nameLower: { $in: lowered } }).select('_id sku name').lean()
}

/** Does anything outside this document's own bookings still reference the product? */
async function productIsInUse(orgId: string, productId: string, ownMovementIds: string[], ownInvoiceIds: string[]): Promise<boolean> {
  const mv = await StockMovement.countDocuments({ orgId, 'lines.productId': productId, _id: { $nin: ownMovementIds } } as any)
  if (mv > 0) return true
  const inv = await Invoice.countDocuments({ orgId, 'lines.productId': productId, _id: { $nin: ownInvoiceIds } } as any)
  return inv > 0
}

/** Build the manifest for one document. Reads only. */
async function planOne(orgId: string, doc: any, opts: DocDeleteOptions): Promise<DocDeletePlan> {
  const plan: DocDeletePlan = {
    docFileId: String(doc._id), docNumber: doc.docNumber, docType: doc.docType, docDate: doc.docDate,
    originalName: doc.originalName, status: doc.status, version: doc.version,
    invoices: [], movements: [], products: [], warnings: [], provenanceMismatch: false,
  }
  const ids = (doc.committedIds || []).map(String)
  const uploadedAt = doc.uploadedAt ? new Date(doc.uploadedAt) : null

  // ── invoices + movements this document booked ──
  for (const id of ids) {
    const inv: any = await Invoice.findOne({ orgId, _id: id }).select('invoiceNumber status total issueDate createdAt').lean()
    if (inv) {
      const stale = uploadedAt && inv.createdAt && new Date(inv.createdAt) < uploadedAt
      if (stale) plan.provenanceMismatch = true
      plan.invoices.push({
        id: String(inv._id), number: inv.invoiceNumber, status: inv.status, total: inv.total, issueDate: dstr(inv.issueDate),
        action: inv.status === 'voided' ? 'already_reversed' : !opts.rollback ? 'skip' : stale && !opts.force ? 'skip' : 'void',
      })
      continue
    }
    const mv: any = await StockMovement.findOne({ orgId, _id: id }).select('movementNumber type status date lines createdAt').lean()
    if (mv) {
      const stale = uploadedAt && mv.createdAt && new Date(mv.createdAt) < uploadedAt
      if (stale) plan.provenanceMismatch = true
      plan.movements.push({
        id: String(mv._id), number: mv.movementNumber, type: mv.type, status: mv.status, date: dstr(mv.date), lineCount: (mv.lines || []).length,
        action: mv.status === 'cancelled' ? 'already_reversed' : !opts.rollback ? 'skip' : stale && !opts.force ? 'skip' : 'reverse',
      })
      continue
    }
    plan.warnings.push(`committed id ${id} no longer resolves to an invoice or movement`)
  }

  if (plan.provenanceMismatch) {
    plan.warnings.push(
      'a booking predates this file\'s current version — it was NOT created by this upload' +
      (opts.force ? ' (forced: it will still be rolled back)' : ' (rollback skipped; pass force to override)'),
    )
  }

  // ── products the import created ──
  if (opts.rollback && opts.removeProducts) {
    const ownMv = plan.movements.map((m) => m.id)
    const ownInv = plan.invoices.map((i) => i.id)
    for (const p of await resolveCreatedProducts(orgId, doc)) {
      const inUse = await productIsInUse(orgId, String(p._id), ownMv, ownInv)
      const exact = (doc.createdProductIds || []).length > 0
      plan.products.push({
        id: String(p._id), sku: p.sku, name: String(p.name || '').trim(),
        action: inUse ? 'in_use' : 'deactivate',
        reason: inUse ? 'referenced by other documents' : exact ? undefined : 'matched by name (not recorded at commit time) — verify before removing',
      })
    }
  }
  return plan
}

/** Net stock change the rollback would cause, per product (reversals + invoice voids). */
async function computeStockImpact(orgId: string, plans: DocDeletePlan[]): Promise<StockImpact[]> {
  const delta = new Map<string, number>()
  for (const plan of plans) {
    for (const m of plan.movements) {
      if (m.action !== 'reverse') continue
      const mv: any = await StockMovement.findOne({ orgId, _id: m.id }).select('lines toWarehouseId fromWarehouseId').lean()
      if (!mv) continue
      // Reversing mirrors the original: a receipt (to) gives back stock, a transfer/adjustment (from) returns it.
      const sign = mv.toWarehouseId ? -1 : 1
      for (const l of mv.lines || []) delta.set(String(l.productId), (delta.get(String(l.productId)) || 0) + sign * Number(l.quantity))
    }
    for (const i of plan.invoices) {
      if (i.action !== 'void') continue
      const inv: any = await Invoice.findOne({ orgId, _id: i.id }).select('lines direction').lean()
      if (!inv) continue
      // Voiding an outgoing invoice puts the dispatched goods back; an incoming one takes them out.
      const sign = inv.direction === 'incoming' ? -1 : 1
      for (const l of inv.lines || []) if (l.productId) delta.set(String(l.productId), (delta.get(String(l.productId)) || 0) + sign * Number(l.quantity || 0))
    }
  }
  const out: StockImpact[] = []
  for (const [productId, d] of delta) {
    if (Math.abs(d) < 0.001) continue
    const p: any = await Product.findOne({ orgId, _id: productId }).select('sku name').lean()
    const levels: any[] = await StockLevel.find({ orgId, productId }).select('quantity').lean()
    const current = levels.reduce((s, l) => s + (Number(l.quantity) || 0), 0)
    const after = r2(current + d)
    out.push({ productId, sku: p?.sku, name: String(p?.name || '').trim(), delta: r2(d), current: r2(current), after, negative: after < 0 })
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

/** Book the mirror of a completed movement so its stock effect nets to zero. */
async function reverseMovement(orgId: string, userId: string, mvId: string, docNumber: string): Promise<string> {
  const mv: any = await StockMovement.findOne({ orgId, _id: mvId }).lean()
  if (!mv) throw new Error(`movement ${mvId} not found`)
  const lines = (mv.lines || []).map((l: any) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, totalCost: l.totalCost }))
  // Same unit costs as the original, so value nets out exactly (WAC stays put).
  const mirror =
    mv.toWarehouseId && mv.fromWarehouseId ? { type: 'transfer', fromWarehouseId: mv.toWarehouseId, toWarehouseId: mv.fromWarehouseId }
    : mv.toWarehouseId ? { type: 'adjustment', fromWarehouseId: mv.toWarehouseId }
    : { type: 'receipt', toWarehouseId: mv.fromWarehouseId }
  const num = await stockMovementDao.getNextMovementNumber(orgId)
  const rev: any = await StockMovement.create({
    orgId, movementNumber: num, status: 'draft', date: new Date(), ...mirror,
    totalAmount: mv.totalAmount, lines, createdBy: userId,
    notes: `Reversal of ${mv.movementNumber} — document removed (docdelete:${docNumber})`,
  })
  await confirmMovement(String(rev._id))
  return rev.movementNumber
}

/** Void an issued invoice through the same path the invoicing controller uses. */
async function voidInvoice(orgId: string, userId: string, invId: string): Promise<void> {
  const r = getRepos()
  const inv: any = await r.invoices.findOne({ id: invId, orgId } as any)
  if (!inv) throw new Error(`invoice ${invId} not found`)
  await reverseInvoiceStockMovement(inv, userId, undefined, inv.orderId ? { allowNegative: true } : undefined)
  const history = [...(inv.statusHistory || []), { status: 'voided', fromStatus: inv.status, changedAt: new Date(), changedBy: userId, reason: 'source document removed' }]
  const updated = await r.invoices.update(invId, { status: 'voided', voidedAt: new Date(), statusHistory: history } as any)
  try { await syncOrderForInvoice(orgId, updated || inv, userId) } catch { /* no order linkage on migration invoices */ }
}

/** Plan only — reads nothing but the manifest. */
export async function planDeleteDocFiles(orgId: string, docFileIds: string[], opts: DocDeleteOptions = {}): Promise<DocDeleteResult> {
  return deleteDocFiles(orgId, '', docFileIds, { ...opts, execute: false })
}

export async function deleteDocFiles(
  orgId: string, userId: string, docFileIds: string[],
  opts: DocDeleteOptions = {},
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<DocDeleteResult> {
  const options: DocDeleteOptions = { rollback: opts.rollback !== false, removeProducts: !!opts.removeProducts, force: !!opts.force, execute: !!opts.execute }
  const docs: any[] = await DocFile.find({ orgId, _id: { $in: docFileIds } }).lean()
  const byId = new Map(docs.map((d) => [String(d._id), d]))

  const plans: DocDeletePlan[] = []
  for (const id of docFileIds) {
    const doc = byId.get(String(id))
    if (!doc) {
      plans.push({ docFileId: String(id), docNumber: '?', docType: '?', docDate: '?', originalName: '?', status: '?', version: 0, invoices: [], movements: [], products: [], warnings: [], provenanceMismatch: false, blocked: 'DocFile not found' })
      continue
    }
    plans.push(await planOne(orgId, doc, options))
  }
  const stockImpact = await computeStockImpact(orgId, plans)
  const totals = {
    docs: plans.filter((p) => !p.blocked).length,
    invoices: plans.reduce((s, p) => s + p.invoices.filter((i) => i.action === 'void').length, 0),
    movements: plans.reduce((s, p) => s + p.movements.filter((m) => m.action === 'reverse').length, 0),
    products: plans.reduce((s, p) => s + p.products.filter((x) => x.action === 'deactivate').length, 0),
    blocked: plans.filter((p) => p.blocked).length,
  }
  const preview: DocDeleteResult = { plans, stockImpact, totals, executed: false }
  if (!options.execute) return preview

  // ── execute, in the reverse of the order things were created ──
  const voided: string[] = [], reversals: string[] = [], deactivated: string[] = [], deleted: string[] = [], warnings: string[] = []
  let done = 0
  for (const plan of plans) {
    if (plan.blocked) { onProgress?.(++done, plans.length, plan.docNumber); continue }
    const doc = byId.get(plan.docFileId)!
    try {
      for (const i of plan.invoices) if (i.action === 'void') { await voidInvoice(orgId, userId, i.id); voided.push(i.number) }
      for (const m of plan.movements) if (m.action === 'reverse') reversals.push(await reverseMovement(orgId, userId, m.id, plan.docNumber))
      for (const p of plan.products) if (p.action === 'deactivate') {
        await Product.updateOne({ orgId, _id: p.id } as any, { $set: { isActive: false, deactivatedAt: new Date() } })
        deactivated.push(p.sku || p.id)
      }
      const trashed = await trashDocumentFile(orgId, doc).catch(() => null)
      if (!trashed) warnings.push(`${plan.docNumber}: file bytes could not be moved to the trash folder`)
      // HARD delete: the unique {orgId,docType,docNumber} index must not block a corrected re-upload.
      await DocFile.deleteOne({ orgId, _id: plan.docFileId } as any)
      deleted.push(plan.docNumber)
      createAuditEntry({
        orgId, userId, action: 'delete', module: 'files', entityType: 'DocFile', entityId: plan.docFileId, entityName: plan.originalName,
        changes: [
          { field: 'docDate', oldValue: plan.docDate, newValue: null },
          { field: 'voidedInvoices', oldValue: null, newValue: plan.invoices.filter((i) => i.action === 'void').map((i) => i.number).join(', ') || null },
          { field: 'reversedMovements', oldValue: null, newValue: plan.movements.filter((m) => m.action === 'reverse').map((m) => m.number).join(', ') || null },
          { field: 'deactivatedProducts', oldValue: null, newValue: plan.products.filter((p) => p.action === 'deactivate').map((p) => p.sku).join(', ') || null },
        ],
      })
    } catch (e: any) {
      warnings.push(`${plan.docNumber}: ${String(e?.message || e)}`)
    } finally {
      onProgress?.(++done, plans.length, plan.docNumber)
    }
  }
  return { ...preview, executed: true, voided, reversals, deactivated, deleted, warnings }
}
