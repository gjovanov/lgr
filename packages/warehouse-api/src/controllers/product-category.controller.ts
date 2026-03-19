import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const productCategoryController = new Elysia({ prefix: '/org/:orgId/warehouse/product-category' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) filter.name = { $regex: query.search, $options: 'i' }
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 100
    const sortBy = (query.sortBy as string) || 'sortOrder'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.productCategories.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { productCategories: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()
      const productCategory = await r.productCategories.create({ ...body, orgId } as any)
      return { productCategory }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        icon: t.Optional(t.String()),
        color: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const productCategory = await r.productCategories.findOne({ id, orgId } as any)
    if (!productCategory) return status(404, { message: 'Category not found' })
    return { productCategory }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()
      const existing = await r.productCategories.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Category not found' })
      const productCategory = await r.productCategories.update(id, body as any)
      return { productCategory }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        icon: t.Optional(t.String()),
        color: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const existing = await r.productCategories.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Category not found' })
    if (existing.isSystem) return status(400, { message: 'Cannot delete system category' })

    // Check if any products use this category
    const count = await r.products.count({ orgId, categoryId: id } as any)
    if (count > 0) return status(400, { message: `Cannot delete: ${count} products use this category` })

    await r.productCategories.delete(id)
    return { message: 'Category deleted' }
  }, { isSignIn: true })
