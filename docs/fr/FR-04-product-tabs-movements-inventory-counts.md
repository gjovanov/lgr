# FR-04 — Product tabs, document links, inventory count ⇄ adjustment marriage

**Goal:** (a) Swap the *Ledger*/*Movements* tab **labels** on the product detail page
(translations only). (b) On the product *movements* tab the `SM-…` number becomes a link;
on the *levels* tab show the product's **± quantity from each document** and make `IC-…` a
link. (c) **Marry inventory counts and adjustment movements both ways** — completing a count
creates the adjustment movement (already true) and confirming a manual adjustment movement
creates the matching completed inventory count. (d) Rename "Stock Movements" →
**"Stock Movement Documents"** in all languages.

Status: draft for implementation · Date: 2026-08-21 · Depends on: nothing · Feeds: —

---

## 1. Current state

**Product tabs.** Routes `products/:id/:tab` with `tab ∈ stock|ledger|movements|levels` →
`ProductStockView.vue` (`inventory-ui/src/router/index.ts:16`). Labels from
`ProductTabBar.vue:37-45` (`warehouse.tabLedger` / `tabMovements` / `tabLevels`). What each
tab actually renders (`ProductStockView.vue:230-234` URL→internal remap):

| URL tab | content | doc numbers |
|---|---|---|
| `stock` | current per-warehouse StockLevels | none |
| `ledger` | `GET /warehouse/product-ledger/:productId` — per-line event journal, signed qty, running balance | **already links** SM + IC + invoice (`:96-98`, `:321-325`) |
| `movements` | `GET /warehouse/movement?productId=…` — movement **document headers** | `movementNumber` **plain text**; *Warehouse* and *Quantity* columns bound to non-existent fields → render **empty** (`:249-256`) |
| `levels` | `GET /warehouse/inventory-count?productId=…` — inventory-count docs containing the product | `countNumber` **plain text**; Date column bound to `countDate` which doesn't exist (field is `date`) → **empty**; no qty columns (`:258-263`) |

**Counts → movements already exists.** `POST /warehouse/inventory-count/:id/complete`
(`inventory-count.controller.ts:118-179`) creates ONE `type:'adjustment'` StockMovement with
**signed** `quantity: line.variance` lines, only `toWarehouseId` set, confirms it via
`confirmMovement` (stock + WAC mutate only through the movement), stores
`adjustmentMovementId` on the count. Zero-variance counts only bump `lastCountDate`.

**Gaps around it:**
- Movements have **no DELETE/void/cancel endpoints at all** (immutable once confirmed;
  `movement.controller.ts` — confirm sets status `'completed'`, `warehouse.service.ts:57-60`).
- Counts: `PUT` has **no status guard** and `DELETE` deletes a completed count **without**
  touching its movement or stock (`inventory-count.controller.ts:100-116`).
- Count form "Load Products" fetches stock levels **without a `size` param** → only the
  default 10 rows seed the count (`InventoryCountFormView.vue:148-160`,
  `stock-level.controller.ts:34`).
- Count header `notes` is posted by the form but absent from the schema → silently dropped
  (`inventory-count.model.ts`).
- `MovementFormView` optimistically sets status `'confirmed'` after confirm while the backend
  wrote `'completed'` (`MovementFormView.vue:438`).
- SM/IC numbers come from ad-hoc max+1 scans, **not** the Sequence registry (`movement.controller.ts:9-20`,
  `inventory-count.controller.ts:8-19`) — leave as-is (out of scope), do not "fix" in passing.

**"Stock Movements" strings.** One key everywhere: `nav.stockMovements` — nav entry
(`inventory-ui/src/layouts/DefaultLayout.vue:78`), page `<h1>` (`MovementsView.vue:4`), form
title concat `common.create + ' ' + nav.stockMovements` (`MovementFormView.vue:3`),
`PAGE_REGISTRY` row (`ui-shared/src/nav/page-registry.ts:54`).

---

## 2. Requirements

### 2.1 Tab label swap (translations only)

- **FR-4.1 (MUST)** Swap the **values** of `warehouse.tabLedger` and `warehouse.tabMovements`
  in all four locale files (`packages/ui-shared/src/locales/{en,bg,de,mk}.json`). Keys, routes,
  URLs, and tab contents are untouched. Outcome:

  | URL slug | key | en (was → is) | bg | de | mk |
  |---|---|---|---|---|---|
  | `/ledger` | `tabLedger` | Ledger → **Movements** | Дневник → **Движения** | Buchungsjournal → **Bewegungen** | Дневник → **Движења** |
  | `/movements` | `tabMovements` | Movements → **Ledger** | Движения → **Дневник** | Bewegungen → **Buchungsjournal** | Движења → **Дневник** |

  (i.e. the running-balance journal is what the user calls "Движения"; the document list is
  the "Дневник".) `tabLevels` ("Counts"/"Инвентаризации") is already correct — unchanged.
  Add a short comment in `ProductTabBar.vue` noting the deliberate key↔label inversion so a
  future cleanup doesn't "fix" it blindly.

### 2.2 Product `movements` tab (document list)

- **FR-4.2 (MUST)** `movementNumber` renders as an `EntityLink` to
  `/inventory/movements/{_id}` (route `inventory.movements.view`).
- **FR-4.3 (MUST)** Fix the two dead columns: replace `warehouseName` with the fields the API
  actually returns (`fromWarehouseName` / `toWarehouseName`, two columns like `MovementsView`),
  and populate quantity: the movement list endpoint, **when `productId` is passed**, adds
  `productQuantity` = Σ of that product's line quantities in the doc (computed before lines
  are stripped, `movement.controller.ts:86`). Render it signed: adjustments keep their stored
  sign; otherwise negative when only `fromWarehouseId` is set, positive when only
  `toWarehouseId` (transfer shows the raw quantity with a ⇄ marker — the ledger tab remains
  the precise per-warehouse view).

### 2.3 Product `levels` tab (inventory counts)

- **FR-4.4 (MUST)** `countNumber` renders as an `EntityLink` to
  `/inventory/inventory-counts/{_id}/edit`.
- **FR-4.5 (MUST)** Per-product ± quantity: the inventory-count list endpoint, when
  `productId` is passed, enriches each row with that product's line data —
  `productSystemQty`, `productCountedQty`, `productVariance` (signed). The tab shows
  System / Counted / **Variance** columns, variance colored green/red with an explicit `+`
  for positives (same convention as the ledger tab, `ProductStockView.vue:106-110`).
- **FR-4.6 (MUST)** Fix the Date column: bind `date` (the real field), not `countDate`.

### 2.4 Marriage: adjustment movement → inventory count (new direction)

- **FR-4.7 (MUST)** New optional back-link field on StockMovement:
  `inventoryCountId?: ObjectId ref InventoryCount` (`stock-movement.model.ts`). The
  count-complete flow sets it on the movement it creates (alongside the existing
  `adjustmentMovementId` on the count) — the pair is now linked both ways.
- **FR-4.8 (MUST)** When `POST /warehouse/movement/:id/confirm` confirms a movement with
  `type === 'adjustment'` and **no** `inventoryCountId`, and the request carries
  `createCount: true`, the server auto-creates a **completed** InventoryCount mirroring it:
  - `warehouseId` = the movement's single warehouse (`fromWarehouseId || toWarehouseId`);
  - per line: signed delta = stored qty sign for signed lines, else `-qty` (from-side) /
    `+qty` (to-side); `systemQuantity` = stock level **before** the adjustment (capture prior
    to `confirmMovement`), `countedQuantity = system + delta`, `variance = delta`,
    `varianceCost = delta × unitCost`;
  - `type:'partial'`, `status:'completed'`, `completedBy/completedAt`,
    `adjustmentMovementId = movement._id`, count number from the existing IC allocator;
  - then set `movement.inventoryCountId = count._id`.
- **FR-4.9 (MUST)** Flag semantics — **API default `createCount=false`**, the inventory UI
  sends `true` for adjustments (MovementsView confirm button, kanban drag, MovementFormView
  Confirm). Rationale: service-level confirms (invoicing dispatch, POS, doc-import
  commit/persist-movement) and the nightly `adjust-stock`/`transfer-stock` skills must NOT
  start generating a count per imported write-off — that would flood the counts list and
  change external behavior (README constraints #1-2). The user-facing flows get the
  "automatic" behavior; imports stay clean. Loop safety is double: count-born movements carry
  `inventoryCountId` (skip), and the count-complete flow calls the service directly, never
  this endpoint.
- **FR-4.10 (MUST)** Guard the count lifecycle so the pair can't diverge:
  - `PUT /inventory-count/:id` → 409 when `status === 'completed'`;
  - `DELETE /inventory-count/:id` → 409 when `status === 'completed'` (message points at the
    linked movement); `in_progress`/`cancelled` counts stay deletable;
  - completed movements were already immutable. Correction path for a wrong completed count =
    a new opposite count/adjustment (standard practice; document in the UI copy).
- **FR-4.11 (MUST)** Surface the links: count form shows a chip/link to its adjustment
  movement (`adjustmentMovementId`); movement form/view shows a chip/link to its
  `inventoryCountId`. Count list gets an optional "Movement" column (SHOULD).
- **FR-4.12 (MUST)** Fix "Load Products" to seed the **whole warehouse**: pass `size: 0`
  (and keep client-side responsiveness — render the lines table virtualized or paged if the
  warehouse has >1k products; regal СКЛАД-1 has ~16k → test this size).
- **FR-4.13 (SHOULD)** Schema/UX cleanups in the touched area: add `notes` to the
  inventory-count schema; fix the edit-form subtitle reading `detail.number` (field is
  `countNumber`); fix MovementFormView's optimistic `'confirmed'` → `'completed'`; add the
  missing movement types (`return`, `production_in`, `production_out`) to the MovementsView
  type filter.

### 2.5 Rename "Stock Movements" → "Stock Movement Documents"

- **FR-4.14 (MUST)** Change `nav.stockMovements` values in all four locales (proposals —
  confirm bg/mk with a native speaker):

  | locale | was | is |
  |---|---|---|
  | en | Stock Movements | **Stock Movement Documents** |
  | bg | Движение на стоки | **Документи за движение на стоки** |
  | de | Lagerbewegungen | **Lagerbewegungsbelege** |
  | mk | Движење на Залихи | **Документи за движење на залихи** |

  This automatically renames the nav entry, the list `<h1>`, and the favorites (★) entry.
- **FR-4.15 (MUST)** The create-form title currently concatenates
  `common.create + ' ' + nav.stockMovements` → "Create Stock Movement Documents" reads wrong.
  Add a singular key `warehouse.movementDoc` ("Stock Movement Document" / "Документ за
  движение на стоки" / "Lagerbewegungsbeleg" / "Документ за движење на залихи") and use it in
  `MovementFormView.vue:3`.

## 3. Edge cases

1. **Adjustment with BOTH warehouses set** (transfer-like, possible via API): skip auto-count
   creation (ambiguous warehouse) and log a warn — counts are single-warehouse documents.
2. **Zero-variance count** — no movement, no links (existing); the levels tab shows variance 0.
3. **Mixed ± variances in one count** — one movement with signed lines (existing pattern,
   `quantity: l.variance`); the reverse direction must produce identical semantics
   (movement-born count of a signed-line adjustment).
4. **WAC:** positive variance blends `|varianceCost/variance|` into avgCost; negative leaves
   avgCost untouched (existing `adjustStock` behavior — no change; assert it in tests).
5. **Auto-count line missing `unitCost`** — movement lines require unitCost at the model, UI
   prefills from avgCost; guard division by zero for `variance=0` lines (skip them, like the
   complete flow's `variance !== 0` filter).
6. **Concurrent confirms** — confirm is guarded by draft status; second call 400s (existing);
   count creation happens after a successful confirm only.
7. **Legacy counts completed before `adjustmentMovementId` existed** feed the ledger directly
   (`product-ledger.service.ts:262-300`, `adjustmentMovementId: {$exists:false}` filter) —
   the new links don't disturb that; movement-born counts DO have `adjustmentMovementId`, so
   the ledger won't double-show them. **Add a regression test for exactly this** (ledger row
   count unchanged after an auto-created count).
8. **`levels`/`movements` tab pagination**: both fetch `size: 0` today; with the new columns
   keep `size: 0` (per-product doc counts are small) — do not regress into pagination work.
9. **PUT-blocked completed counts**: the complete endpoint itself PUTs internally — ensure the
   409 guard applies to the public route only, not the internal repo update.

## 4. Integration & regression

- `doc-import` movement kinds (`stokrazp`/`corr`/`sklrazp`/`sklisk`) and their `notes`
  idempotency markers: untouched (service-level path; `createCount` defaults false).
- `check-doc-sequences` skill greps notes markers — unaffected.
- Product ledger endpoint keeps its contract (rows/summary keys) — the tabs only gained
  columns from the *list* endpoints.
- e2e `warehouse.spec.ts` may assert the old "Stock Movements" heading — update alongside.

## 5. Acceptance criteria

- [ ] Product page tabs read (bg): Наличност · Движения (journal) · Дневник (documents) · Инвентаризации — and the two swapped tabs show their previous content.
- [ ] Product → Дневник (documents) tab: SM number links to the movement; from/to warehouse and ± product qty populated.
- [ ] Product → Инвентаризации tab: IC number links to the count; System/Counted/± Variance and a real date shown.
- [ ] New inventory count seeded with the full warehouse, completed → adjustment movement `SM-…` exists, is linked both ways, and stock/WAC changed only once.
- [ ] New manual adjustment movement (from-warehouse, 2 lines) confirmed from the UI → a completed `IC-…` appears with correct system/counted/variance and mutual links; confirming via raw API without `createCount` creates none.
- [ ] Completed counts can't be edited or deleted (409 with movement reference).
- [ ] Nav/★/list title read "Stock Movement Documents" (per locale); create-form title uses the singular.
- [ ] `bun run test` (new count⇄movement flow spec incl. ledger no-double-count) + `bun run build` green.

## 6. Field test (lgrai.app / regal)

1. Pick a busy product (e.g. a `болт` with imported history): verify tab labels per locale
   switcher (bg/en), SM/IC links land on the right documents, ledger tab unchanged.
2. Run a real partial count on 5 products in СКЛАД-1 with one deliberate −1 and one +2:
   complete → check the movement, both links, ledger rows, stock levels, and that the daily
   `compare-products` reconciliation still matches PlusMinus afterwards.
3. Create a manual adjustment (write-off of 1 damaged unit) via the UI → auto-count appears;
   verify the product's Инвентаризации tab shows it with −1.
4. Next morning: confirm the nightly `adjust-stock`/`receive-stock` imports created **no**
   inventory counts (createCount default-off proof) and `check-doc-sequences` is clean.
