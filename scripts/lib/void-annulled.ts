/**
 * Mark an invoice that PlusMinus has ANNULLED as `voided` in LGR, where `POST /invoices/:id/void` will not.
 *
 * PlusMinus annuls an issued invoice with a `-ФЕА` document that carries the SAME number and the negated
 * amounts; a replacement invoice or a credit note usually follows. The importer brought the original in as
 * an ordinary invoice, and once it is `paid` LGR's own void refuses it (draft / sent / received only), so
 * the annulled sale stayed in the sales figures. A person decided (2026-11-02) that such an invoice is
 * marked annulled, not deleted.
 *
 * What a void changes here: `status → voided`, `voidedAt`, one `statusHistory` entry, one AuditLog row.
 * Nothing else:
 * - NO stock is reversed. `POST …/void` would put the goods back; here the snapshot true-up has normally
 *   done that already (PlusMinus's stock moved when it annulled), and reversing twice would leave LGR above
 *   PlusMinus. If no true-up has run since, run compare + true-up afterwards.
 * - `payments` / `amountPaid` stay: they are the record of what was taken.
 *
 * A credit note is NOT an annulled invoice. PlusMinus keeps it as a valid document, so it is never voided
 * here, and an invoice that a live credit note already cancels is refused: voiding that one too would take
 * its revenue out twice.
 */
import { AuditLog, Invoice, StockMovement } from '../../packages/db/src/models/index.js'

/** The statuses `POST /invoices/:id/void` refuses, the only ones this exists for. */
export const API_REFUSES = ['paid', 'partially_paid', 'overdue']
/** The statuses the API voids properly (and reverses stock for): use it, not this. */
const API_VOIDS = ['draft', 'sent', 'received']

export interface VoidPlan {
  /** The PlusMinus number as named by the caller. */
  number: string
  ok: boolean
  /** Voided already: nothing to do, and not an error. */
  already?: boolean
  /** Why not, when it is not ok. */
  reason?: string
  invoice?: {
    id: string
    invoiceNumber: string
    status: string
    issueDate: Date
    total: number
    amountPaid: number
    currency?: string
  }
  /** The stock movements the invoice made, for the report only: none of them is touched. */
  movements?: Array<{ number: string; type: string; status: string; quantity: number }>
}

const refuse = (number: string, reason: string, extra: Partial<VoidPlan> = {}): VoidPlan => ({ number, ok: false, reason, ...extra })

/** What voiding `INV-<pmNumber>` would do. Reads only. */
export async function planVoid(orgId: unknown, pmNumber: string): Promise<VoidPlan> {
  const number = String(pmNumber).trim()
  if (!/^\d{6,}$/.test(number)) return refuse(number, 'not a PlusMinus invoice number (digits only)')

  const found: any[] = await Invoice.find({ orgId, invoiceNumber: `INV-${number}` }).lean().exec()
  if (!found.length) return refuse(number, `LGR holds no INV-${number}`)
  if (found.length > 1) return refuse(number, `LGR holds ${found.length} documents numbered INV-${number}`)
  const inv = found[0]
  const invoice = {
    id: String(inv._id),
    invoiceNumber: inv.invoiceNumber as string,
    status: inv.status as string,
    issueDate: inv.issueDate as Date,
    total: Number(inv.total) || 0,
    amountPaid: Number(inv.amountPaid) || 0,
    currency: inv.currency as string | undefined,
  }

  if (inv.type !== 'invoice') {
    return refuse(number, `LGR holds it as a ${inv.type}: a credit note or proforma is a valid document, not an annulled invoice`, { invoice })
  }
  if (inv.direction !== 'outgoing') return refuse(number, 'not an outgoing invoice', { invoice })
  if (inv.status === 'voided') return { number, ok: false, already: true, reason: 'already voided', invoice }
  if (API_VOIDS.includes(inv.status)) {
    return refuse(number, `status ${inv.status}: POST /invoices/:id/void handles it, and reverses its stock properly`, { invoice })
  }
  if (!API_REFUSES.includes(inv.status)) return refuse(number, `status ${inv.status} is not one this handles`, { invoice })

  const credits: any[] = await Invoice.find({
    orgId,
    type: 'credit_note',
    relatedInvoiceId: inv._id,
    status: { $nin: ['draft', 'voided', 'cancelled'] },
  }).select('invoiceNumber').lean().exec()
  if (credits.length) {
    return refuse(number, `credit note ${credits.map(c => c.invoiceNumber).join(', ')} already cancels it: voiding it too would take its revenue out twice`, { invoice })
  }

  const moves: any[] = await StockMovement.find({ orgId, invoiceId: inv._id }).lean().exec()
  const movements = moves.map(m => ({
    number: String(m.movementNumber),
    type: String(m.type),
    status: String(m.status),
    quantity: (m.lines ?? []).reduce((s: number, l: any) => s + (Number(l.quantity) || 0), 0),
  }))
  return { number, ok: true, invoice, movements }
}

/**
 * Void one planned invoice. Conditional on the status the plan saw, so a document that changed since (or
 * was voided meanwhile) is left alone: returns false then. Stock, payments and everything else stay as is.
 */
export async function applyVoid(orgId: unknown, plan: VoidPlan, by: unknown, reason: string, at: Date = new Date()): Promise<boolean> {
  if (!plan.ok || !plan.invoice) throw new Error(`refusing to apply a plan that is not ok (${plan.number})`)
  const inv = plan.invoice
  // `voidedAt` is written by the app's own void but is not in the Mongoose schema: strict:false keeps it.
  const res = await Invoice.updateOne(
    { _id: inv.id, orgId, type: 'invoice', status: inv.status },
    {
      $set: { status: 'voided', voidedAt: at },
      $push: { statusHistory: { status: 'voided', fromStatus: inv.status, changedAt: at, changedBy: by, reason } },
    },
    { strict: false },
  ).exec()
  if (res.modifiedCount !== 1) return false
  await AuditLog.create({
    orgId,
    userId: by,
    action: 'void',
    module: 'invoicing',
    entityType: 'invoice',
    entityId: inv.id,
    entityName: inv.invoiceNumber,
    changes: [
      { field: 'status', oldValue: inv.status, newValue: 'voided' },
      { field: 'reason', oldValue: null, newValue: reason },
    ],
    timestamp: at,
  })
  return true
}
