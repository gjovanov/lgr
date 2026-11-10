import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { can } from 'services/biz/access/evaluate'
import {
  SUPPLIER_FACTS_PER_PRODUCT,
  canSeeSupplierFacts,
  canSeeSupplierPrices,
  getRecentSupplierDocuments,
  getSupplierFacts,
  type SupplierFact,
} from 'services/biz/product-suppliers.service'

/** FR-28.6: a page of the list, at most. The list's own page sizes top out at 100 (All is chunked). */
const MAX_PRODUCTS = 100

const REFUSAL = {
  code: 'capability_required',
  capabilities: ['bills.view'],
  message: 'Who we buy from is part of the incoming documents, which are not part of your role.',
} as const

/**
 * FR-28 — which suppliers an article was bought from (`services/biz/product-suppliers.service.ts`).
 *
 * Supplier facts are incoming-document data, so they are served only to a caller who may read bills
 * (`bills.view`), and the price only to one who may see costs. For anyone else the keys are not in the
 * answer at all — hidden in a column is not hidden: the figures stay on the server.
 */
export const productSupplierController = new Elysia({ prefix: '/org/:orgId/warehouse/product-supplier' })
  .use(AppAuthService)
  // The Products list's Suppliers column, for one page of articles in one call (as `stock-level/by-products`
  // serves the stock badges). `suppliers`: at most five facts per article, most recent first; `counts`: how
  // many there are, so "+N" does not understate an article with more.
  .get('/by-products', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const ids = [...new Set(String(query.productIds || '').split(',').map((s) => s.trim()).filter(Boolean))]
    if (ids.length > MAX_PRODUCTS) {
      return status(422, { code: 'too_many_products', message: `At most ${MAX_PRODUCTS} articles at a time.` })
    }
    // No `suppliers` key at all, not an empty one: the caller learns nothing, not even "none".
    if (!canSeeSupplierFacts(user)) return {}
    if (!ids.length) return { suppliers: {}, counts: {} }

    const facts = await getSupplierFacts(orgId, ids, { includePrices: canSeeSupplierPrices(user) })
    const suppliers: Record<string, SupplierFact[]> = {}
    const counts: Record<string, number> = {}
    for (const [productId, list] of Object.entries(facts)) {
      counts[productId] = list.length
      suppliers[productId] = list.slice(0, SUPPLIER_FACTS_PER_PRODUCT)
    }
    return { suppliers, counts }
  }, { isSignIn: true })
  // The article's Suppliers tab: every supplier fact, and the last ten documents behind them. A document the
  // caller may not open is not listed: a receipt is a stock movement, which a role may read or not.
  .get('/:productId', async ({ params: { orgId, productId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!canSeeSupplierFacts(user)) return status(403, REFUSAL)
    const product = await getRepos().products.findOne({ id: productId, orgId } as any)
    if (!product) return status(404, { message: 'Product not found' })

    const includePrices = canSeeSupplierPrices(user)
    const [facts, documents] = await Promise.all([
      getSupplierFacts(orgId, [productId], { includePrices }),
      getRecentSupplierDocuments(orgId, productId, {
        includePrices,
        includeReceipts: can(user, ['movements.view', 'movements.lookup']),
      }),
    ])
    return { suppliers: facts[productId] || [], documents }
  }, { isSignIn: true })
