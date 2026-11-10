# ProductSupplier

What a person records about an article and one of its suppliers (FR-28.9): whether it is the supplier to order from, the supplier's own code for the article, the usual lead time, a note.

> **This is not the record of who sold us the article.** That is read from the received bills and the goods receipts every time (`services/biz/product-suppliers.service.ts`) and stored nowhere, so a corrected bill never leaves a stale copy. A row here is written by a person on the article's Suppliers tab and by nothing else: no bill, receipt or import ever creates, changes or deletes one. It sits beside `SupplierProductAlias`, which stays what it is (the wording a supplier's bills use for an article, written by the document import).

## Entity Interface

```typescript
export interface IProductSupplier extends TenantEntity {
  productId: string
  supplierId: string
  preferred: boolean
  supplierSku?: string
  supplierSkuLower?: string
  leadTimeDays?: number
  note?: string
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant identifier |
| productId | string | Yes | - | Ref to Product |
| supplierId | string | Yes | - | Ref to Contact: type `supplier` or `both`, and active when it was recorded |
| preferred | boolean | No | `false` | The supplier to order this article from. At most one per article |
| supplierSku | string | No | - | The supplier's own code for the article. Searchable on the Products list and in the product search, for a caller who may read bills |
| supplierSkuLower | string | No | - | Cyrillic-safe lowercase mirror of `supplierSku`, kept by `loweredFieldsPlugin` (and by the service in the same write). Never sent to Mongo as a `$regex` from Bun |
| leadTimeDays | number | No | - | Usual lead time, a whole number of days, 0 to 3650 |
| note | string | No | - | Free text, at most 500 characters |
| createdAt | Date | Yes | auto | Timestamp |
| updatedAt | Date | Yes | auto | Timestamp |

## Indexes

- Unique `(orgId, productId, supplierId)`: one row per article and supplier.
- Partial unique `(orgId, productId)` where `preferred: true`: at most one preferred supplier per article, and the database says so, so two writers cannot both win. Setting another supplier preferred clears the previous one first (there is a moment with none, never one with two; a race answers 409 `preferred_conflict`).
- `(orgId, supplierId)`: the Products list's Supplier filter.
- Sparse `(orgId, supplierSkuLower)`: the product search by the supplier's code.

## Replication

Class **R**, like every document of an org: the whole row travels between a master and its hub, and an org move carries it (`db/replication/declare.ts`, `meta.generated.ts`).

⚠ **A master older than the hub does not know the collection.** Moving an org that holds at least one row to such a master, or re-seeding it from the hub's copy, is refused by the master's `readMoveBundle` with `MoveBundleError("productsuppliers is not a collection a move copies")`: loudly, and before anything is kept (an empty collection emits no section, so an org with no recorded supplier moves as before). Update the master to the release that knows the model first. A mirror page from a master that is newer than its hub is refused whole (every row must be of a replicated collection), so the hub (lgrai.app) is deployed first and the server release cut after. A backup restored into an older server warns "N documents in the bundle have no model in this deployment" and skips the section; the restore does not fail.

## Relationships

- **Product** (productId) -- the article
- **Contact** (supplierId) -- the supplier
- Read beside the supplier facts (bills and receipts) on the article's Suppliers tab; the default supplier of an article for an order is `getDefaultSuppliers`: the recorded preferred supplier (while that contact is still an active supplier), else the supplier of the most recent purchase, else the supplier of the newest supplier order with a line for the article, else none.

## API Endpoints

| Method | Path | Needs | Description |
|--------|------|-------|-------------|
| PUT | `/api/org/:orgId/warehouse/product/:id/suppliers/:supplierId` | `products.edit` | Record (create or replace). The body is `{ preferred?, supplierSku?, leadTimeDays?, note? }` and **every recorded field is replaced**: one that is left out, or null, is cleared. 404 `product_not_found`; 422 `supplier_not_found`, `not_a_supplier`, `supplier_inactive`, `too_long`, `invalid_lead_time`. Audited against the product (field `recordedSupplier`): `create` for a first record, `update` for a replacement |
| DELETE | `/api/org/:orgId/warehouse/product/:id/suppliers/:supplierId` | `products.edit` | Clear what is recorded. A supplier the documents name stays listed with its facts. Answers `{ deleted }` |
| GET | `/api/org/:orgId/warehouse/product-supplier/:productId` | `bills.view` | The Suppliers tab: `{ suppliers, documents, recorded }`. 403 `capability_required` without `bills.view` |
| GET | `/api/org/:orgId/warehouse/product-supplier/by-products?productIds=` | `bills.view` for the facts | The Products list's Suppliers column for one page (at most 100 ids): the suppliers the documents name, then those only a person recorded (`documents: 0`, no `lastPurchasedAt`), five per article at most, with `counts` |
