/**
 * FR-06 (#14) P2 — the three document registers: `sales-documents`, `purchase-documents`
 * and `cash-register`.
 *
 * These mirror the three KINDS the invoicing export endpoint has always had
 * (`POST /invoicing/export/kind/:kind`), and deliberately do NOT replace it: that endpoint
 * stays mounted and byte-compatible (FR-6.20), and the moved three-tab export page keeps
 * driving it. What the registry adds is the other half — the same population as a runnable,
 * filterable, drill-downable TABLE, which the export page cannot do.
 *
 *   outgoing  = invoice + credit_note + debit_note, direction outgoing (shared SALES_DOC numbering)
 *   incoming  = bills — type invoice, direction incoming
 *   cash_register = cash_sale (its own numbering)
 *
 * Draft documents are included but flagged by their status: a draft register is exactly what
 * you want when hunting for the document someone forgot to issue. Converted proformas never
 * appear — they are not in any of the three type sets.
 *
 * ── The per-method columns (gjovanov/lgr#127) ────────────────────────────────
 * The register also splits what was PAID across the four methods the app offers (cash, card,
 * cash on delivery, bank transfer), each with its own column total — the question "how much of
 * today's invoicing came in over the counter" was otherwise unanswerable from this screen.
 *
 * It splits what was PAID, not the `total`, which is what makes the four columns reconcile:
 * paidCash + paidCard + paidCashOnDelivery + paidBank + `meta.unattributedPaid` equals the
 * Платено column's total (to the extent `payments[]` and `amountPaid` agree on a document —
 * where they disagree the payment rows win, since they are the record of what was tendered).
 * Attributing `total` by the header method (what FR-08's
 * `effectiveMethods` does, correctly, for register reconciliation where the two coincide) would
 * put an unpaid invoice's full amount in a column headed „Платени" — that is a different
 * question, and the Платено / Остатък columns already answer it.
 */

import { Invoice } from 'db/models'
import {
  rowCapFor,
  type ReportColumn,
  type ReportHandlerContext,
  type ReportResult,
} from '../report-registry.types.js'

export type DocumentKind = 'outgoing' | 'incoming' | 'cash_register'

/** Type + direction filter per kind — the same split the export controller uses. */
const KIND_FILTER: Record<DocumentKind, Record<string, any>> = {
  outgoing: { type: { $in: ['invoice', 'credit_note', 'debit_note'] }, direction: 'outgoing' },
  incoming: { type: 'invoice', direction: 'incoming' },
  cash_register: { type: 'cash_sale' },
}

/**
 * Exactly the Invoice model's status enum — no more. Offering a filter value the schema can
 * never produce (`completed`, which some list views still show) is a filter that silently
 * returns nothing.
 */
const STATUS_OPTIONS = [
  'draft', 'sent', 'received', 'partially_paid', 'paid', 'overdue', 'voided', 'cancelled', 'converted',
]

function oid(v: unknown) {
  return new Invoice.base.Types.ObjectId(String(v))
}

function dayStart(d: string) { return new Date(`${d}T00:00:00.000`) }
function dayEnd(d: string) { return new Date(`${d}T23:59:59.999`) }

/**
 * `Invoice.payments[].method` / `Invoice.paymentMethod` → column key. The model's enum also
 * allows `other`, and `paymentMethod` is a free String, so anything unmapped lands in
 * `meta.unattributedPaid` rather than being quietly dropped or folded into cash.
 */
const METHOD_COLUMN: Record<string, string> = {
  cash: 'paidCash',
  card: 'paidCard',
  cash_on_delivery: 'paidCashOnDelivery',
  bank_transfer: 'paidBank',
}

const METHOD_KEYS = ['paidCash', 'paidCard', 'paidCashOnDelivery', 'paidBank'] as const

/**
 * How much of this document's `amountPaid` came in by which method.
 *
 *   1. `payments[]` when present — the real record of what was tendered, so a split-tender
 *      document feeds two columns;
 *   2. else the header `paymentMethod`, for whatever has actually been paid;
 *   3. else, for a cash sale that was paid, infer cash — the one document kind that is paid on
 *      the spot and is routinely recorded without a payment row (imported CSR day-aggregates).
 *
 * Steps 2 and 3 mirror `effectiveMethods` (FR-08); only the amount differs, see the file head.
 */
function paidByMethod(doc: {
  docType?: string
  paymentMethod?: string
  payments?: { method?: string; amount?: number }[]
  amountPaid?: number
}): { method: string; amount: number }[] {
  const rows = (doc.payments || []).filter(p => p && Number(p.amount))
  if (rows.length) {
    return rows.map(p => ({ method: String(p.method || 'other'), amount: Number(p.amount) || 0 }))
  }
  const paid = Number(doc.amountPaid) || 0
  if (!paid) return []
  if (doc.paymentMethod) return [{ method: String(doc.paymentMethod), amount: paid }]
  if (doc.docType === 'cash_sale') return [{ method: 'cash', amount: paid }]
  return []
}

const COLUMNS: ReportColumn[] = [
  { key: 'date',        labelKey: 'reports.columns.date',        type: 'date' },
  { key: 'number',      labelKey: 'reports.columns.document' },
  { key: 'docType',     labelKey: 'reports.columns.docType' },
  { key: 'contactName', labelKey: 'reports.columns.contact' },
  { key: 'status',      labelKey: 'common.status' },
  { key: 'currency',    labelKey: 'common.currency' },
  { key: 'subtotal',    labelKey: 'reports.columns.net',      type: 'money', align: 'end' },
  { key: 'taxTotal',    labelKey: 'reports.columns.tax',      type: 'money', align: 'end' },
  { key: 'total',       labelKey: 'reports.columns.total',    type: 'money', align: 'end' },
  { key: 'amountPaid',  labelKey: 'reports.columns.paid',     type: 'money', align: 'end' },
  { key: 'amountDue',   labelKey: 'reports.columns.due',      type: 'money', align: 'end' },
  // The paid-by-method split. Last, so the register still reads left-to-right as a document
  // list; the runner's column cog hides them for anyone who does not want them.
  { key: 'paidCash',           labelKey: 'reports.columns.paidCash',           type: 'money', align: 'end' },
  { key: 'paidCard',           labelKey: 'reports.columns.paidCard',           type: 'money', align: 'end' },
  { key: 'paidCashOnDelivery', labelKey: 'reports.columns.paidCashOnDelivery', type: 'money', align: 'end' },
  { key: 'paidBank',           labelKey: 'reports.columns.paidBank',           type: 'money', align: 'end' },
]

/**
 * One handler, three registry entries. The kind is bound at registration time rather than
 * read from a param, so each register is its own catalog card with its own permission and
 * its own shareable URL — which is what the legacy screens were.
 */
export function makeDocumentsReport(kind: DocumentKind) {
  return async function runDocuments(ctx: ReportHandlerContext): Promise<ReportResult> {
    const cap = rowCapFor(ctx.output)
    const period = (ctx.params.period || {}) as { from?: string; to?: string }

    const match: Record<string, any> = { orgId: oid(ctx.orgId), ...KIND_FILTER[kind] }

    if (period.from || period.to) {
      match.issueDate = {
        ...(period.from ? { $gte: dayStart(period.from) } : {}),
        ...(period.to ? { $lte: dayEnd(period.to) } : {}),
      }
    }
    if (ctx.params.contactId) match.contactId = oid(ctx.params.contactId)
    if (ctx.params.currency) match.currency = String(ctx.params.currency)

    const statuses = (ctx.params.statuses as string[] | undefined)?.filter(s => STATUS_OPTIONS.includes(s))
    if (statuses?.length) match.status = { $in: statuses }

    const rows = await Invoice.aggregate([
      { $match: match },
      { $sort: { issueDate: -1, invoiceNumber: -1 } },
      { $limit: cap + 1 },
      {
        $lookup: {
          from: 'contacts',
          localField: 'contactId',
          foreignField: '_id',
          as: 'contact',
          pipeline: [{ $project: { companyName: 1, firstName: 1, lastName: 1 } }],
        },
      },
      { $unwind: { path: '$contact', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          invoiceId: { $toString: '$_id' },
          date: { $dateToString: { format: '%Y-%m-%d', date: '$issueDate' } },
          number: '$invoiceNumber',
          docType: '$type',
          contactName: {
            $ifNull: [
              '$contact.companyName',
              {
                $trim: {
                  input: {
                    $concat: [{ $ifNull: ['$contact.firstName', ''] }, ' ', { $ifNull: ['$contact.lastName', ''] }],
                  },
                },
              },
            ],
          },
          status: 1,
          currency: 1,
          subtotal: { $round: [{ $ifNull: ['$subtotal', 0] }, 2] },
          taxTotal: { $round: [{ $ifNull: ['$taxTotal', 0] }, 2] },
          total: { $round: [{ $ifNull: ['$total', 0] }, 2] },
          amountPaid: { $round: [{ $ifNull: ['$amountPaid', 0] }, 2] },
          amountDue: { $round: [{ $ifNull: ['$amountDue', 0] }, 2] },
          // Carried only to compute the per-method split below; stripped from the rows after.
          paymentMethod: 1,
          payments: 1,
        },
      },
    ]).exec()

    const truncated = rows.length > cap
    const raw = truncated ? rows.slice(0, cap) : rows

    // Split what was paid across the four method columns. Tender under an unmapped method
    // (`other`, or a free-text value) is counted apart rather than lost.
    let unattributedPaid = 0
    const page = raw.map(r => {
      const { paymentMethod: _pm, payments: _pay, ...rest } = r
      const split: Record<string, number> = { paidCash: 0, paidCard: 0, paidCashOnDelivery: 0, paidBank: 0 }
      for (const { method, amount } of paidByMethod(r)) {
        const key = METHOD_COLUMN[method.toLowerCase()]
        if (key) split[key] += amount
        else unattributedPaid += amount
      }
      for (const k of METHOD_KEYS) split[k] = +split[k].toFixed(2)
      return { ...rest, ...split }
    })

    const sum = (k: string) => +page.reduce((s, r) => s + (r[k] || 0), 0).toFixed(2)
    const currencies = [...new Set(page.map(r => r.currency).filter(Boolean))]

    return {
      columns: COLUMNS,
      rows: page,
      totals: {
        subtotal: sum('subtotal'),
        taxTotal: sum('taxTotal'),
        total: sum('total'),
        amountPaid: sum('amountPaid'),
        amountDue: sum('amountDue'),
        paidCash: sum('paidCash'),
        paidCard: sum('paidCard'),
        paidCashOnDelivery: sum('paidCashOnDelivery'),
        paidBank: sum('paidBank'),
      },
      meta: {
        truncated,
        cap,
        rowCount: page.length,
        kind,
        /**
         * Paid under a method with no column of its own (`other`, or a free-text
         * `paymentMethod`). The four columns plus this always add up to the Платено total, so
         * a non-zero value here is the explanation for a split that looks short.
         */
        unattributedPaid: +unattributedPaid.toFixed(2),
        // Totals across mixed currencies mean nothing; the renderers print a note instead
        // of a totals box when this is set (same rule as the cash-aggregate export).
        currency: currencies.length === 1 ? currencies[0] : undefined,
        mixedCurrency: currencies.length > 1,
      },
    }
  }
}

export { STATUS_OPTIONS as DOCUMENT_STATUS_OPTIONS }
