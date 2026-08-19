/**
 * Canonical column catalog shared between the ExportDialog UI and
 * the reporting generators. Keep `key` values in lockstep with:
 *  - packages/reporting/src/excel/invoicing-list.excel.ts (COLUMN_DEFS)
 *  - packages/reporting/src/pdf/invoicing-list.pdf.ts     (COLUMN_DEFS)
 *  - packages/invoicing-api/src/controllers/invoice-export.controller.ts (ALLOWED_COLUMN_KEYS)
 */

export type ExportMode = 'compact' | 'detailed'
export type DocType = 'invoice' | 'proforma' | 'credit_note' | 'debit_note' | 'cash_sale' | 'bill'

export interface ExportColumn {
  key: string
  i18n: string              // i18n key (fallback label used when no translation exists)
  label: string             // plain-English label used if the i18n key resolves to itself
  modes: ExportMode[]       // which modes offer this column
  docs?: DocType[]          // restrict to specific docTypes; omit = all
  defaultOn: boolean        // initial checkbox state
  align?: 'start' | 'end'
}

export const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'number',       i18n: 'invoicing.invoiceNumber', label: 'Number',      modes: ['compact','detailed'], defaultOn: true },
  { key: 'issueDate',    i18n: 'invoicing.issueDate',     label: 'Issue Date',  modes: ['compact','detailed'], defaultOn: true },
  { key: 'dueDate',      i18n: 'invoicing.dueDate',       label: 'Due Date',    modes: ['compact'], docs: ['invoice','proforma','bill'], defaultOn: true },
  { key: 'contactName',  i18n: 'invoicing.contact',       label: 'Contact',     modes: ['compact','detailed'], defaultOn: true },
  { key: 'contactTaxId', i18n: 'invoicing.taxId',         label: 'Tax ID',      modes: ['compact'], defaultOn: false },
  { key: 'status',       i18n: 'common.status',           label: 'Status',      modes: ['compact','detailed'], defaultOn: true },
  { key: 'currency',     i18n: 'common.currency',         label: 'Currency',    modes: ['compact','detailed'], defaultOn: true },
  // Net / VAT / gross are the three figures the journal report is read for, so all three
  // are on by default — the totals line sums each of them.
  { key: 'subtotal',     i18n: 'common.subtotal',         label: 'Subtotal',    modes: ['compact'], defaultOn: true, align: 'end' },
  { key: 'taxTotal',     i18n: 'invoicing.tax',           label: 'Tax',         modes: ['compact'], defaultOn: true,  align: 'end' },
  { key: 'total',        i18n: 'common.total',            label: 'Total',       modes: ['compact','detailed'], defaultOn: true, align: 'end' },
  { key: 'amountPaid',   i18n: 'invoicing.amountPaid',    label: 'Amount Paid', modes: ['compact'], docs: ['invoice','bill','cash_sale'], defaultOn: false, align: 'end' },
  { key: 'amountDue',    i18n: 'invoicing.amountDue',     label: 'Amount Due',  modes: ['compact'], docs: ['invoice','bill'], defaultOn: false, align: 'end' },
  { key: 'reference',    i18n: 'invoicing.reference',     label: 'Reference',   modes: ['compact'], defaultOn: false },
  { key: 'paymentMethod',i18n: 'invoicing.paymentMethod', label: 'Payment Method', modes: ['compact'], defaultOn: false },
  // line-level columns (detailed only)
  { key: 'lineNo',       i18n: 'invoicing.lineNo',        label: 'Line #',      modes: ['detailed'], defaultOn: true },
  { key: 'description',  i18n: 'common.description',      label: 'Description', modes: ['detailed'], defaultOn: true },
  { key: 'quantity',     i18n: 'common.qty',              label: 'Qty',         modes: ['detailed'], defaultOn: true, align: 'end' },
  { key: 'unit',         i18n: 'common.unit',             label: 'Unit',        modes: ['detailed'], defaultOn: true },
  { key: 'unitPrice',    i18n: 'invoicing.unitPrice',     label: 'Unit Price',  modes: ['detailed'], defaultOn: true, align: 'end' },
  { key: 'discount',     i18n: 'invoicing.discount',      label: 'Discount',    modes: ['detailed'], defaultOn: false, align: 'end' },
  { key: 'taxRate',      i18n: 'invoicing.taxRate',       label: 'Tax Rate',    modes: ['detailed'], defaultOn: false, align: 'end' },
  { key: 'lineTotal',    i18n: 'invoicing.lineTotal',     label: 'Line Total',  modes: ['detailed'], defaultOn: true, align: 'end' },
]

/** Columns applicable to the given mode + docType. */
export function filterColumns(mode: ExportMode, docType: DocType): ExportColumn[] {
  return EXPORT_COLUMNS.filter(c =>
    c.modes.includes(mode) && (!c.docs || c.docs.includes(docType)),
  )
}

/** Default on/off selection for a (mode, docType) pair. */
export function defaultSelection(mode: ExportMode, docType: DocType): string[] {
  return filterColumns(mode, docType).filter(c => c.defaultOn).map(c => c.key)
}

/** Used by tests to pin catalog ↔ backend allowlist alignment. */
export const ALL_COLUMN_KEYS: string[] = EXPORT_COLUMNS.map(c => c.key)
