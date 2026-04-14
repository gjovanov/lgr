import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Invoice, Contact, Org } from 'db/models'
import { generateInvoicingListXLSX, type InvoiceExportRow } from 'reporting/excel/invoicing-list.excel'
import { generateInvoicingListPDF } from 'reporting/pdf/invoicing-list.pdf'
import { generateInvoicingSingleXLSX } from 'reporting/excel/invoicing-single.excel'
import { generateInvoicePDF } from 'reporting/pdf/invoice.pdf'

const MAX_ROWS = 1000

// Human-readable title per doc type.
const DOC_TITLES: Record<string, string> = {
  invoice: 'Invoices',
  proforma: 'Proforma Invoices',
  credit_note: 'Credit Notes',
  debit_note: 'Debit Notes',
  cash_sale: 'Cash Sales',
  bill: 'Supplier Bills',
}

function titleFor(docType: string, direction?: string): string {
  if (docType === 'invoice' && direction === 'incoming') return DOC_TITLES.bill
  return DOC_TITLES[docType] || 'Documents'
}

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
  if (q.status) f.status = q.status
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

function checkPerm(user: any): boolean {
  const perms: string[] = user?.permissions || []
  return perms.includes('trade.read') || perms.includes('trade.write') || user?.role === 'admin'
}

export const invoiceExportController = new Elysia({ prefix: '/org/:orgId/invoicing/export' })
  .use(AppAuthService)

  // List export: POST so complex filters fit comfortably
  .post(
    '/list',
    async ({ params: { orgId }, body, user, status, set }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!checkPerm(user)) return status(403, { message: 'Forbidden' })

      const filter = buildFilter(orgId, body as any)
      const invoices = await Invoice.find(filter).sort({ issueDate: -1 }).limit(MAX_ROWS).lean()
      if (invoices.length === 0) return status(404, { message: 'No documents match the filter' })

      const rows = await toExportRows(invoices)
      const docType = (body as any).docType || 'invoice'
      const direction = (body as any).direction
      const title = titleFor(docType, direction)
      const mode = ((body as any).mode as 'compact' | 'detailed') || 'compact'
      const format = ((body as any).format as 'xlsx' | 'pdf') || 'xlsx'
      const filename = `${docType}-${mode}-${new Date().toISOString().split('T')[0]}.${format}`

      if (format === 'xlsx') {
        const buffer = await generateInvoicingListXLSX({ title, mode, rows })
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
        format: t.Union([t.Literal('xlsx'), t.Literal('pdf')]),
        mode: t.Union([t.Literal('compact'), t.Literal('detailed')]),
        status: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        tags: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        startDate: t.Optional(t.String()),
        endDate: t.Optional(t.String()),
      }),
    },
  )

  // Single-object export
  .get(
    '/:id',
    async ({ params: { orgId, id }, query, user, status, set }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!checkPerm(user)) return status(403, { message: 'Forbidden' })

      const invoice = await Invoice.findOne({ _id: id, orgId }).lean()
      if (!invoice) return status(404, { message: 'Document not found' })

      const format = (query.format as string) || 'pdf'
      const mode = ((query.mode as string) || 'detailed') as 'compact' | 'detailed'
      const filename = `${(invoice as any).invoiceNumber}.${format}`

      if (format === 'xlsx') {
        const [row] = await toExportRows([invoice])
        const buffer = await generateInvoicingSingleXLSX(row, mode)
        set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        set.headers['content-disposition'] = `attachment; filename="${filename}"`
        return new Response(buffer)
      } else {
        const contact = (invoice as any).contactId
          ? await Contact.findById((invoice as any).contactId).lean()
          : null
        const org = await Org.findById(orgId).lean()
        try {
          const buffer = await generateInvoicePDF(invoice as any, org as any, (contact as any) || {})
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
