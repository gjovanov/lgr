import { createWorkbook, finalizeWorkbook } from './base.excel.js'
import { companionDocI18n } from '../companion-doc.i18n.js'
import type { CompanionDocData } from '../pdf/companion-doc.pdf.js'

function fmtDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${date.getFullYear()}`
}

/**
 * Worksheet twin of `generateCompanionDocPDF` — same content and ordering, laid out as rows so
 * the numbers stay editable. The PDF is the document of record; this exists because the Print
 * dialog offers Excel alongside it.
 */
export async function generateCompanionDocXLSX(data: CompanionDocData): Promise<Buffer> {
  const i18n = companionDocI18n(data.locale)
  const L = i18n.label
  const H = i18n.header
  const isCertificate = data.kind === 'certificate'

  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet(i18n.title[data.kind].slice(0, 31))

  ws.columns = [
    { width: 6 },   // No
    { width: 52 },  // Name
    { width: 10 },  // Unit
    { width: 14 },  // Quantity
    { width: 22 },  // Certificate / Remark
  ]

  const titleRow = ws.addRow([i18n.title[data.kind]])
  titleRow.font = { bold: true, size: 14 }
  titleRow.commit()
  ws.addRow([`${L.number}:`, data.number]).commit()
  ws.addRow([`${L.date}:`, fmtDate(data.date)]).commit()
  ws.addRow([]).commit()

  // Recipient on the left pair of columns, supplier on the right — mirrors the printed form.
  ws.addRow([`${L.recipient}:`, data.recipient.name, '', `${L.supplier}:`, data.supplier.name]).commit()
  ws.addRow([`${L.city}:`, data.recipient.city || '', '', `${L.city}:`, data.supplier.city || '']).commit()
  ws.addRow([`${L.address}:`, data.recipient.address || '', '', `${L.address}:`, data.supplier.address || '']).commit()
  ws.addRow([`${L.taxId}:`, data.recipient.taxId || '', '', `${L.taxId}:`, data.supplier.taxId || '']).commit()
  ws.addRow([]).commit()

  const headerRow = ws.addRow([
    H.lineNo,
    H.name,
    isCertificate ? H.unitShort : H.unit,
    isCertificate ? H.quantityShort : H.quantity,
    isCertificate ? H.certificate : H.remark,
  ])
  headerRow.font = { bold: true }
  headerRow.commit()

  data.lines.forEach((l, i) => {
    ws.addRow([i + 1, l.name, l.unit || '', Number(l.quantity || 0), l.note || '']).commit()
  })

  if (!isCertificate) {
    const total = data.lines.reduce((s, l) => s + Number(l.quantity || 0), 0)
    const totalRow = ws.addRow(['', '', i18n.totalQuantity, total, ''])
    totalRow.font = { bold: true }
    totalRow.commit()
  }

  ws.addRow([]).commit()
  ws.addRow([i18n.body[data.kind]]).commit()
  ws.addRow([]).commit()
  ws.addRow([L.docList]).commit()
  for (const d of data.sourceDocs) {
    ws.addRow([`-${d.label} № ${d.number} ${data.locale === 'bg' ? 'от' : '/'} ${fmtDate(d.date)}`]).commit()
  }
  ws.addRow([]).commit()
  ws.addRow([L.additionalInfo, data.additionalInfo || '']).commit()
  ws.addRow([]).commit()

  if (isCertificate) {
    ws.addRow([`${L.preparedBy}:`, data.preparedBy || '']).commit()
  } else {
    ws.addRow([`${L.receivedBy}:`, '', '', `${L.preparedBy}:`, data.preparedBy || '']).commit()
    ws.addRow([L.signature, '', '', L.signature]).commit()
  }

  if (data.footerText) {
    ws.addRow([]).commit()
    const foot = ws.addRow([data.footerText])
    foot.font = { size: 8 }
    foot.commit()
  }

  ws.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
