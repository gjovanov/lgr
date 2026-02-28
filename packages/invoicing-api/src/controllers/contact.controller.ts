import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Contact } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const contactController = new Elysia({ prefix: '/org/:orgId/invoicing/contact' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type

    const result = await paginateQuery(Contact, filter, query)
    return { contacts: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const contact = await Contact.create({ ...body, orgId })
      return { contact: contact.toJSON() }
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

    const contact = await Contact.findOne({ _id: id, orgId }).lean().exec()
    if (!contact) return status(404, { message: 'Contact not found' })

    return { contact }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const contact = await Contact.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!contact) return status(404, { message: 'Contact not found' })

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
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const contact = await Contact.findOneAndDelete({ _id: id, orgId }).exec()
    if (!contact) return status(404, { message: 'Contact not found' })

    return { message: 'Contact deleted' }
  }, { isSignIn: true })
