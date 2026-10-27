/**
 * FR-21 — what a till line needs from its product.
 *
 * Until R4 this module also copied ONE POS row into its document on the spot (`copyPosRow`), for a
 * keyed retry or a storno that met a sale an older release had written. Since R3 every row has its
 * document and the model is frozen, so nothing meets a row without one (FR-21.27). The copy of a
 * whole org stays in `copy-org.ts`, for migrations 0008/0009 and the restore of an older bundle.
 */
import { Invoice, Product } from 'db/models'

const oid = (v: unknown) => new Invoice.base.Types.ObjectId(String(v))

/** The units of the products a row sells, for its lines (a POS line carries none). */
export async function unitsOf(orgId: unknown, lines: Array<{ productId?: unknown }>): Promise<Map<string, string>> {
  const ids = [...new Set(lines.map(l => l.productId).filter(Boolean).map(String))]
  if (!ids.length) return new Map()
  const products = await Product.find({ orgId: oid(orgId), _id: { $in: ids.map(oid) } }, { unit: 1 }).lean().exec()
  return new Map((products as any[]).filter(p => p.unit).map(p => [String(p._id), String(p.unit)]))
}
