import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Invoice, Contact, Org } from 'db/models'
import { generateInvoicingListXLSX, type InvoiceExportRow } from 'reporting/excel/invoicing-list.excel'
import { generateInvoicingListPDF } from 'reporting/pdf/invoicing-list.pdf'
import { generateInvoicingSingleXLSX } from 'reporting/excel/invoicing-single.excel'
import { generateInvoicePDF, HEADER_NOTE_MAX } from 'reporting/pdf/invoice.pdf'
import { generateCompanionDocPDF, type CompanionDocData } from 'reporting/pdf/companion-doc.pdf'
import { generateCompanionDocXLSX } from 'reporting/excel/companion-doc.excel'
import { docTitleFor, exportI18n } from 'reporting/i18n'
import { sourceDocLabel } from 'reporting/companion-doc.i18n'
import { getNextCompanionNumber, companionNumberField, buildPaymentMethodFilter, type CompanionDocKind } from './invoice.controller.js'
import { canExport, canWrite } from '../lib/export-access.js'

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

// Doc types that share the merged sales/purchase grids (FR-01) and may be exported together.
const MERGEABLE_TYPES = new Set(['invoice', 'credit_note', 'debit_note'])

function buildFilter(orgId: string, q: Record<string, any>): Record<string, any> {
  const f: Record<string, any> = { orgId }
  const docType = q.docType || 'invoice'
  if (docType === 'bill') {
    f.type = 'invoice'
    f.direction = 'incoming'
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

async function toExportRows(invoices: any[]): Promise<InvoiceExportRow[]> {
  // Batch-load contacts
  const contactIds = new Set<string>()
  for (const inv of invoices) if (inv.contactId) contactIds.add(String(inv.contactId))
  const contacts = contactIds.size
    ? await Contact.find({ _id: { $in: [...contactIds] } }).lean()
    : []
  const cmap = new Map(contacts.map((c: any) => [String(c._id), c]))

  return invoices.map((inv: any) => {
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

// ── Companion documents (Декларация за съответствие / Приемо-предавателен протокол) ──

const COMPANION_KINDS = new Set<CompanionDocKind>(['certificate', 'ppprotocol'])

/** Only outgoing documents get companion prints — on an incoming bill we are the recipient. */
function companionAllowed(invoice: any): boolean {
  return invoice?.direction === 'outgoing'
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
    footerText: orgFooterLine(org),
    // Same letterhead the invoice form prints; the generator falls back to the bundled asset.
    logo: (org as any)?.logo,
    locale,
  }
}

/**
 * Page-foot issuer line: who issued the document. The e-mail is deliberately left out —
 * the printed forms carry the company, phone and site only. The software credit is a
 * separate line, printed by the generators (see `reporting/product-credit`).
 */
function orgFooterLine(org: any): string {
  return [
    org?.name,
    org?.phone ? `тел.: ${org.phone}` : '',
    org?.website,
  ].filter(Boolean).join('   ')
}

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
      // Default sort matches usePaginatedTable defaults → createdAt desc. Accept explicit
      // overrides from the caller so the export row order mirrors what the user sees on screen.
      const sortBy = ((body as any).sortBy as string) || 'createdAt'
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
            logo: (org as any)?.logo,
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
        filter.type = 'cash_sale'
        title = i18n.docTitle.cash_sale
      } else {
        return status(400, { message: `Unknown kind: ${kind}` })
      }

      if (b.startDate || b.endDate) {
        filter.issueDate = {} as any
        if (b.startDate) filter.issueDate.$gte = new Date(b.startDate)
        if (b.endDate) filter.issueDate.$lte = new Date(b.endDate)
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

      const sortBy = (b.sortBy as string) || 'createdAt'
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
            logo: (org as any)?.logo,
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

      // ── Companion document branch (?doc=certificate|ppprotocol) ──
      const doc = query.doc as string | undefined
      if (doc && doc !== 'document') {
        if (!COMPANION_KINDS.has(doc as CompanionDocKind)) {
          return status(400, { message: `Unknown companion document: ${doc}` })
        }
        const kind = doc as CompanionDocKind
        if (!companionAllowed(invoice)) {
          return status(400, { message: 'Companion documents are only available for outgoing documents' })
        }
        // Allocating the number mutates the invoice, so a read-only role (nra_auditor) may only
        // reprint a companion whose number already exists.
        const existingNumber = (invoice as any)[companionNumberField(kind)]
        if (!existingNumber && !canWrite(user)) {
          return status(403, { message: 'Issuing a new companion document number requires write permission' })
        }

        const number = await ensureCompanionNumber(orgId, invoice, kind)
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
        const [row] = await toExportRows([invoice])
        const buffer = await generateInvoicingSingleXLSX(row, mode, columns, locale)
        set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        set.headers['content-disposition'] = `attachment; filename="${filename}"`
        return new Response(buffer)
      } else {
        const contact = (invoice as any).contactId
          ? await Contact.findById((invoice as any).contactId).lean()
          : null
        const org = await Org.findById(orgId).lean()
        // The note belongs to the document: a caller-supplied one is stored on the invoice (so
        // every later copy carries it), and a print that supplies none reprints what is stored.
        const supplied = query.note === undefined ? undefined : String(query.note).trim().slice(0, HEADER_NOTE_MAX)
        const stored = ((invoice as any).printNote as string | undefined) || ''
        if (supplied !== undefined && supplied !== stored && canWrite(user)) {
          await Invoice.updateOne({ _id: id, orgId }, { $set: { printNote: supplied } })
        }
        try {
          // The invoice form reads the letterhead off the org record it is given.
          const buffer = await generateInvoicePDF(invoice as any, org as any, (contact as any) || {}, columns, {
            locale,
            footerText: orgFooterLine(org),
            headerNote: supplied ?? stored,
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
    { isSignIn: true },
  )
