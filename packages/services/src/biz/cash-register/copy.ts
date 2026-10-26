/**
 * FR-21 — a POS row becomes its cash-register document.
 *
 * `copyPosRow` copies ONE row on the spot. Until the copy migration has run, and for anything an
 * older release wrote after it, a till sale can still live only in `postransactions`. Two requests
 * must reach it there (FR-21 §6):
 * - a keyed retry of a sale an older release rang up (edge 1): copied, then replayed;
 * - a storno of such a sale (edge 3): copied, and the claim is taken on the copy. The frozen POS
 *   row is never written.
 *
 * The copy keeps the row's `_id`, number, УНП and times (`mapping.ts#fromPosTransaction`), so the
 * readers that union both stores read it once, and a second copy finds the first. Its stock
 * movement is linked by `invoiceId`, which the migration also does for every row.
 */
import { Invoice, Org, POSSession, POSTransaction, Product, StockMovement } from 'db/models'
import { fromPosTransaction } from './mapping.js'
import { REGISTER_TYPES } from './pos-union.js'

const oid = (v: unknown) => new Invoice.base.Types.ObjectId(String(v))

/** The units of the products a row sells, for its lines (a POS line carries none). */
export async function unitsOf(orgId: unknown, lines: Array<{ productId?: unknown }>): Promise<Map<string, string>> {
  const ids = [...new Set(lines.map(l => l.productId).filter(Boolean).map(String))]
  if (!ids.length) return new Map()
  const products = await Product.find({ orgId: oid(orgId), _id: { $in: ids.map(oid) } }, { unit: 1 }).lean().exec()
  return new Map((products as any[]).filter(p => p.unit).map(p => [String(p._id), String(p.unit)]))
}

/**
 * The cash-register document of one POS row, created from it if it does not exist yet. Null when
 * the org has no such row in either store.
 */
export async function copyPosRow(orgId: string, id: string): Promise<any | null> {
  if (!Invoice.base.Types.ObjectId.isValid(id)) return null
  const existing = await Invoice.findOne({ _id: oid(id), orgId: oid(orgId), type: { $in: REGISTER_TYPES } }).lean().exec()
  if (existing) return existing
  const row: any = await POSTransaction.findOne({ _id: oid(id), orgId: oid(orgId) }).lean().exec()
  if (!row) return null

  const [session, org, stornos, units] = await Promise.all([
    row.sessionId ? POSSession.findOne({ _id: row.sessionId, orgId: row.orgId }).lean().exec() : null,
    Org.findById(row.orgId, { 'settings.baseCurrency': 1 }).lean().exec(),
    // The stornos that reverse a sale: a storno whose receipt failed reversed nothing (#145).
    row.type === 'sale'
      ? POSTransaction.find({ orgId: row.orgId, type: 'storno', originalTransactionId: row._id, status: 'completed' }, { _id: 1 }).lean().exec()
      : [],
    unitsOf(row.orgId, row.lines || []),
  ])
  const doc = fromPosTransaction(row, session as any, {
    baseCurrency: (org as any)?.settings?.baseCurrency,
    unitOf: productId => units.get(String(productId)),
    stornoedBy: (stornos as any[]).map(s => s._id),
  })

  try {
    // Through the model, so the home guard and the schema see it; with its own times (§5.4).
    await new Invoice(doc).save({ timestamps: false })
  } catch (e: any) {
    // Copied by a concurrent request (or the migration) in the meantime: the same document. Any
    // other duplicate — its number or its key on another document — is a conflict the copy
    // migration's preflight reports, and this must not hide.
    if (e?.code !== 11000 || !(await Invoice.exists({ _id: row._id, orgId: row.orgId }).exec())) throw e
  }
  if (row.movementId) {
    await StockMovement.updateOne(
      { _id: row.movementId, orgId: row.orgId, invoiceId: { $exists: false } },
      { $set: { invoiceId: row._id } },
    ).exec()
  }
  return Invoice.findOne({ _id: row._id, orgId: row.orgId }).lean().exec()
}
