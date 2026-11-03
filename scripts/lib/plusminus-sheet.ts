/**
 * A PlusMinus export as the matrix of cells `services/biz/accounting-books/plusminus-exports.ts`
 * reads: the first sheet, row by row, with formulas and rich text flattened to what they show.
 *
 * Streamed: a year's journal is 150k rows, and a loaded workbook of it takes gigabytes.
 */
import ExcelJS from 'exceljs'
import type { Matrix } from '../../packages/services/src/biz/accounting-books/plusminus-exports.js'

function flatten(v: any): unknown {
  // ⚠ The exports write a blank number as an empty cell, and the stream reads that as NaN.
  if (typeof v === 'number' && Number.isNaN(v)) return null
  if (v === null || v === undefined || typeof v !== 'object' || v instanceof Date) return v
  if ('result' in v) return v.result
  if ('text' in v) return v.text
  if (Array.isArray(v.richText)) return v.richText.map((part: any) => part.text).join('')
  return String(v)
}

export async function readSheet(path: string): Promise<Matrix> {
  const reader = new (ExcelJS as any).stream.xlsx.WorkbookReader(path, { entries: 'emit', sharedStrings: 'cache', styles: 'ignore', hyperlinks: 'ignore', worksheets: 'emit' })
  const matrix: Matrix = []
  for await (const sheet of reader) {
    for await (const row of sheet as any) {
      const cells = (row.values as unknown[]).slice(1).map(flatten)
      // A row's number is its address: the guards name it, and blank rows are not in the stream.
      while (matrix.length < row.number - 1) matrix.push([])
      matrix.push(cells)
    }
    break // the first sheet: the exports have one
  }
  return matrix
}
