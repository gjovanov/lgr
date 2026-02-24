import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Invoice, Contact } from 'db/models'

export const invoiceController = new Elysia({ prefix: '/org/:orgId/invoices' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type
    if (query.direction) filter.direction = query.direction
    if (query.status) filter.status = query.status
    if (query.contactId) filter.contactId = query.contactId
    if (query.startDate || query.endDate) {
      filter.issueDate = {}
      if (query.startDate) filter.issueDate.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.issueDate.$lte = new Date(query.endDate as string)
    }

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      Invoice.find(filter).sort({ issueDate: -1 }).skip(skip).limit(pageSize).exec(),
      Invoice.countDocuments(filter).exec(),
    ])

    return { invoices: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      // Auto-generate invoice number
      const lastInvoice = await Invoice.findOne({ orgId, direction: body.direction })
        .sort({ createdAt: -1 })
        .exec()
      const prefix = body.direction === 'outgoing' ? 'INV' : 'BILL'
      const seq = lastInvoice
        ? Number(lastInvoice.invoiceNumber.replace(/\D/g, '')) + 1
        : 1
      const invoiceNumber = `${prefix}-${String(seq).padStart(6, '0')}`

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

      const invoice = await Invoice.create({
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
      })

      return { invoice: invoice.toJSON() }
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
        })),
        subtotal: t.Number(),
        discountTotal: t.Optional(t.Number()),
        taxTotal: t.Optional(t.Number()),
        taxAmount: t.Optional(t.Number()),
        total: t.Number(),
        totalBase: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
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

    const invoice = await Invoice.findOne({ _id: id, orgId })
      .populate('contactId', 'companyName firstName lastName email')
      .lean()
      .exec()
    if (!invoice) return status(404, { message: 'Invoice not found' })

    return { invoice }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const existing = await Invoice.findOne({ _id: id, orgId }).exec()
      if (!existing) return status(404, { message: 'Invoice not found' })
      if (existing.status !== 'draft') return status(400, { message: 'Can only edit draft invoices' })

      const updated = await Invoice.findByIdAndUpdate(id, body, { new: true }).lean().exec()
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
        }))),
        subtotal: t.Optional(t.Number()),
        discountTotal: t.Optional(t.Number()),
        taxTotal: t.Optional(t.Number()),
        taxAmount: t.Optional(t.Number()),
        total: t.Optional(t.Number()),
        totalBase: t.Optional(t.Number()),
        amountDue: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
        terms: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const invoice = await Invoice.findOne({ _id: id, orgId }).exec()
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (invoice.status !== 'draft') return status(400, { message: 'Can only delete draft invoices' })

    await Invoice.findByIdAndDelete(id).exec()
    return { message: 'Invoice deleted' }
  }, { isSignIn: true })
  .post('/:id/send', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const invoice = await Invoice.findOne({ _id: id, orgId }).exec()
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (invoice.status !== 'draft') return status(400, { message: 'Invoice is not in draft status' })

    invoice.status = 'sent'
    invoice.sentAt = new Date()
    await invoice.save()

    return { invoice: invoice.toJSON() }
  }, { isSignIn: true })
  .post(
    '/:id/payments',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const invoice = await Invoice.findOne({ _id: id, orgId }).exec()
      if (!invoice) return status(404, { message: 'Invoice not found' })
      if (['voided', 'cancelled', 'paid'].includes(invoice.status))
        return status(400, { message: 'Cannot record payment on this invoice' })

      invoice.payments.push({
        date: new Date(body.date),
        amount: body.amount,
        method: body.method,
        reference: body.reference,
      } as any)

      invoice.amountPaid += body.amount
      invoice.amountDue = invoice.total - invoice.amountPaid

      if (invoice.amountDue <= 0) {
        invoice.status = 'paid'
        invoice.paidAt = new Date()
      } else {
        invoice.status = 'partially_paid'
      }

      await invoice.save()
      return { invoice: invoice.toJSON() }
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
