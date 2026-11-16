import { InternalOrder, Contact, Org, Product } from 'db/models'
import { generateCustomerOrderPDF } from 'reporting/pdf/customer-order.pdf'
import type { CustomerOrderCtx } from 'reporting/customer-order.i18n'
import { orgLocalParts } from 'services/biz/digest/digest-time'

/**
 * The customer order's printed sheet (`InternalOrder`, ORDI-), assembled in one place so that
 * `GET /internal-orders/:id/export` and whatever else hands the sheet to a client (an e-mail's
 * attachment) render the same document from one code path, as `renderInvoicePdf` does for an
 * invoice.
 *
 * The sheet carries no price (`reporting/pdf/customer-order.pdf`), so there is nothing here for a
 * caller's role to change: every caller gets the same page.
 */

export type RenderInternalOrderPdfResult =
  | { ok: true; buffer: Buffer | Uint8Array; filename: string; order: any }
  | { ok: false; status: 404 | 503; message: string; detail?: string }

/** A well-formed id: anything else would throw a CastError (a 500) instead of a 404. */
function isId(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v)
}

const contactName = (c: any): string => c?.companyName || [c?.firstName, c?.lastName].filter(Boolean).join(' ') || ''

/**
 * What the sheet is built from: the order, the organization as its supplier, the contact as its
 * customer, and the articles its lines fall back to. Every read names the org (S-35): an id the
 * order holds that is not this org's resolves to nothing. Exported for its test.
 */
export async function customerOrderCtx(orgId: string, order: any, locale: string): Promise<CustomerOrderCtx> {
  const productIds = [...new Set<string>((order.lines || []).map((l: any) => (l.productId ? String(l.productId) : '')).filter(Boolean))]
  const [org, contact, products] = await Promise.all([
    Org.findById(orgId, { name: 1, taxNumber: 1, vatNumber: 1, email: 1, phone: 1, 'settings.timezone': 1 }).lean().exec(),
    order.contactId
      ? Contact.findOne(
        { _id: order.contactId, orgId } as any,
        { companyName: 1, firstName: 1, lastName: 1, taxId: 1, taxNumber: 1, vatNumber: 1, email: 1, phone: 1, mobile: 1 },
      ).lean().exec()
      : null,
    productIds.length
      ? Product.find({ orgId, _id: { $in: productIds } } as any, { name: 1, sku: 1, unit: 1 }).lean().exec()
      : [],
  ])
  const o = org as any
  const c = contact as any
  // The foot's day is the org's own: at night the server's (UTC) is still yesterday's. No zone set: UTC.
  const today = orgLocalParts(new Date(), o?.settings?.timezone).date
  return {
    order,
    org: { name: o?.name || '', taxId: o?.taxNumber, vatId: o?.vatNumber, email: o?.email, phone: o?.phone },
    customer: { name: contactName(c), taxId: c?.taxId || c?.taxNumber, vatId: c?.vatNumber, email: c?.email, phone: c?.phone || c?.mobile },
    productInfo: Object.fromEntries((products as any[]).map((p) => [String(p._id), { name: p.name, sku: p.sku, unit: p.unit }])),
    locale,
    generatedAt: new Date(`${today}T00:00:00.000Z`),
  }
}

/**
 * The order's sheet as a PDF, named `<orderNumber>.pdf`.
 *
 * 404 for an id that is not an order of THIS org (another org's, a deleted one, a malformed one);
 * 503 when the renderer fails, with its reason in `detail`. It reads only: printing an order
 * changes nothing on it.
 */
export async function renderInternalOrderPdf(
  orgId: string,
  orderId: string,
  opts?: { locale?: string },
): Promise<RenderInternalOrderPdfResult> {
  const order: any = isId(orgId) && isId(orderId)
    ? await InternalOrder.findOne({ _id: orderId, orgId } as any).lean().exec()
    : null
  if (!order) return { ok: false, status: 404, message: 'Incoming order not found' }

  // Outside the `try`: a failed read is the server's error to report, not the renderer's.
  const ctx = await customerOrderCtx(orgId, order, opts?.locale || 'en')
  try {
    const buffer = await generateCustomerOrderPDF(ctx)
    if (!buffer) return { ok: false, status: 503, message: 'PDF renderer unavailable' }
    return { ok: true, buffer, filename: `${order.orderNumber}.pdf`, order }
  } catch (e: any) {
    return {
      ok: false,
      status: 503,
      message: 'PDF export is temporarily unavailable. Try again in a moment.',
      detail: e?.message?.slice(0, 300),
    }
  }
}
