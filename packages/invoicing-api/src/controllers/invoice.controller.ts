import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createInvoiceStockMovement, reverseInvoiceStockMovement, validateStockAvailability } from 'services/biz/invoicing.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'
import { eventBus } from 'services/events/event-bus'
import { getNextNumber } from 'services/biz/sequence.service'

// Prefix rendered on the invoice number. `invoice` resolves dynamically by direction.
const TYPE_PREFIX: Record<string, string> = {
  cash_sale: 'CS',
  proforma: 'PRF',
  credit_note: 'CRN',
  debit_note: 'DBN',
}

// Sequence counter key. INV/CRN/DBN share a single counter (SALES_DOC) so the sequence
// interleaves across those three types. PRF, CS, BILL get their own counters.
function sequenceKeyFor(type: string, direction: string): string {
  if (type === 'proforma') return 'PROFORMA'
  if (type === 'cash_sale') return 'CASH_SALE'
  if (type === 'invoice' && direction === 'incoming') return 'BILL'
  // invoice/outgoing, credit_note, debit_note → shared
  return 'SALES_DOC'
}

function prefixFor(type: string, direction: string): string {
  if (type === 'invoice') return direction === 'incoming' ? 'BILL' : 'INV'
  return TYPE_PREFIX[type] || 'INV'
}

function statusEntry(toStatus: string, fromStatus?: string, userId?: string, reason?: string) {
  return {
    status: toStatus,
    fromStatus,
    changedAt: new Date(),
    changedBy: userId,
    reason,
  }
}

// Produce a viewable history when legacy rows have no statusHistory yet, using
// the known status-change timestamps (createdAt, sentAt, paidAt). Read-only synthesis —
// does not persist.
function synthesizeStatusHistory(invoice: any): any[] {
  if (Array.isArray(invoice.statusHistory) && invoice.statusHistory.length > 0) {
    return invoice.statusHistory
  }
  const entries: any[] = []
  if (invoice.createdAt) {
    entries.push({ status: 'draft', changedAt: invoice.createdAt, reason: 'created (reconstructed)' })
  }
  if (invoice.sentAt) {
    const sentStatus = invoice.direction === 'incoming' ? 'received' : 'sent'
    entries.push({ status: sentStatus, fromStatus: 'draft', changedAt: invoice.sentAt, reason: 'reconstructed' })
  }
  if (invoice.paidAt && invoice.status === 'paid') {
    entries.push({ status: 'paid', changedAt: invoice.paidAt, reason: 'reconstructed' })
  }
  if (invoice.status && !entries.find(e => e.status === invoice.status)) {
    entries.push({ status: invoice.status, changedAt: invoice.updatedAt || invoice.createdAt, reason: 'reconstructed' })
  }
  return entries
}

async function getNextInvoiceNumber(orgId: string, direction: string, type?: string): Promise<string> {
  const t = type || 'invoice'
  const key = sequenceKeyFor(t, direction)
  const prefix = prefixFor(t, direction)
  const year = new Date().getFullYear()

  // Atomic $inc via SequenceService. Shared key → shared counter.
  // The counter value is formatted with the type-specific prefix (e.g. SALES_DOC=10 →
  // emitted as "INV-2026-00010" or "CRN-2026-00010" depending on the current type).
  const numberFromService = await getNextNumber(orgId, key, 5, year) // e.g. "SALES_DOC-2026-00010"
  const seqPart = numberFromService.split('-').pop()!
  return `${prefix}-${year}-${seqPart}`
}

export const invoiceController = new Elysia({ prefix: '/org/:orgId/invoices' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      // Two-stage search: search invoices by their fields + contacts by name
      const searchStr = query.search as string
      const invoiceFilter = buildSearchFilter(searchStr, ['invoiceNumber', 'notes', 'reference'])
      // Also find contacts matching the search
      const contactFilter = buildSearchFilter(searchStr, ['companyName', 'firstName', 'lastName'])
      const matchingContacts = await r.contacts.findMany({ orgId, ...contactFilter } as any)
      const contactIds = matchingContacts.map((c: any) => c.id || c._id)

      if (contactIds.length > 0 && invoiceFilter.$or) {
        // Combine: invoice fields match OR contactId in matching contacts
        filter.$or = [...invoiceFilter.$or, { contactId: { $in: contactIds } }]
      } else if (contactIds.length > 0 && invoiceFilter.$and) {
        filter.$or = [invoiceFilter, { contactId: { $in: contactIds } }]
      } else {
        Object.assign(filter, invoiceFilter)
      }
    }
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
    const sortBy = (query.sortBy as string) || 'createdAt'
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
        statusHistory: synthesizeStatusHistory(item),
      }
    })
    const { items: _raw, ...pagination } = result
    return { invoices, ...pagination }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // Sanitize empty string IDs to undefined
      if (!body.contactId) body.contactId = undefined

      // Auto-generate invoice number
      const invoiceNumber = await getNextInvoiceNumber(orgId, body.direction, body.type)

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

      const isCashSale = body.type === 'cash_sale'
      const initialStatus = isCashSale ? 'paid' : 'draft'
      const invoice = await r.invoices.create({
        ...body,
        lines,
        dueDate,
        invoiceNumber,
        orgId,
        direction: isCashSale ? 'outgoing' : body.direction,
        status: initialStatus,
        statusHistory: [statusEntry(initialStatus, undefined, user.id, isCashSale ? 'cash_sale_created' : 'created')],
        taxTotal,
        totalBase: body.totalBase ?? +(body.total * exchangeRate).toFixed(2),
        billingAddress: body.billingAddress || { street: '-', city: '-', postalCode: '-', country: '-' },
        amountPaid: isCashSale ? body.total : 0,
        amountDue: isCashSale ? 0 : body.total,
        paidAt: isCashSale ? new Date() : undefined,
        createdBy: user.id,
      } as any)
      await upsertTags(orgId, 'invoice', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: invoice.id, entityName: (invoice as any).invoiceNumber })

      // Cash sales trigger stock movement immediately
      if (isCashSale) {
        // Confirm pending transfers first (cross-warehouse)
        const pendingTransferIds = (body as any).pendingTransferIds as string[] | undefined
        if (pendingTransferIds?.length) {
          const { confirmTransferMovements } = await import('services/biz/stock-transfer.service')
          try {
            await confirmTransferMovements(pendingTransferIds)
            await r.invoices.update(invoice.id, { pendingTransferIds } as any)
          } catch (e: any) {
            await r.invoices.delete(invoice.id)
            return status(400, { message: `Transfer confirmation failed: ${e.message}` })
          }
        }

        try {
          await createInvoiceStockMovement(invoice, user.id)
        } catch (e: any) {
          // Roll back the cash sale if stock validation fails
          await r.invoices.delete(invoice.id)
          return status(400, { message: e.message })
        }
      }

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
          t.Literal('cash_sale'),
        ]),
        direction: t.Union([t.Literal('outgoing'), t.Literal('incoming')]),
        contactId: t.Optional(t.String()),
        issueDate: t.String(),
        dueDate: t.Optional(t.String()),
        currency: t.String(),
        exchangeRate: t.Optional(t.Number()),
        reference: t.Optional(t.String()),
        relatedInvoiceId: t.Optional(t.String()),
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
          priceExplanation: t.Optional(t.Array(t.Object({
            type: t.Union([t.Literal('base'), t.Literal('tag'), t.Literal('contact'), t.Literal('override')]),
            label: t.String(),
            price: t.Number(),
          }))),
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
        statusHistory: synthesizeStatusHistory(invoice),
        contactId: contact ? { _id: contact.id, id: contact.id, companyName: (contact as any).companyName, firstName: (contact as any).firstName, lastName: (contact as any).lastName, email: (contact as any).email } : invoice.contactId,
      },
    }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // Sanitize empty string IDs to undefined
      if (!body.contactId) body.contactId = undefined

      const existing = await r.invoices.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Invoice not found' })
      if (existing.status !== 'draft') return status(400, { message: 'Can only edit draft invoices' })

      const updated = await r.invoices.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (updated as any)?.invoiceNumber || (existing as any)?.invoiceNumber, changes: diffChanges(existing as any, updated as any) })

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
        relatedInvoiceId: t.Optional(t.String()),
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
          priceExplanation: t.Optional(t.Array(t.Object({
            type: t.Union([t.Literal('base'), t.Literal('tag'), t.Literal('contact'), t.Literal('override')]),
            label: t.String(),
            price: t.Number(),
          }))),
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

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (existing as any)?.invoiceNumber })

    return { message: 'Invoice deleted' }
  }, { isSignIn: true })
  .post('/:id/send', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (invoice.status !== 'draft') return status(400, { message: 'Invoice is not in draft status' })

    const newStatus = invoice.direction === 'incoming' ? 'received' : 'sent'

    // Confirm pending transfer movements before dispatch (cross-warehouse transfers)
    const pendingTransferIds = (body as any)?.pendingTransferIds as string[] | undefined
    if (pendingTransferIds?.length) {
      const { confirmTransferMovements } = await import('services/biz/stock-transfer.service')
      try {
        await confirmTransferMovements(pendingTransferIds)
      } catch (e: any) {
        return status(400, { message: `Transfer confirmation failed: ${e.message}` })
      }
    }

    try {
      await createInvoiceStockMovement(invoice, user.id)
    } catch (e: any) {
      return status(400, { message: e.message })
    }

    const history = [...((invoice as any).statusHistory || []), statusEntry(newStatus, invoice.status, user.id)]
    const updateData: any = { status: newStatus, sentAt: new Date(), statusHistory: history }
    if (pendingTransferIds?.length) updateData.pendingTransferIds = pendingTransferIds
    const updated = await r.invoices.update(id, updateData)

    createAuditEntry({ orgId, userId: user.id, action: 'send', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (invoice as any)?.invoiceNumber })

    // Emit for cross-module journal entry creation
    eventBus.emit('invoice.posted', {
      invoiceId: id,
      orgId,
      userId: user.id,
      direction: invoice.direction,
      total: invoice.total,
      contactId: invoice.contactId as string,
    })

    return { invoice: updated }
  }, { isSignIn: true })
  .post('/:id/receive', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (invoice.direction !== 'incoming') return status(400, { message: 'Only incoming invoices can be received' })
    if (invoice.status !== 'draft') return status(400, { message: 'Invoice is not in draft status' })

    const history = [...((invoice as any).statusHistory || []), statusEntry('received', invoice.status, user.id)]
    const updated = await r.invoices.update(id, { status: 'received', sentAt: new Date(), statusHistory: history } as any)

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

      const history = newStatus !== invoice.status
        ? [...((invoice as any).statusHistory || []), statusEntry(newStatus, invoice.status, user.id, `payment ${body.amount} ${body.method}`)]
        : ((invoice as any).statusHistory || [])

      const updated = await r.invoices.update(id, {
        payments,
        amountPaid,
        amountDue,
        status: newStatus,
        paidAt,
        statusHistory: history,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'record_payment', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (invoice as any)?.invoiceNumber })

      // Emit for cross-module journal entry creation
      eventBus.emit('payment.recorded', {
        invoiceId: id,
        orgId,
        userId: user.id,
        amount: body.amount,
        method: body.method,
        date: body.date,
      })

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

    try {
      await reverseInvoiceStockMovement(invoice, user.id)
    } catch (e: any) {
      return status(400, { message: e.message })
    }

    const history = [...((invoice as any).statusHistory || []), statusEntry('voided', invoice.status, user.id)]
    const updated = await r.invoices.update(id, { status: 'voided', voidedAt: new Date(), statusHistory: history } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'void', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (invoice as any)?.invoiceNumber })

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
      statusHistory: [statusEntry('draft', undefined, user.id, `converted_from_proforma ${proforma.invoiceNumber}`)],
      createdBy: user.id,
    } as any)

    const proformaHistory = [
      ...((proforma as any).statusHistory || []),
      statusEntry('converted', proforma.status, user.id, `converted_to ${invoice.invoiceNumber}`),
    ]
    await r.invoices.update(proforma.id, {
      status: 'converted',
      convertedInvoiceId: invoice.id,
      statusHistory: proformaHistory,
    } as any)

    return { invoice }
  }, { isSignIn: true })
