import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { resolveProductListFilter } from 'services/biz/product-list-query'
import { QuickProductError, createQuickProduct } from 'services/biz/quick-product.service'
import { findProductsByTierPrice, tierForSortKey } from 'services/biz/product-tier-sort'
import { findProductsByStockColumn, stockColumnForSortKey } from 'services/biz/product-stock-sort'
import { grantOf } from 'services/biz/access/evaluate'
import { keepStoredCosts, redactProduct, redactProducts } from 'config/access'
import { PRODUCT_TARIFF_CODE_MAX } from 'config/constants'
import { LIST_SORTS, chooseListSort } from 'config/list-sorts'
import { listProjection } from 'config/list-rows'
import { PRODUCT_SEARCH_INDEX } from 'services/biz/search.utils'

/** What an article is (`PRODUCT_TYPES`). One list for the create and the update route. */
const PRODUCT_TYPE = t.Union([
  t.Literal('goods'),
  t.Literal('service'),
  t.Literal('raw_material'),
  t.Literal('finished_product'),
])

/** The filter fields of the Products list's plain query: the org, and the active switch (FR-22.48). */
const PLAIN_LIST_FIELDS = new Set(['orgId', 'isActive'])

/**
 * FR-30.2: the index a declared sort is served by, for a query that filters on nothing but the org and the active
 * switch. Any other filter (a category, a tag, an id list) is left to the planner, which may read a narrower index.
 */
function sortIndexOf(key: string, filter: Record<string, unknown>): string | undefined {
  const served = LIST_SORTS.products.keys[key]?.served
  if (!served || !('index' in served)) return undefined
  return Object.keys(filter).every((f) => PLAIN_LIST_FIELDS.has(f)) ? served.index : undefined
}

export const productController = new Elysia({ prefix: '/org/:orgId/warehouse/product' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    // FR-22.48 / FR-28.3: the list's filters, resolved to one query by `resolveProductListFilter` (the same builder
    // the order preview of FR-28.16 resolves "all that match the filter" with). A caller who may not read bills is
    // refused the supplier filters.
    const resolved = await resolveProductListFilter(orgId, query as Record<string, unknown>, user)
    if (resolved.refusal) return status(resolved.refusal.statusCode, resolved.refusal.body)
    const { filter } = resolved

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    // FR-30.2: a sort the list declares (`config/list-sorts`), else the list's default.
    const chosen = chooseListSort('products', query.sortBy, query.sortOrder)
    const sortOrder = chosen.order

    // A price tier's column (`tier_1`) sorts by that tier's price, and a stock column by the figure
    // its cell shows; a plain find can do neither.
    const tier = tierForSortKey(chosen.key)
    const stockColumn = stockColumnForSortKey(chosen.key)
    const plain = LIST_SORTS.products.keys[chosen.key] ? chosen : chooseListSort('products', undefined, undefined)
    // FR-30.7: `fields=list` (the grid, the pickers) answers rows: a slot's name and price, not its filters.
    const select = listProjection('products', query.fields)
    const sortIndex = sortIndexOf(plain.key, filter as Record<string, unknown>)
    const result = tier
      ? await findProductsByTierPrice(r.products, filter, tier, sortOrder, page, size, select)
      : stockColumn
        ? await findProductsByStockColumn(r.products, orgId, filter, stockColumn, (query.warehouseId as string) || undefined, sortOrder, page, size, select)
        : await r.products.findAll(
          filter,
          // FR-30.12: a type-ahead reads one row more than it shows: `count=none` counts nothing, `count=when-more` only
          // when more follow (the line search's "Show all N results").
          { page, size, sort: { [plain.field]: plain.order }, ...(query.count === 'none' ? { count: false as const } : query.count === 'when-more' ? { count: 'when-more' as const } : {}) },
          // FR-30.11: a search reads the search field's index, which the planner passed over for the sort's. Only when the
          // search reads that field alone (`indexedSearch`): a supplier's code or an article without the field is read
          // from documents, which those keys cannot answer.
          // FR-30.2: the plain list (the org and the active switch, no other filter) reads the page through the index
          // its sort declares. The search index answers "active" from its keys too, so the planner may pick it (or keep
          // it cached for this shape) and sort every active article in memory.
          { select, ...(resolved.indexedSearch ? { hint: PRODUCT_SEARCH_INDEX } : sortIndex ? { index: sortIndex } : {}) },
        )
    // FR-27.6: the cost figures only for a role that holds `products.costs`; absent, not blanked.
    const items = redactProducts(grantOf(user as any), result.items as any[])
    return { ...result, products: items, items }
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

      // FR-27.6: a role without the cost figures sets none.
      const grant = grantOf(user as any)
      const product = await r.products.create({ ...keepStoredCosts(grant, body, null), orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'product', entityId: product.id, entityName: (product as any).name })

      // Upsert tags
      if (body.tags?.length) {
        for (const value of body.tags) {
          const existing = await r.tags.findOne({ orgId, type: 'product', value } as any)
          if (!existing) await r.tags.create({ orgId, type: 'product', value } as any)
        }
      }

      return { product: redactProduct(grant, product as any) }
    },
    {
      isSignIn: true,
      body: t.Object({
        sku: t.String({ minLength: 1 }),
        barcode: t.Optional(t.String()),
        name: t.String({ minLength: 1 }),
        tariffCode: t.Optional(t.String({ maxLength: PRODUCT_TARIFF_CODE_MAX })),
        description: t.Optional(t.String()),
        category: t.String({ minLength: 1 }),
        type: PRODUCT_TYPE,
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
        const grant = grantOf(user as any)
        return { product: redactProduct(grant, await createQuickProduct(orgId, user, keepStoredCosts(grant, body, null) as typeof body) as any) }
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

    return { product: redactProduct(grantOf(user as any), product as any) }
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

      // FR-27.6: a role that read the product without its costs keeps the stored ones: its body has none to send,
      // and the tiers it sends come back with the cost slot and every margin as stored.
      const grant = grantOf(user as any)
      const product = await r.products.updateInOrg(id, orgId, keepStoredCosts(grant, body, existing as any) as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'product', entityId: id, entityName: (product as any).name, changes: diffChanges(existing as any, product as any) })

      // Upsert tags
      if (body.tags?.length) {
        for (const value of body.tags) {
          const existingTag = await r.tags.findOne({ orgId, type: 'product', value } as any)
          if (!existingTag) await r.tags.create({ orgId, type: 'product', value } as any)
        }
      }

      return { product: redactProduct(grant, product as any) }
    },
    {
      isSignIn: true,
      body: t.Object({
        sku: t.Optional(t.String()),
        barcode: t.Optional(t.String()),
        name: t.Optional(t.String()),
        tariffCode: t.Optional(t.String({ maxLength: PRODUCT_TARIFF_CODE_MAX })),
        description: t.Optional(t.String()),
        category: t.Optional(t.String()),
        // ⚠ A field this schema does not name never reaches the handler: Elysia drops it and answers 200. `type` was
        // missing here from the first commit, so the form's Type select never saved on an existing article.
        type: t.Optional(PRODUCT_TYPE),
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
