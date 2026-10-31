import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { lookupCompany } from 'services/biz/company-lookup.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'
import { pickerContacts } from 'services/biz/contact-picker.service'
import { Invoice, StockMovement } from 'db/models'
import { NOT_PAYMENT_RECEIPT } from 'services/biz/sale-counting'

/**
 * Email is optional, and an empty box is how a form says "none". `format: 'email'` alone
 * rejects `''`, so every contact saved without an email used to answer 422 — read by users as
 * "email is required".
 *
 * The `error` text is what a rejected value is told: a union's own message is TypeBox's
 * "Expected union value", which says nothing about email.
 */
const optionalEmail = t.Optional(t.Union(
  [t.Literal(''), t.String({ format: 'email' })],
  { error: 'Expected a valid email address (or leave it empty)' },
))

export const contactController = new Elysia({ prefix: '/org/:orgId/invoicing/contact' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['companyName', 'firstName', 'lastName', 'email', 'phone', 'taxId', 'vatNumber'], {
        lowered: {
          companyName: 'companyNameLower',
          firstName: 'firstNameLower',
          lastName: 'lastNameLower',
          email: 'emailLower',
          taxId: 'taxIdLower',
          vatNumber: 'vatNumberLower',
        },
      })
      Object.assign(filter, searchFilter)
    }
    if (query.type) {
      // 'both' contacts act as customer AND supplier — include them in either filter
      filter.type = query.type === 'customer' || query.type === 'supplier'
        ? { $in: [query.type, 'both'] }
        : query.type
    }
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10

    // FR-22.25: a document's partner picker asks for its side first, by recent use. Opt-in, and
    // never when the caller sorts: the contacts list keeps its own columns' sort.
    const prefer = query.prefer === 'customer' || query.prefer === 'supplier' ? query.prefer : null
    if (prefer && !query.sortBy && size > 0) {
      const result = await pickerContacts(orgId, filter, prefer, page, size)
      return { contacts: result.items, ...result }
    }

    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : ((query.sortOrder as string) === 'asc' ? 1 : -1)

    const result = await r.contacts.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { contacts: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // An empty email means none: store nothing rather than ''.
      const { email, ...rest } = body
      const contact = await r.contacts.create({ ...rest, ...(email ? { email } : {}), orgId } as any)
      await upsertTags(orgId, 'contact', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'contact', entityId: contact.id, entityName: (contact as any).companyName || (contact as any).firstName })

      return { contact }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.Union([
          t.Literal('customer'),
          t.Literal('supplier'),
          t.Literal('both'),
        ]),
        companyName: t.Optional(t.String()),
        firstName: t.Optional(t.String()),
        lastName: t.Optional(t.String()),
        email: optionalEmail,
        phone: t.Optional(t.String()),
        mobile: t.Optional(t.String()),
        website: t.Optional(t.String()),
        taxId: t.Optional(t.String()),
        taxNumber: t.Optional(t.String()),
        vatNumber: t.Optional(t.String()),
        registrationNumber: t.Optional(t.String()),
        currency: t.Optional(t.String()),
        paymentTermsDays: t.Optional(t.Number()),
        creditLimit: t.Optional(t.Number()),
        discount: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        isActive: t.Optional(t.Boolean()),
        addresses: t.Optional(t.Array(t.Object({
          type: t.Optional(t.String()),
          street: t.Optional(t.String()),
          street2: t.Optional(t.String()),
          city: t.Optional(t.String()),
          state: t.Optional(t.String()),
          postalCode: t.Optional(t.String()),
          country: t.Optional(t.String()),
          isDefault: t.Optional(t.Boolean()),
        }))),
        bankDetails: t.Optional(t.Array(t.Object({
          bankName: t.String(),
          accountNumber: t.String(),
          iban: t.Optional(t.String()),
          swift: t.Optional(t.String()),
          currency: t.String(),
          isDefault: t.Optional(t.Boolean()),
        }))),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const contact = await r.contacts.findOne({ id, orgId } as any)
    if (!contact) return status(404, { message: 'Contact not found' })

    return { contact }
  }, { isSignIn: true })
  // Summary counts for Contact form smart buttons (Invoices / Open Balance / Movements)
  .get('/:id/summary', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const [invoiceCount, unpaid, movementCount] = await Promise.all([
      Invoice.countDocuments({ orgId, contactId: id, ...NOT_PAYMENT_RECEIPT } as any),
      Invoice.find({
        orgId,
        contactId: id,
        status: { $in: ['sent', 'partially_paid', 'overdue', 'received'] },
      } as any).select('amountDue total amountPaid currency').lean(),
      StockMovement.countDocuments({ orgId, contactId: id } as any),
    ])

    let openBalance = 0
    let mixedCurrency = false
    let currency: string | null = null
    for (const inv of unpaid) {
      const due = (inv as any).amountDue ?? ((inv as any).total - ((inv as any).amountPaid || 0))
      openBalance += Number(due) || 0
      const c = (inv as any).currency || null
      if (currency == null) currency = c
      else if (c && c !== currency) mixedCurrency = true
    }

    return {
      invoiceCount,
      openBalance: mixedCurrency ? null : +openBalance.toFixed(2),
      currency: mixedCurrency ? null : currency,
      mixedCurrency,
      movementCount,
    }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.contacts.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Contact not found' })

      const contact = await r.contacts.updateInOrg(id, orgId, body as any)
      await upsertTags(orgId, 'contact', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'contact', entityId: id, entityName: (contact as any).companyName || (contact as any).firstName, changes: diffChanges(existing as any, contact as any) })

      return { contact }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.Optional(t.Union([
          t.Literal('customer'),
          t.Literal('supplier'),
          t.Literal('both'),
        ])),
        companyName: t.Optional(t.String()),
        firstName: t.Optional(t.String()),
        lastName: t.Optional(t.String()),
        email: optionalEmail,
        phone: t.Optional(t.String()),
        mobile: t.Optional(t.String()),
        website: t.Optional(t.String()),
        taxId: t.Optional(t.String()),
        taxNumber: t.Optional(t.String()),
        vatNumber: t.Optional(t.String()),
        registrationNumber: t.Optional(t.String()),
        currency: t.Optional(t.String()),
        paymentTermsDays: t.Optional(t.Number()),
        creditLimit: t.Optional(t.Number()),
        discount: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        isActive: t.Optional(t.Boolean()),
        addresses: t.Optional(t.Array(t.Object({
          type: t.Optional(t.String()),
          street: t.Optional(t.String()),
          street2: t.Optional(t.String()),
          city: t.Optional(t.String()),
          state: t.Optional(t.String()),
          postalCode: t.Optional(t.String()),
          country: t.Optional(t.String()),
          isDefault: t.Optional(t.Boolean()),
        }))),
        bankDetails: t.Optional(t.Array(t.Object({
          bankName: t.String(),
          accountNumber: t.String(),
          iban: t.Optional(t.String()),
          swift: t.Optional(t.String()),
          currency: t.String(),
          isDefault: t.Optional(t.Boolean()),
        }))),
      }),
    },
  )
  .get('/lookup/:vatNumber', async ({ params: { vatNumber }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const company = await lookupCompany(vatNumber)
    if (!company.isValid && company.unavailable) {
      return status(503, { code: 'lookup_unavailable', message: 'EU VAT numbers cannot be checked on this server. A Bulgarian EIK still can be.' })
    }
    if (!company.isValid) return status(404, { message: 'Company not found' })
    return { company }
  }, { isSignIn: true })
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.contacts.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Contact not found' })

    await r.contacts.updateInOrg(id, orgId, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'invoicing', entityType: 'contact', entityId: id, entityName: (existing as any)?.companyName || (existing as any)?.firstName })

    return { message: 'Contact deactivated' }
  }, { isSignIn: true })
