import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildProductListFilter } from 'services/biz/product-list-filter'
import { QuickProductError, createQuickProduct } from 'services/biz/quick-product.service'
import { findProductsByTierPrice, tierForSortKey } from 'services/biz/product-tier-sort'

export const productController = new Elysia({ prefix: '/org/:orgId/warehouse/product' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    // FR-22.48: the Products list asks for active or deactivated articles; without the param every
    // caller (the pickers, the API clients) still gets both. The Movements list filters by the
    // same rules (`buildProductListFilter`).
    const filter = buildProductListFilter(orgId, {
      search: query.search as string | undefined,
      category: query.category as string | undefined,
      type: query.type as string | undefined,
      tags: query.tags as string | string[] | undefined,
      isActive: query.isActive as string | undefined,
    })
    if (query.warehouseId) {
      // Restrict to products that currently hold stock in the selected warehouse.
      const stock = await r.stockLevels.findMany({ orgId, warehouseId: query.warehouseId, quantity: { $gt: 0 } } as any)
      filter.id = { $in: stock.map((s: any) => s.productId) }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    // A price tier's column (`tier_1`) sorts by that tier's price, which a plain find cannot.
    const tier = tierForSortKey(sortBy)
    const result = tier
      ? await findProductsByTierPrice(r.products, filter, tier, sortOrder, page, size)
      : await r.products.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
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

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'product', entityId: product.id, entityName: (product as any).name })

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
        costingMethod: t.Optional(t.Union([t.Literal('wac'), t.Literal('fifo'), t.Literal('lifo'), t.Literal('fefo'), t.Literal('standard'), t.Null()])),
        standardCost: t.Optional(t.Union([t.Number(), t.Null()])),
        categoryId: t.Optional(t.Union([t.String(), t.Null()])),
        customPrices: t.Optional(t.Array(t.Any())),
        tagPrices: t.Optional(t.Array(t.Any())),
        categoryPrices: t.Optional(t.Array(t.Any())),
        priceTiers: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  // FR-22.30: „+ Нов продукт „…"" from a receipt or bill line — the next SKU, the org's tier
  // template, „Общи" unless a category is chosen. 409 `product_exists` (with the article) for a
  // name the catalog already has. See services/biz/quick-product.service.ts.
  .post(
    '/quick',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        return { product: await createQuickProduct(orgId, user, body) }
      } catch (e: any) {
        if (e instanceof QuickProductError) return status(e.statusCode, { code: e.code, message: e.message, ...(e.details || {}) })
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 300 }),
        unit: t.Optional(t.String({ minLength: 1 })),
        categoryId: t.Optional(t.String()),
        taxRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        purchasePrice: t.Optional(t.Number({ minimum: 0 })),
        sellingPrice: t.Optional(t.Number({ minimum: 0 })),
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

      const product = await r.products.updateInOrg(id, orgId, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'product', entityId: id, entityName: (product as any).name, changes: diffChanges(existing as any, product as any) })

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
        costingMethod: t.Optional(t.Union([t.Literal('wac'), t.Literal('fifo'), t.Literal('lifo'), t.Literal('fefo'), t.Literal('standard'), t.Null()])),
        standardCost: t.Optional(t.Number()),
        isActive: t.Optional(t.Boolean()),
        categoryId: t.Optional(t.Union([t.String(), t.Null()])),
        customPrices: t.Optional(t.Array(t.Any())),
        tagPrices: t.Optional(t.Array(t.Any())),
        categoryPrices: t.Optional(t.Array(t.Any())),
        priceTiers: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.products.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Product not found' })

    await r.products.updateInOrg(id, orgId, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'warehouse', entityType: 'product', entityId: id, entityName: (existing as any).name })

    return { message: 'Product deactivated' }
  }, { isSignIn: true })
