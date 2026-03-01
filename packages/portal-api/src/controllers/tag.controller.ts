import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { Tag, Product, Contact, Warehouse, Employee, Invoice, Lead, Deal } from 'db/models'

const modelMap: Record<string, any> = {
  product: Product,
  contact: Contact,
  warehouse: Warehouse,
  employee: Employee,
  invoice: Invoice,
  lead: Lead,
  deal: Deal,
}

export const tagController = new Elysia({ prefix: '/org/:orgId/tags' })
  .use(AuthService)

  // List / search tags
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type
    if (query.search) filter.value = { $regex: query.search, $options: 'i' }

    const tags = await Tag.find(filter).sort({ value: 1 }).lean().exec()
    return { tags }
  }, { isSignIn: true })

  // Create tag
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const existing = await Tag.findOne({ orgId, type: body.type, value: body.value }).lean().exec()
      if (existing) return { tag: existing }

      const tag = await Tag.create({ orgId, type: body.type, value: body.value })
      return { tag: tag.toJSON() }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.String(),
        value: t.String(),
      }),
    },
  )

  // Update tag (rename)
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const tag = await Tag.findOne({ _id: id, orgId }).exec()
      if (!tag) return status(404, { message: 'Tag not found' })

      const oldValue = tag.value
      tag.value = body.value
      await tag.save()

      // Update all documents of this type that contain the old tag
      const Model = modelMap[tag.type]
      if (Model) {
        await Model.updateMany(
          { orgId, tags: oldValue },
          { $set: { 'tags.$[elem]': body.value } },
          { arrayFilters: [{ elem: oldValue }] },
        )
      }

      return { tag: tag.toJSON() }
    },
    {
      isSignIn: true,
      body: t.Object({
        value: t.String(),
      }),
    },
  )

  // Delete tag
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const tag = await Tag.findOne({ _id: id, orgId }).exec()
    if (!tag) return status(404, { message: 'Tag not found' })

    // Remove from all documents of this type
    const Model = modelMap[tag.type]
    if (Model) {
      await Model.updateMany(
        { orgId, tags: tag.value },
        { $pull: { tags: tag.value } },
      )
    }

    await Tag.deleteOne({ _id: id })
    return { success: true }
  }, { isSignIn: true })
