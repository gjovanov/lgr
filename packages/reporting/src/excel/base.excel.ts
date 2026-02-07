import ExcelJS from 'exceljs'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlink } from 'fs/promises'

export async function createWorkbook(): Promise<{ workbook: ExcelJS.stream.xlsx.WorkbookWriter; tmpFile: string }> {
  const tmpFile = join(tmpdir(), `lgr-export-${Date.now()}.xlsx`)
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: tmpFile,
    useSharedStrings: false,
  })
  return { workbook, tmpFile }
}

export async function finalizeWorkbook(workbook: ExcelJS.stream.xlsx.WorkbookWriter, tmpFile: string): Promise<Buffer> {
  await workbook.commit()
  const buffer = await Bun.file(tmpFile).arrayBuffer()
  await unlink(tmpFile)
  return Buffer.from(buffer)
}

export function styleHeaderRow(worksheet: ExcelJS.Worksheet, columnCount: number) {
  const headerRow = worksheet.getRow(1)
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } }
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' }
}

export function formatCurrency(value: number): string {
  return value.toFixed(2)
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]
}
