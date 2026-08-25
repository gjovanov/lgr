# FR-07 — „Складови операции" / Warehouse Operations report

**Goal:** A report that traces **purchases and sales of goods** for a period, aggregated
**per article** with quantities, prices, values and average price (legacy PlusMinus
„Складови операции"), filterable by period, operation (purchases | sales), warehouse,
document type, product, product group and contact — with **column show/hide/reorder that
works AFTER generation without regenerating**, on-screen grid plus XLSX/PDF export.

Status: draft for implementation · Date: 2026-08-25 · Depends on: **FR-06** (this report is
a registry entry + handler in the Reports app — issue #14) · Feeds: nothing.

Source requirement: „Spravki ledger.docx" §1 — full Bulgarian text in the appendix. Legacy
screenshots (`word/media/image1.png`, `image2.png` inside the docx) show the target: rows =
products, columns Име / Мярка / Количество / Цена / Стойност / Средна цена / Ст-ст по ср.
цена / (Ср. цена АП / Ст-ст по ср.цена АП / Печалба склад / Печалба счет.), a **Всичко**
totals row, and a filter panel (Период, Операция, Склад, Тип на док., Име, Група,
Партньор) with an „Изведи" (Generate) button and a „Колони" button usable post-generation.

---

## 1. Current state (master @ `dc1422c`, anchors may drift)

**Data sources.** A warehouse operation in LGR is a `StockMovement`
(`packages/db/src/models/stock-movement.model.ts`):

- `type` enum `['receipt','dispatch','transfer','adjustment','return','production_in','production_out']` (`:50-54`), `status` enum `['draft','confirmed','completed','cancelled']` (`:55`), single `date` field (`:56`), `fromWarehouseId`/`toWarehouseId` both optional (`:57-58`), `contactId` (`:59`), **`invoiceId` (`:60`) — the only structured link to the source document**; `inventoryCountId` (`:88`, FR-04). There is **no** `reference`/`sourceModule` field; imports carry idempotency markers in free-text `notes` (`doc-import/types.ts:181`).
- `lines[]` (`:63-81`): `productId` (req), `quantity`, `unitCost`, `totalCost`, `batchNumber?`, `costAllocations?[{costLayerId,quantity,unitCost,totalCost}]`, `resolvedUnitCost?`, `costingMethod?`.
- Indexes (`:95-98`): `{orgId,type,date:-1}`, `{orgId,'lines.productId',date:-1}`. **No index on from/toWarehouseId or contactId.**

**How movements get their prices** (`packages/services/src/biz/invoicing.service.ts:242-304`
`createInvoiceStockMovement`): one movement **per line-level warehouse**; type matrix:
credit_note → `return` (side by direction), outgoing → `dispatch`/from, incoming →
`receipt`/to; `invoiceId: invoice.id` is set, **`date: new Date()` (booking time, not the
invoice's `issueDate`)**, and `lines[].unitCost = l.unitPrice` (`:286`) — i.e. **on
invoice-born movements `unitCost` is the document price** (sale price on dispatches,
purchase price on receipts). Import-born receipt movements (stokrazp) carry the delivery
price; at org `regal` most goods receipts are exactly these — imported movements **without**
`invoiceId`.

**Per-product precedent** — `packages/services/src/biz/product-ledger.service.ts`:
aggregation `$match → $unwind lines → $lookup warehouses/invoices/contacts` (`:82-155`),
`isIncoming = ['receipt','return','production_in'].includes(m.type)` (`:216`), transfers
yield two rows (`:190-213`), status filter `{ $in: ['confirmed','completed'] }` (`:70`).
Its sales summary matches invoices `type $in ['cash_sale','invoice'], direction:'outgoing',
status $nin ['draft','cancelled','voided']` on **`issueDate`**, warehouse via
`'lines.warehouseId'` (`:377-401`).

**Invoice model** (`packages/db/src/models/invoice.model.ts`): `type` enum incl. the FR-01
merged sales/purchase families (`:167`), `direction` (`:168`), **no `date` field — only
`issueDate`** (`:185`), `warehouseId` per line only (`:202`), `currency` + `exchangeRate`
(`:187-188`).

**Product group**: `Product.category` (denormalised name, required, `product.model.ts:105`)
+ `Product.categoryId` (optional, `:106`); `ProductCategory` has `parentId` hierarchy
(`product-category.model.ts`). Contact `type ∈ customer|supplier|both`
(`contact.model.ts:64`).

**Report rendering house style** (freshest pattern, FR-03): `packages/reporting/src/excel/
cash-agg.excel.ts` — `AggColumnDef` map keyed by UI catalog keys (`:37-55`),
`pickAggColumns` (`:64`), `sectionTotals` (`:69`), per-currency sections (`:99-131`);
`pdf/cash-agg.pdf.ts` reuses the same column defs (`:5-10`) and exports `buildCashAggHtml`
for renderer-free tests (`:116`). i18n ×4 in `packages/reporting/src/i18n.ts` — header keys
today lack `warehouse`, `category`, `date`, `avgPrice`, `cost`, `profit` (`:38-64`).

**Grid machinery (all shipped with FR-05, free to reuse):** `ListScaffold` gives every grid
a cog → `GridColumnPickerDialog` with show/hide + drag reorder, persisted per user/org/grid
(`useGridColumns.ts:39` storage key; `reorder()` `:132`) — **column settings after
generation cost zero new code**. `useListQueryState` (`ui-shared`) syncs filters to the URL.
`ExportDialog` emits `{format, mode, columns, aggregated}` but its column catalog is
hard-wired to invoicing doc types (`useExportColumns.ts`) — a new catalog constant is
needed for this report's columns.

**No `/org/:orgId/reports` namespace exists yet** — FR-06 creates it (registry
`packages/services/src/biz/report-registry.ts`, `GET /reports/catalog`,
`POST /reports/:id/run`, `POST /reports/:id/export`). The closest existing report endpoint
is `invoicing/reports/aging` (`aging-report.controller.ts:9-117`). Export permission gate
precedent: `invoicing-api/src/lib/export-access.ts:15` (`canExport`); no warehouse-side
equivalent exists.

## 2. Requirements

### 2.1 Registry entry (rides FR-06)

- **FR-7.1 (MUST)** New report-registry entry `id: 'warehouse-operations'`, category
  `inventory`, `permission: 'inventory.read'` (fallback to the FR-06 permission decision if
  it lands differently), `outputs: ['table','xlsx','pdf']`. Adding it = one registry entry +
  one handler per FR-6.6; the generic ReportRunner UI renders it — **no bespoke view**.
- **FR-7.2 (MUST)** Params (all optional except period + operation, combinable per the
  docx): `dateFrom`/`dateTo` (period presets per FR-6.11), `operation: 'purchases'|'sales'`
  (default `sales`), `warehouseId`, `docTypes[]` (multi-select of LGR document types, see
  FR-7.4), `productId`, `categoryId` (product group; SHOULD include descendants via
  `ProductCategory.parentId`), `contactId` (customer for sales, supplier for purchases —
  the picker filters `type $in [<side>,'both']`).

### 2.2 Handler semantics

- **FR-7.3 (MUST)** Rows are built from **StockMovements** (status
  `$in ['confirmed','completed']`), because at regal purchases exist mostly as imported
  receipt movements with no bill. Operation families:
  - `purchases` → `type: 'receipt'`, plus `return` with `fromWarehouseId` set (return to
    supplier, **negative**);
  - `sales` → `type: 'dispatch'`, plus `return` with `toWarehouseId` set (customer return,
    **negative**).
  `transfer`, `adjustment`, `production_*` are **excluded** — they are neither purchase nor
  sale. Warehouse filter matches the operation-side warehouse (to- for purchases, from- for
  sales; returns use the opposite side).
- **FR-7.4 (MUST)** Document enrichment: `$lookup invoices` on `invoiceId` → document
  number, LGR `type` + `direction`, `issueDate`, `contactId` fallback. `docTypes[]` filters
  on the looked-up invoice type, with two pseudo-types for movements without an invoice:
  `receipt_note` (no-invoice receipt — stokrazp imports) and `dispatch_note` (no-invoice
  dispatch). Effective row date = **invoice `issueDate` when linked, else movement `date`**
  (invoice-born movements carry booking time in `date` — see §1); the period filter applies
  to the effective date. ⚠ This forces the date filter after the lookup — cap the `$match`
  window generously on `movement.date` first (e.g. ±45 days) only as an optimisation, or
  accept the wider scan; do not silently filter on `movement.date` alone.
- **FR-7.5 (MUST)** Aggregation **grouped by product** (`$unwind lines` → group by
  `lines.productId`), emitting per row: product name, SKU, unit (Мярка), `totalQuantity`
  (returns negative), `avgUnitPrice` (= value/qty, weighted), `totalValue`
  (Σ `lines.totalCost`), and per-report totals row (Всичко) summing quantity and value —
  matching the legacy screenshot columns Име/Мярка/Количество/Цена/Стойност/Средна цена.
  Products resolved via batch `$lookup`/`find` (name, sku, unit, category); rows sorted by
  product name `localeCompare('bg')` like `aggregateCashSales` (`invoice-export.controller.ts:237`).
- **FR-7.6 (SHOULD)** Cost & profit columns for `operation: 'sales'` (legacy „Ст-ст по ср.
  цена" / „Печалба склад"): per dispatch line, cost basis = Σ `costAllocations[].totalCost`
  when present, else `resolvedUnitCost × quantity`, else `product.avgCost × quantity`
  (current, flagged as approximation). `profit = totalValue − totalCost`. ⚠ Do **not** use
  dispatch `lines[].unitCost` as cost — on invoice-born movements it is the **sale** price
  (§1). Flag the chosen cost basis in the report meta. If cost data is too sparse at regal,
  ship without these columns and note it in the PR (they remain in the registry `columns`
  as default-off).
- **FR-7.7 (MUST)** A detail drill-down mode `groupBy: 'document'` (per-operation rows:
  effective date, document number — invoice number or `movementNumber` fallback — doc type,
  contact, warehouse, quantity, price, value) so „проследяване по артикули" is auditable.
  MAY: `withBatches` flag (legacy „С партиди") splitting rows by `lines.batchNumber`.
- **FR-7.8 (MUST)** Read-only handler, aggregation-first (FR-6.13/6.14); row cap per
  FR-6.15 with an explicit "narrow the period" message — no silent truncation.

### 2.3 UI & export

- **FR-7.9 (MUST)** Rendered by the FR-06 ReportRunner: filter bar from params → Generate →
  `ListScaffold` grid. Column show/hide/reorder via the built-in cog **operates on the
  already-fetched result** (client-side, per `useGridColumns`) — the docx's „настройката да
  работи СЛЕД генериране" is satisfied by construction; verify no refetch fires on column
  changes. Filters + grid state in the URL via `useListQueryState` (shareable link).
- **FR-7.10 (MUST)** XLSX/PDF export via `packages/reporting` following the cash-agg
  pattern: one `AggColumnDef`-style map shared by Excel and PDF, `buildXxxHtml` exported
  for tests, meta block (org, period, operation, warehouse, filters), totals row. New
  header i18n keys (`warehouse`, `category`, `avgPrice`, `cost`, `profit`, `operation`, …)
  added to **all four locales** in `reporting/src/i18n.ts`.
- **FR-7.11 (MUST)** Currency: movements carry no currency; invoice-linked rows use the
  invoice currency. Single-currency result → one section; mixed → per-currency sections
  exactly like cash-agg (`:99-131`). No cross-currency summing.
- **FR-7.12 (MUST)** i18n ×4 for the card, params, column labels (`reports.warehouseOps.*`
  in `ui-shared` locales); bg labels follow the legacy names (Количество, Цена, Стойност,
  Средна цена).

## 3. Edge cases

1. **Movements without invoiceId** (the regal majority on the purchase side): document
   column shows `movementNumber`, doc type shows the pseudo-type; contact from
   `movement.contactId` when present, else blank.
2. **Sales invoices that skipped stock movements** (`skipStockMovement` import flag,
   service lines without `warehouseId`, invoicing lines with no product): absent from this
   report by design — it reports **warehouse** operations. State this in the FR-06 card
   description; the cash-register/sales-history reports cover document-side turnover.
3. **Returns** net against the period's purchases/sales (negative quantity); a product with
   only returns shows a negative row.
4. **Transfers** are invisible here even though they move stock — by design (neither
   purchase nor sale). The product ledger remains the per-product audit trail.
5. **Duplicate-side warehouses**: a `return` has only one side set — guard against rows
   where the expected side is missing (skip + count in meta, don't crash).
6. **Deactivated products/warehouses/contacts** (soft-delete, `isActive:false`) still
   render by name — historical rows must not disappear.
7. **Query plan**: `{orgId,type,date:-1}` and `{orgId,'lines.productId',date:-1}` exist;
   filters by warehouse/contact will scan within the period — acceptable at regal scale
   (~tens of movements/day). If slow, add `{orgId, toWarehouseId, date:-1}` /
   `{orgId, fromWarehouseId, date:-1}` indexes in the same PR.
8. **Effective-date window** (FR-7.4): an invoice issued 30.06 whose movement was booked
   01.07 must appear in June, not July, when linked — test this explicitly.
9. **Draft movements** never count (status filter).

## 4. Integration & regression constraints

1. Depends on FR-06's registry/runner/catalog/export plumbing — do not build a parallel
   bespoke page; if FR-06 P1 is not merged yet, this FR blocks.
2. Touches **no existing endpoint** — `/invoicing/export/*`, product-ledger, movement list
   stay byte-identical (import skills + e2e depend on them).
3. `reporting/src/i18n.ts` additions are append-only (existing keys untouched — the
   invoicing export suites assert current headers).
4. Handler lives in `packages/services` (server-only; the UI consumes catalog metadata
   only — FR-6.6 bundling caveat).
5. New tests: handler integration test (seed receipts + dispatches + a return + an
   invoice-linked movement with drifted booking date; assert per-product sums, effective
   dates, returns netting, doc-type filter incl. pseudo-types) + export layout test via the
   exported `build*Html`.

## 5. Acceptance criteria

- [ ] Reports hub shows a „Складови операции" / Warehouse Operations card (permission-gated); opening it renders the param bar; Generate returns per-product rows with Име/Мярка/Количество/Цена (avg)/Стойност and a Всичко totals row.
- [ ] Operation toggle switches purchases ↔ sales; results reconcile with the product ledger for a spot-checked product (same period, same warehouse).
- [ ] Every docx filter works alone and combined: period, warehouse, doc type (incl. no-invoice pseudo-types), product, product group, contact.
- [ ] Column cog hides/shows/reorders columns **without** a new fetch; choices persist per user; URL restores the full parameterisation on Back/refresh.
- [ ] XLSX and PDF exports match the on-screen columns, localized ×4, with meta block and totals; mixed currencies render as sections.
- [ ] Returns appear negative; transfers/adjustments absent; draft movements absent.
- [ ] `bun run test` green (new handler + export tests); `bun run build` green.

## 6. Field test (lgrai.app / regal)

1. Generate sales for a known day (cross-check: pick a day already reconciled during the
   PlusMinus migration) for one warehouse; compare Количество/Стойност totals with the
   legacy report's Всичко for the same day if available, else with the cash-register
   aggregated export for cash sales + sales invoices of that day.
2. Generate purchases for a period covering a known stokrazp import batch; verify the
   receipt rows show delivery prices and the doc column shows SM numbers.
3. Filter by a DIN fastener category and by a single supplier; verify combination filters.
4. Reorder + hide columns after generation; refresh the page → parameters restored from the
   URL, column prefs persisted.
5. Export PDF and XLSX; verify Cyrillic, totals row, and letterhead/meta block.

---

## Appendix — authoritative requirement wording (Spravki ledger.docx §1)

```
Складови операции
Цел: Да се създаде справка, чрез която потребителят да може да проследява извършените
покупки и продажби на стоки за избран период.
1.1 Основни филтри: Период (начална/крайна дата); Операция: Покупки | Продажби; Склад;
Тип/вид документ; Продукт; Група продукти; Контрагент (при продажби – клиент; при
покупки – доставчик). Филтрите — самостоятелно и в комбинация.
1.2 Резултат: бутон „Изведи" → всички складови операции по критериите; проследяване по
артикули със съответните количества, цени и стойности.
1.3 Настройка на колоните: бутон „Колони" — кои колони се виждат/скрити; по възможност
ред на визуализиране. Важно: настройката да работи СЛЕД генериране, без ново генериране.
```
