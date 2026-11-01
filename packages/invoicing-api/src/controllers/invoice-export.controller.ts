import { Elysia, t } from 'elysia'
import { assertHomeIsHere, HomeElsewhereError } from 'db/home/home'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Invoice, Contact, Org, Product } from 'db/models'
import { generateInvoicingListXLSX, type InvoiceExportRow } from 'reporting/excel/invoicing-list.excel'
import { generateInvoicingListPDF } from 'reporting/pdf/invoicing-list.pdf'
import { generateCashAggXLSX, CASH_AGG_KEYS, type CashAggRow, type CashAggSection } from 'reporting/excel/cash-agg.excel'
import { generateCashAggPDF } from 'reporting/pdf/cash-agg.pdf'
import { generateInvoicingSingleXLSX } from 'reporting/excel/invoicing-single.excel'
import { generateInvoicePDF, HEADER_NOTE_MAX } from 'reporting/pdf/invoice.pdf'
import { generateCompanionDocPDF, type CompanionDocData } from 'reporting/pdf/companion-doc.pdf'
import { generateCompanionDocXLSX } from 'reporting/excel/companion-doc.excel'
import { generateStockReceiptPDF, type StockReceiptData } from 'reporting/pdf/stock-receipt.pdf'
import { billStockReceiptSections, isSupplierBill, RELEASED_BILL_STATUSES, stockReceiptCurrency } from 'services/biz/bill-stock-receipt.service'
import { docTitleFor, exportI18n } from 'reporting/i18n'
import { sourceDocLabel } from 'reporting/companion-doc.i18n'
import { getNextCompanionNumber, companionNumberField, buildPaymentMethodFilter, invoiceSortField, type CompanionDocKind } from './invoice.controller.js'
import { canExport, canWrite } from '../lib/export-access.js'
import { emailRequestBlock, isValidRecipient, RESEND_WINDOW_MS } from '../lib/email-guards.js'
import { getOrgLogoDataUri } from 'services/biz/org-logo.service'
import { orgFooterLine, renderInvoicePdf } from '../lib/invoice-pdf.js'
import { sendEmail } from 'services/biz/email.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { EmailLog } from 'db/models'
import { BULGARIAN_TIME_ZONE, localDayWindow } from 'services/biz/local-day'

const MAX_ROWS = 1000

// Columns allowed in the export request. Kept in sync with useExportColumns.ts.
// Unknown keys are rejected with 400 to catch drift early.
const ALLOWED_COLUMN_KEYS = new Set([
  'number', 'type', 'issueDate', 'dueDate', 'contactName', 'contactTaxId', 'status', 'currency',
  'subtotal', 'taxTotal', 'total', 'amountPaid', 'amountDue', 'reference', 'paymentMethod',
  'lineNo', 'description', 'quantity', 'unit', 'unitPrice', 'discount', 'taxRate', 'lineTotal',
])

const ALLOWED_SORT_FIELDS = new Set([
  'createdAt', 'updatedAt', 'issueDate', 'dueDate', 'invoiceNumber', 'total', 'status', 'amountDue',
])

function isAllowedSortField(key: string): boolean {
  return ALLOWED_SORT_FIELDS.has(key)
}

class ColumnValidationError extends Error {}

function normaliseColumns(raw: any): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  // Accept "a,b,c" string form from GET query param too.
  const arr = typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw
  if (!Array.isArray(arr)) throw new ColumnValidationError('columns must be an array of strings')
  const invalid: string[] = []
  for (const c of arr) {
    if (typeof c !== 'string' || !ALLOWED_COLUMN_KEYS.has(c)) invalid.push(String(c))
  }
  if (invalid.length) throw new ColumnValidationError(`Unknown column keys: ${invalid.join(', ')}`)
  return arr as string[]
}

// Human-readable title per doc type, locale-aware (delegates to reporting/i18n).
function titleFor(docType: string, direction: string | undefined, locale?: string): string {
  return docTitleFor(docType, direction, locale)
}

// ── FR-10 (#19): emailing an outgoing document ──

// The recipient pattern, the resend window and the whole gate live in lib/email-guards.ts —
// pure and unit-tested, because Elysia's `handle()` does not route under `bun test` here.

const EMAIL_BODY_I18N: Record<string, { greeting: string; attached: string; regards: string; date: string; total: string }> = {
  en: { greeting: 'Hello,', attached: 'Please find attached', regards: 'Kind regards,', date: 'Date', total: 'Total' },
  bg: { greeting: 'Здравейте,', attached: 'Прикачено ще намерите', regards: 'С уважение,', date: 'Дата', total: 'Общо' },
  de: { greeting: 'Guten Tag,', attached: 'Anbei finden Sie', regards: 'Mit freundlichen Grüßen,', date: 'Datum', total: 'Gesamt' },
  mk: { greeting: 'Здраво,', attached: 'Во прилог ќе најдете', regards: 'Со почит,', date: 'Датум', total: 'Вкупно' },
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A deliberately minimal covering note — the document itself is the attachment. No new
 * templating engine enters the codebase for four paragraphs of text.
 */
function buildEmailHtml(opts: {
  title: string
  invoice: any
  orgName: string
  message?: string
  locale?: string
}): string {
  const L = EMAIL_BODY_I18N[(opts.locale || 'en').slice(0, 2)] || EMAIL_BODY_I18N.en
  const inv = opts.invoice
  const issued = inv.issueDate ? new Date(inv.issueDate).toISOString().slice(0, 10) : ''
  const total = `${Number(inv.total || 0).toFixed(2)} ${esc(inv.currency || '')}`.trim()

  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">',
    `<p>${esc(L.greeting)}</p>`,
    `<p>${esc(L.attached)} <strong>${esc(opts.title)} ${esc(inv.invoiceNumber)}</strong>.</p>`,
    opts.message ? `<p>${esc(opts.message).replace(/\n/g, '<br>')}</p>` : '',
    '<table style="border-collapse:collapse;margin:12px 0">',
    issued ? `<tr><td style="padding:2px 12px 2px 0;color:#666">${esc(L.date)}</td><td>${esc(issued)}</td></tr>` : '',
    `<tr><td style="padding:2px 12px 2px 0;color:#666">${esc(L.total)}</td><td><strong>${total}</strong></td></tr>`,
    '</table>',
    `<p>${esc(L.regards)}<br>${esc(opts.orgName)}</p>`,
    '</div>',
  ].filter(Boolean).join('\n')
}

// Doc types that share the merged sales/purchase grids (FR-01) and may be exported together.
const MERGEABLE_TYPES = new Set(['invoice', 'credit_note', 'debit_note'])

function buildFilter(orgId: string, q: Record<string, any>): Record<string, any> {
  const f: Record<string, any> = { orgId }
  const docType = q.docType || 'invoice'
  if (docType === 'bill') {
    f.type = 'invoice'
    f.direction = 'incoming'
  } else if (docType === 'cash_sale') {
    // The cash register: its sales and their stornos, which count against them (FR-21.9).
    f.type = { $in: ['cash_sale', 'cash_storno'] }
  } else {
    f.type = docType
    if (docType === 'invoice') f.direction = q.direction || 'outgoing'
  }
  // `types` narrows/expands within the merged grids: only meaningful for the invoice/bill
  // docTypes, whose direction is already pinned above. Junk values → 400 (drift catcher).
  if (q.types && (docType === 'invoice' || docType === 'bill')) {
    const list = String(q.types).split(',').map((s: string) => s.trim()).filter(Boolean)
    const invalid = list.filter((t: string) => !MERGEABLE_TYPES.has(t))
    if (invalid.length) throw new ColumnValidationError(`Unknown doc types: ${invalid.join(', ')}`)
    if (list.length === 1) f.type = list[0]
    else if (list.length > 1) f.type = { $in: list }
  }
  if (q.status) {
    // Same CSV convention the list endpoint uses ("draft,sent" from the status multiselect).
    const list = String(q.status).split(',').map((s: string) => s.trim()).filter(Boolean)
    if (list.length === 1) f.status = list[0]
    else if (list.length > 1) f.status = { $in: list }
  }
  if (q.contactId) f.contactId = q.contactId
  if (q.tags) {
    const tagList = Array.isArray(q.tags) ? q.tags : String(q.tags).split(',')
    f.tags = { $in: tagList }
  }
  if (q.startDate || q.endDate) {
    f.issueDate = {} as any
    if (q.startDate) f.issueDate.$gte = new Date(q.startDate)
    if (q.endDate) f.issueDate.$lte = new Date(q.endDate)
  }
  return f
}

/** A storno's amounts with its sign: what it takes back, as a negative row. */
function negatedStorno(inv: any): any {
  const neg = (n: unknown) => (Number(n) ? -Number(n) : 0)
  return {
    ...inv,
    subtotal: neg(inv.subtotal),
    taxTotal: neg(inv.taxTotal),
    total: neg(inv.total),
    amountPaid: neg(inv.amountPaid),
    amountDue: neg(inv.amountDue),
    payments: (inv.payments || []).map((p: any) => ({ ...p, amount: neg(p.amount) })),
    lines: (inv.lines || []).map((l: any) => ({ ...l, quantity: neg(l.quantity), lineTotal: neg(l.lineTotal) })),
  }
}

/**
 * `signStornos` (on by default) turns a storno negative, for a register that sums it against its
 * sale. A storno exported on its own keeps its own amounts, as its PDF and its receipt print them.
 */
async function toExportRows(invoices: any[], opts: { signStornos?: boolean } = {}): Promise<InvoiceExportRow[]> {
  const signStornos = opts.signStornos ?? true
  // Batch-load contacts
  const contactIds = new Set<string>()
  for (const inv of invoices) if (inv.contactId) contactIds.add(String(inv.contactId))
  const contacts = contactIds.size
    ? await Contact.find({ _id: { $in: [...contactIds] } }).lean()
    : []
  const cmap = new Map(contacts.map((c: any) => [String(c._id), c]))

  return invoices.map((raw: any) => {
    // A cash-sale storno is stored positive and gives its sale back: it exports negative (FR-21.9).
    const inv = raw.type === 'cash_storno' && signStornos ? negatedStorno(raw) : raw
    const c = inv.contactId ? cmap.get(String(inv.contactId)) : null
    const contactName = c
      ? ((c as any).companyName || [(c as any).firstName, (c as any).lastName].filter(Boolean).join(' '))
      : ''

    // Collapse payments[] by method for the aggregate footer. Cash sales that never recorded a
    // payment still count as cash (method inferred from `status === 'paid'` + no payment rows).
    const paymentsByMethod: Record<string, number> = {}
    for (const p of (inv.payments || [])) {
      const m = (p as any).method || 'other'
      paymentsByMethod[m] = (paymentsByMethod[m] || 0) + Number((p as any).amount || 0)
    }
    if (inv.type === 'cash_sale' && !Object.keys(paymentsByMethod).length && (inv.amountPaid || 0) > 0) {
      paymentsByMethod.cash = (paymentsByMethod.cash || 0) + (inv.amountPaid || 0)
    }

    return {
      invoiceNumber: inv.invoiceNumber,
      type: inv.type,
      direction: inv.direction,
      status: inv.status,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      contactName,
      contactTaxId: (c as any)?.taxId || '',
      currency: inv.currency,
      subtotal: inv.subtotal,
      taxTotal: inv.taxTotal,
      total: inv.total,
      amountPaid: inv.amountPaid,
      amountDue: inv.amountDue,
      reference: inv.reference,
      notes: inv.notes,
      paymentsByMethod,
      // Methods actually used, in payment order; falls back to the header-level
      // `paymentMethod` for documents recorded without payment rows.
      paymentMethod: Object.keys(paymentsByMethod).join(',') || inv.paymentMethod || '',
      lines: (inv.lines || []).map((l: any) => ({
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        discount: l.discount,
        taxRate: l.taxRate,
        lineTotal: l.lineTotal,
      })),
    }
  })
}

// ── FR-03 (#10): aggregated cash-register export — one row per product ──

const CASH_AGG_COLUMN_KEYS = new Set(CASH_AGG_KEYS)
/** Doc cap for the pivot. Far above MAX_ROWS: truncating the input would silently
 * understate the per-product sums, which is worse than a slower export. */
const CASH_AGG_DOC_CAP = 5000

function normaliseAggColumns(raw: any): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const arr = typeof raw === 'string' ? raw.split(',').map((s: string) => s.trim()).filter(Boolean) : raw
  if (!Array.isArray(arr)) throw new ColumnValidationError('columns must be an array of strings')
  const invalid = arr.filter((c: any) => typeof c !== 'string' || !CASH_AGG_COLUMN_KEYS.has(c))
  if (invalid.length) throw new ColumnValidationError(`Unknown column keys: ${invalid.join(', ')}`)
  return arr as string[]
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Pivot the matching cash sales into per-product rows, sectioned by currency (summing
 * across currencies would be a wrong number). VAT is Σ line taxAmount — never recomputed
 * from the summed net — so the totals reconcile with the per-document export to the cent.
 * ProductId-less legacy lines group by description+unit.
 */
export async function aggregateCashSales(filter: Record<string, any>): Promise<{ sections: CashAggSection[]; docCount: number }> {
  const docs: any[] = await Invoice.find(filter, { lines: 1, currency: 1, type: 1, status: 1 }).limit(CASH_AGG_DOC_CAP).lean()

  type Acc = CashAggRow & { productId?: string }
  const byCurrency = new Map<string, Map<string, Acc>>()
  for (const doc of docs) {
    // A voided document sold nothing and gave nothing back: a voided storno is a refund whose
    // receipt failed (FR-21.9 counts paid documents only).
    if (doc.status === 'voided') continue
    const currency = doc.currency || ''
    // A storno takes its goods and money back (FR-21.9); it is stored positive.
    const sign = doc.type === 'cash_storno' ? -1 : 1
    let group = byCurrency.get(currency)
    if (!group) { group = new Map(); byCurrency.set(currency, group) }
    for (const l of doc.lines || []) {
      const key = l.productId ? `p:${l.productId}` : `t:${(l.description || '').trim().toLowerCase()}|${l.unit || ''}`
      let acc = group.get(key)
      if (!acc) {
        acc = {
          productId: l.productId ? String(l.productId) : undefined,
          productName: l.description || '',
          unit: l.unit || '',
          totalQuantity: 0, avgUnitPrice: 0, netTotal: 0, taxTotal: 0, grossTotal: 0,
        }
        group.set(key, acc)
      }
      const gross = sign * (Number(l.lineTotal) || 0)
      const tax = sign * (Number(l.taxAmount) || 0)
      acc.totalQuantity += sign * (Number(l.quantity) || 0)
      acc.grossTotal += gross
      acc.taxTotal += tax
      acc.netTotal += gross - tax
    }
  }

  const ids = new Set<string>()
  for (const g of byCurrency.values()) for (const a of g.values()) if (a.productId) ids.add(a.productId)
  const products: any[] = ids.size
    ? await Product.find({ _id: { $in: [...ids] } }, { sku: 1, name: 1, unit: 1 }).lean()
    : []
  const pmap = new Map(products.map((p: any) => [String(p._id), p]))

  const sections: CashAggSection[] = [...byCurrency.entries()]
    .map(([currency, group]) => ({
      currency,
      rows: [...group.values()]
        .map((a) => {
          const p = a.productId ? pmap.get(a.productId) : undefined
          const net = round2(a.netTotal)
          return {
            productName: p?.name || a.productName,
            sku: p?.sku || '',
            unit: a.unit || p?.unit || '',
            totalQuantity: round2(a.totalQuantity),
            avgUnitPrice: a.totalQuantity ? round2(net / a.totalQuantity) : 0,
            netTotal: net,
            taxTotal: round2(a.taxTotal),
            grossTotal: round2(a.grossTotal),
          }
        })
        .sort((x, y) => x.productName.localeCompare(y.productName, 'bg')),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
  return { sections, docCount: docs.filter((d) => d.status !== 'voided').length }
}

/** Shared response builder for both aggregated endpoints. Returns a Response or an error. */
async function cashAggResponse(
  orgId: string,
  filter: Record<string, any>,
  b: any,
  set: any,
): Promise<Response | { error: { code: 400 | 503; message: string; detail?: string } }> {
  let columns: string[] | undefined
  try {
    columns = normaliseAggColumns(b.columns)
  } catch (e: any) {
    return { error: { code: 400, message: e.message } }
  }
  const { sections } = await aggregateCashSales(filter)
  const locale = (b.locale as string) || 'en'
  const title = exportI18n(locale).docTitle.cash_aggregated
  const format = (b.format as 'xlsx' | 'pdf') || 'xlsx'
  // Empty result → header-only file (matching /kind semantics): an empty period is an
  // answer, not an error.
  const filename = `cash-register-aggregated-${new Date().toISOString().split('T')[0]}.${format}`

  if (format === 'xlsx') {
    const buffer = await generateCashAggXLSX({ title, sections, columns, locale })
    set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    set.headers['content-disposition'] = `attachment; filename="${filename}"`
    return new Response(buffer)
  }
  const org = await Org.findById(orgId).lean()
  try {
    const buffer = await generateCashAggPDF({
      title,
      sections,
      columns,
      locale,
      orgName: (org as any)?.name || 'Organization',
      period: { from: b.startDate, to: b.endDate },
      footerText: orgFooterLine(org),
      logo: (await getOrgLogoDataUri(orgId)) ?? (org as any)?.logo,
    })
    if (!buffer) return { error: { code: 503, message: 'PDF renderer unavailable' } }
    set.headers['content-type'] = 'application/pdf'
    set.headers['content-disposition'] = `attachment; filename="${filename}"`
    return new Response(buffer)
  } catch (e: any) {
    return {
      error: {
        code: 503,
        message: 'PDF export is temporarily unavailable. Use Excel export or retry.',
        detail: e?.message?.slice(0, 300),
      },
    }
  }
}

// ── Companion documents (Декларация за съответствие / Приемо-предавателен протокол) ──

const COMPANION_KINDS = new Set<CompanionDocKind>(['certificate', 'ppprotocol'])

/**
 * Only outgoing documents get companion prints — on an incoming bill we are the recipient — and
 * never a storno or a payment's receipt: they deliver nothing to declare or hand over.
 */
function companionAllowed(invoice: any): boolean {
  return invoice?.direction === 'outgoing' && !['cash_storno', 'payment_receipt', 'payment_storno'].includes(invoice?.type)
}

/**
 * Return the companion document's number, allocating it on first print and persisting it on the
 * invoice so every later reprint carries the same number. The conditional filter makes a
 * concurrent double-print settle on one number rather than overwriting.
 */
async function ensureCompanionNumber(orgId: string, invoice: any, kind: CompanionDocKind): Promise<string> {
  const field = companionNumberField(kind)
  const existing = invoice[field]
  if (existing) return existing

  // FR-20.6: a number is allocated only at the org's home — printing on a mirror must never make
  // it a second allocator. Fresh, not cached: a move freezes the org first.
  await assertHomeIsHere(orgId, { fresh: true })
  const allocated = await getNextCompanionNumber(orgId, kind)
  const claimed = await Invoice.findOneAndUpdate(
    { _id: invoice._id, orgId, $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }] },
    { $set: { [field]: allocated } },
    { new: true, projection: { [field]: 1 } },
  ).lean()
  if (claimed && (claimed as any)[field]) return (claimed as any)[field]

  // Lost the race — another print already stored a number; use theirs and drop ours.
  const current = await Invoice.findById(invoice._id, { [field]: 1 }).lean()
  return (current as any)?.[field] || allocated
}

function partyFromContact(contact: any, invoice: any) {
  const addr = contact?.addresses?.find((a: any) => a.isDefault) || contact?.addresses?.[0] || invoice?.billingAddress
  const name = contact
    ? (contact.companyName || [contact.firstName, contact.lastName].filter(Boolean).join(' '))
    : ''
  return {
    name: name || '',
    city: addr?.city || '',
    address: [addr?.street, addr?.street2].filter(Boolean).join(' '),
    taxId: contact?.taxId || contact?.vatNumber || '',
  }
}

function partyFromOrg(org: any) {
  const addr = org?.addresses?.find((a: any) => a.isDefault) || org?.addresses?.[0]
  return {
    name: org?.name || '',
    city: addr?.city || '',
    address: addr?.street || '',
    taxId: org?.taxNumber || org?.vatNumber || '',
  }
}

async function buildCompanionData(
  orgId: string,
  invoice: any,
  kind: CompanionDocKind,
  locale: string,
  number: string,
): Promise<CompanionDocData> {
  const [contact, org] = await Promise.all([
    invoice.contactId ? Contact.findById(invoice.contactId).lean() : null,
    Org.findById(orgId).lean(),
  ])

  return {
    kind,
    number,
    date: invoice.issueDate,
    recipient: partyFromContact(contact, invoice),
    supplier: partyFromOrg(org),
    // Service lines (no product) still belong on a handover protocol, so nothing is filtered out.
    lines: (invoice.lines || []).map((l: any) => ({
      name: l.description,
      unit: l.unit || '',
      quantity: Number(l.quantity || 0),
    })),
    sourceDocs: [{
      label: sourceDocLabel(invoice.type, locale),
      number: invoice.invoiceNumber,
      date: invoice.issueDate,
    }],
    preparedBy: invoice.preparedBy || '',
    // Typed on the document, printed in the "Допълнителна информация" block of both companions.
    additionalInfo: invoice.companionNote || '',
    footerText: orgFooterLine(org),
    // Same letterhead the invoice form prints; the generator falls back to the bundled asset.
    logo: (await getOrgLogoDataUri(orgId)) ?? (org as any)?.logo,
    locale,
  }
}

// ── „Стокова разписка": the goods receipts a supplier bill booked ──

/** `?doc=` value of the stock receipt — checked before the companion branch, which refuses bills. */
const STOCK_RECEIPT_DOC = 'stock_receipt'

/**
 * The stock receipt of `bill`: one section per receipt it booked, the bill named by OUR number
 * and date (no supplier block, no supplier invoice number). `null` when it booked no goods.
 */
async function buildStockReceiptData(orgId: string, bill: any, locale: string): Promise<StockReceiptData | null> {
  const sections = await billStockReceiptSections(orgId, bill)
  if (!sections.length) return null
  const org = await Org.findById(orgId).lean()
  return {
    sections,
    bill: { number: bill.invoiceNumber, date: bill.issueDate, draft: bill.status === 'draft' },
    currency: stockReceiptCurrency(bill, (org as any)?.settings?.baseCurrency),
    footerText: orgFooterLine(org),
    // Same letterhead the invoice form prints; the generator falls back to the bundled asset.
    logo: (await getOrgLogoDataUri(orgId)) ?? (org as any)?.logo,
    locale,
  }
}

// `orgFooterLine` moved to lib/invoice-pdf.ts (FR-10) so the export and email paths share it.

export const invoiceExportController = new Elysia({ prefix: '/org/:orgId/invoicing/export' })
  .use(AppAuthService)

  // List export: POST so complex filters fit comfortably
  .post(
    '/list',
    async ({ params: { orgId }, body, user, status, set }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canExport(user)) return status(403, { message: 'Forbidden' })

      let filter: Record<string, any>
      try {
        filter = buildFilter(orgId, body as any)
      } catch (e: any) {
        if (e instanceof ColumnValidationError) return status(400, { message: e.message })
        throw e
      }

      // FR-03: per-product pivot for the cash register. Bypasses the row/mode machinery —
      // the pivot has its own column set and its own generators.
      if ((body as any).aggregated) {
        if ((body as any).docType !== 'cash_sale') {
          return status(400, { message: 'aggregated is only supported for cash-register exports' })
        }
        const res = await cashAggResponse(orgId, filter, body as any, set)
        if (res instanceof Response) return res
        return status(res.error.code, { message: res.error.message, ...(res.error.detail ? { detail: res.error.detail } : {}) })
      }

      // Default sort matches usePaginatedTable defaults → createdAt desc. Accept explicit
      // overrides from the caller so the export row order mirrors what the user sees on screen.
      // The grid's sort, № included (`number` is the column, `invoiceNumber` the field).
      const sortBy = invoiceSortField((body as any).sortBy)
      const sortOrder = ((body as any).sortOrder as string) === 'asc' ? 1 : -1
      if (!isAllowedSortField(sortBy)) return status(400, { message: `Invalid sortBy: ${sortBy}` })
      const invoices = await Invoice.find(filter).sort({ [sortBy]: sortOrder }).limit(MAX_ROWS).lean()
      if (invoices.length === 0) return status(404, { message: 'No documents match the filter' })

      const rows = await toExportRows(invoices)
      const docType = (body as any).docType || 'invoice'
      const direction = (body as any).direction
      const locale = ((body as any).locale as string) || 'en'
      const title = titleFor(docType, direction, locale)
      const mode = ((body as any).mode as 'compact' | 'detailed') || 'compact'
      const format = ((body as any).format as 'xlsx' | 'pdf') || 'xlsx'
      let columns: string[] | undefined
      try {
        columns = normaliseColumns((body as any).columns)
      } catch (e: any) {
        return status(400, { message: e.message })
      }
      const filename = `${docType}-${mode}-${new Date().toISOString().split('T')[0]}.${format}`

      if (format === 'xlsx') {
        const buffer = await generateInvoicingListXLSX({ title, mode, rows, columns, locale })
        set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        set.headers['content-disposition'] = `attachment; filename="${filename}"`
        return new Response(buffer)
      } else {
        const org = await Org.findById(orgId).lean()
        try {
          const buffer = await generateInvoicingListPDF({
            title,
            orgName: (org as any)?.name || 'Organization',
            mode,
            rows,
            columns,
            locale,
            period: { from: (body as any).startDate, to: (body as any).endDate },
            footerText: orgFooterLine(org),
            logo: (await getOrgLogoDataUri(orgId)) ?? (org as any)?.logo,
          })
          if (!buffer) return status(503, { message: 'PDF renderer unavailable' })
          set.headers['content-type'] = 'application/pdf'
          set.headers['content-disposition'] = `attachment; filename="${filename}"`
          return new Response(buffer)
        } catch (e: any) {
          return status(503, {
            message: 'PDF export is temporarily unavailable. Use Excel export or retry.',
            detail: e?.message?.slice(0, 300),
          })
        }
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        docType: t.Union([
          t.Literal('invoice'),
          t.Literal('proforma'),
          t.Literal('credit_note'),
          t.Literal('debit_note'),
          t.Literal('cash_sale'),
          t.Literal('bill'),
        ]),
        direction: t.Optional(t.Union([t.Literal('outgoing'), t.Literal('incoming')])),
        // CSV subset of invoice|credit_note|debit_note — narrows the merged grids' export.
        types: t.Optional(t.String()),
        format: t.Union([t.Literal('xlsx'), t.Literal('pdf')]),
        mode: t.Union([t.Literal('compact'), t.Literal('detailed')]),
        status: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        tags: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        startDate: t.Optional(t.String()),
        endDate: t.Optional(t.String()),
        sortBy: t.Optional(t.String()),
        sortOrder: t.Optional(t.Union([t.Literal('asc'), t.Literal('desc')])),
        columns: t.Optional(t.Array(t.String())),
        locale: t.Optional(t.String()),
        // FR-03: pivot to one row per product (cash_sale docType only).
        aggregated: t.Optional(t.Boolean()),
      }),
    },
  )

  // ── Reporting → Export (union across multiple docTypes) ──
  // kind=outgoing   → invoice + credit_note + debit_note (direction=outgoing)
  // kind=incoming   → bills (type=invoice, direction=incoming)
  // kind=cash_register → cash_sale
  // Empty result returns 200 with a header-only workbook (not 404) for better UX.
  .post(
    '/kind/:kind',
    async ({ params: { orgId, kind }, body, user, status, set }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canExport(user)) return status(403, { message: 'Forbidden' })

      const b = body as any
      if (b.startDate && b.endDate && new Date(b.startDate) > new Date(b.endDate)) {
        return status(400, { message: 'startDate must be ≤ endDate' })
      }

      const filter: Record<string, any> = { orgId }
      const locale = (b.locale as string) || 'en'
      const i18n = exportI18n(locale)
      let title: string
      if (kind === 'outgoing') {
        filter.type = { $in: ['invoice', 'credit_note', 'debit_note'] }
        filter.direction = 'outgoing'
        title = i18n.docTitle.documents
      } else if (kind === 'incoming') {
        // Bills + incoming credit/debit notes — the merged purchase side (FR-01).
        filter.type = { $in: ['invoice', 'credit_note', 'debit_note'] }
        filter.direction = 'incoming'
        title = i18n.docTitle.bill
      } else if (kind === 'cash_register') {
        // Its sales and their stornos, which count against them (FR-21.9).
        filter.type = { $in: ['cash_sale', 'cash_storno'] }
        title = i18n.docTitle.cash_sale
      } else {
        return status(400, { message: `Unknown kind: ${kind}` })
      }

      if (b.startDate || b.endDate) {
        // Till documents carry the moment of sale: their days are the org's, as on the grid.
        const window = kind === 'cash_register'
          ? localDayWindow(b.startDate, b.endDate, ((await Org.findById(orgId).lean()) as any)?.settings?.timezone || BULGARIAN_TIME_ZONE)
          : null
        if (window) filter.issueDate = window
        else {
          filter.issueDate = {} as any
          if (b.startDate) filter.issueDate.$gte = new Date(b.startDate)
          if (b.endDate) filter.issueDate.$lte = new Date(b.endDate)
        }
      }
      if (b.status) {
        const list = String(b.status).split(',').map(s => s.trim()).filter(Boolean)
        if (list.length === 1) filter.status = list[0]
        else if (list.length > 1) filter.status = { $in: list }
      }
      if (b.contactId) filter.contactId = b.contactId
      if (b.tags) {
        const tagList = Array.isArray(b.tags) ? b.tags : String(b.tags).split(',').map((s: string) => s.trim()).filter(Boolean)
        if (tagList.length) filter.tags = { $in: tagList }
      }
      if (b.paymentMethod) {
        // $and, not $or — the search branch below owns filter.$or.
        const cond = buildPaymentMethodFilter(b.paymentMethod)
        if (cond) (filter.$and ||= []).push(cond)
      }
      if (b.search) {
        const rx = new RegExp(String(b.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        filter.$or = [{ invoiceNumber: rx }, { reference: rx }, { notes: rx }]
      }

      // FR-03: per-product pivot for the cash-register tab.
      if (b.aggregated) {
        if (kind !== 'cash_register') {
          return status(400, { message: 'aggregated is only supported for the cash register export' })
        }
        const res = await cashAggResponse(orgId, filter, b, set)
        if (res instanceof Response) return res
        return status(res.error.code, { message: res.error.message, ...(res.error.detail ? { detail: res.error.detail } : {}) })
      }

      const sortBy = invoiceSortField(b.sortBy)
      const sortOrder = (b.sortOrder as string) === 'asc' ? 1 : -1
      if (!isAllowedSortField(sortBy)) return status(400, { message: `Invalid sortBy: ${sortBy}` })

      const invoices = await Invoice.find(filter).sort({ [sortBy]: sortOrder }).limit(MAX_ROWS).lean()
      const rows = await toExportRows(invoices)

      const mode = ((b.mode as 'compact' | 'detailed')) || 'compact'
      const format = ((b.format as 'xlsx' | 'pdf')) || 'xlsx'
      let columns: string[] | undefined
      try {
        columns = normaliseColumns(b.columns)
      } catch (e: any) {
        return status(400, { message: e.message })
      }
      const filename = `reporting-${kind}-${mode}-${new Date().toISOString().split('T')[0]}.${format}`

      if (format === 'xlsx') {
        const buffer = await generateInvoicingListXLSX({ title, mode, rows, columns, locale })
        set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        set.headers['content-disposition'] = `attachment; filename="${filename}"`
        return new Response(buffer)
      } else {
        const org = await Org.findById(orgId).lean()
        try {
          const buffer = await generateInvoicingListPDF({
            title,
            orgName: (org as any)?.name || 'Organization',
            mode,
            rows,
            columns,
            locale,
            period: { from: b.startDate, to: b.endDate },
            footerText: orgFooterLine(org),
            logo: (await getOrgLogoDataUri(orgId)) ?? (org as any)?.logo,
          })
          if (!buffer) return status(503, { message: 'PDF renderer unavailable' })
          set.headers['content-type'] = 'application/pdf'
          set.headers['content-disposition'] = `attachment; filename="${filename}"`
          return new Response(buffer)
        } catch (e: any) {
          return status(503, {
            message: 'PDF export is temporarily unavailable. Use Excel export or retry.',
            detail: e?.message?.slice(0, 300),
          })
        }
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        format: t.Union([t.Literal('xlsx'), t.Literal('pdf')]),
        mode: t.Union([t.Literal('compact'), t.Literal('detailed')]),
        status: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        startDate: t.Optional(t.String()),
        endDate: t.Optional(t.String()),
        sortBy: t.Optional(t.String()),
        sortOrder: t.Optional(t.Union([t.Literal('asc'), t.Literal('desc')])),
        columns: t.Optional(t.Array(t.String())),
        locale: t.Optional(t.String()),
        search: t.Optional(t.String()),
        tags: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        paymentMethod: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        // FR-03: pivot to one row per product (cash_register kind only).
        aggregated: t.Optional(t.Boolean()),
      }),
    },
  )

  // Single-object export
  .get(
    '/:id',
    async ({ params: { orgId, id }, query, user, status, set }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canExport(user)) return status(403, { message: 'Forbidden' })

      const invoice = await Invoice.findOne({ _id: id, orgId }).lean()
      if (!invoice) return status(404, { message: 'Document not found' })

      const format = (query.format as string) || 'pdf'
      const mode = ((query.mode as string) || 'detailed') as 'compact' | 'detailed'
      const locale = (query.locale as string) || 'en'
      let columns: string[] | undefined
      try {
        columns = normaliseColumns(query.columns)
      } catch (e: any) {
        return status(400, { message: e.message })
      }
      const filename = `${(invoice as any).invoiceNumber}.${format}`
      const doc = query.doc as string | undefined

      // ── „Стокова разписка" (?doc=stock_receipt): the goods a supplier bill booked ──
      if (doc === STOCK_RECEIPT_DOC) {
        const inv = invoice as any
        if (format !== 'pdf') return status(400, { message: 'A stock receipt prints as PDF only' })
        if (!isSupplierBill(inv)) {
          return status(422, { code: 'not_a_bill', message: 'A stock receipt is printed from a supplier bill' })
        }
        if (RELEASED_BILL_STATUSES.includes(inv.status)) {
          return status(422, { code: 'bill_voided', message: `${inv.invoiceNumber} is voided — the goods it booked are no longer its own` })
        }
        const data = await buildStockReceiptData(orgId, inv, locale)
        if (!data) {
          return status(404, { code: 'no_goods_booked', message: `${inv.invoiceNumber} has booked no goods — a stock receipt prints once they are received` })
        }
        try {
          const buffer = await generateStockReceiptPDF(data)
          if (!buffer) return status(503, { message: 'PDF renderer unavailable' })
          set.headers['content-type'] = 'application/pdf'
          set.headers['content-disposition'] = `attachment; filename="${inv.invoiceNumber}-stock-receipt.pdf"`
          return new Response(buffer)
        } catch (e: any) {
          return status(503, {
            message: 'PDF export is temporarily unavailable. Retry in a moment.',
            detail: e?.message?.slice(0, 300),
          })
        }
      }

      // ── Companion document branch (?doc=certificate|ppprotocol) ──
      if (doc && doc !== 'document') {
        if (!COMPANION_KINDS.has(doc as CompanionDocKind)) {
          return status(400, { message: `Unknown companion document: ${doc}` })
        }
        const kind = doc as CompanionDocKind
        if (!companionAllowed(invoice)) {
          return status(400, { message: 'Companion documents are only available for outgoing documents, never a storno' })
        }
        // Allocating the number mutates the invoice, so a read-only role (nra_auditor) may only
        // reprint a companion whose number already exists.
        const existingNumber = (invoice as any)[companionNumberField(kind)]
        if (!existingNumber && !canWrite(user)) {
          return status(403, { message: 'Issuing a new companion document number requires write permission' })
        }

        let number: string
        try {
          number = await ensureCompanionNumber(orgId, invoice, kind)
        } catch (e) {
          if (e instanceof HomeElsewhereError) {
            return status(409, { code: 'org_home_elsewhere', message: 'This document has no companion number yet, and numbers are issued only on the server that is this organization\'s home.' })
          }
          throw e
        }
        const data = await buildCompanionData(orgId, invoice, kind, locale, number)
        const companionFilename = `${(invoice as any).invoiceNumber}-${kind}.${format}`

        if (format === 'xlsx') {
          const buffer = await generateCompanionDocXLSX(data)
          set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          set.headers['content-disposition'] = `attachment; filename="${companionFilename}"`
          return new Response(buffer)
        }
        try {
          const buffer = await generateCompanionDocPDF(data)
          if (!buffer) return status(503, { message: 'PDF renderer unavailable' })
          set.headers['content-type'] = 'application/pdf'
          set.headers['content-disposition'] = `attachment; filename="${companionFilename}"`
          return new Response(buffer)
        } catch (e: any) {
          return status(503, {
            message: 'PDF export is temporarily unavailable. Use Excel export or retry.',
            detail: e?.message?.slice(0, 300),
          })
        }
      }

      if (format === 'xlsx') {
        const [row] = await toExportRows([invoice], { signStornos: false })
        const buffer = await generateInvoicingSingleXLSX(row, mode, columns, locale)
        set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        set.headers['content-disposition'] = `attachment; filename="${filename}"`
        return new Response(buffer)
      } else {
        // FR-10.1: the assembly moved to `lib/invoice-pdf.ts` verbatim, so Print and Email
        // produce the same bytes. Behaviour here is unchanged — including that only a
        // writer's supplied note is persisted.
        const rendered = await renderInvoicePdf(orgId, id, {
          locale,
          columns,
          note: query.note === undefined ? undefined : String(query.note),
          canPersistNote: canWrite(user),
        })
        if (!rendered.ok) {
          const detail = (rendered as any).detail
          return status(rendered.status, detail ? { message: rendered.message, detail } : { message: rendered.message })
        }
        set.headers['content-type'] = 'application/pdf'
        set.headers['content-disposition'] = `attachment; filename="${filename}"`
        return new Response(rendered.buffer)
      }
    },
    { isSignIn: true },
  )

  /**
   * FR-10.5 (#19) — email an outgoing document to the customer as a PDF attachment.
   *
   * Deliberately NOT called "send": `POST /invoices/:id/send` already means "issue the
   * document" (allocate a number, book stock). Overloading the word in a sibling route
   * would be a trap for every future reader.
   *
   * Sits on the export controller because it renders the very same PDF — via the shared
   * `renderInvoicePdf` helper, so the attachment is byte-identical to what Print produces.
   */
  .post(
    '/:id/email',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const b = body as any
      const to = String(b.to || '').trim()

      // The document is loaded before the gate so one call can answer every question. A
      // malformed address costs one indexed read; the ordering the caller sees is unchanged
      // (see `emailRequestBlock`, where the sequence is pinned by tests).
      const invoice = isValidRecipient(to) && canWrite(user)
        ? await Invoice.findOne({ _id: id, orgId }).lean()
        : null

      // FR-10.6 — double-click insurance, not a rate limiter. A FAILED previous attempt is
      // not a block: the failure is why the user is clicking again. One still QUEUED on a master
      // (FR-20.86) is a block: a second click would queue a second mail.
      const recent = invoice
        ? await EmailLog.findOne({
          orgId, entityType: 'invoice', entityId: id, to, status: { $in: ['sent', 'queued'] },
          createdAt: { $gte: new Date(Date.now() - RESEND_WINDOW_MS) },
        }).lean()
        : null

      const blocked = emailRequestBlock({ user, to, invoice, recentSend: !!recent })
      if (blocked) return status(blocked.status, { message: blocked.message })

      const inv = invoice as any

      let columns: string[] | undefined
      try {
        columns = normaliseColumns(b.columns)
      } catch (e: any) {
        return status(400, { message: e.message })
      }

      const locale = b.locale || 'en'
      const rendered = await renderInvoicePdf(orgId, id, {
        locale,
        columns,
        note: b.note,
        canPersistNote: true,
      })
      // Renderer down → nothing is sent and nothing is logged; the user retries.
      if (!rendered.ok) return status(rendered.status, { message: rendered.message })

      const org = await Org.findById(orgId).lean()
      const orgName = (org as any)?.name || ''
      const title = titleFor(inv.type, inv.direction, locale)
      const subject = String(b.subject || `${title} ${inv.invoiceNumber} — ${orgName}`).slice(0, 200)

      const result = await sendEmail({
        to,
        subject,
        html: buildEmailHtml({ title, invoice: inv, orgName, message: b.message, locale }),
        attachments: [{ filename: rendered.filename, content: rendered.buffer, type: 'application/pdf' }],
        creatorId: user.id,
        orgId,
        entityType: 'invoice',
        entityId: id,
      })

      if (!result.ok) {
        // Never a fake success: an unconfigured provider is an ops problem the user must see.
        if (result.reason === 'not_configured') {
          return status(503, { message: 'Email is not configured on this server' })
        }
        return status(502, { message: 'The mail provider rejected the message', detail: result.detail?.slice(0, 300) })
      }

      // FR-20.86: on a master the mail is queued for global to send. Its send history is updated
      // when it has gone (`relay/outbox-worker.ts`), and the user is told "queued", never "sent".
      if (result.queued) {
        createAuditEntry({
          orgId,
          userId: user.id,
          action: 'email',
          module: 'invoicing',
          entityType: 'invoice',
          entityId: id,
          entityName: inv.invoiceNumber,
        })
        return status(202, { sent: false, queued: true, to })
      }

      // Only a delivered mail updates the document's send history.
      await Invoice.updateOne(
        { _id: id, orgId },
        { $addToSet: { emailedTo: to }, $set: { lastEmailedAt: new Date() } },
      )

      createAuditEntry({
        orgId,
        userId: user.id,
        action: 'email',
        module: 'invoicing',
        entityType: 'invoice',
        entityId: id,
        entityName: inv.invoiceNumber,
      })

      return { sent: true, to }
    },
    {
      isSignIn: true,
      body: t.Object({
        to: t.String(),
        subject: t.Optional(t.String()),
        message: t.Optional(t.String()),
        locale: t.Optional(t.String()),
        note: t.Optional(t.String()),
        columns: t.Optional(t.Array(t.String())),
      }),
    },
  )
