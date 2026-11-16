import { Contact, Org, Product, StockMovement, Warehouse } from 'db/models'
import { generateStockMovementPDF, type StockMovementData } from 'reporting/pdf/stock-movement.pdf'
import { getOrgLogoDataUri } from './org-logo.service.js'
import { orgFooterLine } from './org-footer-line.js'
import { sideIsExternal } from 'config/external-warehouse'

/**
 * A stock movement as a printed document (`reporting/pdf/stock-movement.pdf`).
 *
 * One function renders it, for the print route (`GET /warehouse/movement/:id/export`) and for
 * anything that sends the sheet on: an attachment made here is the print, byte for byte.
 *
 * ⚠ The sheet carries no price: a line's `unitCost` is a cost figure not every role sees, and the
 * sheet leaves the org. So whoever may read the movement may print it, and nothing here asks more.
 */

export type RenderStockMovementPdfResult =
  | { ok: true; buffer: Buffer | Uint8Array; filename: string; movement: any }
  | { ok: false; status: 404 | 503; message: string; detail?: string }

const OBJECT_ID = /^[0-9a-f]{24}$/i
const idOf = (v: unknown): string => (v ? String(v) : '')

/** The partner as the lists name one: the company, else the person. */
function partnerName(c: any): string {
  return c ? c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || '' : ''
}

/**
 * What the sheet prints, read from the movement of this org as it stands. Exported so the content
 * can be asserted without launching Chromium.
 */
export async function stockMovementDocumentData(orgId: string, movement: any, opts: { locale?: string } = {}): Promise<StockMovementData> {
  // A side names the warehouse whose stock moved, or the external one a completed movement keeps apart.
  const fromId = idOf(movement.fromWarehouseId) || idOf(movement.externalFromWarehouseId)
  const toId = idOf(movement.toWarehouseId) || idOf(movement.externalToWarehouseId)
  const productIds = [...new Set((movement.lines || []).map((l: any) => idOf(l.productId)).filter(Boolean))]
  const warehouseIds = [...new Set([fromId, toId].filter(Boolean))]

  const [warehouses, products, contact, org, logo] = await Promise.all([
    warehouseIds.length ? Warehouse.find({ orgId, _id: { $in: warehouseIds } } as any, { name: 1, isExternal: 1 }).lean().exec() : [],
    productIds.length ? Product.find({ orgId, _id: { $in: productIds } } as any, { name: 1, unit: 1 }).lean().exec() : [],
    movement.contactId ? Contact.findOne({ _id: movement.contactId, orgId } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec() : null,
    Org.findById(orgId).lean().exec(),
    getOrgLogoDataUri(orgId),
  ])
  const warehouseOf = new Map((warehouses as any[]).map(w => [String(w._id), w]))
  const productOf = new Map((products as any[]).map(p => [String(p._id), p]))

  const side = (id: string, stockId: unknown, externalId: unknown) => {
    const w: any = id ? warehouseOf.get(id) : null
    return w ? { name: w.name || '', external: sideIsExternal(movement, stockId, externalId, !!w.isExternal) } : null
  }

  return {
    number: movement.movementNumber || '',
    date: movement.date,
    type: movement.type,
    draft: movement.status === 'draft',
    from: side(fromId, movement.fromWarehouseId, movement.externalFromWarehouseId),
    to: side(toId, movement.toWarehouseId, movement.externalToWarehouseId),
    partner: partnerName(contact),
    reference: movement.reference || '',
    note: movement.notes || '',
    lines: (movement.lines || []).map((l: any) => {
      const p: any = productOf.get(idOf(l.productId))
      return { name: p?.name || '', unit: p?.unit, quantity: Number(l.quantity) || 0 }
    }),
    logo: logo ?? (org as any)?.logo,
    footerText: orgFooterLine(org),
    locale: opts.locale || 'en',
  }
}

/**
 * Render one movement of this org to a PDF. 404 when the org has no such movement; 503 when the
 * renderer is unavailable or fails, as the invoice's print answers (`renderInvoicePdf`).
 */
export async function renderStockMovementPdf(
  orgId: string,
  movementId: string,
  opts: { locale?: string } = {},
): Promise<RenderStockMovementPdfResult> {
  const movement: any = OBJECT_ID.test(String(movementId))
    ? await StockMovement.findOne({ _id: movementId, orgId } as any).lean().exec()
    : null
  if (!movement) return { ok: false, status: 404, message: 'Stock movement not found' }

  try {
    const buffer = await generateStockMovementPDF(await stockMovementDocumentData(orgId, movement, opts))
    if (!buffer) return { ok: false, status: 503, message: 'PDF renderer unavailable' }
    // The number names the file. One a caller chose may hold what a file name or a header cannot.
    const name = String(movement.movementNumber || 'stock-movement').replace(/[\\/:*?"<>|\r\n]+/g, '-')
    return { ok: true, buffer, filename: `${name}.pdf`, movement }
  } catch (e: any) {
    return {
      ok: false,
      status: 503,
      message: 'PDF export is temporarily unavailable. Please retry.',
      detail: e?.message?.slice(0, 300),
    }
  }
}
