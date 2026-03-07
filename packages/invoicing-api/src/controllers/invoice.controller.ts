import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createInvoiceStockMovement, reverseInvoiceStockMovement } from 'services/biz/invoicing.service'

async function upsertTags(orgId: string, type: string, tags?: string[]) {
  if (!tags?.length) return
  const r = getRepos()
  for (const value of tags) {
    const existing = await r.tags.findOne({ orgId, type, value } as any)
    if (!existing) await r.tags.create({ orgId, type, value } as any)
  }
}

async function getNextInvoiceNumber(orgId: string, direction: string): Promise<string> {
  const r = getRepos()
  const prefix = direction === 'outgoing' ? 'INV' : 'BILL'
  const lastInvoices = await r.invoices.findMany(
    { orgId, direction } as any,
    { createdAt: -1 },
  )
  const lastInvoice = lastInvoices.length > 0 ? lastInvoices[0] : null
  const seq = lastInvoice
    ? Number(lastInvoice.invoiceNumber.replace(/\D/g, '')) + 1
    : 1
  return `${prefix}-${String(seq).padStart(6, '0')}`
}

export const invoiceController = new Elysia({ prefix: '/org/:orgId/invoices' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type
    if (query.direction) filter.direction = query.direction
    if (query.status) filter.status = query.status
    if (query.contactId) filter.contactId = query.contactId
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }
    if (query.startDate || query.endDate) {
      filter.issueDate = {}
      if (query.startDate) filter.issueDate.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.issueDate.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'issueDate'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.invoices.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Manual batch lookups to replace .populate()
    const contactIds = new Set<string>()
    const relatedInvoiceIds = new Set<string>()
    for (const item of result.items) {
      if (item.contactId) contactIds.add(item.contactId)
      if ((item as any).convertedInvoiceId) relatedInvoiceIds.add((item as any).convertedInvoiceId)
      if ((item as any).proformaId) relatedInvoiceIds.add((item as any).proformaId)
      if ((item as any).relatedInvoiceId) relatedInvoiceIds.add((item as any).relatedInvoiceId)
    }

    const [contacts, relatedInvoices] = await Promise.all([
      contactIds.size > 0 ? r.contacts.findMany({ id: { $in: [...contactIds] } } as any) : [],
      relatedInvoiceIds.size > 0 ? r.invoices.findMany({ id: { $in: [...relatedInvoiceIds] } } as any) : [],
    ])

    const contactMap = new Map(contacts.map(c => [c.id, c]))
    const invoiceMap = new Map(relatedInvoices.map(i => [i.id, i]))

    const invoices = result.items.map((item: any) => {
      const contact = item.contactId ? contactMap.get(item.contactId) : null
      const convertedInv = item.convertedInvoiceId ? invoiceMap.get(item.convertedInvoiceId) : null
      const proformaInv = item.proformaId ? invoiceMap.get(item.proformaId) : null
      const relatedInv = item.relatedInvoiceId ? invoiceMap.get(item.relatedInvoiceId) : null
      return {
        ...item,
        number: item.invoiceNumber,
        contactName: contact
          ? ((contact as any).companyName || [(contact as any).firstName, (contact as any).lastName].filter(Boolean).join(' ') || '')
          : '',
        convertedInvoiceNumber: convertedInv?.invoiceNumber || '',
        proformaNumber: proformaInv?.invoiceNumber || '',
        relatedInvoiceNumber: relatedInv?.invoiceNumber || '',
      }
    })
    return { invoices, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // Auto-generate invoice number
      const invoiceNumber = await getNextInvoiceNumber(orgId, body.direction)

      // Compute defaults for fields the form may not provide
      const lines = (body.lines || []).map((l: any) => {
        const subtotal = l.quantity * l.unitPrice
        const disc = subtotal * ((l.discount || 0) / 100)
        const taxAmt = (subtotal - disc) * ((l.taxRate || 0) / 100)
        return {
          ...l,
          unit: l.unit || 'pcs',
          description: l.description || '',
          taxAmount: l.taxAmount ?? taxAmt,
          lineTotal: l.lineTotal ?? (subtotal - disc + taxAmt),
        }
      })

      const taxTotal = body.taxTotal ?? body.taxAmount ?? lines.reduce((s: number, l: any) => s + (l.taxAmount || 0), 0)
      const exchangeRate = body.exchangeRate || 1
      const dueDate = body.dueDate || body.issueDate

      const invoice = await r.invoices.create({
        ...body,
        lines,
        dueDate,
        invoiceNumber,
        orgId,
        status: 'draft',
        taxTotal,
        totalBase: body.totalBase ?? +(body.total * exchangeRate).toFixed(2),
        billingAddress: body.billingAddress || { street: '-', city: '-', postalCode: '-', country: '-' },
        amountDue: body.total,
        createdBy: user.id,
      } as any)
      await upsertTags(orgId, 'invoice', body.tags)

      return { invoice }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.Union([
          t.Literal('invoice'),
          t.Literal('proforma'),
          t.Literal('credit_note'),
          t.Literal('debit_note'),
        ]),
        direction: t.Union([t.Literal('outgoing'), t.Literal('incoming')]),
        contactId: t.String(),
        issueDate: t.String(),
        dueDate: t.Optional(t.String()),
        currency: t.String(),
        exchangeRate: t.Optional(t.Number()),
        reference: t.Optional(t.String()),
        footer: t.Optional(t.String()),
        lines: t.Array(t.Object({
          productId: t.Optional(t.String()),
          product: t.Optional(t.String()),
          description: t.Optional(t.String()),
          quantity: t.Number(),
          unit: t.Optional(t.String()),
          unitPrice: t.Number(),
          discount: t.Optional(t.Number()),
          taxRate: t.Optional(t.Number()),
          taxAmount: t.Optional(t.Number()),
          lineTotal: t.Optional(t.Number()),
          accountId: t.Optional(t.String()),
          warehouseId: t.Optional(t.String()),
        })),
        subtotal: t.Number(),
        discountTotal: t.Optional(t.Number()),
        taxTotal: t.Optional(t.Number()),
        taxAmount: t.Optional(t.Number()),
        total: t.Number(),
        totalBase: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        terms: t.Optional(t.String()),
        billingAddress: t.Optional(t.Object({
          street: t.String(),
          city: t.String(),
          state: t.Optional(t.String()),
          postalCode: t.String(),
          country: t.String(),
        })),
        shippingAddress: t.Optional(t.Object({
          street: t.String(),
          city: t.String(),
          state: t.Optional(t.String()),
          postalCode: t.String(),
          country: t.String(),
        })),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })

    // Manual lookup for contact
    let contact = null
    if (invoice.contactId) {
      contact = await r.contacts.findById(invoice.contactId)
    }

    return {
      invoice: {
        ...invoice,
        contactId: contact ? { _id: contact.id, id: contact.id, companyName: (contact as any).companyName, firstName: (contact as any).firstName, lastName: (contact as any).lastName, email: (contact as any).email } : invoice.contactId,
      },
    }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.invoices.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Invoice not found' })
      if (existing.status !== 'draft') return status(400, { message: 'Can only edit draft invoices' })

      const updated = await r.invoices.update(id, body as any)
      return { invoice: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        contactId: t.Optional(t.String()),
        issueDate: t.Optional(t.String()),
        dueDate: t.Optional(t.String()),
        currency: t.Optional(t.String()),
        exchangeRate: t.Optional(t.Number()),
        reference: t.Optional(t.String()),
        footer: t.Optional(t.String()),
        lines: t.Optional(t.Array(t.Object({
          productId: t.Optional(t.String()),
          product: t.Optional(t.String()),
          description: t.Optional(t.String()),
          quantity: t.Number(),
          unit: t.Optional(t.String()),
          unitPrice: t.Number(),
          discount: t.Optional(t.Number()),
          taxRate: t.Optional(t.Number()),
          taxAmount: t.Optional(t.Number()),
          lineTotal: t.Optional(t.Number()),
          warehouseId: t.Optional(t.String()),
        }))),
        subtotal: t.Optional(t.Number()),
        discountTotal: t.Optional(t.Number()),
        taxTotal: t.Optional(t.Number()),
        taxAmount: t.Optional(t.Number()),
        total: t.Optional(t.Number()),
        totalBase: t.Optional(t.Number()),
        amountDue: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        terms: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.invoices.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Invoice not found' })
    if (existing.status !== 'draft') return status(400, { message: 'Can only delete draft invoices' })

    await r.invoices.delete(id)
    return { message: 'Invoice deleted' }
  }, { isSignIn: true })
  .post('/:id/send', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (invoice.status !== 'draft') return status(400, { message: 'Invoice is not in draft status' })

    const newStatus = invoice.direction === 'incoming' ? 'received' : 'sent'
    const updated = await r.invoices.update(id, { status: newStatus, sentAt: new Date() } as any)

    await createInvoiceStockMovement(updated || invoice, user.id)

    return { invoice: updated }
  }, { isSignIn: true })
  .post('/:id/receive', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (invoice.direction !== 'incoming') return status(400, { message: 'Only incoming invoices can be received' })
    if (invoice.status !== 'draft') return status(400, { message: 'Invoice is not in draft status' })

    const updated = await r.invoices.update(id, { status: 'received', sentAt: new Date() } as any)

    await createInvoiceStockMovement(updated || invoice, user.id)

    return { invoice: updated }
  }, { isSignIn: true })
  .post(
    '/:id/payments',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const invoice = await r.invoices.findOne({ id, orgId } as any)
      if (!invoice) return status(404, { message: 'Invoice not found' })
      if (['voided', 'cancelled', 'paid'].includes(invoice.status))
        return status(400, { message: 'Cannot record payment on this invoice' })

      const payments = [...(invoice.payments || []), {
        date: new Date(body.date),
        amount: body.amount,
        method: body.method,
        reference: body.reference,
      }]

      const amountPaid = (invoice.amountPaid || 0) + body.amount
      const amountDue = invoice.total - amountPaid
      const newStatus = amountDue <= 0 ? 'paid' : 'partially_paid'
      const paidAt = amountDue <= 0 ? new Date() : invoice.paidAt

      const updated = await r.invoices.update(id, {
        payments,
        amountPaid,
        amountDue,
        status: newStatus,
        paidAt,
      } as any)

      return { invoice: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        date: t.String(),
        amount: t.Number({ minimum: 0.01 }),
        method: t.Union([
          t.Literal('cash'),
          t.Literal('bank_transfer'),
          t.Literal('card'),
          t.Literal('check'),
          t.Literal('other'),
        ]),
        reference: t.Optional(t.String()),
        bankAccountId: t.Optional(t.String()),
      }),
    },
  )
  .post('/:id/void', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (!['draft', 'sent'].includes(invoice.status))
      return status(400, { message: 'Can only void draft or sent invoices' })

    const updated = await r.invoices.update(id, { status: 'voided', voidedAt: new Date() } as any)

    await reverseInvoiceStockMovement(updated || invoice, user.id)

    return { invoice: updated }
  }, { isSignIn: true })
  .post('/:id/convert', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const proforma = await r.invoices.findOne({ id, orgId } as any)
    if (!proforma) return status(404, { message: 'Invoice not found' })
    if (proforma.type !== 'proforma')
      return status(400, { message: 'Only proforma invoices can be converted' })
    if (proforma.status === 'converted')
      return status(400, { message: 'Proforma is already converted' })

    // Auto-generate invoice number
    const invoiceNumber = await getNextInvoiceNumber(orgId, proforma.direction)

    const invoice = await r.invoices.create({
      orgId,
      type: 'invoice',
      direction: proforma.direction,
      contactId: proforma.contactId,
      invoiceNumber,
      issueDate: new Date(),
      dueDate: proforma.dueDate,
      currency: proforma.currency,
      exchangeRate: proforma.exchangeRate,
      reference: proforma.reference,
      lines: proforma.lines,
      subtotal: proforma.subtotal,
      discountTotal: proforma.discountTotal,
      taxTotal: proforma.taxTotal,
      total: proforma.total,
      totalBase: proforma.totalBase,
      amountDue: proforma.total,
      notes: proforma.notes,
      terms: proforma.terms,
      footer: proforma.footer,
      billingAddress: proforma.billingAddress,
      shippingAddress: proforma.shippingAddress,
      proformaId: proforma.id,
      status: 'draft',
      createdBy: user.id,
    } as any)

    await r.invoices.update(proforma.id, { status: 'converted', convertedInvoiceId: invoice.id } as any)

    return { invoice }
  }, { isSignIn: true })
