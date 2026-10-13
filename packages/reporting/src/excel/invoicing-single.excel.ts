import {
  createWorkbook, finalizeWorkbook, styleHeaderBand, styleDataCells,
  NUM_FMT, fmtForValue, numOrBlank, toExcelDate, HEADER_RULE, GRID_BORDER, ZEBRA_FILL, type CellType,
} from './base.excel.js'
import type { InvoiceExportRow, ExportMode } from './invoicing-list.excel.js'
import { exportI18n, statusLabel, type ExportLocale } from '../i18n.js'
import { invoiceDocTitle } from '../invoice-doc.i18n.js'
import { unitLabel } from '../unit.i18n.js'

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

const SINGLE_LINE_COLUMNS: { key: string; headerKey: HeaderKey; width: number; type?: CellType; value: (l: any, i: number, locale?: string) => any }[] = [
  { key: 'lineNo',      headerKey: 'lineNo',      width: 7,  type: 'int',      value: (_l, i) => i + 1 },
  { key: 'description', headerKey: 'description', width: 46,                   value: (l) => l.description },
  { key: 'quantity',    headerKey: 'quantity',    width: 11, type: 'quantity', value: (l) => numOrBlank(l.quantity) },
    // The canonical code (`pcs`) is stored; the sheet shows the locale's abbreviation („БР.“).
  { key: 'unit',        headerKey: 'unit',        width: 10,                    value: (l, _i, locale) => unitLabel(l.unit, locale) },
  { key: 'unitPrice',   headerKey: 'unitPrice',   width: 13, type: 'money',    value: (l) => numOrBlank(l.unitPrice) },
  { key: 'discount',    headerKey: 'discount',    width: 11, type: 'percent',  value: (l) => numOrBlank(l.discount) },
  { key: 'taxRate',     headerKey: 'taxRate',     width: 10, type: 'percent',  value: (l) => numOrBlank(l.taxRate) },
  { key: 'lineTotal',   headerKey: 'lineTotal',   width: 15, type: 'money',    value: (l) => numOrBlank(l.lineTotal) },
]

/** Two-column layout used when the sheet carries no line table (compact mode). */
const FIELD_BLOCK_WIDTHS = [26, 46]

/**
 * The amounts the totals block under the line table already states; printing them in the
 * field block as well left the sheet with two "Total:" lines saying the same thing.
 */
const MONEY_FIELD_KEYS = new Set(['subtotal', 'taxTotal', 'total', 'amountPaid', 'amountDue'])

const CARD_BORDER = GRID_BORDER

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

  const lineDefs = hasLineTable ? SINGLE_LINE_COLUMNS.filter(c => !allow || allow.has(c.key)) : []

  const worksheet = workbook.addWorksheet(invoiceDocTitle(row.type, row.direction, locale).substring(0, 30), {
    // The sheet's own gridlines stay on, so the cells around and below the document keep
    // reading as a grid instead of as blank paper. Set up to print on one page-width.
    views: [{ showGridLines: true }],
    pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  })
  worksheet.columns = (hasLineTable ? lineDefs.map(c => c.width) : FIELD_BLOCK_WIDTHS)
    .map(width => ({ width })) as any

  // The card blocks span the full width of whatever table sits below them, so the sheet reads
  // as one column of stacked blocks rather than a narrow block beside an empty grid.
  const lastCol = hasLineTable ? lineDefs.length : 2
  const labelEnd = hasLineTable && lastCol > 2 ? 2 : 1
  const valueStart = Math.min(labelEnd + 1, lastCol)
  /** Merge a label/value pair across the sheet width; a no-op when there is nothing to merge. */
  const mergeRow = (rowNo: number) => {
    if (labelEnd > 1) worksheet.mergeCells(rowNo, 1, rowNo, labelEnd)
    if (lastCol > valueStart) worksheet.mergeCells(rowNo, valueStart, rowNo, lastCol)
  }
  let rowNo = 0

  // ── Title: document kind + number, centred over the sheet and closed by a rule ──
  const titleRow = worksheet.addRow([
    `${invoiceDocTitle(row.type, row.direction, locale)} ${row.invoiceNumber}`,
  ])
  rowNo++
  if (lastCol > 1) worksheet.mergeCells(rowNo, 1, rowNo, lastCol)
  titleRow.getCell(1).font = { bold: true, size: 15 }
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' }
  titleRow.height = 26
  for (let c = 1; c <= lastCol; c++) {
    titleRow.getCell(c).border = { bottom: { style: 'medium', color: { argb: HEADER_RULE } } }
  }
  titleRow.commit()
  worksheet.addRow([]).commit()
  rowNo++

  // ── Document fields: shaded label, typed value beside it, boxed so the block reads as a
  //    card rather than as text floating on the grid. ──
  for (const col of SINGLE_HEADER_COLUMNS) {
    if (allow && !allow.has(col.key)) continue
    // With a line table below, the amounts belong to its totals block, not here as well.
    if (hasLineTable && MONEY_FIELD_KEYS.has(col.key)) continue
    const value = col.value(row, locale)
    if (value === '' || value === null || value === undefined) continue
    const values: any[] = new Array(lastCol).fill(null)
    values[0] = `${i18n.header[col.headerKey]}:`
    values[valueStart - 1] = value
    const r = worksheet.addRow(values)
    rowNo++
    mergeRow(rowNo)
    r.height = 17

    const labelCell = r.getCell(1)
    labelCell.font = { bold: true }
    // Right-aligned labels sit next to their values however wide the label block is, so the
    // pair reads as one field instead of as two texts at opposite ends of the sheet.
    labelCell.alignment = { horizontal: labelEnd > 1 ? 'right' : 'left', vertical: 'middle', indent: 1 }
    labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } }

    const valueCell = r.getCell(valueStart)
    const fmt = fmtForValue(col.type, value)
    if (fmt) valueCell.numFmt = fmt
    // Values stay left-aligned so each sits next to its label instead of drifting to the far
    // edge of a wide column, as right/centre alignment would do for amounts and dates.
    valueCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }

    for (let c = 1; c <= lastCol; c++) r.getCell(c).border = CARD_BORDER
    r.commit()
  }
  worksheet.addRow([]).commit()
  rowNo++

  if (hasLineTable) {
    const headerRow = worksheet.addRow(lineDefs.map(c => i18n.header[c.headerKey]))
    rowNo++
    styleHeaderBand(headerRow, lineDefs.length)
    headerRow.commit()

    const types = lineDefs.map(c => c.type)
    row.lines!.forEach((line, i) => {
      const r = worksheet.addRow(lineDefs.map(c => c.value(line, i, locale)))
      rowNo++
      styleDataCells(r, types, i % 2 === 1)
      r.commit()
    })

    // Totals under the line table, each amount under the column it closes. The label is merged
    // across the middle columns so a long localized one ("Междинна сума") is not clipped.
    const totalCol = lineDefs.length
    const labelStart = totalCol > 2 ? 2 : 1
    const labelEndT = Math.max(labelStart, totalCol - 1)
    const totals: [string, number | null | undefined, boolean][] = [
      [i18n.header.subtotal,   numOrBlank(row.subtotal),   false],
      [i18n.header.taxTotal,   numOrBlank(row.taxTotal),   false],
      [i18n.header.total,      numOrBlank(row.total),      true],
      [i18n.header.amountPaid, numOrBlank(row.amountPaid), false],
      [i18n.header.amountDue,  numOrBlank(row.amountDue),  false],
    ]
    totals.forEach(([label, amount, grand]) => {
      if (amount === null || amount === undefined) return
      const values: any[] = new Array(totalCol).fill(null)
      values[labelStart - 1] = `${label}:`
      values[totalCol - 1] = amount
      const r = worksheet.addRow(values)
      rowNo++
      if (labelEndT > labelStart) worksheet.mergeCells(rowNo, labelStart, rowNo, labelEndT)
      const labelCell = r.getCell(labelStart)
      labelCell.font = { bold: grand }
      labelCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 }
      const amountCell = r.getCell(totalCol)
      amountCell.font = { bold: grand }
      amountCell.numFmt = NUM_FMT.money
      amountCell.alignment = { horizontal: 'right', vertical: 'middle' }
      // Boxed like the table above, so the totals continue its grid rather than floating
      // under it; the document total — the figure the reader looks for — is ruled and shaded.
      for (let c = labelStart; c <= totalCol; c++) {
        const cell = r.getCell(c)
        cell.border = grand
          ? { ...GRID_BORDER, top: { style: 'thin', color: { argb: 'FF808080' } }, bottom: { style: 'thin', color: { argb: 'FF808080' } } }
          : { ...GRID_BORDER }
        if (grand) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } }
      }
      r.commit()
    })
    worksheet.addRow([]).commit()
    rowNo++
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
