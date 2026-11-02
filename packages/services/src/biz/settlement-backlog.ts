import { Invoice } from 'db/models'
import { printsHere } from './sale-counting.js'

/**
 * What `scripts/settle-cash-invoices.ts` may touch: the invoices paid at the counter that were issued
 * before such an invoice was paid on issue.
 *
 * ⚠ FR-23: only where nothing prints. Where LGR prints, the receipt and its payment are the settlement,
 * and an unpaid cash invoice is one whose money nobody took: settling it books money with no receipt.
 * Run for real, the script did exactly that to an invoice whose receipt had failed, and took a part-paid
 * one's remainder. So an org where LGR prints is refused by name and skipped otherwise, and a document
 * with a receipt tried is never selected, in any org: its money is that receipt's, whatever it came to.
 */

/** The states in which an invoice paid at the counter can still show money due. */
const UNSETTLED = ['sent', 'overdue', 'partially_paid']
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/**
 * This org's invoices paid at the counter that still show money due (a zero-total one is never
 * "due"). An invoice for a cash sale is the cash sale's to settle (#171): the rule skips it.
 */
export async function unsettledInvoices(orgId: any, methods: string[]) {
  const tried = await Invoice.distinct('register.paidInvoiceId', { orgId, type: 'payment_receipt' }).exec()
  const docs: any[] = await Invoice.find({
    orgId, direction: 'outgoing', type: 'invoice', paymentMethod: { $in: methods }, status: { $in: UNSETTLED },
    'cashSaleRef.cashSaleId': { $exists: false }, _id: { $nin: tried },
  }).select('_id invoiceNumber total payments issueDate paymentMethod').sort({ issueDate: 1 }).lean()
  return docs
    .map(d => ({ id: String(d._id), number: d.invoiceNumber, method: d.paymentMethod as string, outstanding: round2(d.total - (d.payments || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)) }))
    .filter(d => d.outstanding > 0)
}

/** Of the orgs homed here, the ones a run may settle: those that print nothing. An org named by the operator says why not. */
export async function orgsToSettle(found: any[], named: boolean): Promise<any[]> {
  const orgs: any[] = []
  for (const o of found) {
    if (await printsHere(String(o._id))) {
      if (named) throw new Error(`${o.slug}: LGR prints for this org, so a receipt and its payment settle its invoices. Nothing was written.`)
      console.log(`skip ${o.slug}: LGR prints here`)
      continue
    }
    orgs.push(o)
  }
  return orgs
}
