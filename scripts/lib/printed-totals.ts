/**
 * #485's repair: an invoice imported before the PDF reader took the printed VAT carries the sum of its
 * lines' rounded VAT, one or two cents away from the VAT the document prints, and a total off by the same.
 * This puts back the printed VAT and sum due, read from the PDF each invoice was committed from, and
 * nothing else: not a line, not the base, not the contact.
 *
 * What it takes, and why each is safe to change:
 *   - `unpaid`: sent, nothing paid, the whole total due. VAT, total, the base-currency total and what is due.
 *   - `paid_on_issue`: paid when issued by ONE cash or card payment of the whole total, nothing due, no
 *     receipt holding it, no till session. The same four, the payment's amount and `amountPaid`. The customer
 *     paid what the document printed, so the payment moves with the total. `tendered` moves only where it
 *     was exactly the old total.
 * Everything else is counted and left alone: a till register's payment, a part payment, an invoice whose
 * PDF and stored base disagree (it was edited, or the PDF is a re-export), a difference of more than the
 * VAT's rounding.
 */
import { Contact, DocFile, Invoice } from '../../packages/db/src/models/index.js'
import { recordAuditEntry, type AuditEntry } from '../../packages/services/src/biz/audit-log.service.js'
import { draftFromLayoutText } from '../../packages/services/src/biz/doc-import/parse-table.js'

export type PrintedCategory = 'unpaid' | 'paid_on_issue'

export interface PrintedTotalsPlan {
  id: string
  invoiceNumber: string
  category: PrintedCategory
  /** What was read, which the write is conditional on. */
  before: { taxTotal: number; total: number; totalBase: number; amountDue: number; amountPaid: number; payment?: number; tendered?: number }
  after: { taxTotal: number; total: number; totalBase: number; amountDue: number; amountPaid: number; payment?: number; tendered?: number }
}

export interface PrintedTotalsSurvey {
  plans: PrintedTotalsPlan[]
  /** Committed invoice PDFs looked at, and what became of each, by reason. */
  counts: Record<string, number>
}

const cents = (v: unknown) => Math.round((Number(v) || 0) * 100)
const round2 = (v: number) => Math.round(v * 100) / 100
const ON_ISSUE = new Set(['cash_on_issue', 'card_on_issue'])

/** Every committed invoice PDF of the org, against the invoice it was committed to. Reads only. */
export async function planPrintedTotals(orgId: unknown): Promise<PrintedTotalsSurvey> {
  const counts: Record<string, number> = {}
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1 }
  const plans: PrintedTotalsPlan[] = []
  const files = DocFile.find({ orgId, docType: 'invoice', status: 'committed' }).select('extractedText committedIds').lean().cursor()
  for await (const f of files as any) {
    bump('committed invoice PDFs')
    const inv: any = await Invoice.findOne({ orgId, _id: { $in: f.committedIds ?? [] }, direction: 'outgoing', type: { $in: ['invoice', 'credit_note', 'debit_note'] } })
      .select('invoiceNumber status subtotal discountTotal taxTotal total totalBase exchangeRate amountPaid amountDue payments receiptHolds register').lean()
    if (!inv) { bump('left: no outgoing invoice behind the PDF'); continue }
    const printed = draftFromLayoutText(String(f.extractedText ?? ''), 'invoice')?.extraction
    if (printed?.vat_total == null || printed.gross_total == null || printed.net_total == null) { bump('left: the PDF prints no VAT and sum due the reader can take'); continue }
    const net = cents(inv.total) - cents(inv.taxTotal)
    const vat = Math.abs(cents(printed.vat_total)), gross = Math.abs(cents(printed.gross_total))
    if (vat === cents(inv.taxTotal) && gross === cents(inv.total)) { bump('equal to the print already'); continue }
    if (Math.abs(cents(printed.net_total)) !== net || cents(inv.subtotal) - cents(inv.discountTotal) !== net || gross !== net + vat) {
      bump('left: the PDF and the invoice hold different bases (edited, or a re-export)'); continue
    }
    if (Math.abs(vat - cents(inv.taxTotal)) > 2) { bump('left: off by more than the VAT\'s rounding'); continue }

    const pays: any[] = inv.payments ?? []
    const rate = Number(inv.exchangeRate) || 1
    const total = gross / 100
    const base = {
      taxTotal: inv.taxTotal, total: inv.total, totalBase: inv.totalBase, amountDue: inv.amountDue ?? 0, amountPaid: inv.amountPaid ?? 0,
    }
    const after = { taxTotal: vat / 100, total, totalBase: round2(total * rate), amountDue: base.amountDue, amountPaid: base.amountPaid }
    if (inv.status === 'sent' && !pays.length && !cents(inv.amountPaid) && cents(inv.amountDue) === cents(inv.total) && !inv.register?.sessionId) {
      plans.push({ id: String(inv._id), invoiceNumber: inv.invoiceNumber, category: 'unpaid', before: base, after: { ...after, amountDue: total } })
      bump('to repair: unpaid')
      continue
    }
    const p = pays[0]
    if (
      inv.status === 'paid' && pays.length === 1 && ON_ISSUE.has(p.origin) && cents(p.amount) === cents(inv.total) &&
      cents(inv.amountPaid) === cents(inv.total) && !cents(inv.amountDue) && !(inv.receiptHolds ?? []).length && !inv.register?.sessionId
    ) {
      const tenderedMoves = p.tendered != null && cents(p.tendered) === cents(inv.total)
      plans.push({
        id: String(inv._id), invoiceNumber: inv.invoiceNumber, category: 'paid_on_issue',
        before: { ...base, payment: p.amount, ...(p.tendered != null ? { tendered: p.tendered } : {}) },
        after: { ...after, amountPaid: total, payment: total, ...(p.tendered != null ? { tendered: tenderedMoves ? total : p.tendered } : {}) },
      })
      bump('to repair: paid on issue')
      continue
    }
    bump(`left: ${inv.status}, ${pays.map((x: any) => x.origin ?? x.method).join('+') || 'no payment'}${inv.register?.sessionId ? ', in a till session' : ''}`)
  }
  return { plans, counts }
}

/**
 * Write one plan. Conditional on every value the plan read, so a document that changed since is left alone
 * (false). One AuditLog row names each field, before and after.
 */
export async function applyPrintedTotals(orgId: unknown, plan: PrintedTotalsPlan, by: unknown, reason: string): Promise<boolean> {
  const b = plan.before, a = plan.after
  const filter: Record<string, unknown> = { _id: plan.id, orgId, taxTotal: b.taxTotal, total: b.total, amountDue: b.amountDue, amountPaid: b.amountPaid }
  const set: Record<string, unknown> = { taxTotal: a.taxTotal, total: a.total, totalBase: a.totalBase, amountDue: a.amountDue }
  if (plan.category === 'unpaid') {
    Object.assign(filter, { status: 'sent', 'payments.0': { $exists: false } })
  } else {
    Object.assign(filter, { status: 'paid', 'payments.0.amount': b.payment, 'payments.1': { $exists: false }, 'receiptHolds.0': { $exists: false } })
    Object.assign(set, { amountPaid: a.amountPaid, 'payments.0.amount': a.payment })
    if (b.tendered != null) Object.assign(filter, { 'payments.0.tendered': b.tendered })
    if (a.tendered != null && a.tendered !== b.tendered) set['payments.0.tendered'] = a.tendered
  }
  const res = await Invoice.updateOne(filter, { $set: set }).exec()
  if (res.modifiedCount !== 1) return false
  const changed = (['taxTotal', 'total', 'totalBase', 'amountDue', 'amountPaid', 'payment', 'tendered'] as const)
    .filter(k => (a as any)[k] !== undefined && (a as any)[k] !== (b as any)[k])
    .map(k => ({ field: k === 'payment' ? 'payments.0.amount' : k === 'tendered' ? 'payments.0.tendered' : k, oldValue: (b as any)[k], newValue: (a as any)[k] }))
  await audited({
    orgId: String(orgId), userId: String(by), action: 'update', module: 'invoicing', entityType: 'invoice', entityId: plan.id, entityName: plan.invoiceNumber,
    changes: [...changed, { field: 'reason', oldValue: null, newValue: reason }],
  })
  return true
}

// ── the customer's VAT number ───────────────────────────────────────────────────────────

export interface ContactVatPlan {
  id: string
  name: string
  vatNumber: string
  /** How many of its invoices print it. */
  invoices: number
}

const compactId = (s: unknown) => String(s ?? '').replace(/\s+/g, '').toUpperCase()

/**
 * A contact with no VAT number, whose own invoices print one: `BG` and the contact's own ЕИК, and the same
 * on every one of them. The register names a partner by its VAT number, so without it the sales register
 * LGR derives names the ЕИК where the filed one has the VAT number (FR-25 R3). Reads only.
 */
export async function planContactVat(orgId: unknown): Promise<ContactVatPlan[]> {
  // Per contact, every VAT number and ЕИК its invoices print: one of each, or it is left alone.
  const seen = new Map<string, { vat: Set<string>; eik: Set<string>; invoices: number }>()
  const files = DocFile.find({ orgId, docType: 'invoice', status: 'committed' }).select('extractedText committedIds').lean().cursor()
  for await (const f of files as any) {
    const inv: any = await Invoice.findOne({ orgId, _id: { $in: f.committedIds ?? [] }, direction: 'outgoing' }).select('contactId').lean()
    if (!inv?.contactId) continue
    const customer = draftFromLayoutText(String(f.extractedText ?? ''), 'invoice')?.extraction?.customer
    const vat = compactId(customer?.vat_id)
    if (!vat) continue
    const k = String(inv.contactId)
    const s = seen.get(k) ?? { vat: new Set<string>(), eik: new Set<string>(), invoices: 0 }
    s.vat.add(vat)
    s.eik.add(compactId(customer?.company_id))
    s.invoices++
    seen.set(k, s)
  }
  const plans: ContactVatPlan[] = []
  for (const [id, s] of seen) {
    if (s.vat.size !== 1 || s.eik.size !== 1) continue
    const vatNumber = [...s.vat][0], eik = [...s.eik][0]
    const c: any = await Contact.findOne({ _id: id, orgId }).select('companyName taxId vatNumber').lean()
    if (!c || compactId(c.vatNumber) || !compactId(c.taxId)) continue
    if (eik !== compactId(c.taxId) || vatNumber !== `BG${eik}`) continue
    plans.push({ id, name: c.companyName ?? '', vatNumber, invoices: s.invoices })
  }
  return plans
}

/** Write one contact's VAT number, if it still has none. One AuditLog row. */
export async function applyContactVat(orgId: unknown, plan: ContactVatPlan, by: unknown, reason: string): Promise<boolean> {
  const res = await Contact.updateOne(
    { _id: plan.id, orgId, $or: [{ vatNumber: { $exists: false } }, { vatNumber: null }, { vatNumber: '' }] },
    { $set: { vatNumber: plan.vatNumber } },
  ).exec()
  if (res.modifiedCount !== 1) return false
  await audited({
    orgId: String(orgId), userId: String(by), action: 'update', module: 'invoicing', entityType: 'contact', entityId: plan.id, entityName: plan.name,
    changes: [{ field: 'vatNumber', oldValue: null, newValue: plan.vatNumber }, { field: 'reason', oldValue: null, newValue: reason }],
  })
  return true
}

/** A correction of money or master data is not done until its audit row is: a failed one stops the run. */
async function audited(entry: AuditEntry): Promise<void> {
  if (!(await recordAuditEntry(entry))) throw new Error(`the audit row for ${entry.entityType} ${entry.entityId} was not written; the change itself was`)
}
