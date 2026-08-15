import { markdownToPdf } from './base.pdf.js'
import { orderSheetI18n, type OrderSheetCtx } from '../order-sheet.i18n.js'

/**
 * Per-supplier-group Order sheets as PDF (markdown → md-to-pdf).
 *
 *  - 'supplier': offer sheet with blank price/total/delivery columns; no internal data.
 *  - 'internal': allocation + reservation breakdown for warehouse/transport planning.
 */
export async function generateOrderSheetPDF(ctx: OrderSheetCtx, variant: 'supplier' | 'internal'): Promise<Buffer | undefined> {
  const t = orderSheetI18n(ctx.locale)
  const lines: any[] = ctx.group.lines || []
  const esc = (s: any) => String(s ?? '').replace(/\|/g, '\\|')

  let md = `# ${variant === 'supplier' ? t.titleSupplier : t.titleInternal}\n\n`
  md += `**${t.orderNo}** ${ctx.order.orderNumber || ''}  \n`
  md += `**${t.date}:** ${ctx.order.issueDate ? new Date(ctx.order.issueDate).toISOString().split('T')[0] : ''}  \n`
  if (ctx.order.expectedDate) md += `**${t.expectedDate}:** ${new Date(ctx.order.expectedDate).toISOString().split('T')[0]}  \n`
  md += `\n`

  // Two-party block
  md += `| ${t.buyer} | ${t.supplier} |\n|---|---|\n`
  const buyerBits = [ctx.org.name]
  if (ctx.org.taxNumber) buyerBits.push(`${t.taxId}: ${ctx.org.taxNumber}`)
  if (ctx.org.vatNumber) buyerBits.push(`${t.vatId}: ${ctx.org.vatNumber}`)
  if (ctx.org.email) buyerBits.push(`${t.email}: ${ctx.org.email}`)
  if (ctx.org.phone) buyerBits.push(`${t.phone}: ${ctx.org.phone}`)
  const supplierBits = [ctx.supplierName]
  if (ctx.supplierTaxId) supplierBits.push(`${t.taxId}: ${ctx.supplierTaxId}`)
  if (ctx.group.reference) supplierBits.push(`${t.notes}: ${ctx.group.reference}`)
  md += `| ${buyerBits.map(esc).join('<br>')} | ${supplierBits.map(esc).join('<br>')} |\n\n`

  if (variant === 'supplier') {
    md += `| № | ${t.product} | ${t.sku} | ${t.qty} | ${t.unit} | ${t.offerPrice} | ${t.offerTotal} | ${t.deliveryTime} |\n`
    md += `|---|---|---|---:|---|---|---|---|\n`
    lines.forEach((line, i) => {
      const p = line.productId ? ctx.productInfo[String(line.productId)] : undefined
      md += `| ${i + 1} | ${esc(line.description || p?.name)} | ${esc(line.sku || p?.sku || '')} | ${Number(line.quantity) || 0} | ${esc(line.unit || p?.unit || '')} |  |  |  |\n`
    })
    md += `\n*${t.fillInHint}*\n\n`
  } else {
    md += `| № | ${t.product} | ${t.qty} | ${t.warehouse} | ${t.allocated} | ${t.received} | ${t.reservedFor} | ${t.reservedQty} | ${t.free} |\n`
    md += `|---|---|---:|---|---:|---:|---|---:|---:|\n`
    lines.forEach((line, i) => {
      const p = line.productId ? ctx.productInfo[String(line.productId)] : undefined
      const name = esc(line.description || p?.name)
      const allocations: any[] = line.allocations || []
      if (!allocations.length) {
        md += `| ${i + 1} | **${name}** | ${Number(line.quantity) || 0} |  |  |  |  |  |  |\n`
        return
      }
      let firstOfLine = true
      for (const alloc of allocations) {
        const whName = esc(ctx.warehouseNames[String(alloc.warehouseId)] || '')
        const reservations: any[] = ctx.reservations?.[String(alloc._id)] || []
        const reservedSum = reservations.reduce((s: number, r: any) => s + (Number(r.quantity) || 0), 0)
        const free = Math.max(0, (Number(alloc.quantity) || 0) - reservedSum)
        if (!reservations.length) {
          md += `| ${firstOfLine ? i + 1 : ''} | ${firstOfLine ? `**${name}**` : ''} | ${firstOfLine ? Number(line.quantity) || 0 : ''} | ${whName} | ${Number(alloc.quantity) || 0} | ${Number(alloc.receivedQuantity) || 0} |  |  | ${free} |\n`
          firstOfLine = false
          continue
        }
        let firstOfAlloc = true
        for (const res of reservations) {
          const clientName = esc(ctx.contactNames[String(res.contactId)] || '')
          md += `| ${firstOfLine ? i + 1 : ''} | ${firstOfLine ? `**${name}**` : ''} | ${firstOfLine ? Number(line.quantity) || 0 : ''} | ${firstOfAlloc ? whName : ''} | ${firstOfAlloc ? Number(alloc.quantity) || 0 : ''} | ${firstOfAlloc ? Number(alloc.receivedQuantity) || 0 : ''} | ${clientName} | ${Number(res.quantity) || 0} | ${firstOfAlloc ? free : ''} |\n`
          firstOfLine = false
          firstOfAlloc = false
        }
      }
      const allocated = allocations.reduce((s: number, a: any) => s + (Number(a.quantity) || 0), 0)
      const unallocated = Math.max(0, (Number(line.quantity) || 0) - allocated)
      if (unallocated > 0) {
        md += `|  |  |  | *${t.unallocated}* | ${unallocated} |  |  |  |  |\n`
      }
    })
    md += `\n`
  }

  if (ctx.order.notes) md += `**${t.notes}:** ${ctx.order.notes}\n\n`
  if (ctx.order.terms && variant === 'supplier') md += `**${t.terms}:** ${ctx.order.terms}\n\n`
  md += `---\n\n*${t.generated}: ${new Date().toISOString().split('T')[0]}*\n`

  return markdownToPdf(md)
}
