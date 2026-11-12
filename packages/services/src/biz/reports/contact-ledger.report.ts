/**
 * FR-06 (#14) P2 — `contact-ledger`: every document line traded with one counterparty.
 *
 * A thin adapter over the existing `getContactLedger`, deliberately: that service already
 * backs `/invoicing/contacts/:id/ledger`, and two implementations of "what did we sell this
 * customer" would drift within a release. The report re-shapes its result into the registry's
 * column/row contract and lets the runner do the rest.
 *
 * The contact is REQUIRED. A ledger with no counterparty is not a ledger — it is the document
 * register, which is what `sales-documents` / `purchase-documents` are for.
 */

import { getContactLedger, withoutLedgerCosts } from '../contact-ledger.service.js'
import {
  rowCapFor,
  ReportParamError,
  type ReportColumn,
  type ReportHandlerContext,
  type ReportResult,
} from '../report-registry.types.js'

const COLUMNS: ReportColumn[] = [
  { key: 'date',           labelKey: 'reports.columns.date',      type: 'date' },
  { key: 'documentNumber', labelKey: 'reports.columns.document' },
  { key: 'documentType',   labelKey: 'reports.columns.docType' },
  // The movements behind the row: a document's own and those it stands for, or the movement no document carries.
  { key: 'movementNumbers', labelKey: 'reports.columns.stockMovement' },
  { key: 'productName',    labelKey: 'reports.columns.product' },
  { key: 'warehouseName',  labelKey: 'reports.columns.warehouse' },
  { key: 'quantity',       labelKey: 'reports.columns.quantity',  type: 'quantity', align: 'end' },
  { key: 'unitPrice',      labelKey: 'reports.columns.price',     type: 'money',    align: 'end' },
  { key: 'taxRate',        labelKey: 'reports.columns.taxRate',   type: 'percent',  align: 'end' },
  { key: 'lineTotal',      labelKey: 'reports.columns.value',     type: 'money',    align: 'end' },
]

export async function runContactLedger(ctx: ReportHandlerContext): Promise<ReportResult> {
  const contactId = ctx.params.contactId ? String(ctx.params.contactId) : ''
  if (!contactId) throw new ReportParamError('A contact is required for the contact ledger', 'contactId')

  const cap = rowCapFor(ctx.output)
  const period = (ctx.params.period || {}) as { from?: string; to?: string }

  // The service pages; the report wants one capped page. `size: cap + 1` is the same
  // "ask for one more than the cap" trick the aggregation handlers use to detect truncation.
  const read = await getContactLedger(ctx.orgId, contactId, {
    dateFrom: period.from,
    dateTo: period.to,
    documentTypes: ctx.params.docTypes as string[] | undefined,
    // As the ledger's own route reads it: no incoming document without the purchases side (FR-26.6)…
    outgoingOnly: ctx.sees ? !ctx.sees.bills : false,
    page: 0,
    size: cap + 1,
  })
  // …and no cost figure without them (FR-27.11.C.2): the summary goes out whole in `meta`, where no column holds it.
  const result = ctx.sees && !ctx.sees.costs ? withoutLedgerCosts(read) : read

  const truncated = result.entries.length > cap
  const entries = truncated ? result.entries.slice(0, cap) : result.entries

  const rows = entries.map(({ movements, ...e }) => ({
    ...e,
    // `documentType` is a raw enum value; the UI translates it through the same
    // `reports.docTypes.*` keys the warehouse-operations report uses.
    movementNumbers: movements.map(m => m.number).join(', '),
    quantity: +(e.quantity || 0).toFixed(3),
    // A stock movement's own row is valued at cost: a figure its row does not carry for a role without the costs,
    // and that stays absent here, never a 0.00.
    ...(e.unitPrice === undefined ? {} : { unitPrice: +e.unitPrice.toFixed(4) }),
    ...(e.lineTotal === undefined ? {} : { lineTotal: +e.lineTotal.toFixed(2) }),
  }))

  return {
    columns: COLUMNS,
    rows,
    totals: {
      quantity: +rows.reduce((s, r) => s + (r.quantity || 0), 0).toFixed(3),
      lineTotal: +rows.reduce((s, r) => s + (r.lineTotal || 0), 0).toFixed(2),
    },
    meta: {
      truncated,
      cap,
      rowCount: rows.length,
      // The service's own summary is richer than a totals row — surface it as the
      // reconciliation card the runner already renders for FR-08.
      ledgerSummary: result.summary,
      totalEntries: result.total,
    },
  }
}
