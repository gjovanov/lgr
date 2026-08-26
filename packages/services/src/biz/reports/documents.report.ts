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
        },
      },
    ]).exec()

    const truncated = rows.length > cap
    const page = truncated ? rows.slice(0, cap) : rows

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
      },
      meta: {
        truncated,
        cap,
        rowCount: page.length,
        kind,
        // Totals across mixed currencies mean nothing; the renderers print a note instead
        // of a totals box when this is set (same rule as the cash-aggregate export).
        currency: currencies.length === 1 ? currencies[0] : undefined,
        mixedCurrency: currencies.length > 1,
      },
    }
  }
}

export { STATUS_OPTIONS as DOCUMENT_STATUS_OPTIONS }
