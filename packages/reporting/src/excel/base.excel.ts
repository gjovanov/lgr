import ExcelJS from 'exceljs'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlink } from 'fs/promises'

export async function createWorkbook(): Promise<{ workbook: ExcelJS.stream.xlsx.WorkbookWriter; tmpFile: string }> {
  const tmpFile = join(tmpdir(), `lgr-export-${Date.now()}.xlsx`)
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: tmpFile,
    useSharedStrings: false,
    // Without this the streaming writer silently drops every style — header fills, number
    // formats and borders never reached the produced workbooks.
    useStyles: true,
  })
  return { workbook, tmpFile }
}

export async function finalizeWorkbook(workbook: ExcelJS.stream.xlsx.WorkbookWriter, tmpFile: string): Promise<Buffer> {
  await workbook.commit()
  const buffer = await Bun.file(tmpFile).arrayBuffer()
  await unlink(tmpFile)
  return Buffer.from(buffer)
}

/**
 * Style the header row: bold black on the sheet's own background, separated from the data by a
 * hairline rule. Applied per cell across `columnCount` columns so the rule stops at the last
 * data column instead of running the full sheet width.
 */
export function styleHeaderRow(worksheet: ExcelJS.Worksheet, columnCount: number) {
  const headerRow = worksheet.getRow(1)
  for (let c = 1; c <= columnCount; c++) {
    const cell = headerRow.getCell(c)
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: HEADER_SIZE }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { bottom: { style: 'medium', color: { argb: HEADER_RULE } } }
  }
  headerRow.commit()
}

// ── Shared cell styling for the invoicing sheets ──

/**
 * Cell kinds drive the number format and alignment, and keep amounts/dates real values
 * (not text) so a sheet stays sortable, filterable and summable in Excel.
 */
export type CellType = 'text' | 'money' | 'quantity' | 'percent' | 'int' | 'date'

export const NUM_FMT: Record<CellType, string | undefined> = {
  text: undefined,
  money: '#,##0.00',
  quantity: '#,##0.###',
  percent: '0.##"%"',
  int: '0',
  date: 'dd.mm.yyyy',
}

/** Everything but plain text is right-aligned, as on the printed form. */
export function alignFor(type: CellType | undefined): 'left' | 'right' | 'center' {
  if (!type || type === 'text') return 'left'
  if (type === 'date') return 'center'
  return 'right'
}

/** Amounts are written as numbers; a missing value stays empty rather than becoming 0. */
export function numOrBlank(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

export const HEADER_TEXT = 'FF000000'
export const HEADER_RULE = 'FF000000'
/** A point above the data font — bold alone is binary, so weight comes from size too. */
export const HEADER_SIZE = 12
export const BORDER_COLOR = 'FFD0D0D0'
export const ZEBRA_FILL = 'FFF7F7F7'

/**
 * Heading band: bold black on the sheet's own background, closed by a hairline rule. Styled per
 * cell over `columnCount` columns so the rule stops at the last data column rather than running
 * the full sheet width.
 */
export function styleHeaderBand(row: any, columnCount: number, height = 30) {
  row.height = height
  for (let c = 1; c <= columnCount; c++) {
    const cell = row.getCell(c)
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: HEADER_SIZE }
    // Wrapped labels keep long localized headers ("Дата на издаване") readable instead of
    // being clipped by the column width.
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { bottom: { style: 'medium', color: { argb: HEADER_RULE } } }
  }
}

/**
 * Per-cell data formatting. The streaming writer drops the `style` set on
 * `worksheet.columns`, so number formats and alignment have to be stamped on the cells —
 * otherwise amounts render unformatted and dates fall back to Excel's mm-dd-yy default.
 */
export function styleDataCells(row: any, types: (CellType | undefined)[], zebra: boolean) {
  types.forEach((type, i) => {
    const cell = row.getCell(i + 1)
    const fmt = NUM_FMT[type ?? 'text']
    if (fmt) cell.numFmt = fmt
    cell.alignment = { horizontal: alignFor(type), vertical: 'middle', wrapText: false }
    cell.border = {
      top: { style: 'hair', color: { argb: BORDER_COLOR } },
      bottom: { style: 'hair', color: { argb: BORDER_COLOR } },
      left: { style: 'hair', color: { argb: BORDER_COLOR } },
      right: { style: 'hair', color: { argb: BORDER_COLOR } },
    }
    if (zebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } }
  })
}

/**
 * ExcelJS serialises a Date by its UTC instant, so a local-midnight date lands on the previous
 * day for any positive UTC offset (2026-03-01 00:00 CET → 28.02.2026 in the sheet). Re-anchor
 * the calendar day at UTC midnight so the exported day matches the document's date.
 */
export function toExcelDate(d: Date | string | undefined | null): Date | null {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return null
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
}

export function formatCurrency(value: number): string {
  return value.toFixed(2)
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]
}
