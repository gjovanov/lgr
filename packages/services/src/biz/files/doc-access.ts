import { mongoose } from 'db/connection'
import { DocFile, Invoice, StockMovement } from 'db/models'
import { PERMISSION_BY_TARGET, targetRefusal, type ImportActor } from '../doc-import/target-access.js'
import type { ImportTarget } from '../doc-import/types.js'
import { permissionRefusal } from '../route-permission.js'
import { targetForDocType } from './doc-pipeline.service.js'

/**
 * Files app — what a session needs to BOOK, UNDO, RECONCILE or ANALYSE a document, and to see a
 * snapshot's diff.
 *
 * The Files gate (`admin.settings`, in `file.controller`) says who may use the document store. It
 * says nothing about what a document goes on to change: committing one issues invoices and moves
 * stock, undoing one voids them and reverses the movements, reconciling one rewrites a booked
 * movement. Each asks for what the import dialog asks for the same target (`targetRefusal`):
 * `invoicing.write` for invoices and cash sales, `inventory.write` for movements, and the
 * purchases area for a bill. Routes that only store, read or extract a document keep the Files
 * gate alone.
 *
 * ANALYSING asks for the same. The analysis writes nothing to the books (it never creates or edits a
 * contact: #484, #499), but it matches the document against the live catalog, contacts and costs and
 * hands the mapping back, and the import dialog's analysis is "a write on the surface being imported
 * into" (`PERMISSION_BY_TARGET`). The Files routes ask the same, so the two doors agree.
 *
 * The DIFF of a storeAvailability snapshot (`compareRefusal`) is a read, not a booking: it sets the
 * snapshot against the live catalog and stock and prints both side by side.
 *
 * `admin` always passes, as in `writeRefusal`: a set that lacked a write would otherwise lock an
 * org's owner out of their own data.
 *
 * Asked BEFORE the job starts, so a refusal is a 403 and not a job that fails, and all or nothing:
 * one document the caller may not book refuses the batch.
 */

export type BooksAction =
  | { kind: 'commit' }
  | { kind: 'analyze' }
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

  if (action.kind === 'commit' || action.kind === 'analyze') {
    for (const d of docs) {
      // The target a document was ANALYZED as is the one a commit books, and the one a second analysis
      // of the same bytes comes out as. A „Складови операции" export of sales is a cash sale although
      // its docType says movement; one never analyzed has only its docType to say.
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

/** The route a snapshot's diff is a read of: the stock levels, whose reads S-29 gave their rule. */
const STOCK_READ_ROUTE = '/api/org/:orgId/warehouse/stock-level'

/**
 * Why `actor` may not see a storeAvailability snapshot's diff, or null.
 *
 * The diff sets the snapshot against the live catalog and stock and prints the quantities and prices
 * of both sides. That is a read of what `GET warehouse/*` reads, so it asks what that read asks, from
 * the same table (`permissionRefusal`), and cannot drift from it: whoever may read stock may see the
 * diff, and nobody else. `admin` always passes.
 */
export function compareRefusal(actor: ImportActor & { amr?: readonly string[] }) {
  return permissionRefusal(
    { role: actor.role, permissions: actor.permissions, areas: actor.areas ?? undefined, amr: actor.amr },
    'GET',
    STOCK_READ_ROUTE,
  )
}
