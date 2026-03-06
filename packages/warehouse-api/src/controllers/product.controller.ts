import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const productController = new Elysia({ prefix: '/org/:orgId/warehouse/product' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.category) filter.category = query.category
    if (query.type) filter.type = query.type
    if (query.search) filter.name = { $regex: query.search }
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.products.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { products: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // Sanitize customPrices: convert empty strings to undefined for ObjectId/Date fields
      if (body.customPrices) {
        body.customPrices = body.customPrices.map((cp: any) => ({
          ...cp,
          contactId: cp.contactId || undefined,
          validFrom: cp.validFrom || undefined,
          validTo: cp.validTo || undefined,
        }))
      }

      const product = await r.products.create({ ...body, orgId } as any)

      // Upsert tags
      if (body.tags?.length) {
        for (const value of body.tags) {
          const existing = await r.tags.findOne({ orgId, type: 'product', value } as any)
          if (!existing) await r.tags.create({ orgId, type: 'product', value } as any)
        }
      }

      return { product }
    },
    {
      isSignIn: true,
      body: t.Object({
        sku: t.String({ minLength: 1 }),
        barcode: t.Optional(t.String()),
        name: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        category: t.String({ minLength: 1 }),
        type: t.Union([
          t.Literal('goods'),
          t.Literal('service'),
          t.Literal('raw_material'),
          t.Literal('finished_product'),
        ]),
        unit: t.String({ minLength: 1 }),
        purchasePrice: t.Optional(t.Number()),
        sellingPrice: t.Optional(t.Number()),
        currency: t.Optional(t.String()),
        taxRate: t.Optional(t.Number()),
        trackInventory: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
        minStockLevel: t.Optional(t.Number()),
        maxStockLevel: t.Optional(t.Number()),
        reorderLevel: t.Optional(t.Number()),
        reorderQuantity: t.Optional(t.Number()),
        tags: t.Optional(t.Array(t.String())),
        customPrices: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const product = await r.products.findOne({ id, orgId } as any)
    if (!product) return status(404, { message: 'Product not found' })

    return { product }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.products.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Product not found' })

      // Sanitize customPrices: convert empty strings to undefined for ObjectId/Date fields
      if (body.customPrices) {
        body.customPrices = body.customPrices.map((cp: any) => ({
          ...cp,
          contactId: cp.contactId || undefined,
          validFrom: cp.validFrom || undefined,
          validTo: cp.validTo || undefined,
        }))
      }

      const product = await r.products.update(id, body as any)

      // Upsert tags
      if (body.tags?.length) {
        for (const value of body.tags) {
          const existingTag = await r.tags.findOne({ orgId, type: 'product', value } as any)
          if (!existingTag) await r.tags.create({ orgId, type: 'product', value } as any)
        }
      }

      return { product }
    },
    {
      isSignIn: true,
      body: t.Object({
        sku: t.Optional(t.String()),
        barcode: t.Optional(t.String()),
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        category: t.Optional(t.String()),
        unit: t.Optional(t.String()),
        purchasePrice: t.Optional(t.Number()),
        sellingPrice: t.Optional(t.Number()),
        currency: t.Optional(t.String()),
        taxRate: t.Optional(t.Number()),
        trackInventory: t.Optional(t.Boolean()),
        minStockLevel: t.Optional(t.Number()),
        maxStockLevel: t.Optional(t.Number()),
        tags: t.Optional(t.Array(t.String())),
        isActive: t.Optional(t.Boolean()),
        customPrices: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.products.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Product not found' })

    await r.products.update(id, { isActive: false } as any)

    return { message: 'Product deactivated' }
  }, { isSignIn: true })
