import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { Tag, Product, Contact, Warehouse, Employee, Invoice } from 'db/models'
import { createAuditEntry } from 'services/biz/audit-log.service'

const modelMap: Record<string, any> = {
  product: Product,
  contact: Contact,
  warehouse: Warehouse,
  employee: Employee,
  invoice: Invoice,
}

/**
 * #493: what writing a tag of each type needs. A rename or a delete rewrites every document of its
 * type that carries the tag, so it takes the write permission of that module. The route rule
 * (`invoicing.write` or `inventory.write`, `route-permission.ts`) let a Seller, whose products are
 * read-only, rename or delete product tags across the catalog. A type of no module needs no more
 * than the route rule.
 */
const WRITE_BY_TYPE: Readonly<Record<string, string>> = {
  product: 'inventory.write',
  warehouse: 'inventory.write',
  contact: 'invoicing.write',
  invoice: 'invoicing.write',
  employee: 'payroll.write',
}

function tagWriteRefusal(user: { role?: string; permissions?: readonly string[] }, type: string) {
  const need = WRITE_BY_TYPE[type]
  if (!need || user.role === 'admin' || user.permissions?.includes(need)) return null
  return { code: 'permission_required', permissions: [need], message: `Permission required: ${need}` }
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
      const refused = tagWriteRefusal(user, body.type)
      if (refused) return status(403, refused)

      const existing = await Tag.findOne({ orgId, type: body.type, value: body.value }).lean().exec()
      if (existing) return { tag: existing }

      const tag = await Tag.create({ orgId, type: body.type, value: body.value })

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'admin', entityType: 'tag', entityId: String(tag._id), entityName: body.value })

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
      const refused = tagWriteRefusal(user, tag.type)
      if (refused) return status(403, refused)

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

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'admin', entityType: 'tag', entityId: id, entityName: body.value })

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
    const refused = tagWriteRefusal(user, tag.type)
    if (refused) return status(403, refused)

    // Remove from all documents of this type
    const Model = modelMap[tag.type]
    if (Model) {
      await Model.updateMany(
        { orgId, tags: tag.value },
        { $pull: { tags: tag.value } },
      )
    }

    await Tag.deleteOne({ _id: id, orgId })

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'admin', entityType: 'tag', entityId: id, entityName: tag.value })

    return { success: true }
  }, { isSignIn: true })
