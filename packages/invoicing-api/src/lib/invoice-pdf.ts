import { Invoice, Contact, Org } from 'db/models'
import { generateInvoicePDF, HEADER_NOTE_MAX } from 'reporting/pdf/invoice.pdf'
import { getOrgLogoDataUri } from 'services/biz/org-logo.service'
import { paidByReceipts } from 'services/biz/cash-register/payment-receipt.service'

/**
 * Issuer line printed in the page foot, beneath the software-credit line printed by the
 * generators (see `reporting/product-credit`). Lived in the export controller; moved here
 * so both the export and the email path share one definition.
 */
export function orgFooterLine(org: any): string {
  return [
    org?.phone ? `тел.: ${org.phone}` : '',
    org?.website,
  ].filter(Boolean).join('   ')
}

/**
 * FR-10.1 — the single-invoice PDF assembly, extracted so `GET /export/:id` and
 * `POST /export/:id/email` render byte-identical documents from one code path.
 *
 * Behaviour is frozen: this is exactly what the export route did inline, moved. The export
 * suites are the regression net and must stay green unmodified.
 */

export interface RenderInvoicePdfOptions {
  locale?: string
  columns?: string[]
  /**
   * A caller-supplied header note. `undefined` means "reprint whatever is stored"; a string
   * replaces it. The note belongs to the DOCUMENT, so a new one is persisted (when the
   * caller may write) and every later copy carries it.
   */
  note?: string
  /** Whether this caller is allowed to persist a changed note. */
  canPersistNote?: boolean
}

export type RenderInvoicePdfResult =
  | { ok: true; buffer: Buffer; filename: string; invoice: any }
  | { ok: false; status: 404; message: string }
  | { ok: false; status: 503; message: string; detail?: string }

/**
 * The cash sale a storno reverses, as its printout names it: the sale's number and date, its УНП
 * and receipt, and the reason (FR-21's `register.storno`).
 */
export async function stornoRefOf(orgId: string, storno: any) {
  const s = storno.register?.storno || {}
  const originalId = s.originalId || storno.relatedInvoiceId
  const original: any = originalId
    ? await Invoice.findOne({ _id: originalId, orgId }, { invoiceNumber: 1, issueDate: 1 }).lean()
    : null
  return {
    number: original?.invoiceNumber || '',
    issueDate: s.originalDate || original?.issueDate,
    unp: s.originalUnp || '',
    receiptNumber: s.originalReceiptNumber || '',
    reason: s.reason || '',
  }
}

/**
 * The document as its printout reads it: a storno names the sale it reverses, and an invoice or a
 * debit note the fiscal receipts that paid it (FR-23), as an invoice for a cash sale names that sale.
 */
export async function printableDocument(orgId: string, invoice: any): Promise<any> {
  const stornoRef = invoice.type === 'cash_storno' || invoice.type === 'payment_storno' ? await stornoRefOf(orgId, invoice) : undefined
  const receipts = invoice.type === 'invoice' || invoice.type === 'debit_note' ? await paidByReceipts(orgId, String(invoice._id)) : []
  // A cash-on-delivery receipt has paid nothing while the courier still owes: "Платена с касов бон"
  // on a document wholly due is a false statement on a tax document. So is it of a text receipt: no
  // device recorded one, as an invoice for a text sale names no receipt either.
  const paidBy = receipts.filter(r => !r.text && (r.method !== 'cash_on_delivery' || invoice.status === 'paid'))
  return { ...invoice, ...(stornoRef ? { stornoRef } : {}), ...(paidBy.length ? { paymentReceipts: paidBy } : {}) }
}

export async function renderInvoicePdf(
  orgId: string,
  invoiceId: string,
  opts: RenderInvoicePdfOptions = {},
): Promise<RenderInvoicePdfResult> {
  const invoice = await Invoice.findOne({ _id: invoiceId, orgId }).lean()
  if (!invoice) return { ok: false, status: 404, message: 'Document not found' }

  const locale = opts.locale || 'en'
  const supplied = opts.note === undefined ? undefined : String(opts.note).trim().slice(0, HEADER_NOTE_MAX)
  const stored = ((invoice as any).printNote as string | undefined) || ''
  if (supplied !== undefined && supplied !== stored && opts.canPersistNote) {
    await Invoice.updateOne({ _id: invoiceId, orgId }, { $set: { printNote: supplied } })
  }

  const contact = (invoice as any).contactId
    ? await Contact.findById((invoice as any).contactId).lean()
    : null
  const org = await Org.findById(orgId).lean()

  // The invoice form reads the letterhead off the org record it is given, and the renderer
  // cannot fetch a URL — so hand it the uploaded logo inlined, falling back to whatever
  // `Org.logo` holds (and from there to the bundled asset).
  const orgForPdf = { ...(org as any), logo: (await getOrgLogoDataUri(orgId)) ?? (org as any)?.logo }

  try {
    const doc = await printableDocument(orgId, invoice)
    const buffer = await generateInvoicePDF(doc as any, orgForPdf as any, (contact as any) || {}, opts.columns, {
      locale,
      footerText: orgFooterLine(org),
      headerNote: supplied ?? stored,
    })
    if (!buffer) return { ok: false, status: 503, message: 'PDF renderer unavailable' }
    return { ok: true, buffer, filename: `${(invoice as any).invoiceNumber}.pdf`, invoice }
  } catch (e: any) {
    return {
      ok: false,
      status: 503,
      message: 'PDF export is temporarily unavailable. Use Excel export or retry.',
      detail: e?.message?.slice(0, 300),
    }
  }
}
