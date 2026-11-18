# History: Warehouse, products, pricing and orders

What was built in this area, release by release: tag-based pricing and price tiers, orders and reservations, stock bookings, the external warehouse, supplier facts.

Moved here whole from `CLAUDE.md` by FR-32.13 (#797), section by section and word for word, so "below" and
"above" in it speak of the file it came from. The traps and the never/always rules of these sections are also in
the rule file [`.claude/rules/warehouse.md`](../../.claude/rules/warehouse.md), which a session loads when it touches
this area's files. A new trap goes there (or in `CLAUDE.md` if it is not one area's); what was built goes here.

## Tag-Based Pricing

Products support custom pricing based on contact tags. Each custom price entry can have:
- **Name** (required), **price**, optional **minQuantity**, **validFrom/validTo**
- **Contact** (specific customer) and/or **Tags** (multiselect contact tags)

**Price resolution chain** (each step overrides previous): base selling price → category price → tag price (lowest match) → **price tier (filtered slot)** → contact custom price → user override.

- **API**: `GET /api/org/:orgId/pricing/resolve?productId=...&contactId=...&quantity=...` returns `{ finalPrice, steps[] }`
- **Service**: `packages/services/src/biz/pricing.service.ts` — `resolvePrice()`
- **UI**: `PriceExplainButton` (info icon on invoice line items) opens dialog showing the full price derivation chain
- **Product form**: Unified "Custom Prices" tab with contact autocomplete + tags multiselect (TagInput)
- **Data model**: **`Product.priceTiers[]`** (canonical since 2026-04-21, 10-slot cap) — each tier `{ name, percent, finalPrice, manualOverride, contactIds?, tags?, minQuantity?, validFrom?, validTo? }`. Tiers with filters participate in resolution; filterless slots are storage-only (used as `price1..price10` columns in goods-receipt flow). **LEGACY**: `Product.tagPrices[]` + `Product.customPrices[]` — still read by `resolvePrice()` for backward compat; UI no longer writes them. Existing records continue to work; new pricing flows through `priceTiers[]`.
- **Tier-name tags convention**: seeded sales tiers carry `tags: [<tier name>]` (e.g. `"Цена 4"`) — tagging a contact with the same name selects that tier via resolution step 4 (legacy per-client price groups). The cost tier (`Доставна цена`: the STORED name, drawn as „Цена с ТО" since 2026-11-15, see below) and zero-price slots stay filterless (display-only). Wiring: `scripts/assign-price-group-tags.ts` (tags tiers + derives contact groups from imported invoices; dry-run default). PriceCombobox never overwrites a loaded line's stored historical price (`auto-apply-resolved=false` for `line.loaded`); `listPriceOptions` mirrors `resolvePrice` for its resolvedKey.
- **Product form "Pricing" tab**: 10-row compact tier table. Always-visible columns: Name / % / Final Price. Filter chips (Contact, Tags, Min Qty, Validity) reveal optional columns. Editing `purchasePrice` cascades into all non-overridden tiers; editing a tier's `finalPrice` sets `manualOverride=true` (shown with lock icon).
  - **Since 2026-11-12** the table begins with two unnumbered rows, the purchase price and the selling price: the SAME models as the fields above (never tiers, never sent as such), shown to whoever sees the field above (`seesCosts`, `seesSelling`).
  - **A price keeps four decimals and a margin three** (0.0472, 2000.555): `config/price-precision` is the one rule (in `config` since 2026-11-15 so the server and the scripts read it too; `ui-shared/composables/price-precision.ts` re-exports it. `roundTo` rounds the figure as WRITTEN, not `toFixed`'s double; `priceAtMargin`, `marginOver`), used by the form and by the goods receipt's cascade (`gr-product-update.ts`), so both give an article the same price. The form rounded a price to the cent and a margin to a tenth until then.
  - `ui-shared/components/DecimalField.vue` shows such a figure with every decimal at rest. ⚠ It emits only for what was TYPED, already rounded: a figure it was only handed is shown rounded and never written back (an import's 0.047231 stays until somebody changes that price), and a Ctrl+S with the field focused stores no fifth decimal.
  - The figures' columns have widths of their own (`th` hints, the fields' `min-width` in `ch`), and a column with no width takes the rest (`spareColumn`): in a table whose every column names a width the browser shares the slack out among them all. With every filter shown in a narrow window the table scrolls sideways before a field is cut. `e2e/tests/product-form.spec.ts` measures the room at 1366 and 1920.
- **`Product.tariffCode`** (2026-11-12): the customs tariff number, free text, trimmed, ≤ `PRODUCT_TARIFF_CODE_MAX` (50), absent or empty when not kept. On the form's Edit tab after the name (lines: SKU, Name, Tariff code / Type, Category, Unit / Barcode, Description, Tags / Active). Not searched, not a list column, not on any document yet.
- ⚠ **A route's body schema is a whitelist.** Elysia drops a field the schema does not name and answers 200. `PUT /warehouse/product/:id` never named `type`, so the form's Type select did not save on an existing article until 2026-11-12. `integration/product-form-fields.flow.test.ts` reads the form's own fields out of `ProductFormView.vue` and holds each one to the update route: a field added to the form must be added to both schemas.
- **Goods-receipt with product update**: `POST /warehouse/movement/with-update` — atomic via Mongo transaction. Updates product fields (purchasePrice, sellingPrice, priceTiers, type, category, unit) AND creates the stock movement in one session. Requires replica set. On failure, transaction aborts → full rollback, no partial state. Audit-log: one entry per product update + one for the movement, correlated by movement id.
- **Invoice lines**: `priceExplanation: IPriceStep[]` persisted for audit trail (types: `base | category | tag | contact | tier | override`)
- ⚠ **A price the person typed or picked is pinned, on every document** (`pricePinned`, `PriceCombobox#chosen`), so a resolved one does not come back over it on a quantity edit or a restored draft. `update:modelValue` cannot say so: a resolved price arrives by it too. A draft from before this has no pin, and its trail's `override` step stands in. A change of contact still re-resolves every line.
- **Backfill**: `bun run scripts/backfill-price-tiers.ts [--execute] [--org slug]` — idempotent, seeds 10 default slots with `percent=0, finalPrice=sellingPrice`, no filters
- **„Доставна цена" is a KEY; it reads „Цена с ТО" (owner, 2026-11-15).** The slot's stored name did not change:
  `priceTiers[].name`, `PRICE_TIERS`, `COST_TIER_NAMES`, the importers' column mapping and the tier-name tags find it
  by `Доставна цена`, and PlusMinus's „Доставна цена" / „Дост. цена" and a receipt's „Цена" keep filling it. What a
  person READS comes from one table, `config/price-tiers#tierLabel(name, locale, form)`: bg „Цена с ТО" in both
  forms, en "Trade-discount price" / "Price with trade discount", de, mk.
  - ⚠ In Bulgarian the name is „Цена с ТО" everywhere (owner, 2026-11-16). For a day the long form (the product
    form's row, the price trail) spelled it out as „Цена с търговска отстъпка (Цена с ТО)": that text is a RETIRED
    label (`RETIRED_TIER_LABELS`), never drawn and still read back to the slot when typed. The form's hint
    (`warehouse.deliveryTierHint`) is where the term is spelled out.
  - ⚠ The label is put on at RENDER, in the UI only. `listPriceOptions`, `resolvePrice`'s steps and a line's stored
    `priceExplanation` keep the stored name: the access rules class a price by it (`capOfTier`, `capOfPriceSource`),
    and a relabelled cost slot would read as `products.price:other` and reach a role without costs.
  - Render sites: the Products list (`productColumnHeaders`, `opts.locale`), receipt and bill lines
    (`grColumnLabel`), the price menus (`priceOptionLabel`), the price trail (`priceStepLabel`), the till, and the
    product form, where a labelled slot's name is text and not a field (`data-testid="tier-label"`; `data-tier` stays
    the stored name). A name a person types is taken back to the stored one (`tierNameOfLabel`): a label is never
    stored. ⚠ A new place that draws a tier's name goes through `tierLabel`.
  - ⚠ The bg receipt column for the product's `purchasePrice` was headed „Доставна цена" as well: it reads „Покупна
    цена" now (`warehouse.grCol.purchasePrice`).
- **`purchasePrice` is „Цена 2" / 1.2, not the delivery price (owner, 2026-11-15).** PlusMinus keeps no buying price,
  and "Доставна цена = Покупна цена" was wrong. One function: `config/price-tiers#purchasePriceFromTier2` (four
  decimals, a half goes up, null without a „Цена 2" above 0).
  - **A product an import CREATES** takes it when its row carries a „Цена 2" (`purchasePriceForNewProduct`:
    `newProductDoc`, `receive-new-products.ts`, `seed-products.ts`, `import-regal-pz.ts`), the delivery price
    otherwise. The delivery price still fills its slot and opens avgCost; each slot's `percent` is over the purchase
    price.
  - **An import never re-derives it for a product that exists** (`PROTECTED_TIERS` and `persistMovement`'s strip
    stand). Those are corrected once per org by `scripts/set-purchase-price-from-tier2.ts --org <slug>` (a dry run;
    `--execute --backup <file>` writes; `--restore <file>` puts it back), core in
    `services/biz/purchase-price-from-tier2.ts`. A product without „Цена 2" is left as it is. ⚠ ONCE: the run cannot
    tell a stale figure from one a bill or a person set since, and a later run would put the approximation back over it.
  - ⚠ That run moves NO price: `finalPrice`, `sellingPrice`, `manualOverride` and avgCost stay (a written product's
    `updatedAt` moves, as with any save). It rewrites `percent`
    where a slot is fixed by hand or followed the purchase price (`marginsAfterPurchaseChange`), which is what the
    form's cascade shows for such a slot; a backfilled slot (the selling price at 0 %) stays as stored.
  - ⚠ Nothing compares `purchasePrice` with PlusMinus's „Дост. цена" any more: the snapshot compare
    (`compare-snapshot.service.ts`, `scripts/compare-products.ts`) holds that column to the SLOT. The daily import's
    `prices.ts diff` still reports a changed `purchase` as PROTECTED, so the one-time run stays out of a run's
    snapshot pair.
  - D-2 (`applyLinkedBillPrices`) also replaces a purchase price that is still the approximation, but only by a
    price the bill states itself (one that differs from every receipt's cost): a bill entered in LGR is where the
    real one comes from, and one that repeats an imported receipt's cost would put the delivery price back.

---

## Orders: ORDO (external) + ORDI (internal) + RES reservations (2026-07-26; split 2026-08-15)

Three linked invoicing document families (none is an Invoice `type`):

```
ORDI (InternalOrder, client demand)          ORDO (Order, supplier supply)
  lines[{product, qty, deadline}]              supplierGroups→lines→allocations
        ▲                                            ▲
        └────────── RES (Reservation) ───────────────┘
          source: 'stock' (free WH stock) | 'order' (ORDO allocation)
                        │ orderRef.reservationId on invoice lines
          conversion sales invoice → dispatch → delivered
```

- **ORDO** (`packages/db/src/models/order.model.ts`, model name `Order`): supplier groups → lines (product, qty, expectedUnitPrice) → warehouse **allocations**. Counter keys `ORDER`/`DRAFT_ORD` **unchanged** across the ORD→ORDO rename — numbering continues, display prefixes now `ORDO`/`DRF-ORDO` (historic ORD- numbers untouched; migration copies any legacy year-0 `ORD`/`DRF-ORD` display sentinel onto the counter keys). Status: draft → sent → partially_received → received → completed/cancelled. Embedded `reservations[]` subdocs are DEPRECATED (read only by the migration; strip phase empties them).
- **ORDI** (`internal-order.model.ts`, `InternalOrder`): client order for future delivery — `contactId`, `requestedDeliveryDate` (drives priority; rank = urgent>high>normal>low, then earliest deadline, then createdAt; no-ORDI reservations rank last), optional preferred `warehouseId`, flat lines `{productId (req), quantity, expectedUnitPrice?, pricePinned?}` (`pricePinned`: the price was chosen on the line and is what `/convert` charges, see "price-select" above; absent: an indication) + derived per-line `reservedQuantity/invoicedQuantity/deliveredQuantity`. Sequences `INTERNAL_ORDER`/`ORDI` + `DRAFT_ORDI`/`DRF-ORDI`. Status: draft → confirmed (number issued) → partially_delivered → delivered (derived from dispatch) → completed (manual, releases open RES) / cancelled (draft/confirmed only, cascades RES).
- **RES** (`reservation.model.ts`, `Reservation`): numbered hold (`RESERVATION`/`RES`, direct issue) linking demand (contactId, optional internalOrderId/LineId) to supply (`source: 'stock' | 'order'` + warehouseId; order-source carries orderId/groupId/lineId/allocationId). Derived `invoicedQuantity/dispatchedQuantity/invoiceIds` from LIVE outgoing type-'invoice' docs only (converted proformas/bills never count). Status active ↔ fulfilled (auto), cancelled terminal with `cancelReason: manual|preempted|internal_order_cancelled|external_order_cancelled|released` + `preemptedBy`. Holds: stock-source = `qty − dispatched` while active (availability-validated at create); order-source = old formula `min(Σ(qty−dispatched), received−Σdispatched)` per allocation, only while the ORDO is sent/partially_received/received (draft-ORDO RES records intent, holds nothing). Reopen rule: a void only reactivates a fulfilled RES if its ORDI is still live — closed demand shrinks instead (no zombie holds).
- **Sync engine** (`services/biz/reservation.service.ts`): decomposed into `recomputeOrderReceipts` / `recomputeReservations` / `recomputeInternalOrder` / `syncReservedQuantities` (now reads the Reservation collection). Public entry points kept: `syncOrderDerivedState(orgId, orderId)` and `syncOrderForInvoice(orgId, invoice)` — the latter walks doc `orderId`/`internalOrderId` AND line `orderRef.{orderId,internalOrderId,reservationId}` (mixed-source conversion invoices may have no doc orderId). Invoice hooks: POST create (after the cash-sale rollback block), PUT, DELETE, send, receive, void, proforma-convert, bill-import convert. `applyReservationCancel`/`reservationReleasable` implement release semantics (fully-open cancel keeps quantity for audit; partially-consumed shrinks to consumed).
- **Ops layer** (`services/biz/reservation-ops.service.ts`, throws `ReservationOpsError{statusCode}`): `createReservation` (validates availability / allocation capacity / ORDI line open demand / contact match), `cancelReservation {quantity?}` (releasable = qty − max(invoiced, dispatched)), `preemptReservation` (Mongo txn, releasable re-checked on the session read → concurrent preempts serialize, loser gets 422; beneficiary RES inherits the supply source), `reserveAvailableForInternalOrder` (one-click stock cover, preferred-WH first), `getInternalOrderSuggestions` (per short line: freeStock / unreserved incoming (+`late` vs deadline) / preemptable ranked most-deferrable first with equal/higher-priority demand excluded, caps 20 + totals, supplierHint from the latest ORDO carrying the product), `completeInternalOrder`, `cancelInternalOrder`, `generateExternalOrder` (txn: new/append-to draft ORDO grouped by supplier + order-source RES per line).
- **Availability precision** (`invoicing.service.ts` + `stock-transfer.service.ts`): reservation-backed lines are exempt via a per-RES **budget per validation call** (`loadReservationBudgets`: the RES's hold — open = qty − dispatched, and for an order-source RES also capped by its allocation's received − Σdispatched, 0 while the ORDO isn't holding, one pool per allocation — shared across the doc's lines: N lines on one RES can't each claim the full hold; excess competes for free stock). ⚠ Until FR-22.5 an order-source budget ignored receipt, so an invoice dispatched a sent-but-unreceived ORDO's units: stock 404 → −10 (B-7). `checkCrossWarehouseAvailability` + `/stock-availability/check` accept per-line `reservationId` (both UI callers send it). Invoice POST/PUT guard `validateReservationLineRefs`: only outgoing sales invoices may reference reservations (bills/cash sales/notes → 422) and Σ live invoiced per RES ≤ RES.quantity (422 with remainder).
- **Controllers**: `order.controller.ts` — CRUD + `/send` `/cancel` (live-invoice check spans doc orderId + line orderRef.orderId + RES invoiceIds; cascades RES with `external_order_cancelled`, returns `affectedInternalOrders`) `/complete` (releases open RES remainders) `/release` (legacy alias → RES cancel) `/convert {contactId}` (over RES docs via shared `lib/reservation-convert.ts` builder — same `planConversion` rule as the ORDI convert) `/peek-next` `/export` (internal sheet reads `ctx.reservations` grouped by allocationId); PUT guards allocations against Σ non-cancelled RES (409). `internal-order.controller.ts` — CRUD + `/confirm` `/complete` `/cancel` `/convert` (open RES → one draft invoice, doc `internalOrderId`, per-line full orderRef incl. `orderId`; only what can be dispatched: `planConversion` caps an order-source RES at its allocation's received − dispatched − what live drafts claim, returns the rest as `waiting`, and answers 422 `awaiting_receipt` instead of an empty draft) `/reserve-available` `/suggestions` `/generate-external` `/peek-next`; PUT guards lines vs Σ RES/delivered. `reservation.controller.ts` — list (enriched names + computed late/shortage flags) + create/cancel/preempt. All mounted in `unified.ts`.
- **Invoice model**: doc `orderId`/`orderGroupId`/`internalOrderId`; per-line `orderRef {orderId?,groupId?,lineId?,allocationId?,reservationId?,internalOrderId?,internalOrderLineId?}` (all-optional) + `sourceText`; indexes on `{orgId,orderId}`, `{orgId,internalOrderId}`, `{orgId,'lines.orderRef.reservationId'}`. The form round-trips orderRef verbatim (document-payload).
- **Migration**: `scripts/migrate-order-reservations.ts` — preflight (embedded `_id` uniqueness, loud failure; display-sentinel copy) → `--execute` UPSERT (RES doc per embedded subdoc, **preserving the subdoc `_id`** so historic `orderRef.reservationId` resolve; closed orders normalise qty to max(invoiced, dispatched); qty-0 `/release` leftovers → cancelled('released'); re-runs refresh counters) → deploy → `--strip` (re-upserts, verifies per-(product,WH) hold parity, empties embedded arrays, re-materialises StockLevels). Zero hold-loss sequence: execute → deploy → strip.
- **ORDO-aware purchase import**: unchanged mechanics — `POST /bills/import/draft` accepts `orderId`; ladder alias → exact → AI-vs-order-candidates; bills carry `orderRef {groupId,lineId,allocationId}` (NEVER reservationId — 422). Skill `.claude/skills/import-purchase-invoices/` + `scripts/import-purchase-invoices.ts` are prefix-agnostic (resolve by number search). **Ops:** ORDO-received deliveries must not ALSO be booked by the daily `receive-stock` import.
- **UI** (labels renamed 2026-10-25, see the next section: Internal → **Incoming**, External → **Outgoing**): nav group "Orders" → Internal Orders (`/internal-orders`, InternalOrdersView + InternalOrderFormView with coverage chips, Reserve-from-stock, Cover-shortages dialog (free stock / incoming / preempt with confirm), Generate-external dialog with supplier hints), External Orders (`/orders` — paths/route names unchanged for e2e; OrderFormView: allocation editor + read-only RES panel + per-allocation Reserve-for-client dialog; convert dialog fed by linked RES), Reservations (`/reservations`, ReservationsView with source/late/shortage indicators + cancel). Sequences page groups: order/internal_order/reservation. i18n ×4 (en/bg/de/mk): nav keys, `invoicing.status.{confirmed,partially_delivered,delivered,active,fulfilled}`, priority/coverage/preempt blocks.
- **Tests**: `order-reservations.flow` (7-case behavioral contract over RES docs), `order-import.flow`, `order-sheet-export`, `reservation-migration.flow` (preserved ids, upsert refresh, hold parity, strip), `internal-order.flow` (budgeted exemption incl. N-lines-one-RES, delivered statuses, void-after-complete no zombie hold, cascades), `reservation-preempt.flow` (partial/concurrent preempt, suggestions ranking, generate-external rollback, cross-WH exemption).

## Orders: the customer order prints (2026-11-16)

An ORDI had no printed form: nothing to hand a client, nothing an e-mail could attach.

- **The sheet** — `reporting/pdf/customer-order.pdf.ts` + `customer-order.i18n.ts` (en/bg/de/mk), in the
  supplier sheet's family (markdown through `markdownToPdf`; `buildCustomerOrderMarkdown` is exported so
  the layout is tested without a browser). The title says where the order stands: confirmed and later
  „ПОТВЪРЖДЕНИЕ НА ПОРЪЧКА", a draft „ПОРЪЧКА (ЧЕРНОВА)", a cancelled one „ПОРЪЧКА (ОТКАЗАНА)"; a
  status it does not know is never called a confirmation. Then the number, the date and the requested
  delivery date; the supplier (the org) and the customer (the contact); the lines as № / article / SKU /
  quantity / unit, a line's own words before the catalogue's; the notes, cut at 500 characters; the
  terms; the "generated on" foot, on the org's own day.
- ⚠ **No price, no amount, no total, on purpose.** A line's `expectedUnitPrice` is an indication unless
  it is pinned, and the invoice may charge the client's own price: a figure on a confirmation is read as
  agreed. It also leaves nothing to redact, so every role gets the same page.
  `unit/customer-order-sheet.test.ts` fails when a money word or one of the order's figures reaches it.
- A draft shows **no number** (FR-22.18: its `DRF-` number goes on confirm). The file is still named
  `<orderNumber>.pdf`.
- ⚠ **Stored text is printed as text**: every name, description and note goes through the renderer's
  `mdText` (see „A printed page runs nothing and fetches nothing"). A new field goes through it.
- **One function**: `renderInternalOrderPdf(orgId, orderId, { locale })` in
  `invoicing-api/src/lib/internal-order-pdf.ts`, with `renderInvoicePdf`'s result shape
  (`{ok, buffer, filename, order}` or `{ok: false, status: 404 | 503, message, detail?}`). The route calls
  it, and so does the mail of the list's ticked orders (kind `internal-order`, „A list's ticked
  documents by e-mail"). Every read names the org (the contact and the
  articles too), a malformed id is 404, and it writes nothing.
- **Route** `GET /org/:orgId/invoicing/internal-orders/:id/export?locale=`. Its gate is `canExport`
  (`sales-docs.export`) ON TOP of the order's read rule (`orders.view`). Both route tables resolve it by
  the existing `invoicing/internal-orders` prefix: no row was added.
- **UI**: „Печат" on the form (`print-order`; an edit not saved yet is saved first, as Confirm does) and
  in every row of the list (`print-order-row`). Both show to `sales-docs.export` and download through
  `useCustomerOrderPrint` → `downloadAsSession`, in the user's language. No new i18n key.
- **Tests**: `unit/customer-order-sheet`, `integration/internal-order-print.flow`,
  `e2e/customer-order-print.spec` (in the `invoicing-inventory` project).

## Orders: client reservations where the order is (2026-10-25, #203)

- **Names.** In all four UI languages the ORDI is an **incoming order** (bg „Входяща поръчка", de
  „Eingehende Bestellung", mk „Влезна нарачка": the client's order comes IN) and the ORDO an
  **outgoing order** („Изходяща поръчка": ours goes OUT to the supplier); the API's messages say the
  same. ⚠ Only words changed: the models (`InternalOrder` / `Order`), the paths
  (`/internal-orders`, `/orders`), the route names, the i18n KEYS (`nav.internalOrders`,
  `nav.externalOrders`), the counters and the ORDI/ORDO prefixes are untouched.
- **Reservations are staged in the ORDO form and saved with the order** — the form no longer posts
  each one at once, which is why a NEW order could not take any. `POST`/`PUT /invoicing/orders`
  accept `reservationChanges: {create[], update[], cancel[]}`
  (`services/biz/order-reservations.service.ts#saveOrderWithReservations`) — ⚠ not
  `reservations`, the deprecated embedded array the controller still ignores. A create names its
  allocation by `allocationId`, or by the `clientKey` of an allocation added in the same save:
  `assignSubdocIds` gives the new subdocuments their ids before the write so the reservation can
  point at one. One transaction holds the order and every change; a refused change saves nothing.
  - `planOrderReservations` (pure) keeps an allocation at or above what its live reservations hold:
    untouched in this save → the legacy **409** message ("…cancel or preempt them before shrinking"),
    changed in this save → **422** naming the allocation.
  - The form keeps `staged {creates, updates, cancels}` and shows them in each line's own
    **client-reservations grid**, a nested, collapsible row under the line, separate from the
    allocation editor, grouped by allocation with „Резервирай за клиент" per group. Its status column
    reads "new" / "cancelled on save". A line holding live reservations opens that grid by itself.
    The open/closed state of both expanders survives the reload after a save (`wasOpen` in
    `loadOrder`), and neither counts as an edit (`_expanded` / `_resExpanded` are kept out of the
    pending-changes snapshot). The P7-who walk reads the grid as the row right under the line. ⚠ After a save
    the staged changes go **in the same tick** the reloaded reservations arrive
    (`loadOrder(id, { clearStaged: true })`): clearing them before the request left the allocation
    empty while the order reloaded, and whatever was typed in that window was lost — the e2e caught
    it. Complete / Cancel order drop them too (a closed order can never save them); Send keeps them.
- **Change, and reserve again.** `POST /invoicing/reservations/:id/update {quantity?, contactId?}`
  (`updateReservation`): never below the consumed `max(invoiced, dispatched)`, raised only within
  free stock / the allocation's free room / the ORDI line's open demand; the client changes only
  while nothing is consumed and no ORDI fixes it. `POST /:id/repeat` (`repeatReservation`) makes a
  cancelled reservation again as a NEW numbered one carrying `repeatOf`. ⚠ The unique partial
  index `{orgId, repeatOf}` is what makes that once-only: a second click answers the first copy
  with `created: false`.
- **Where a product stands**: `GET /invoicing/product-supply/:productId`
  (`services/biz/product-supply.service.ts`; read rule: invoicing OR inventory read) → per warehouse
  onHand / reserved / available / incoming / reservedIncoming / planned, the expected deliveries (sent
  or partly received ORDO lines, outstanding quantity, the clients holding it) and the product's
  reservations. A draft ORDO is `planned`, never `incoming`: nothing was ordered yet. Shown on the
  product's Stock tab (`inventory-ui ProductStockView`), linking into invoicing via `appHref`.
- **On the Products list** (FR-22.45/.46/.48): `GET /warehouse/stock-level/by-products`, the call the
  list already made for its stock badges, also returns `supply: {[productId]: {reserved, incoming,
  reservedIncoming, planned}}` from `getProductsSupplyTotals`. It runs the stock tab's own steps
  (`loadSupplyDocs → incomingAllocations → warehouseFigures`), so there is no second definition of
  "reserved" or "incoming", and three queries serve a page of any size. With `warehouseId` the badges
  AND the totals describe that warehouse only. „Резервирано" / „Поръчано" follow „Наличност", which
  now precedes „Мярка"; each non-zero figure opens the stock tab. `GET /warehouse/product?isActive=
  true|false` (`true` is `$ne: false`: a product without the flag is active); without it, both, as
  every picker expects. The list defaults to active articles (`status` in the URL, a declared
  default), and shows its „Активен" column only when deactivated ones can be listed: that width is
  what keeps the row actions inside 1366 px. Tests: `integration/products-supply-list.flow.test.ts`
  (parity with `getProductSupply`, 5 queries for 5 or 50 products), `unit/grid-column-order.test.ts`;
  the P1 walk goes 6 → 5 clicks through the figure's link.
- **Lists and the ORDI form.** ReservationsView: Source is the ORDO number (linked) or "Stock", the
  ORDI is linked, quantity edit (`ReservationQuantityDialog`) and reserve again, `source` filter in
  the URL. InternalOrderFormView: each line's reservations in a sub-row; a reservation action
  refreshes only the reservations and the derived quantities (`refreshReservations`) — the
  whole-form reload it used threw unsaved line edits away.
- `DELETE /orders/:id` (drafts only) cancels the draft's reservations (`external_order_cancelled`)
  instead of leaving them pointing at a deleted order.
- **A reservation has a screen (FR-22.37).** Made on the Reservations list
  (`ReservationCreateDialog`), opened at `/reservations/:id` (`ReservationDetailView`, fed by
  `GET /reservations/:id` → `{reservation, detail}`: order + allocation, ORDI + line, every invoice
  naming it in any status with the quantity it takes, repeat-of / repeated-as, preempted from / to,
  user names). Every RES number links there, the product's stock tab through `appHref`.
  - The dialog offers only `GET /reservations/sources?productId=&contactId=`
    (`getReservationSources`), computed by the create's own rules: free stock per active warehouse,
    room on allocations of sent / partly received ORDOs, the client's open ORDI lines.
  - ⚠ `/reservations/new` (the „+ Нов" entry) is a REDIRECT to the list with `?new=1`, which the
    list strips once the dialog is open. A route rendering the list itself would give the grid
    another route name: the key of its column preferences and of its remembered filters.
  - Refusals carry a code: `ReservationOpsError(status, message, {code, …figure})`, spread into
    the body and said through `invoicing.reservations.errors.<code>` (`reservation-errors.ts`),
    inside the dialog. The English message is unchanged. `unit/reservation-screen.test.ts` fails when
    the service sends a code the UI does not know.
  - A release is `/cancel` with an explicit quantity, so one that raced an invoice is refused rather
    than freeing something else. All of an unconsumed reservation cancels it; anything less lowers
    it. Buttons „Не" / „Освободи резервацията", the same dialog in the ORDI form (no `confirm()`).
  - `POST /:id/repeat` takes the changes D-4 routes through it (another warehouse, client or
    order): a body naming `source` replaces the supply, one naming `contactId` / `internalOrderId`
    the demand (a client alone drops the ORDI link). Never the product, and still once. A one-click
    repeat refused for a shortage opens the create dialog in repeat mode, the shortage named (§5.7).
- **The order forms (FR-22 slice 4b).**
  - **Coverage has one rule**, `config/order-coverage` (`lineCoverage` / `orderCoverage`), used by
    the ORDI list, the ORDI GET and the form: `full` when what is HELD covers the line, `ordered`
    („Поръчана") when the reservations cover it but part waits on a DRAFT ORDO, else `partial` /
    `none`. A sent ORDO's reservation counts as held. ⚠ `onUnsentOrderQuantity` (per line),
    `reservationCoverage` and `shortQuantity` are derived on READ (`onUnsentOrders` in the
    controller), never stored: sending the ORDO changes them without touching the ORDI.
  - ⚠ **What the server derives per ORDI line (reserved, on unsent orders, invoiced, delivered)
    lives in `lineFigures`, OUTSIDE `form`.** The pending-changes snapshot is the form; a reservation
    action or Convert changes those figures with no edit, and inside the form they made an untouched
    order read „Незапазени промени" (FR-22.13). Both order forms re-take the snapshot after every load
    (`snapshot()` of `usePendingChanges`); the ORDO form only while nothing is staged.
  - The ORDI form opens a blank line once the last one gets an article; lines without an article
    are never sent (`productId` is required). „Резервирай от склад" names the lines it could not
    cover from the response's `short[]`, also when nothing at all was free.
  - `POST /internal-orders/:id/generate-external {orderId?}` appends to a DRAFT ORDO of any supplier
    (a new supplier gets its own group; a target that is not a draft answers 422 `order_not_draft`). The dialog
    preselects the newest draft carrying every supplier of its rows (`order-generate.ts`), else a
    new order, and shows each row's warehouse: the ORDI's, else the default one.
  - Hand-offs land on the next document (FR-22.35): generating opens the ORDO, Convert opens the new
    draft invoice and its message still says what stays reserved. Both forms list their invoices
    from `lookup.invoices` (`OrderInvoicesCard`, FR-22.36), each opening in its own form.
  - Cancel and Complete confirm first (FR-22.41, `OrderCascadeDialog`) with what they release,
    counted by `order-cascade.ts` on the server's rule (`reservationReleasable` > 0 on a reservation
    not cancelled): an ORDO names the ORDIs it lets down, an ORDI says what sits on stock and names
    the ORDOs. Cancel always asks; Complete asks when it releases something (the ORDO: or when
    changes are staged). Both still run through `doAction`, which drops staged changes.
  - The ORDI and ORDO actions pass the service's `{code, …figure}` through like the reservation
    endpoints; the ORDO's own cancel refusal is `order_has_invoices` (`ORDER_ERROR_CODES`).
  - The Reservations list's `search` matches the RES number, and the clients, articles (name or
    SKU) and ORDO / ORDI numbers it matches first — each resolved to at most 500 ids.
- **Tests**: `integration/order-form-reservations.flow.test.ts` (12), `integration/reservation-screen.flow.test.ts`
  (10), `integration/order-screens.flow.test.ts` (6), `e2e/tests/orders-reservations.spec.ts` (3),
  `e2e/tests/reservations-page.spec.ts` (5), `e2e/tests/order-forms.spec.ts` (10). The FR-22
  walks take the shorter routes and assert them (`e2e/tests/ux-budgets/p7-*`):
  P7-chain 27 → 26 clicks (the ORDO number is a link on the ORDI) → 18 (slice 4b: an article opens
  the next line, each hand-off lands on the next document, the invoice is issued on its own form),
  P7-repeat 4 → 3 („Резервирай отново" on the row), P7-who 2 + a second page → 1 (answered on the
  ORDO), P7-new 4 (a reservation made on the list). `e2e/tests/orders-product-autocomplete.spec.ts` (in `invoicing-inventory` since
  2026-10-27) checks the product search on both order forms: server search, ↓ keeps the results
  open, Enter picks. The invoice form's copy is `invoicing-product-autocomplete.spec.ts`.

## Flat 7-tab Product Route (2026-04-21)

Routes: `/inventory/products/:id/:tab` where `tab ∈ {edit|pricing|settings|stock|ledger|movements|levels}`. `/products/:id` redirects to `/edit`, `/products/new` to `/new/edit`. Shared `ProductTabBar.vue` component at top of both ProductFormView and ProductStockView navigates between siblings via named routes (works in both inventory-ui and desktop-ui). `new` mode disables stock/ledger/movements/levels tabs with "save first" tooltip.

## A stock booking is one transaction (FR-29 A, #794)

`confirmMovement` (`services/biz/warehouse.service.ts`) stores a movement's levels, cost layers and
`completed` together or not at all. Before, a line that failed kept what the lines before it had moved,
and each retry moved them again.
- The claim (`claimedUntil`) is still taken OUTSIDE the transaction, so a second confirm is told at
  once (409 `movement_busy`). A confirm that fails releases its own claim before it answers.
- **`{ session }` joins the caller's transaction** and starts none. The caller then commits or aborts
  both, and sends `stock.movement.confirmed` itself AFTER its commit (`announceMovementConfirmed`).
  ⚠ A caller that catches the booking's error must abort, never commit.
- ⚠ **Every write of the booking carries the session**: `adjustStock`, `moveLevel`, `createCostLayers`,
  `consumeCostLayers`, `restoreCostLayers` take it. A write without it commits at once, outside the
  booking. `movement-confirm-atomic.flow` reads the driver's own calls and fails on one.
- ⚠ **Never two operations at once on a transaction's session** (`Promise.all`). Both try to start
  the transaction, and `withTransaction` runs the whole booking again.
- A duplicate key inside a transaction aborts it, so a level two bookings create at the same moment
  makes the booking run again (`services/biz/transaction.ts#inTransaction`), not `adjustStock`'s
  land-on-the-row fallback.
- A cost-layer refusal is `StockBookingRefusedError`: 422 `no_cost_layer` / `insufficient_cost_layers`,
  with the article's name and SKU and the warehouse's name, on every route (`spaErrorHandler`). It
  was a 500 naming two ids.
- The repository methods take `{ select, session }` as their last argument (FR-32.14).
- **Issuing is one service** (FR-29 B, `services/biz/issue-document.service.ts#issueDocument`), behind `/send` and
  `/receive`. Each route keeps its checks, its questions and its claim (the `issue` lease). Then one transaction:
  the stock (joined), the issued number LAST (so a failed issue draws none), the status, only while the draft is
  still this request's (`heldBy`). Events, the audit row, the order and the prices come after the commit, in the route.
  - ⚠ **A retry finishes what an earlier attempt left** (`createInvoiceStockMovement`'s `resume`): per warehouse a
    completed movement carrying the document's id stands, a draft one is removed and booked afresh. It is never
    skipped: `/send` used to skip "a movement with this id exists", issuing the invoice with its goods unmoved.
  - `scripts/count-issue-leftovers.ts` (read-only, native driver) counts what older releases left: documents issued
    with a draft movement, drafts with a booked one.

## External warehouse (2026-11-16)

The owner's ask: a warehouse can be marked **external**: another site's warehouse, named in this org
so a transfer can say where the goods went or where they came from. No stock is kept on it here. The
movement is a document for the colleagues on the other side, who keep their own stock in their own
org; booking the other org's side waits until the two catalogues agree on names.

- **`Warehouse.isExternal`** (rules in `config/src/external-warehouse.ts`: pure, shared by the form
  and the server). Never default and external together: 422 `external_default`. A warehouse does not
  BECOME external while a `StockLevel` of it has `quantity != 0` or `reservedQuantity > 0`: 422
  `warehouse_holds_stock`, with `articles` (how many). External → own is always allowed. ⚠ That
  check reads the levels alone: a draft movement or an ORDO allocation that names the warehouse does
  not stop it.
- ⚠ **`GET /warehouse/warehouse` answers only the warehouses that keep stock.** Every picker in every
  app lists through this route, and none of them may offer an external one. `?external=include`
  answers all (the Warehouses page, the movement form, the movements filter), `?external=only` the
  external ones; any other value is the default.
- **The server's "default, else first warehouse" fallbacks skip one**: doc-import (`persist.ts`,
  `map-movement.ts#resolveWarehouse`), Files (`doc-pipeline`, `compare-snapshot`, `doc-reconcile`),
  `orders-from-products`. The ops scripts that list warehouses over the API get the default above.
  ⚠ The few that read `Warehouse` from the database themselves do not skip one.
- **Only a transfer names one, with a warehouse of our own on the other side**
  (`config/src/movement-warehouses.ts#movementWarehouseRefusal`, told `fromExternal` / `toExternal`
  by `services/biz/external-warehouses.ts#movementExternalSides`). 422
  `external_warehouse_not_transfer`: a movement of any other type names one. 422
  `transfer_without_own_warehouse`: a transfer names no warehouse of our own. Doors:
  `movement.controller` POST `/`, POST `/with-update`, PUT `/:id`, POST `/:id/confirm`;
  `/doc-import/convert`; `doc-import/commit.ts`; the movement form, before it sends anything. The
  flag is read at the door and never remembered on a draft, so a draft whose warehouse became
  external since is judged at `/confirm`. Opening stock writes levels past the engine, so it refuses
  one at its own door (422 `external_warehouse`). A transfer-only session (FR-26.7) writes both
  directions: an external warehouse counts as a named side.
- ⚠ **Completed, `fromWarehouseId` / `toWarehouseId` name only warehouses whose stock the movement
  moved.** `confirmMovement` books an external side as if the movement named none (no level, no cost
  layer; goods from one arrive at the line's cost, as a receipt's do) and, in the update that
  completes it, moves that id to `externalFromWarehouseId` / `externalToWarehouseId`. Every reader
  that derives stock from movements relies on it, and none reads the pair. ⚠ It is NOT a refusal in
  `confirmMovement`, which never refuses (see its note): the engine is the last line of defence for
  what passes no door (an import, a replay, a count, the legacy POS). A draft keeps the form's choice
  in the two stock fields.
- ⚠ **Goods from an external warehouse that say no cost arrive at what the article costs here**
  (`warehouse.service#costsAt`: the average of its level in the receiving warehouse, so the arrival
  moves no average; with no level, its purchase price; with neither, zero as before). A role that does
  not see costs posts `unitCost: 0`, and averaged in at zero every delivery from the other site
  pulled the average down. The line keeps the `unitCost` it said; `resolvedUnitCost` is what was
  booked. ⚠ Only for an external From: a transfer between two of our own warehouses still books the
  destination at the line's `unitCost` under WAC, zero included (older than this feature, not changed
  here).
- ⚠ **A sale or a bill never names one.** `invoicing.service#stockBooking` refuses a document whose
  product line names an external warehouse (`stock_line_external_warehouse`): `/send` answers 400
  before a number is drawn, `/receive` 422, and the till's sale reports it as its stock error. No
  picker offers one on a document, so this is a warehouse that became external after the line was
  written (an order's allocation, a pinned default) or an API client. Booking nothing there would be
  a document issued with its stock unmoved, which is what the function's two older refusals exist to
  stop.
- **Reading the other side**: `fromWarehouseId || externalFromWarehouseId`. `sideIsExternal`
  (`config/external-warehouse`) is the one rule behind `fromExternal` / `toExternal` on the list, on
  `GET /:id` and on the print: booked, the pair says so; a draft, the warehouse as it is now. The
  list's `warehouseId` filter and its two name sorts follow the pair. ⚠ The `stock-movements` report
  and the product ledger read the stock fields alone: the external side is blank there. The digest
  files every transfer under „transferred", whichever way it went.
- ⚠ **A transfer posts no journal entry** (`createMovementValuationEntry` books receipts, dispatches
  and returns only), with an external side as without: goods sent to another site leave the stock
  and stay on the inventory account.
- **Print**: `GET /warehouse/movement/:id/export?locale=` answers `<movementNumber>.pdf`, draft or
  booked, to whoever may read the movement. `services/biz/stock-movement-document.service.ts`
  (`renderStockMovementPdf`: one function for the route and for anything that sends the sheet on),
  `reporting/pdf/stock-movement.pdf.ts` (`buildStockMovementHtml`), `reporting/stock-movement.i18n.ts`
  ×4. The title follows the type („Стокова разписка" a receipt, „Складова разписка" a transfer, a
  general title with a type row otherwise); then number, date, From / To with „(външен)", partner,
  reference, note, the lines (№, name, unit, quantity) and two signature lines. ⚠ No price and no
  total: a line's `unitCost` is a cost not every role sees (on a sale's dispatch, the sale price),
  and the sheet leaves the org. UI: Print on the movement form and on each row of the list
  (`inventory-ui/composables/useMovementPrint.ts`), downloaded as the tab's session.
- **By e-mail**: the movements list mails its ticked movements, each as this sheet (kind `movement`
  in „A list's ticked documents by e-mail"). Transfers open the dialog on „До един адрес": the
  colleagues of the other site. A draft and a cancelled movement are not mailed.
- **Screens**: `WarehouseFormView` (the switch; Default and External exclude each other),
  `WarehousesView` and `MovementsView` (a chip; the filter lists external ones marked),
  `MovementFormView` (an external warehouse is offered on a transfer only and is cleared when the
  type changes; a note says which stock the transfer changes; from an external one the line reads
  the destination's stock and no quantity is prefilled). Keys in `warehouse.*` ×4.
- **Tests**: `unit/external-warehouse.test.ts`, `unit/stock-movement-document.test.ts`,
  `integration/external-warehouse.flow.test.ts`, `e2e/tests/external-warehouse.spec.ts`
  (`invoicing-inventory`). ⚠ The spec names its warehouses to sort LAST and scrolls the picker: a
  warehouse is never removed, and a select renders only the rows in view, so leftovers sorting first
  would push the seed's warehouses out of the other specs' pickers.

## DIN/ISO Fastener Catalog + Product Tagging (2026-08-03)

Global reference collection **`din_catalog`** (model `DinCatalog`, no tenantPlugin — like ExchangeRate; explicit collection name) holds 165 DIN↔ISO/EN rows in 12 Bulgarian categories from the „DIN ↔ ISO/EN разширен каталог крепежни елементи" DOCX; data committed at `scripts/data/din-catalog.json`. `scripts/seed-din-catalog.ts` upserts it and (with `--org`) creates the 12 `ProductCategory` docs. `scripts/assign-din-tags.ts` derives **product tags from NAMES** — `DIN 933` (+whitelisted variants 7504-K/M/N/O/P/R, 125-A/B, 7380-1/2, 976-1; junk-proof against "- K 8.8" class markers), catalog cross-tags (`DIN 933`→`ISO 4017`, `EN 14399-4`→`DIN 6914`), canonical Cyrillic dimensions (`М8Х25`/`Ф90Х529`/`6Х70`, pipe fractions `1/2Х3/8` excluded), coating/material/strength (`ZN`/`BL`/`HDG`/`YELLOW ZINC`/`A2`/`A4`/`МЕСИНГ`/`6.8|8.8|10.9|12.9`) — via `$addToSet` + Tag vocabulary upserts, and **recategorizes** catalog-DIN products (first DIN wins; only out of „Общи"/the 12 unless `--force-category`; sets category+categoryId+categoryLower explicitly since bulkWrite bypasses loweredFieldsPlugin). Extraction: `packages/services/src/biz/fastener-tags.utils.ts` (import-pure; tests `packages/tests/src/unit/fastener-tags.test.ts`). ProductsView category filter now loads from `/warehouse/product-category` (was: derived from first page of products). Ops: re-run assign-din-tags after `receive-new-products`; after `seed-products --clean` re-run BOTH scripts (clean wipes tags+categories). Skill: `.claude/skills/assign-din-tags/`. ⚠ Bun transpiles Cyrillic regex literals to `\uXXXX` — never send them to Mongo as `$regex` (PCRE2 error 51091); query tags by equality.

⚠ **A product carries its category twice**: `categoryId`, which the form edits, and the `category` name that lists, reports and imports read. Some articles carry only the NAME: on 2026-10-26, every product of the `regal` org and of the acme seed. On load, `ProductFormView` links such a name to the one category that carries it. Otherwise it shows the name as the field's placeholder and keeps it on save, and only clearing the field drops it. Until 2026-10-26, saving such an article wrote `category: ''` (regression test: `e2e/tests/product-category.spec.ts`).

## Supplier facts: read from the documents, never stored (FR-28, #622, slices 2 and 7)

- **Who we buy an article from is READ every time**, never kept (`services/biz/product-suppliers.service.ts`:
  `getSupplierFacts`, `findProductIdsBySuppliers`, `findProductIdsWithoutSupplier`). Evidence: a received bill
  (`direction: 'incoming'`, `type: 'invoice'`, status received / partially_paid / paid / overdue) and a completed
  receipt that no bill covers and that carries a `contactId`; a bill and the receipt it covers count once. Drafts,
  voided or cancelled bills, incoming credit and debit notes, reversed or `recordOnly` receipts and supplier orders
  never count. ⚠ A stored "last price" would go on showing a corrected bill's old price: documents are editable in
  every status and nothing re-posts.
- ⚠ **Only a caller with `bills.view` gets them** (`canSeeSupplierFacts`; `canSeeSupplierPrices` for the price): for
  anyone else the KEYS are absent from the answer and a `supplierId` / `noSupplier` filter is a 403. The Suppliers
  tab, column and filters are not drawn for such a role, so a warehouse manager who may edit products but not read
  bills sees no Suppliers tab and cannot record a supplier (a known follow-up).
- **The default supplier of an article is ONE function, `getDefaultSuppliers`**: the recorded preferred supplier
  (while that contact is still an active supplier), else the supplier of the most recent purchase, else the supplier
  of the newest supplier order with a line for it, else none. The order dialog's preview and
  `getInternalOrderSuggestions` (the customer-order form's `supplierHint`) both ask it.
- **Recorded suppliers** (`ProductSupplier`, `docs/models/warehouse/product-supplier.md`, replication class **R**,
  `services/biz/recorded-suppliers.service.ts`): what a PERSON writes on the article's Suppliers tab: `preferred`,
  `supplierSku`, `leadTimeDays`, `note`. `PUT` / `DELETE /warehouse/product/:id/suppliers/:supplierId` need
  `products.edit`; the supplier must be an ACTIVE supplier or both contact of the same org. ⚠ `preferred` is unique
  per article by a PARTIAL unique index, so setting one clears the previous one first (a moment with none, never
  with two). No bill, receipt or import writes one, and clearing one leaves a supplier the documents name listed
  with its facts. The Products list's Suppliers column lists a supplier only a person recorded (`documents: 0`), and
  the search matches `supplierSku` through its lowered mirror (never a Cyrillic `$regex` from Bun).
- **Receipts name their supplier**: `scripts/receive-stock-api.ts` and `receive-new-products.ts` resolve the PlusMinus
  `partner` by EXACT normalized name (`doc-import/supplier-name.ts`, `scripts/lib/supplier-partner.ts`: case and
  whitespace folded, the `ПАРТНЬОРИ:` prefix stripped, no homoglyph folding, an ACTIVE supplier or both contact, never
  a natural person) and post its `contactId`. They create no contact and do not use the matching ladder's fuzzy
  rungs (a miss is reported, not guessed); the run ends with the partners it could not resolve and their documents.
  ⚠ **The same words with other punctuation are the same name** (`foldName`, the second rule of
  `pickSupplierByName`, since 2026-11-11): PlusMinus prints a document's partner from its partner list („КАМ - 04
  ООД") and keeps the supplier ledger LGR was seeded from in another spelling („КАМ-04 ООД"), which alone left a
  third of the shops' named receipts without their supplier. A shorter, longer or respelled name („REYHER" for
  „F.REYHER Nchfg.GMBH", a missing ООД) is still nobody to a rule: that needs a person, who says it once on the
  contact (next bullet).
  ⚠ An importer never changes a booked receipt (a movement is editable only as a draft): add the supplier BEFORE
  the next run, or name the receipt afterwards with the backfill below.
- **A contact's other names: „Also known as" (`Contact.aliases`, 2026-11-11).** The names a company is written
  under on documents besides its own, typed on the contact form (chips; a name typed and not confirmed with Enter
  is kept by the save). Stored cleaned by ONE function, `config/contact-aliases#cleanContactAliases`, in the form's
  payload and again in the route: trimmed, single-spaced, each once whatever its case, never the contact's own
  name; at most 50, each up to 200 characters (422 beyond). A contact with none keeps neither `aliases` nor its
  mirror `aliasesLower` (`loweredFieldsPlugin` mirrors a list entry by entry now), so nothing changes for the
  contacts that existed before. Who reads them:
  - `pickSupplierByName` asks four questions in order, and the first that any active supplier answers decides
    (one: matched; several: ambiguous): named exactly so; named by the same words; keeps exactly this as an other
    name; keeps the same words as one. ⚠ **A supplier's own name always comes first, so an other name only fills
    a gap**: it can never take a receipt from the supplier that is named so, and no match that worked before it
    changes. ⚠ Each question is answered from the candidates given: a caller holding a PARTIAL set (a search's
    answer) asks the own names over everything it can fetch before it reads any other name. That is why
    `scripts/lib/supplier-partner.ts` and `matching.ts#matchSupplierByName` pass candidates without their other
    names first, and only then with them.
  - `matching.ts#matchContactByName` (the Files import's contact ladder, either side): after a contact NAMED
    exactly so and before the every-word guess, the one contact that keeps exactly this as an other name; two
    are refused, never picked from; the document's tax number still rules a contact out.
  - The contact search (`GET /invoicing/contact?search=`), so the list and every picker find a contact by an
    other name. ⚠ The receipt scripts' resolver finds its candidates through that search: dropping `aliases` from
    the searched fields silently turns every other name off for the daily import.
  - The backfill below (`rule: 'alias'` in its plan and manifest).
  ⚠ `describeMatch`'s two ⚠ lines („no active supplier is named …", „N active suppliers are named …") are a format
  the daily import's log checks read by their opening words: do not reword them.
- **The daily import settles the day's contacts FIRST, from PlusMinus's own partner directory
  (`scripts/import-contacts-api.ts`, family `contacts` of `daily.ts`, 2026-11-12).** The receipts and invoices
  look a supplier or customer up by name, so a partner no contact carries used to arrive as a receipt with no
  supplier, or as a customer created by name alone. `pull-api.ts --families partners` writes `partners.json` into
  the day folder (ONE `apProperties("ДОСТАВЧИЦИ:; КЛИЕНТИ:; ПАРТНЬОРИ:; КОНТРАГЕНТИ:")` call, the vendor client's own
  `loadPartners`): `КЛИЕНТИ` is a shop's customer ledger, `ПАРТНЬОРИ` every name a document ever used (suppliers
  included), each with БУЛСТАТ, ИНДДС, АДРЕС, ГРАД, МОЛ, ТЕЛ./ТЕЛЕФОН. The rules are `doc-import/map-plusminus-partner.ts`
  (pure, tested) and are deliberately narrow:
  - **Which partners**: the ones the day's documents name, a sales invoice's customer and the supplier of a receipt
    that brings stock IN (a price-only restatement, a pure outgoing correction, the КОРЕКЦИЯ placeholder and the org's
    own stores buy nothing), plus, only with `--all-clients`, every `КЛИЕНТИ` entry PlusMinus identifies. Never the
    whole `ПАРТНЬОРИ` list: thousands of names never traded in the period LGR holds.
  - **Who it is in LGR**, in order: the same ЕИК/VAT number (a branch's 13 digits find its head office's 9; a
    placeholder like 999999999 finds nobody), the same name or one of the contact's other names, the same words with
    other punctuation. A contact of that name holding a DIFFERENT ЕИК is another company: a `conflict` for a person.
    Several contacts sharing a number do not stop the run: the one that already plays the role the documents give the
    partner (a receipt's supplier is the supplier, an invoice's customer the customer), then the named one, else the
    oldest (#762: a company held twice, as a customer and as a supplier, used to be settled on the older of the two and
    widened to `both`, which left two active suppliers answering to one name and the receipt with none; the same
    preference applies to a match by name); two that merely share another name, or only the words, are `ambiguous`; only
    a deactivated contact fits: `inactive`. Each of those is an `ACT` of `daily.ts dry`, and nothing is written for it.
  - **What is written**: a contact nobody holds is created with what PlusMinus knows; a contact somebody holds is
    FILLED WHERE EMPTY (ЕИК in `taxId` and `taxNumber`, VAT, phone, address, МОЛ in the notes), given the documents'
    name as one of its other names when the match was made by number or by the words, and widened to `both` when the
    documents use it in a role no other contact of that number plays. **Nothing a person typed is overwritten, nothing
    is deleted or deactivated.** Twins that already exist are not merged either: that is a person's call on the contact
    form, and `scripts/backfill-receipt-suppliers.ts` then names the receipts left without a supplier.
    A SUPPLIER of a receipt that PlusMinus knows by name alone is created by name (a receipt can only name a supplier
    that exists), with a note saying so and the contacts that start with the same word listed for a person to merge;
    a customer PlusMinus says nothing about is left to the invoice import.
  - ⚠ **The civil number (`ЕГН`) is never read**; a sole trader's БУЛСТАТ can be their ЕГН and the seeded contacts
    already carry it, but this neither copies the field nor widens that.
  - `--max-create` (default 80) refuses a run that would create more; the one-off catch-up of a shop's whole
    `КЛИЕНТИ` ledger is `daily.ts book --family contacts --all-clients --execute` after reading its dry run.
  The log lines `Planned: …` and `Done: …` are a format `scripts/lib/daily-import.ts#parseContactsLog` reads.
  A price on a receipt line that is no number ("1.741.5700", "1,74") is reported with a proposed meaning and NOT
  written (`map-plusminus-stokrazp.ts#parsePrice`): the stores correct their cards, LGR follows for the flagged products.
- **A receipt booked without a supplier: `scripts/backfill-receipt-suppliers.ts --org <slug>`**
  (`scripts/lib/receipt-supplier-backfill.ts`). The partner's NAME is still in LGR: in the notes the API importers
  wrote (`deliveryNote`, read back by `config/movement-notes#deliveryNotePartner`), or in the analysis of the Files
  document that booked it, as the warning for a partner no contact matched (`supplier-name.ts#unmatchedPartnerOf`).
  ⚠ That warning's opening words are stored with every analysed document: they are built by
  `unmatchedPartnerWarning` and pinned by a unit test, so do not reword them without a reader that still takes the
  old ones. Same rule as the importers, and it writes `contactId` and nothing else, as a bill made from a receipt
  does (`claimReceipts`), with an audit entry. Dry run by default, counts only (`--names` lists the partner names
  that matched no single active supplier: an org's partners, keep that output private); `--execute --expect <n>`
  writes a manifest first; `--undo <manifest>` takes a run back unless a document claimed the receipt since. Left
  alone: a receipt that says it is no delivery (`noteSaysNoDelivery`), a rolled-back or record-only one, one a
  document holds, one whose partner is written nowhere. ⚠ An org with no supplier contacts resolves nothing: its
  suppliers come first. Idempotent: run it again after adding a supplier.
  - **A receipt that keeps no partner at all** (everything booked before 2026-09-08, when the import first recorded
    one): `--partners <file>` gives the partner PlusMinus holds per document number, and the receipt says which
    document it is in its marker (`stokrazp:<n>`). Make the file with `--collect-partners <dir> --out <file>` from a
    pull of the period (`pull-api.ts --families stokrazp --no-snapshot --dest <dir>`); it holds partner names, keep it
    out of the repo.
  - **One more rule lives only here**, because it needs every contact: a partner whose name is exactly a CUSTOMER's
    is the supplier that carries that customer's tax number, when exactly one does (the same company, kept twice).
  - ⚠ A stock note prints „Доставчик:" on the line above its items table. Until 2026-11-11 the parser read past the
    end of a blank one and stored the table's HEADER row as the partner's name (`parse-table.ts#statedSupplier`
    now stays on the line; `isItemsTableHeader` is how the backfill knows such a stored name is nobody).
- ⚠ **"Below minimum" and "To order" need minimums, and nothing imports one.** They read `Product.minStockLevel`
  and `maxStockLevel`; an org that has set none sees both empty (the stock range filter does not need them).

## One product search, and orders from the Products list (FR-28, #622, slices 3 and 4)

- **One engine** (`ui-shared/composables/product-list`: `useProductList`, `product-list-params`,
  `useProductColumns`, with `ProductFilterBar` and `ProductCell`) runs under the Products page AND
  `ProductPickerDialog`, which is the Products list in a window ("Details"): the same filters, the same columns, the
  user's saved column choice (`inventory.products`). `multiple` adds a tick column and "Add N articles", in the order
  ticked; `stockWarehouseId` scopes the figures, never the rows; `source="till"` reads the cash register's catalogue.
  A screen that picks an article takes the dialog; it does not write a search of its own.
- **The hit row** (`product-hit`, in `ProductSearch` and `ProductLineDescription`): the name, then SKU · unit · stock ·
  price, and "Show all N results"; F4 or `ProductDetailsButton` opens the dialog with what was typed. **Active
  articles only**, in the inline search as in the list, the dialog and the till. A caller who may read bills also
  finds an article by its supplier's own code.
- ⚠ A Vuetify server table asks for its page when it mounts, so the engine keeps ONE request in flight per set of
  parameters and a closed dialog does not fetch (`active`); a spec counts the requests (FR-28.29).
- ⚠ **A picker searched on the server REPLACES its list with each answer** (`ui-shared/composables/useContactSearch`:
  what the server found, plus the chosen ones so their chips keep a name). The Supplier filter once merged every
  answer into one growing list under `no-filter`, a field that filters nothing itself, so typing changed nothing on
  screen (2026-11-11). Do not write another search for a contact picker: use that composable. The filter also has
  `hide-selected`, so its menu is only what the typing matches.
- **The list reads on one line** (owner, 2026-11-11): a code never wraps (`.sku-cell`, cut only past 220 px), and
  the name column is never narrower than `NAME_MIN_WIDTH` (360 px: a 36-character name in capitals). ⚠ The price is
  FR-22.23's old fit: at 1366 px the list scrolls sideways even with the price tiers hidden, the name and the row menu
  pinned; `product-actions.spec` holds the pinning there, the fit at 1920 px, and the one line. Each supplier in the
  Suppliers column is a badge (`v-chip`, as each warehouse is in Stock), cut inside itself, never across the cell.
- **Selection and orders** (FR-28.13 to .21): `ListScaffold` `selectable` + `v-model:selected` hold ids across pages;
  "all that match" travels as the FILTER, never as ids, and the server resolves it with the list's own builder
  (`services/biz/product-list-query.ts#resolveProductListFilter`, one function for the list and the preview). The cap
  is **500** (422 `selection_too_large`). `services/biz/orders-from-products.service.ts`:
  `POST invoicing/orders/from-products/preview`, `POST invoicing/orders/from-products` (ONE draft supplier order: a
  group per supplier, a line per article, one allocation of the whole quantity, by the builder `generateExternalOrder`
  also uses) and `POST invoicing/internal-orders/from-products` (ONE draft customer order). They need what creating an
  order by hand needs. ⚠ **Idempotent on `requestId`**, made once per dialog opening: `createdFrom { source,
  requestId }` under a PARTIAL unique index (a `sparse` one indexes every document under a null id and refuses the
  second); an append goes to a DRAFT only, is one conditional update, and a replay answers `replayed: true`.

## Orders as a tree (FR-28, #622, slices 5 and 6)

- **One component, two orders**: `invoicing-ui/components/order-tree/OrderTree.vue` draws the node models of
  `invoicing-ui/composables/order-tree/` (plain code, no Vue, unit-tested): `supplier-order-tree.ts` (a line, under it
  its warehouses, under those the clients reserved there), `customer-order-tree.ts` (a line, under it the reservations
  that cover it) and `supply-tree.ts` (the reservation page's), with ONE set of figures (`figures.ts`) and `tree-rows.ts`,
  `columns.ts`, `links.ts`. A parent carries what its children add up to, in the same columns. The save payload did not
  change: a reservation is staged and saved with the order.
- ⚠ **Free is two things, by level**: a supplier-order line's Free is ordered minus allocated, a warehouse's is
  allocated minus reserved (so a line's Free is not the sum of its warehouses'); on the customer order the column is
  "Short" (needed minus reserved). The header says so in a tooltip. On the customer order Reserved is added up from
  the rows, while Invoiced and Delivered stay the server's per-line figures (an invoice can name a line without
  naming a reservation).
- ⚠ **A geometry spec must check that every VALUE fits its field, not only that the table does not scroll.** Slice 5
  passed a spec that measured the table and shipped number fields that clipped three digits ("100" read "10", #632).
  `customer-order-tree.spec` reads a quantity of five digits and a price of 9,999.99 whole at 1366 and 1920 px, panel open and folded.
  The tree measures its room and drops a column its screen marks `optional` (Dispatched / Delivered, whose figure moves
  into Invoiced's tooltip) rather than scroll; cells carry `data-col`, and specs find a cell by it, never by position.
- The reservation page (`ReservationDetailView.vue`) shows the supply a reservation hangs on as a tree (`supply-tree.ts`),
  and the Reservations list and that page link to the exact line of the order they are under (`?line=`, `links.ts`): see
  FR-28 §11 (`docs/fr/FR-28-supplier-facts-product-search-order-tree.md`), slice 6.
