import { seesBills } from 'services/biz/access/partition'
import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { lookupCompany } from 'services/biz/company-lookup.service'
import { moneySign } from 'services/biz/money-sign'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'
import { pickerContacts } from 'services/biz/contact-picker.service'
import { Invoice, StockMovement } from 'db/models'
import { cleanContactAliases, MAX_CONTACT_ALIASES, MAX_CONTACT_ALIAS_LENGTH } from 'config/contact-aliases'
import { QUOTE_TYPES } from 'config/constants'

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

/**
 * A contact's other names („Also known as", FR-28.12). The bounds only keep a careless client from storing a
 * document's worth of text; what is stored is `cleanContactAliases` of what came.
 */
const otherNames = t.Optional(t.Array(
  t.String({ maxLength: MAX_CONTACT_ALIAS_LENGTH }),
  { maxItems: MAX_CONTACT_ALIASES, error: `Expected at most ${MAX_CONTACT_ALIASES} other names, each up to ${MAX_CONTACT_ALIAS_LENGTH} characters` },
))

/** The statuses in which a document still owes. */
const OWING_STATUSES = ['sent', 'partially_paid', 'overdue', 'received'] as const

/** The most rows the Open Balance list sends. Its count and its total are always of them all. */
export const UNPAID_LIST_MAX = 500

/**
 * The contact's documents that still owe: what the contact form's Open Balance button sums, and what the list
 * behind it shows. One reader, so the figure on the button and the rows under it cannot disagree.
 */
function owingDocuments(orgId: string, contactId: string, user: unknown, fields: string) {
  // FR-26.6: without `purchases` the contact's bills are no part of what they are shown.
  const side = seesBills(user as any) ? {} : { direction: 'outgoing' }
  return Invoice.find({
    orgId,
    contactId,
    ...side,
    status: { $in: [...OWING_STATUSES] },
    // An issued quote (a proforma, an offer) is `sent` and owes nothing (FR-22.22).
    type: { $nin: [...QUOTE_TYPES] },
  } as any).select(fields).lean()
}

/** A document's stored amount as it counts in a sum (#447): a credit note's is owed TO the contact. */
const signed = (inv: any, amount: unknown): number => moneySign(inv.type) * (Number(amount) || 0)

/** What a document still owes, signed. */
function owedBy(inv: any): number {
  return signed(inv, inv.amountDue ?? (inv.total - (inv.amountPaid || 0)))
}

/** What the documents owe together, in their one currency; no figure when they are in several. */
function openBalanceOf(docs: any[]): { openBalance: number | null; currency: string | null; mixedCurrency: boolean } {
  let sum = 0
  let mixedCurrency = false
  let currency: string | null = null
  for (const inv of docs) {
    sum += owedBy(inv)
    const c = inv.currency || null
    if (currency == null) currency = c
    else if (c && c !== currency) mixedCurrency = true
  }
  return { openBalance: mixedCurrency ? null : +sum.toFixed(2), currency: mixedCurrency ? null : currency, mixedCurrency }
}

export const contactController = new Elysia({ prefix: '/org/:orgId/invoicing/contact' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      // `aliases`: a contact is found by its other names too („Also known as"), in the list and in every picker.
      const searchFilter = buildSearchFilter(query.search as string, ['companyName', 'aliases', 'firstName', 'lastName', 'email', 'phone', 'taxId', 'vatNumber'], {
        lowered: {
          companyName: 'companyNameLower',
          aliases: 'aliasesLower',
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

      // An empty email means none: store nothing rather than ''. The same for other names: none, no field.
      const { email, aliases, ...rest } = body
      const names = cleanContactAliases(aliases, rest.companyName)
      const contact = await r.contacts.create({ ...rest, ...(email ? { email } : {}), ...(names.length ? { aliases: names } : {}), orgId } as any)
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
        aliases: otherNames,
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
    // FR-26.6: without `purchases` the contact's bills are no part of what they are shown.
    const side = seesBills(user as any) ? {} : { direction: 'outgoing' }

    const [documents, receipts, unpaid, movementCount] = await Promise.all([
      // FR-23: the two counts, not a `$ne` on the type, which would fetch every document the contact has.
      Invoice.countDocuments({ orgId, contactId: id, ...side } as any),
      Invoice.countDocuments({ orgId, type: { $in: ['payment_receipt', 'payment_storno'] }, contactId: id, ...side } as any),
      owingDocuments(orgId, id, user, 'type amountDue total amountPaid currency'),
      StockMovement.countDocuments({ orgId, contactId: id } as any),
    ])

    return { invoiceCount: documents - receipts, ...openBalanceOf(unpaid), movementCount }
  }, { isSignIn: true })
  // The documents behind the Open Balance button, each with what it still owes: the summary's own reader, so the
  // rows add up to the button's figure. The longest due first.
  .get('/:id/unpaid', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const time = (d: unknown) => (d ? new Date(d as any).getTime() : 0)
    const owing = (await owingDocuments(orgId, id, user, 'type direction invoiceNumber issueDate dueDate status total amountDue amountPaid currency'))
      .map((inv: any) => ({ inv, due: +owedBy(inv).toFixed(2) }))
      // Issued, with nothing left to pay (a document of 0): it owes nothing, and adds nothing to the sum.
      .filter(d => d.due !== 0)
      .sort((a, b) => time(a.inv.dueDate ?? a.inv.issueDate) - time(b.inv.dueDate ?? b.inv.issueDate))

    return {
      documents: owing.slice(0, UNPAID_LIST_MAX).map(({ inv, due }) => ({
        _id: String(inv._id),
        type: inv.type,
        direction: inv.direction,
        invoiceNumber: inv.invoiceNumber,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        status: inv.status,
        currency: inv.currency,
        // Signed like `due`, so a row reads total − paid = due whatever its type.
        total: +signed(inv, inv.total).toFixed(2),
        amountPaid: +signed(inv, inv.amountPaid).toFixed(2),
        due,
      })),
      count: owing.length,
      ...openBalanceOf(owing.map(d => d.inv)),
    }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.contacts.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Contact not found' })

      // Other names are stored cleaned, against the name the contact will have after this save. A body that does
      // not carry them leaves them as they are; an empty list clears them.
      const names = body.aliases === undefined ? undefined : cleanContactAliases(body.aliases, body.companyName ?? (existing as any).companyName)
      const contact = await r.contacts.updateInOrg(id, orgId, { ...body, ...(names ? { aliases: names } : {}) } as any)
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
        aliases: otherNames,
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
