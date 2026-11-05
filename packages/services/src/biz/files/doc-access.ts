import { mongoose } from 'db/connection'
import { DocFile, Invoice, StockMovement } from 'db/models'
import { PERMISSION_BY_TARGET, targetRefusal, type ImportActor } from '../doc-import/target-access.js'
import type { ImportTarget } from '../doc-import/types.js'
import { targetForDocType } from './doc-pipeline.service.js'

/**
 * Files app — what a session needs to BOOK, UNDO or RECONCILE a document.
 *
 * The Files gate (`admin.settings`, in `file.controller`) says who may use the document store. It
 * says nothing about what a document goes on to change: committing one issues invoices and moves
 * stock, undoing one voids them and reverses the movements, reconciling one rewrites a booked
 * movement. Each asks for what the import dialog asks for the same target (`targetRefusal`):
 * `invoicing.write` for invoices and cash sales, `inventory.write` for movements, and the
 * purchases area for a bill. Routes that only store, read or extract a document keep the Files
 * gate alone.
 *
 * `admin` always passes, as in `writeRefusal`: a set that lacked a write would otherwise lock an
 * org's owner out of their own data.
 *
 * Asked BEFORE the job starts, so a refusal is a 403 and not a job that fails, and all or nothing:
 * one document the caller may not book refuses the batch.
 */

export type BooksAction =
  | { kind: 'commit' }
  | { kind: 'reconcile' }
  | { kind: 'undo'; rollback: boolean; removeProducts: boolean }

const isTarget = (v: unknown): v is ImportTarget =>
  typeof v === 'string' && (Object.keys(PERMISSION_BY_TARGET) as string[]).includes(v)

/** The targets `action` would put the documents into, or take them out of. */
async function targetsFor(orgId: string, docFileIds: readonly string[], action: BooksAction): Promise<Set<ImportTarget>> {
  const targets = new Set<ImportTarget>()

  // Only a movement document can be reconciled, and it rewrites a booked movement.
  if (action.kind === 'reconcile') return targets.add('movement')

  if (action.kind === 'undo') {
    // Without a rollback only the file and its row go; the bookings stay.
    if (!action.rollback) return targets
    // Products a rollback deactivates are stock records, whatever the document was.
    if (action.removeProducts) targets.add('movement')
  }

  const ids = docFileIds.filter(id => mongoose.Types.ObjectId.isValid(id))
  if (!ids.length) return targets
  const docs: any[] = await DocFile.find({ orgId, _id: { $in: ids } }).select('docType committedIds analysis.target').lean()

  if (action.kind === 'commit') {
    for (const d of docs) {
      // The target a document was ANALYZED as is the one a commit books. A „Складови операции" export
      // of sales is a cash sale although its docType says movement.
      const target = isTarget(d.analysis?.target) ? d.analysis.target : targetForDocType(d.docType)
      if (target) targets.add(target)
    }
    return targets
  }

  // Undo: the records the documents booked decide what undoing them takes, not the document's own
  // fields, which a re-upload or a re-analysis can have moved on from.
  const booked = docs.flatMap(d => (d.committedIds ?? []).map(String))
  if (!booked.length) return targets
  for (const inv of (await Invoice.find({ orgId, _id: { $in: booked } }).select('direction').lean()) as any[]) {
    targets.add(inv.direction === 'incoming' ? 'bill' : 'sales_invoice')
  }
  if (await StockMovement.exists({ orgId, _id: { $in: booked } })) targets.add('movement')
  return targets
}

/** Why `actor` may not do `action` to these documents, or null. The shape is `targetRefusal`'s. */
export async function booksRefusal(orgId: string, actor: ImportActor, docFileIds: readonly string[], action: BooksAction) {
  if (actor.role === 'admin') return null
  for (const target of await targetsFor(orgId, docFileIds, action)) {
    const refusal = targetRefusal(actor, target)
    if (refusal) return refusal
  }
  return null
}
