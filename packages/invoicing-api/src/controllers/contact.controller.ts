import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { lookupCompany } from 'services/biz/company-lookup.service'

async function upsertTags(orgId: string, type: string, tags?: string[]) {
  if (!tags?.length) return
  const r = getRepos()
  for (const value of tags) {
    const existing = await r.tags.findOne({ orgId, type, value } as any)
    if (!existing) await r.tags.create({ orgId, type, value } as any)
  }
}

export const contactController = new Elysia({ prefix: '/org/:orgId/invoicing/contact' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
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

      const contact = await r.contacts.create({ ...body, orgId } as any)
      await upsertTags(orgId, 'contact', body.tags)
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
        email: t.Optional(t.String({ format: 'email' })),
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
          type: t.String(),
          street: t.String(),
          street2: t.Optional(t.String()),
          city: t.String(),
          state: t.Optional(t.String()),
          postalCode: t.String(),
          country: t.String(),
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
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.contacts.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Contact not found' })

      const contact = await r.contacts.update(id, body as any)
      await upsertTags(orgId, 'contact', body.tags)

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
        email: t.Optional(t.String({ format: 'email' })),
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
          type: t.String(),
          street: t.String(),
          street2: t.Optional(t.String()),
          city: t.String(),
          state: t.Optional(t.String()),
          postalCode: t.String(),
          country: t.String(),
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
    if (!company.isValid) return status(404, { message: 'Company not found' })
    return { company }
  }, { isSignIn: true })
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.contacts.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Contact not found' })

    await r.contacts.delete(id)
    return { message: 'Contact deleted' }
  }, { isSignIn: true })
