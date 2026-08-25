/**
 * FR-06 (#14) — the generic report worksheet.
 *
 * One generator for EVERY registry-driven report: it takes the `{columns, rows, totals}`
 * a report handler produced and writes it out. Adding a report therefore adds no export
 * code at all (FR-6.6), and none of the hand-tuned document generators next to this file
 * are touched (FR-6.20 keeps them byte-compatible).
 *
 * Column HEADERS arrive already translated. The registry names columns by i18n key and the
 * only place those keys resolve is the UI's message catalogue — duplicating four locales of
 * every future report's headers into `reporting/i18n.ts` would be a second source of truth.
 */

import type ExcelJS from 'exceljs'
import {
  createWorkbook,
  finalizeWorkbook,
  styleHeaderBand,
  styleDataCells,
  toExcelDate,
  numOrBlank,
  type CellType,
} from './base.excel.js'

export interface ReportSheetColumn {
  key: string
  /** Already localized by the caller. */
  header: string
  type?: CellType
  width?: number
}

export interface ReportSheetOptions {
  title: string
  orgName: string
  columns: ReportSheetColumn[]
  rows: Record<string, any>[]
  /** Column-key → value, written as a bold closing row. */
  totals?: Record<string, number>
  /** Localized "Total" label for the totals row's first cell. */
  totalsLabel?: string
  period?: { from?: string; to?: string }
  /** Sheet tab name; falls back to a trimmed `title`. */
  sheetName?: string
}

/** Excel caps sheet names at 31 chars and rejects []:*?/\ */
function safeSheetName(name: string): string {
  return (name.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Report').slice(0, 31)
}

function widthFor(col: ReportSheetColumn): number {
  if (col.width) return col.width
  switch (col.type) {
    case 'money': return 16
    case 'quantity': return 12
    case 'int': return 10
    case 'percent': return 10
    case 'date': return 14
    default: return Math.min(40, Math.max(14, col.header.length + 4))
  }
}

/** Dates and numbers are written as real values, so the sheet stays sortable and summable. */
function cellValue(raw: any, type: CellType | undefined) {
  if (type === 'date') return toExcelDate(raw)
  if (type && type !== 'text') return numOrBlank(raw)
  return raw ?? ''
}

export async function generateReportExcel(opts: ReportSheetOptions): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const sheet: ExcelJS.Worksheet = workbook.addWorksheet(safeSheetName(opts.sheetName || opts.title))

  const columns = opts.columns
  const types = columns.map(c => c.type)
  sheet.columns = columns.map(c => ({ key: c.key, width: widthFor(c) }))

  // Title block — org, report and (when filtered) the period, above the table.
  const titleRow = sheet.addRow([opts.title])
  titleRow.font = { bold: true, size: 14 }
  titleRow.commit()
  const contextRow = sheet.addRow([
    opts.orgName,
    ...(opts.period?.from || opts.period?.to
      ? [`${opts.period.from || ''} — ${opts.period.to || ''}`]
      : []),
  ])
  contextRow.font = { size: 10, color: { argb: 'FF666666' } }
  contextRow.commit()
  sheet.addRow([]).commit()

  const header = sheet.addRow(columns.map(c => c.header))
  styleHeaderBand(header, columns.length)
  header.commit()

  let zebra = false
  for (const row of opts.rows) {
    const excelRow = sheet.addRow(columns.map(c => cellValue(row[c.key], c.type)))
    styleDataCells(excelRow, types, zebra)
    excelRow.commit()
    zebra = !zebra
  }

  if (opts.totals && Object.keys(opts.totals).length) {
    const values = columns.map((c, i) => {
      if (i === 0) return opts.totalsLabel || 'Total'
      const t = opts.totals![c.key]
      return t === undefined ? '' : t
    })
    const totalsRow = sheet.addRow(values)
    styleDataCells(totalsRow, types, false)
    totalsRow.font = { bold: true }
    totalsRow.commit()
  }

  sheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
