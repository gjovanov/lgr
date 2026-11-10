import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { can } from 'services/biz/access/evaluate'
import { createAuditEntry } from 'services/biz/audit-log.service'
import {
  SUPPLIER_FACTS_PER_PRODUCT,
  canSeeSupplierFacts,
  canSeeSupplierPrices,
  getRecentSupplierDocuments,
  getSupplierFacts,
  type SupplierFact,
} from 'services/biz/product-suppliers.service'
import {
  RecordedSupplierError,
  clearRecordedSupplier,
  getRecordedSupplierNames,
  listRecordedSuppliers,
  recordSupplier,
  type RecordedSupplier,
} from 'services/biz/recorded-suppliers.service'

/** FR-28.6: a page of the list, at most. The list's own page sizes top out at 100 (All is chunked). */
const MAX_PRODUCTS = 100

/** A supplier only a person recorded for the article: no document names it, so there is no last purchase to give. */
type RecordedOnlySupplier = Pick<SupplierFact, 'supplierId' | 'supplierName' | 'quantity' | 'documents'>

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
  // serves the stock badges). `suppliers`: at most five per article, the ones the documents name first (most
  // recent first), then the ones only a person recorded (FR-28.9: no `lastPurchasedAt`, `documents: 0`), so an
  // article the Supplier filter found through a recorded link does not show a dash; `counts`: how many there are,
  // so "+N" does not understate an article with more.
  .get('/by-products', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const ids = [...new Set(String(query.productIds || '').split(',').map((s) => s.trim()).filter(Boolean))]
    if (ids.length > MAX_PRODUCTS) {
      return status(422, { code: 'too_many_products', message: `At most ${MAX_PRODUCTS} articles at a time.` })
    }
    // No `suppliers` key at all, not an empty one: the caller learns nothing, not even "none".
    if (!canSeeSupplierFacts(user)) return {}
    if (!ids.length) return { suppliers: {}, counts: {} }

    const [facts, recorded] = await Promise.all([
      getSupplierFacts(orgId, ids, { includePrices: canSeeSupplierPrices(user) }),
      getRecordedSupplierNames(orgId, ids),
    ])
    const suppliers: Record<string, Array<SupplierFact | RecordedOnlySupplier>> = {}
    const counts: Record<string, number> = {}
    for (const productId of new Set([...Object.keys(facts), ...recorded.keys()])) {
      const list: Array<SupplierFact | RecordedOnlySupplier> = [...(facts[productId] ?? [])]
      const named = new Set(list.map((f) => f.supplierId))
      for (const r of recorded.get(productId) ?? []) {
        if (!named.has(r.supplierId)) list.push({ supplierId: r.supplierId, supplierName: r.supplierName, quantity: 0, documents: 0 })
      }
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
    const [facts, documents, recorded] = await Promise.all([
      getSupplierFacts(orgId, [productId], { includePrices }),
      getRecentSupplierDocuments(orgId, productId, {
        includePrices,
        includeReceipts: can(user, ['movements.view', 'movements.lookup']),
      }),
      // FR-28.9: what a person recorded about the article's suppliers. The same gate as the facts beside it: who the
      // article is bought from is not for a role that reads no bills, however the answer was written.
      listRecordedSuppliers(orgId, productId),
    ])
    return { suppliers: facts[productId] || [], documents, recorded }
  }, { isSignIn: true })

const summaryOf = (r: RecordedSupplier | undefined) => r && {
  supplier: r.supplierName,
  preferred: r.preferred,
  ...(r.supplierSku ? { supplierSku: r.supplierSku } : {}),
  ...(r.leadTimeDays != null ? { leadTimeDays: r.leadTimeDays } : {}),
  ...(r.note ? { note: r.note } : {}),
}

/**
 * FR-28.9 — what a person records about an article and one of its suppliers: preferred, the supplier's own code,
 * the usual lead time, a note. Written by a person on the article's Suppliers tab and by nothing else; the facts of
 * who sold us the article stay read from the documents and are not touched by any of this.
 *
 * Needs `products.edit` (`config/access/routes.ts`, `EXACT_WRITES`). The product and the supplier must both belong to
 * the organization of the route, and the supplier must be an active contact of type supplier or both: the answer
 * for another organization's id is the answer for one that does not exist.
 */
export const productSupplierRecordController = new Elysia({ prefix: '/org/:orgId/warehouse/product' })
  .use(AppAuthService)
  .put(
    '/:id/suppliers/:supplierId',
    async ({ params: { orgId, id, supplierId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const written = await recordSupplier(orgId, id, supplierId, body)
        createAuditEntry({
          orgId, userId: user.id, action: written.created ? 'create' : 'update', module: 'warehouse', entityType: 'product',
          entityId: id, entityName: written.productName,
          changes: [{ field: 'recordedSupplier', oldValue: summaryOf(written.previous) ?? null, newValue: summaryOf(written.supplier) }],
        })
        return { supplier: written.supplier }
      } catch (e: any) {
        if (e instanceof RecordedSupplierError) return status(e.statusCode as 404, { code: e.code, message: e.message })
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        preferred: t.Optional(t.Boolean()),
        supplierSku: t.Optional(t.Union([t.String(), t.Null()])),
        leadTimeDays: t.Optional(t.Union([t.Number(), t.Null()])),
        note: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  // Clears what is recorded. A supplier the documents name stays listed with its facts: they are read, not stored.
  .delete('/:id/suppliers/:supplierId', async ({ params: { orgId, id, supplierId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      const cleared = await clearRecordedSupplier(orgId, id, supplierId)
      if (cleared.deleted) {
        createAuditEntry({
          orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'product', entityId: id, entityName: cleared.productName,
          changes: [{ field: 'recordedSupplier', oldValue: summaryOf(cleared.previous) ?? null, newValue: null }],
        })
      }
      return { deleted: cleared.deleted }
    } catch (e: any) {
      if (e instanceof RecordedSupplierError) return status(e.statusCode as 404, { code: e.code, message: e.message })
      throw e
    }
  }, { isSignIn: true })
