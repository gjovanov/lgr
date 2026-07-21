/**
 * Orchestration for OCR-drafted purchase invoices (bills):
 * match supplier + products from an extracted invoice, create a DRAFT bill,
 * and convert (receive) drafts — reusing the existing invoice numbering + stock flow.
 */
import { getRepos } from 'services/context'
import { buildSearchFilter } from 'services/biz/search.utils'
import { createInvoiceStockMovement } from 'services/biz/invoicing.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { Contact, Product, Warehouse } from 'db/models'
import { getNextInvoiceNumber, getNextDraftInvoiceNumber } from '../controllers/invoice.controller.js'

interface Party { name?: string | null; company_id?: string | null; vat_id?: string | null; address?: string | null; iban?: string | null }
interface LineItem { description: string; quantity?: number | null; unit?: string | null; unit_price?: number | null; vat_rate?: number | null; total?: number | null }
export interface InvoiceExtraction {
  document_number?: string | null; issue_date?: string | null; due_date?: string | null
  currency?: string | null; exchange_rate?: number | null
  supplier: Party; customer: Party; line_items: LineItem[]
  net_total?: number | null; vat_total?: number | null; gross_total?: number | null
  payment_terms?: string | null; notes?: string | null
}
export interface DraftResult {
  extraction: InvoiceExtraction
  validation: { status: 'valid' | 'needs_review'; checks: any[] }
  model: string
  engine: string
}

const clean = (v: unknown): string => (v == null ? '' : String(v)).trim()
const num = (v: unknown, d = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** Match (or create) the supplier Contact from the extracted party. */
export async function matchSupplier(orgId: string, sup: Party): Promise<{ contactId: string; name: string; created: boolean } | null> {
  const eik = clean(sup.company_id)
  const vat = clean(sup.vat_id)
  const name = clean(sup.name)
  const typeIn = { type: { $in: ['supplier', 'both'] } }

  let c: any = null
  if (eik) c = await Contact.findOne({ orgId, ...typeIn, taxId: eik }).lean()
  if (!c && vat) c = await Contact.findOne({ orgId, ...typeIn, vatNumber: vat }).lean()
  if (!c && name) {
    const f = buildSearchFilter(name, ['companyName'], { lowered: { companyName: 'companyNameLower' } })
    c = await Contact.findOne({ orgId, ...typeIn, ...f }).lean()
  }
  if (c) return { contactId: String(c._id), name: c.companyName || name, created: false }
  if (!name) return null

  // Create the supplier — .create() fires the loweredFieldsPlugin hooks (Cyrillic search mirrors).
  const created: any = await Contact.create({
    orgId,
    type: 'supplier',
    companyName: name,
    taxId: eik || undefined,
    vatNumber: vat || undefined,
    notes: clean(sup.address) || undefined,
    isActive: true,
  })
  return { contactId: String(created._id), name, created: true }
}

/** Match an existing product by Cyrillic name/SKU. Unmatched → null (free-text line). */
export async function matchProduct(orgId: string, description: string): Promise<{ productId: string; name: string; unit?: string } | null> {
  const name = clean(description)
  if (!name) return null
  const f = buildSearchFilter(name, ['name', 'sku'], { lowered: { name: 'nameLower', sku: 'skuLower' } })
  const p: any = await Product.findOne({ orgId, isActive: true, ...f }).lean()
  return p ? { productId: String(p._id), name: p.name, unit: p.unit } : null
}

function toAddress(a: any) {
  return {
    street: clean(a?.street) || '-',
    city: clean(a?.city) || '-',
    postalCode: clean(a?.postalCode) || '-',
    country: clean(a?.country) || 'BG',
  }
}

/** Create a DRAFT purchase bill from an extraction, matching supplier + products. */
export async function createDraftBill(orgId: string, userId: string, draft: DraftResult, warehouseId: string, batchId: string) {
  const r = getRepos()
  const ext = draft.extraction
  const supplier = await matchSupplier(orgId, ext.supplier || {})
  const wh: any = await Warehouse.findOne({ orgId, _id: warehouseId }).lean()
  const billingAddress = toAddress(wh?.address)

  const lines: any[] = []
  const perLine: { description: string; matched: boolean; productId: string | null }[] = []
  for (const li of ext.line_items || []) {
    const desc = clean(li.description)
    if (!desc) continue
    const match = await matchProduct(orgId, desc)
    const qty = num(li.quantity)
    const price = num(li.unit_price)
    const taxRate = li.vat_rate != null ? num(li.vat_rate) : 20
    const lineTotal = li.total != null ? num(li.total) : +(qty * price).toFixed(2)
    const taxAmount = +((lineTotal * taxRate) / 100).toFixed(2)
    lines.push({
      productId: match?.productId,
      description: desc,
      quantity: qty,
      unit: match?.unit || clean(li.unit) || 'бр',
      unitPrice: price,
      discount: 0,
      taxRate,
      taxAmount,
      lineTotal,
      // Stock only moves for matched lines (need product + warehouse).
      warehouseId: match ? warehouseId : undefined,
    })
    perLine.push({ description: desc, matched: !!match, productId: match?.productId || null })
  }

  const subtotal = ext.net_total != null ? num(ext.net_total) : +lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2)
  const taxTotal = ext.vat_total != null ? num(ext.vat_total) : +lines.reduce((s, l) => s + l.taxAmount, 0).toFixed(2)
  const total = ext.gross_total != null ? num(ext.gross_total) : +(subtotal + taxTotal).toFixed(2)
  const currency = clean(ext.currency) || 'BGN'
  const exchangeRate = ext.exchange_rate != null ? num(ext.exchange_rate, 1) : 1
  const issueDate = ext.issue_date ? new Date(ext.issue_date) : new Date()
  const dueDate = ext.due_date ? new Date(ext.due_date) : new Date(issueDate.getTime() + 30 * 86_400_000)
  const draftNumber = await getNextDraftInvoiceNumber(orgId, 'incoming', 'invoice')

  const tags = ['ocr-import', `ocr:${batchId}`]
  if (draft.validation?.status === 'needs_review') tags.push('needs-review')

  const bill: any = await r.invoices.create({
    orgId,
    type: 'invoice',
    direction: 'incoming',
    contactId: supplier?.contactId,
    invoiceNumber: draftNumber,
    draftNumber,
    reference: clean(ext.document_number) || undefined,
    issueDate,
    dueDate,
    currency,
    exchangeRate,
    lines,
    subtotal,
    discountTotal: 0,
    taxTotal,
    total,
    totalBase: +(total * exchangeRate).toFixed(2),
    amountDue: total,
    amountPaid: 0,
    notes: clean(ext.notes) || undefined,
    billingAddress,
    status: 'draft',
    statusHistory: [{ status: 'draft', changedAt: new Date(), changedBy: userId, reason: 'ocr_import' }],
    numberHistory: draftNumber ? [{ number: draftNumber, allocatedAt: new Date(), status: 'draft' }] : [],
    createdBy: userId,
    tags,
  } as any)

  return { bill, supplier, perLine }
}

/** Convert a draft bill → received, allocating the issued BILL number and moving stock. */
export async function receiveBill(orgId: string, invoiceId: string, userId: string): Promise<{ ok: boolean; invoiceNumber?: string; error?: string }> {
  const r = getRepos()
  const invoice: any = await r.invoices.findOne({ id: invoiceId, orgId } as any)
  if (!invoice) return { ok: false, error: 'not found' }
  if (invoice.direction !== 'incoming') return { ok: false, error: 'not an incoming bill' }
  if (invoice.status !== 'draft') return { ok: false, error: 'not in draft status' }

  const draftNumber = invoice.invoiceNumber
  const issuedNumber = await getNextInvoiceNumber(orgId, 'incoming', invoice.type)
  const statusHistory = [...(invoice.statusHistory || []), { status: 'received', fromStatus: invoice.status, changedAt: new Date(), changedBy: userId }]
  const numberHistory = [...(invoice.numberHistory || []), { number: issuedNumber, allocatedAt: new Date(), status: 'received' }]
  const updated = await r.invoices.update(invoiceId, {
    status: 'received',
    sentAt: new Date(),
    statusHistory,
    invoiceNumber: issuedNumber,
    draftNumber,
    numberHistory,
  } as any)

  await createInvoiceStockMovement(updated || invoice, userId)
  createAuditEntry({
    orgId, userId, action: 'receive', module: 'invoicing', entityType: 'invoice',
    entityId: invoiceId, entityName: issuedNumber, changes: { invoiceNumber: { from: draftNumber, to: issuedNumber } },
  })
  return { ok: true, invoiceNumber: issuedNumber }
}
