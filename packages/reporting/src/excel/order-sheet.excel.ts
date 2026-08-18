import ExcelJS from 'exceljs'
import { createWorkbook, finalizeWorkbook } from './base.excel.js'
import { orderSheetI18n, type OrderSheetCtx } from '../order-sheet.i18n.js'

/**
 * Per-supplier-group Order sheets.
 *
 *  - variant 'supplier': offer sheet the supplier fills in — product/qty/unit plus
 *    BLANK price/total/delivery columns. No warehouse or client data (redacted).
 *  - variant 'internal': full breakdown — per line, per warehouse allocation, per
 *    client reservation, with received and free quantities. For warehouse storage
 *    and transport planning.
 */
export async function generateOrderSheetXLSX(ctx: OrderSheetCtx, variant: 'supplier' | 'internal'): Promise<Buffer> {
  const t = orderSheetI18n(ctx.locale)
  const { workbook, tmpFile } = await createWorkbook()
  const ws = workbook.addWorksheet(variant === 'supplier' ? t.titleSupplier : t.titleInternal)

  const title = variant === 'supplier' ? t.titleSupplier : t.titleInternal
  const lines: any[] = ctx.group.lines || []

  // ── document header block ──
  const headerPairs: Array<[string, string]> = [
    [t.orderNo, String(ctx.order.orderNumber || '')],
    [t.date, ctx.order.issueDate ? new Date(ctx.order.issueDate).toISOString().split('T')[0] : ''],
  ]
  if (ctx.order.expectedDate) headerPairs.push([t.expectedDate, new Date(ctx.order.expectedDate).toISOString().split('T')[0]])
  headerPairs.push([t.buyer, ctx.org.name + (ctx.org.taxNumber ? ` (${t.taxId} ${ctx.org.taxNumber})` : '')])
  headerPairs.push([t.supplier, ctx.supplierName + (ctx.supplierTaxId ? ` (${t.taxId} ${ctx.supplierTaxId})` : '')])
  if (ctx.group.reference) headerPairs.push([t.notes, String(ctx.group.reference)])

  const titleRow = ws.addRow([title])
  titleRow.font = { bold: true, size: 14 }
  titleRow.commit()
  for (const [label, value] of headerPairs) {
    const r = ws.addRow([label, value])
    r.getCell(1).font = { bold: true }
    r.commit()
  }
  ws.addRow([]).commit()

  const styleHeader = (row: ExcelJS.Row) => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } }
    row.alignment = { vertical: 'middle', horizontal: 'center' }
  }

  if (variant === 'supplier') {
    ws.columns = [
      { width: 6 }, { width: 50 }, { width: 16 }, { width: 12 }, { width: 10 },
      { width: 18 }, { width: 16 }, { width: 18 },
    ] as any
    const header = ws.addRow(['№', t.product, t.sku, t.qty, t.unit, t.offerPrice, t.offerTotal, t.deliveryTime])
    styleHeader(header)
    header.commit()

    lines.forEach((line, i) => {
      const p = line.productId ? ctx.productInfo[String(line.productId)] : undefined
      const r = ws.addRow([
        i + 1,
        line.description || p?.name || '',
        line.sku || p?.sku || '',
        Number(line.quantity) || 0,
        line.unit || p?.unit || '',
        '', // supplier fills the price
        '', // supplier fills the total
        '', // supplier fills the delivery time
      ])
      r.getCell(4).alignment = { horizontal: 'right' }
      r.commit()
    })
    ws.addRow([]).commit()
    const hint = ws.addRow([t.fillInHint])
    hint.getCell(1).font = { italic: true }
    hint.commit()
  } else {
    ws.columns = [
      { width: 6 }, { width: 44 }, { width: 14 }, { width: 12 }, { width: 9 }, { width: 14 },
      { width: 22 }, { width: 13 }, { width: 12 }, { width: 26 }, { width: 12 }, { width: 11 },
    ] as any
    const header = ws.addRow([
      '№', t.product, t.sku, t.qty, t.unit, t.expectedPrice,
      t.warehouse, t.allocated, t.received, t.reservedFor, t.reservedQty, t.free,
    ])
    styleHeader(header)
    header.commit()

    lines.forEach((line, i) => {
      const p = line.productId ? ctx.productInfo[String(line.productId)] : undefined
      const base = [
        i + 1,
        line.description || p?.name || '',
        line.sku || p?.sku || '',
        Number(line.quantity) || 0,
        line.unit || p?.unit || '',
        line.expectedUnitPrice != null ? Number(line.expectedUnitPrice) : '',
      ]
      const allocations: any[] = line.allocations || []
      if (!allocations.length) {
        ws.addRow([...base, '', '', '', '', '', '']).commit()
        return
      }
      let firstOfLine = true
      for (const alloc of allocations) {
        const whName = ctx.warehouseNames[String(alloc.warehouseId)] || ''
        const reservations: any[] = ctx.reservations?.[String(alloc._id)] || []
        const reservedSum = reservations.reduce((s: number, r: any) => s + (Number(r.quantity) || 0), 0)
        const free = Math.max(0, (Number(alloc.quantity) || 0) - reservedSum)
        if (!reservations.length) {
          const r = ws.addRow([
            ...(firstOfLine ? base : ['', '', '', '', '', '']),
            whName, Number(alloc.quantity) || 0, Number(alloc.receivedQuantity) || 0, '', '', free,
          ])
          if (firstOfLine) r.font = { bold: false }
          r.commit()
          firstOfLine = false
          continue
        }
        let firstOfAlloc = true
        for (const res of reservations) {
          const clientName = ctx.contactNames[String(res.contactId)] || ''
          ws.addRow([
            ...(firstOfLine ? base : ['', '', '', '', '', '']),
            firstOfAlloc ? whName : '',
            firstOfAlloc ? Number(alloc.quantity) || 0 : '',
            firstOfAlloc ? Number(alloc.receivedQuantity) || 0 : '',
            clientName,
            Number(res.quantity) || 0,
            firstOfAlloc ? free : '',
          ]).commit()
          firstOfLine = false
          firstOfAlloc = false
        }
      }
      // Unallocated remainder, if the line isn't fully split across warehouses.
      const allocated = allocations.reduce((s: number, a: any) => s + (Number(a.quantity) || 0), 0)
      const unallocated = Math.max(0, (Number(line.quantity) || 0) - allocated)
      if (unallocated > 0) {
        const r = ws.addRow(['', '', '', '', '', '', t.unallocated, unallocated, '', '', '', ''])
        r.getCell(7).font = { italic: true }
        r.commit()
      }
    })
  }

  if (ctx.order.notes) {
    ws.addRow([]).commit()
    const r = ws.addRow([`${t.notes}: ${ctx.order.notes}`])
    r.commit()
  }
  if (ctx.order.terms && variant === 'supplier') {
    const r = ws.addRow([`${t.terms}: ${ctx.order.terms}`])
    r.commit()
  }

  return finalizeWorkbook(workbook, tmpFile)
}
