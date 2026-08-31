/**
 * Writing analysed documents. The review step decides *what* to commit; this decides *how*.
 *
 * Per-item failures are captured, never thrown: one unparseable document out of forty must
 * not abandon the other thirty-nine, and the caller needs to tell the user exactly which
 * one failed and why. That was the single biggest gap in the old batch importer, which
 * collected per-item errors into an array nothing ever read.
 */
import { File as FileModel } from 'db/models'
import { persistInvoiceDraft, persistCashSale, convertDraftInvoice } from './persist.js'
import { persistMovement } from './persist-movement.js'
import { findDuplicateCashSale, findDuplicateInvoice, findDuplicateMovement } from './dedupe.js'
import type { ImportTarget, MappedInvoice, MappedMovement } from './types.js'

export interface CommitItemOptions {
  /** Issue the document immediately after creating it (batch "convert now"). */
  convert?: boolean
  /** Move stock on convert. False mirrors the CLI skills' `--no-stock`. */
  adjustStock?: boolean
  /** Goods receipts: create catalog-new products before booking their quantity. */
  createMissingProducts?: boolean
  /** Import anyway even though the document is already in the system. Off by default. */
  allowDuplicate?: boolean
}

export interface CommitItem {
  fileId?: string
  mapped: MappedInvoice | MappedMovement | Record<string, any>
  /** A correction's second movement — booked alongside `mapped`. */
  extraMovements?: MappedMovement[]
  options?: CommitItemOptions
}

export interface CommitResult {
  fileId?: string
  ok: boolean
  /** Created entity id (invoice or movement). */
  id?: string
  /** EVERY created entity id — a correction books TWO movements from one document. */
  ids?: string[]
  /** Draft number as created. */
  number?: string
  /** Issued number, when `convert` was requested and succeeded. */
  issuedNumber?: string
  /** Products this commit created (`createMissingProducts`) — the exact set a rollback undoes. */
  createdProductIds?: string[]
  error?: string
}

/** Attach the uploaded source file to the document it produced, so the PDF stays reachable. */
async function linkFile(fileId: string | undefined, entityType: string, entityId: string): Promise<void> {
  if (!fileId) return
  try {
    await FileModel.updateOne({ _id: fileId } as any, { $set: { entityType, entityId } })
  } catch {
    // A missing/renamed File row must not fail a committed document.
  }
}

/**
 * Re-check for a duplicate at commit time.
 *
 * Analysis already flags them and the review step leaves them unchecked, but a user can
 * override, and the API can be called directly. Without this the second import creates a
 * draft, then dies on the unique index while issuing — leaving an orphan draft and a raw
 * Mongo error where a sentence would do.
 */
async function duplicateGuard(orgId: string, item: CommitItem): Promise<CommitResult | null> {
  if (item.options?.allowDuplicate) return null
  const mapped = item.mapped as any

  const hit = mapped?.marker
    ? await findDuplicateMovement(orgId, mapped.marker)
    : mapped?.type === 'cash_sale'
      ? await findDuplicateCashSale(orgId, mapped.reference || '')
      : await findDuplicateInvoice(orgId, mapped?.reference || '', mapped?.type || 'invoice', mapped?.direction || 'outgoing')

  return hit
    ? { fileId: item.fileId, ok: false, id: hit.id, number: hit.number, error: `${hit.reason} — ${hit.number}` }
    : null
}

async function commitInvoice(
  orgId: string,
  userId: string,
  item: CommitItem,
): Promise<CommitResult> {
  const mapped = item.mapped as MappedInvoice

  // Cash sales skip the draft/convert dance entirely — they are issued and paid on
  // creation, so `convert` has nothing to do and `adjustStock` applies at creation time.
  if (mapped.type === 'cash_sale') {
    const cs: any = await persistCashSale(orgId, userId, mapped, { adjustStock: item.options?.adjustStock !== false })
    const csId = String(cs.id || cs._id)
    await linkFile(item.fileId, 'invoice', csId)
    return { fileId: item.fileId, ok: true, id: csId, number: cs.invoiceNumber, issuedNumber: cs.invoiceNumber }
  }

  const invoice: any = await persistInvoiceDraft(orgId, userId, mapped)
  const id = String(invoice.id || invoice._id)
  await linkFile(item.fileId, 'invoice', id)

  const result: CommitResult = { fileId: item.fileId, ok: true, id, number: invoice.invoiceNumber }
  if (item.options?.convert) {
    const conv = await convertDraftInvoice(orgId, id, userId, { adjustStock: item.options.adjustStock !== false })
    if (conv.ok) result.issuedNumber = conv.invoiceNumber
    // A draft that failed to convert still exists and is still useful — report the reason
    // and let the user retry from the list rather than deleting their work.
    else result.error = `created, but convert failed: ${conv.error}`
  }
  return result
}

async function commitMovement(
  orgId: string,
  userId: string,
  item: CommitItem,
): Promise<CommitResult> {
  const mapped = item.mapped as MappedMovement
  // A correction books two movements from one document; both must land or neither is useful.
  const all: MappedMovement[] = [mapped, ...((item.extraMovements as MappedMovement[]) || [])]
  const numbers: string[] = []
  const allIds: string[] = []
  const createdProductIds: string[] = []
  let firstId: string | undefined
  const notes: string[] = []

  for (const m of all) {
    const res = await persistMovement(orgId, userId, m, {
      createMissingProducts: item.options?.createMissingProducts === true,
      // Confirming is what writes stock; `adjustStock: false` books the draft only.
      confirm: item.options?.adjustStock !== false,
    })
    firstId ??= res.id
    if (res.id) allIds.push(res.id)
    numbers.push(res.movementNumber)
    if (res.createdProducts.some(p => p.created)) {
      notes.push(`${res.createdProducts.filter(p => p.created).length} new product(s) created`)
      createdProductIds.push(...res.createdProducts.filter(p => p.created).map(p => p.productId))
    }
    if (res.droppedLines.length) {
      notes.push(`${res.droppedLines.length} line(s) skipped without a product: ${res.droppedLines.slice(0, 3).join(', ')}`)
    }
  }

  await linkFile(item.fileId, 'stock_movement', firstId!)
  return {
    fileId: item.fileId,
    ok: true,
    id: firstId,
    ids: allIds,
    number: numbers.join(', '),
    issuedNumber: numbers.join(', '),
    createdProductIds: createdProductIds.length ? createdProductIds : undefined,
    // Not a failure — surfaced so "created, but…" is visible in the result table.
    error: notes.length ? notes.join('; ') : undefined,
  }
}

export async function commitDocuments(
  orgId: string,
  userId: string,
  target: ImportTarget,
  items: CommitItem[],
  onProgress?: (done: number, total: number, label: string) => Promise<void> | void,
): Promise<CommitResult[]> {
  const out: CommitResult[] = []
  for (let i = 0; i < items.length; i++) {
    await onProgress?.(i, items.length, `Committing ${i + 1}/${items.length}`)
    try {
      const dup = await duplicateGuard(orgId, items[i])
      if (dup) { out.push(dup); continue }
      if (target === 'movement') {
        out.push(await commitMovement(orgId, userId, items[i]))
      } else {
        out.push(await commitInvoice(orgId, userId, items[i]))
      }
    } catch (e: any) {
      out.push({ fileId: items[i].fileId, ok: false, error: String(e?.message || e) })
    }
  }
  await onProgress?.(items.length, items.length, 'Commit complete')
  return out
}
