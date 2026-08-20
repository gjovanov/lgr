import {
  createWorkbook, finalizeWorkbook, styleHeaderBand, styleDataCells,
  fmtForValue, GRID_BORDER, ZEBRA_FILL, HEADER_RULE, type CellType,
} from './base.excel.js'
import { companionDocI18n } from '../companion-doc.i18n.js'
import type { CompanionDocData } from '../pdf/companion-doc.pdf.js'

function fmtDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${date.getFullYear()}`
}

/** No / Name / Unit / Quantity / Certificate-Remark — the printed form's five columns. */
const WIDTHS = [7, 46, 11, 13, 24]
const LAST_COL = WIDTHS.length
/** Column C separates the recipient block (A–B) from the supplier block (D–E). */
const SUPPLIER_COL = 4

/**
 * Worksheet twin of `generateCompanionDocPDF` — same content, same ordering and the same
 * visual language as the single-invoice sheet: centred title over the table width, shaded
 * party bands, a ruled line table and the boxed total quantity. The PDF is the document of
 * record; this exists because the Print dialog offers Excel alongside it.
 */
export async function generateCompanionDocXLSX(data: CompanionDocData): Promise<Buffer> {
  const i18n = companionDocI18n(data.locale)
  const L = i18n.label
  const H = i18n.header
  const isCertificate = data.kind === 'certificate'

  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet(i18n.title[data.kind].slice(0, 31), {
    // Gridlines stay on so the cells around the document still read as a grid; fitted to one
    // page-width for a reader who prints the sheet.
    views: [{ showGridLines: true }],
    pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  })
  ws.columns = WIDTHS.map(width => ({ width })) as any

  let rowNo = 0
  const addRow = (values: any[] = []) => {
    const r = ws.addRow(values)
    rowNo++
    return r
  }
  /** Merge across the sheet width, e.g. for the title and the paragraph blocks. */
  const mergeAll = (from = 1, to = LAST_COL) => { if (to > from) ws.mergeCells(rowNo, from, rowNo, to) }

  /** Height for a merged, wrapped block: its own line breaks plus what the width will wrap. */
  const wrapHeight = (text: string, width: number) => {
    const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(20, width))), 0)
    return Math.min(200, Math.max(17, lines * 14))
  }
  const fullWidth = WIDTHS.reduce((a, b) => a + b, 0)

  // ── Title ──
  const titleRow = addRow([i18n.title[data.kind]])
  mergeAll()
  titleRow.getCell(1).font = { bold: true, size: 15 }
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' }
  titleRow.height = 26
  for (let c = 1; c <= LAST_COL; c++) {
    titleRow.getCell(c).border = { bottom: { style: 'medium', color: { argb: HEADER_RULE } } }
  }
  titleRow.commit()
  addRow().commit()

  // ── Number / date card: shaded label, value beside it, boxed as on the invoice sheet ──
  const fieldRow = (label: string, value: string) => {
    const r = addRow([`${label}:`, value])
    ws.mergeCells(rowNo, 2, rowNo, LAST_COL)
    const labelCell = r.getCell(1)
    labelCell.font = { bold: true }
    labelCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
    labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } }
    r.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
    r.height = 17
    for (let c = 1; c <= LAST_COL; c++) r.getCell(c).border = { ...GRID_BORDER }
    r.commit()
  }
  fieldRow(L.number, data.number)
  fieldRow(L.date, fmtDate(data.date))
  addRow().commit()

  // ── Parties: the two names on a shaded band, their details in the rows beneath ──
  const bandRow = addRow([L.recipient, data.recipient.name, '', L.supplier, data.supplier.name])
  bandRow.height = 18
  for (const c of [1, 2, SUPPLIER_COL, SUPPLIER_COL + 1]) {
    const cell = bandRow.getCell(c)
    cell.font = { bold: true }
    cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } }
    cell.border = { ...GRID_BORDER }
  }
  bandRow.commit()

  const partyRow = (label: string, left?: string, right?: string) => {
    const r = addRow([label, left || '', '', label, right || ''])
    r.height = 17
    for (const c of [1, 2, SUPPLIER_COL, SUPPLIER_COL + 1]) {
      r.getCell(c).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
      r.getCell(c).border = { ...GRID_BORDER }
    }
    r.commit()
  }
  partyRow(L.city, data.recipient.city, data.supplier.city)
  partyRow(L.address, data.recipient.address, data.supplier.address)
  partyRow(L.taxId, data.recipient.taxId, data.supplier.taxId)
  addRow().commit()

  // ── Line table ──
  const headerRow = addRow([
    H.lineNo,
    H.name,
    isCertificate ? H.unitShort : H.unit,
    isCertificate ? H.quantityShort : H.quantity,
    isCertificate ? H.certificate : H.remark,
  ])
  styleHeaderBand(headerRow, LAST_COL)
  headerRow.commit()

  const types: (CellType | undefined)[] = ['int', 'text', 'text', 'quantity', 'text']
  data.lines.forEach((l, i) => {
    const r = addRow([i + 1, l.name, l.unit || '', Number(l.quantity || 0), l.note || ''])
    styleDataCells(r, types, i % 2 === 1)
    r.commit()
  })

  // Total quantity handed over, closing the table under its own column. Neither companion
  // document states amounts, so this is the only total they carry.
  if (data.lines.length) {
    const total = data.lines.reduce((s, l) => s + Number(l.quantity || 0), 0)
    // The label goes in B — the anchor of the B:C merge, which is where the value is read from.
    const r = addRow(['', `${i18n.total}:`, '', total, ''])
    ws.mergeCells(rowNo, 2, rowNo, 3)
    const labelCell = r.getCell(2)
    labelCell.font = { bold: true }
    labelCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 }
    const qty = r.getCell(4)
    qty.font = { bold: true }
    qty.numFmt = fmtForValue('quantity', total)
    qty.alignment = { horizontal: 'right', vertical: 'middle' }
    for (let c = 2; c <= 4; c++) {
      r.getCell(c).border = {
        ...GRID_BORDER,
        top: { style: 'thin', color: { argb: 'FF808080' } },
        bottom: { style: 'thin', color: { argb: 'FF808080' } },
      }
      r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } }
    }
    r.commit()
  }
  addRow().commit()

  // ── Legal paragraph, source documents, additional info ──
  const legal = addRow([i18n.body[data.kind]])
  mergeAll()
  legal.getCell(1).alignment = { horizontal: 'left', vertical: 'top', wrapText: true, indent: 1 }
  legal.height = wrapHeight(i18n.body[data.kind], fullWidth)
  legal.commit()
  addRow().commit()

  const docList = addRow([L.docList])
  mergeAll()
  docList.getCell(1).font = { bold: true }
  docList.commit()
  for (const d of data.sourceDocs) {
    const r = addRow([`-${d.label} № ${d.number} ${data.locale === 'bg' ? 'от' : '/'} ${fmtDate(d.date)}`])
    mergeAll()
    r.commit()
  }
  addRow().commit()

  const info = addRow([L.additionalInfo, data.additionalInfo || ''])
  ws.mergeCells(rowNo, 2, rowNo, LAST_COL)
  info.getCell(1).font = { bold: true }
  info.commit()
  addRow().commit()

  // ── Signatures: the certificate is signed by its author, the protocol countersigned ──
  if (isCertificate) {
    const r = addRow(['', '', '', `${L.preparedBy}:`, data.preparedBy || ''])
    r.getCell(SUPPLIER_COL).font = { bold: true }
    r.commit()
    const sig = addRow(['', '', '', '', L.signature])
    sig.height = 26
    sig.getCell(SUPPLIER_COL + 1).border = { top: { style: 'thin', color: { argb: 'FF808080' } } }
    sig.commit()
  } else {
    const r = addRow([`${L.receivedBy}:`, '', '', `${L.preparedBy}:`, data.preparedBy || ''])
    r.getCell(1).font = { bold: true }
    r.getCell(SUPPLIER_COL).font = { bold: true }
    r.commit()
    const sig = addRow(['', L.signature, '', '', L.signature])
    sig.height = 26
    for (const c of [2, SUPPLIER_COL + 1]) {
      sig.getCell(c).border = { top: { style: 'thin', color: { argb: 'FF808080' } } }
    }
    sig.commit()
  }

  if (data.footerText) {
    addRow().commit()
    const foot = addRow([data.footerText])
    mergeAll()
    foot.getCell(1).font = { size: 8 }
    foot.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' }
    foot.commit()
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
