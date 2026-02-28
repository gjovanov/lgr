import { Elysia, t } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { Product } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const productController = new Elysia({ prefix: '/org/:orgId/warehouse/product' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.category) filter.category = query.category
    if (query.type) filter.type = query.type
    if (query.search) filter.name = { $regex: query.search, $options: 'i' }

    const result = await paginateQuery(Product, filter, query, { sortBy: 'name', sortOrder: 'asc' })
    return { products: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const product = await Product.create({ ...body, orgId })
      return { product: product.toJSON() }
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

    const product = await Product.findOne({ _id: id, orgId }).lean().exec()
    if (!product) return status(404, { message: 'Product not found' })

    return { product }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const product = await Product.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!product) return status(404, { message: 'Product not found' })

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
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    // Deactivate instead of hard delete
    const product = await Product.findOneAndUpdate(
      { _id: id, orgId },
      { isActive: false },
      { new: true },
    ).exec()
    if (!product) return status(404, { message: 'Product not found' })

    return { message: 'Product deactivated' }
  }, { isSignIn: true })
