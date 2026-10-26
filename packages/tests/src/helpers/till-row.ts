import { Invoice, POSTransaction } from 'db/models'
import { toPosTransaction } from 'services/biz/cash-register/mapping'
import { asEntity, loadPosRows } from 'services/biz/cash-register/pos-union'

/**
 * FR-21 — a till sale or storno as the POS row it stands for, from whichever store holds it.
 *
 * Since R2 the till writes cash-register documents (`invoices`), and older sales are POS rows until
 * the copy. The tests that assert on a till row read it through here, as the readers do (FR-21.8).
 */
export async function tillRow(id: unknown): Promise<any | null> {
  const doc = await Invoice.findById(String(id)).lean().exec()
  if (doc) return asEntity(toPosTransaction(doc))
  return POSTransaction.findById(String(id)).lean().exec()
}

/** Every till row of an org, from both stores, each once. */
export function tillRows(orgId: unknown): Promise<any[]> {
  return loadPosRows({ orgId: String(orgId) })
}
