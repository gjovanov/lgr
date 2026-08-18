import {
  createWorkbook, finalizeWorkbook, styleHeaderBand, styleDataCells,
  NUM_FMT, numOrBlank, toExcelDate, HEADER_RULE, BORDER_COLOR, ZEBRA_FILL, type CellType,
} from './base.excel.js'
import type { InvoiceExportRow, ExportMode } from './invoicing-list.excel.js'
import { exportI18n, statusLabel, type ExportLocale } from '../i18n.js'
import { invoiceDocTitle } from '../invoice-doc.i18n.js'

type HeaderKey = keyof ReturnType<typeof exportI18n>['header']

/**
 * Document-level fields, rendered as a label/value block (the sheet reads like the document
 * header on the printed form, not like a one-row table).
 */
const SINGLE_HEADER_COLUMNS: { key: string; headerKey: HeaderKey; type?: CellType; value: (r: InvoiceExportRow, locale?: string) => any }[] = [
  { key: 'number',       headerKey: 'number',       value: (r) => r.invoiceNumber },
  { key: 'issueDate',    headerKey: 'issueDate',    type: 'date',  value: (r) => toExcelDate(r.issueDate) },
  { key: 'dueDate',      headerKey: 'dueDate',      type: 'date',  value: (r) => toExcelDate(r.dueDate) },
  { key: 'contactName',  headerKey: 'contactName',  value: (r) => r.contactName || '' },
  { key: 'contactTaxId', headerKey: 'contactTaxId', value: (r) => r.contactTaxId || '' },
  { key: 'status',       headerKey: 'status',       value: (r, locale) => statusLabel(r.status, locale) },
  { key: 'currency',     headerKey: 'currency',     value: (r) => r.currency },
  { key: 'reference',    headerKey: 'reference',    value: (r) => r.reference || '' },
  { key: 'subtotal',     headerKey: 'subtotal',     type: 'money', value: (r) => numOrBlank(r.subtotal) },
  { key: 'taxTotal',     headerKey: 'taxTotal',     type: 'money', value: (r) => numOrBlank(r.taxTotal) },
  { key: 'total',        headerKey: 'total',        type: 'money', value: (r) => numOrBlank(r.total) },
  { key: 'amountPaid',   headerKey: 'amountPaid',   type: 'money', value: (r) => numOrBlank(r.amountPaid) },
  { key: 'amountDue',    headerKey: 'amountDue',    type: 'money', value: (r) => numOrBlank(r.amountDue) },
]

const SINGLE_LINE_COLUMNS: { key: string; headerKey: HeaderKey; width: number; type?: CellType; value: (l: any, i: number) => any }[] = [
  { key: 'lineNo',      headerKey: 'lineNo',      width: 22, type: 'int',      value: (_l, i) => i + 1 },
  { key: 'description', headerKey: 'description', width: 44,                   value: (l) => l.description },
  { key: 'quantity',    headerKey: 'quantity',    width: 11, type: 'quantity', value: (l) => numOrBlank(l.quantity) },
  { key: 'unit',        headerKey: 'unit',        width: 10,                    value: (l) => l.unit || '' },
  { key: 'unitPrice',   headerKey: 'unitPrice',   width: 13, type: 'money',    value: (l) => numOrBlank(l.unitPrice) },
  { key: 'discount',    headerKey: 'discount',    width: 11, type: 'percent',  value: (l) => numOrBlank(l.discount) },
  { key: 'taxRate',     headerKey: 'taxRate',     width: 10, type: 'percent',  value: (l) => numOrBlank(l.taxRate) },
  { key: 'lineTotal',   headerKey: 'lineTotal',   width: 15, type: 'money',    value: (l) => numOrBlank(l.lineTotal) },
]

/**
 * Column widths serve both blocks: A holds the field labels (and the line numbers), B the
 * field values (and the descriptions), C.. the remaining line columns. Without a line table
 * (compact mode) only the two field-block columns matter.
 */
const LINE_TABLE_WIDTHS = SINGLE_LINE_COLUMNS.map(c => c.width)
const FIELD_BLOCK_WIDTHS = [24, 40]

/**
 * Export a single invoicing document to XLSX: a title row, the document's field block, the
 * priced line table and the totals, styled like the list export (blue heading band, real
 * numbers/dates with number formats, hairline borders).
 * When `columns` is provided, only matching keys are rendered (omit = full default).
 */
export async function generateInvoicingSingleXLSX(
  row: InvoiceExportRow,
  mode: ExportMode = 'detailed',
  columns?: string[],
  locale?: ExportLocale | string,
): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const i18n = exportI18n(locale)
  const allow = columns?.length ? new Set(columns) : null
  // Compact mode is the document summary only — no line table, so the sheet is two columns.
  const hasLineTable = mode === 'detailed'
    && !!row.lines?.length
    && SINGLE_LINE_COLUMNS.some(c => !allow || allow.has(c.key))

  const worksheet = workbook.addWorksheet(invoiceDocTitle(row.type, row.direction, locale).substring(0, 30))
  worksheet.columns = (hasLineTable ? LINE_TABLE_WIDTHS : FIELD_BLOCK_WIDTHS).map(width => ({ width })) as any

  // ── Title: document kind + number, underlined across the field block ──
  const titleRow = worksheet.addRow([
    `${invoiceDocTitle(row.type, row.direction, locale)} ${row.invoiceNumber}`,
  ])
  titleRow.getCell(1).font = { bold: true, size: 13 }
  titleRow.height = 22
  for (let c = 1; c <= 2; c++) {
    titleRow.getCell(c).border = { bottom: { style: 'thin', color: { argb: HEADER_RULE } } }
  }
  titleRow.commit()
  worksheet.addRow([]).commit()

  // ── Document fields: shaded label in A, typed value in B, boxed so the block reads as a
  //    card rather than as text floating on the grid. ──
  for (const col of SINGLE_HEADER_COLUMNS) {
    if (allow && !allow.has(col.key)) continue
    const value = col.value(row, locale)
    if (value === '' || value === null || value === undefined) continue
    const r = worksheet.addRow([`${i18n.header[col.headerKey]}:`, value])

    const labelCell = r.getCell(1)
    labelCell.font = { bold: true }
    // Labels left-aligned: the label column's width then supplies the gutter between the
    // label and its value, instead of the two texts butting up against the column edge.
    labelCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
    labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } }

    const valueCell = r.getCell(2)
    const fmt = NUM_FMT[col.type ?? 'text']
    if (fmt) valueCell.numFmt = fmt
    // Values stay left-aligned so each sits next to its label instead of drifting to the far
    // edge of a wide column, as right/centre alignment would do for amounts and dates.
    valueCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }

    for (const c of [1, 2]) {
      r.getCell(c).border = {
        top: { style: 'hair', color: { argb: BORDER_COLOR } },
        bottom: { style: 'hair', color: { argb: BORDER_COLOR } },
        left: { style: 'hair', color: { argb: BORDER_COLOR } },
        right: { style: 'hair', color: { argb: BORDER_COLOR } },
      }
    }
    r.commit()
  }
  worksheet.addRow([]).commit()

  if (hasLineTable) {
    const lineDefs = SINGLE_LINE_COLUMNS.filter(c => !allow || allow.has(c.key))
    const headerRow = worksheet.addRow(lineDefs.map(c => i18n.header[c.headerKey]))
    styleHeaderBand(headerRow, lineDefs.length)
    headerRow.commit()

    const types = lineDefs.map(c => c.type)
    row.lines!.forEach((line, i) => {
      const r = worksheet.addRow(lineDefs.map(c => c.value(line, i)))
      styleDataCells(r, types, i % 2 === 1)
      r.commit()
    })

    // Totals under the line table, right-aligned against the last column.
    const totalCol = lineDefs.length
    const labelCol = Math.max(1, totalCol - 1)
    const totals: [string, number | null | undefined][] = [
      [i18n.header.subtotal, numOrBlank(row.subtotal)],
      [i18n.header.taxTotal, numOrBlank(row.taxTotal)],
      [i18n.header.total, numOrBlank(row.total)],
    ]
    totals.forEach(([label, amount], idx) => {
      if (amount === null || amount === undefined) return
      const values: any[] = new Array(totalCol).fill(null)
      values[labelCol - 1] = `${label}:`
      values[totalCol - 1] = amount
      const r = worksheet.addRow(values)
      const grand = idx === totals.length - 1
      r.getCell(labelCol).font = { bold: grand }
      r.getCell(labelCol).alignment = { horizontal: 'right', vertical: 'middle' }
      const amountCell = r.getCell(totalCol)
      amountCell.font = { bold: grand }
      amountCell.numFmt = NUM_FMT.money
      amountCell.alignment = { horizontal: 'right', vertical: 'middle' }
      if (grand) {
        for (let c = 1; c <= totalCol; c++) {
          r.getCell(c).border = { top: { style: 'thin', color: { argb: 'FF808080' } } }
        }
      }
      r.commit()
    })
    worksheet.addRow([]).commit()
  }

  if (row.notes) {
    const r = worksheet.addRow([`${i18n.meta.notes}:`, row.notes])
    r.getCell(1).font = { bold: true }
    r.getCell(1).alignment = { horizontal: 'left', vertical: 'top', indent: 1 }
    r.getCell(2).alignment = { vertical: 'top', wrapText: true }
    r.commit()
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
