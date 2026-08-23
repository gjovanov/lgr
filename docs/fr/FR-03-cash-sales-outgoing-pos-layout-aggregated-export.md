# FR-03 — Cash sales: Outgoing menu, POS-style detail page, aggregated export

**Goal:** (a) Move *Cash Sales* into the **Outgoing Documents** menu group (list unchanged).
(b) The cash-sale **detail page becomes a POS-terminal-style screen** — product cards left,
cart right — with client selection kept. (c) Cash-sale export gets the FR-02 defaults (PDF,
Status/Currency off, Payment Method on) **plus an "aggregate by product" checkbox, ticked by
default**, which sums per product and drops the per-document header info.

Status: draft for implementation · Date: 2026-08-21 · Depends on: FR-01 (menu restructure),
FR-02 (dialog defaults, per-mode mechanism) · Feeds: —

---

## 1. Current state

**Nav:** Cash Sales is the sole child of the "Cash Register" group
(`packages/invoicing-ui/src/layouts/DefaultLayout.vue:90-96`, child label `invoicing.cashSales`).

**Cash-sale document path (must stay intact):**
- `POST /org/:orgId/invoices` with `type:'cash_sale'` → born `status:'paid'`, `direction`
  forced outgoing, `amountPaid=total`, no draft number (`invoice.controller.ts:383-424`);
  number `CS-YYYY-#####` from the `CASH_SALE` counter (`sequence-registry.ts:69`).
- **Stock dispatches immediately at creation** (`:454-475`); a failed dispatch hard-deletes the
  document and 400s (rollback block). Pre-create the UI runs
  `POST /invoicing/stock-availability/check` and offers cross-warehouse transfers
  (`CashSaleFormView.vue:46-80`, `stockTransferFlow: true`).
- Issued cash sales: **no void** (`paid` not in the void-able list, `:926`), **no delete**
  (`:741` draft-only), API-editable until a posted JE exists (`:606-622`) but the UI hides the
  action bar (`editSaveGate:'draft-only'`, empty `formActions` — `useDocumentForm.ts:659`).
- No payment record and no fiscal/UNP call on this path (SUPTO sees cash-sale invoices only at
  export time, table 18.1 — `supto-export.service.ts:34-40`).

**Current form:** generic `DocumentForm` with `DOCUMENT_CONFIGS.cash_sale`
(`configs.ts:377-442`): optional customer (`partyRequired:false`), fixed payment method
default `cash`, issue-date only, doc-level warehouse selector with per-user pin
(`lgr:default-wh:<user>:<org>`), price combobox + re-resolve on contact change.

**POS terminal for reference** (`packages/pos-ui/src/views/PosTerminalView.vue`): left pane
`md=7` — search (300 ms debounce) + category/type/tag filters + 24-per-page card grid from
`GET /org/:orgId/trade/pos/catalog` (params `page,size,warehouseId,search,category,type,tags`;
cards show name, price, `stockAvailable`; click = add/increment); right pane `md=5` — cart
with qty ± / remove, totals (net + VAT), payment select, submit. The catalog search matches
`name|sku|barcode` server-side (`pos.controller.ts:164`). **Note:** POS posts to a separate
`POSTransaction` collection — that path is NOT what cash sales use and is not touched here.

**Export:** `CashSalesView.vue:88` `<ExportDialog doc-type="cash_sale" …>` →
`POST /invoicing/export/list`; reporting card posts `/export/kind/cash_register`
(filter `type:'cash_sale'`, `invoice-export.controller.ts:370-373`). List export caps at
`MAX_ROWS=1000` documents (`:14`).

---

## 2. Requirements

### 2.1 Navigation

- **FR-3.1 (MUST)** Move the Cash Sales entry into **Outgoing Documents** (after Proforma;
  post-FR-01 children: Sales Documents, Proforma, Cash Sales). Remove the now-empty
  "Cash Register" group from `menuItems`. Route path/name (`/cash-sales`,
  `invoicing.cash-sales`) and the list view stay **unchanged** (README constraint #3).
  `nav.cashRegister` i18n keys and the `PAGE_REGISTRY` row for `/cash-sales` stay (the page
  itself didn't move).

### 2.2 POS-style detail page

- **FR-3.2 (MUST)** Replace the `/cash-sales/new` form body with a two-pane terminal layout
  (`md+`; stacked on mobile with a sticky totals/actions bar):

  ```
  ┌ Cash Sale  CS-2026-00123 (peek)   [Client ▾ + create/🔍] [Warehouse ▾ 📌] [Date] ┐
  ├──────────────────────────────────┬───────────────────────────────────────────┤
  │ [Search / barcode…] [Category ▾] │ Cart (N)                                  │
  │ ┌────┐ ┌────┐ ┌────┐             │ Болт М8х25 ZN    [−] 2 [+]  × 0.12  ✕     │
  │ │card│ │card│ │card│  …          │   price editable + PriceSelectButton      │
  │ └────┘ └────┘ └────┘             │ ─────────────────────────────────────────│
  │ name · SKU · price · stock       │ Subtotal / VAT / Total                    │
  │ click → add / qty++              │ [Payment ▾]  [Notes]                      │
  │ ‹ pagination ›                   │ [Save (issue)]        [Print]             │
  └──────────────────────────────────┴───────────────────────────────────────────┘
  ```
- **FR-3.3 (MUST)** Backend contract unchanged: the screen submits the **same
  `POST /invoices` payload** the current `DocumentForm` builds for `cash_sale` (lines with
  `productId, description, quantity, unit, unitPrice, taxRate, taxAmount, lineTotal,
  warehouseId, priceExplanation`, totals, `paymentMethod`, optional `contactId`, notes,
  amount-in-words note post-processing). Recommended implementation: keep
  `useDocumentForm` as the engine (payload/pricing/save/stock-check logic) and swap only the
  presentation, or extract its payload builder — do **not** fork the payload logic
  (`import-cash-register-sales` posts the same shape; README constraint #2).
- **FR-3.4 (MUST)** Product catalog pane:
  - source: `GET /org/:orgId/trade/pos/catalog` with `warehouseId` = the selected doc-level
    warehouse (init priority as today: pinned user default → org default), `search`
    (debounced 300 ms, matches name/SKU/barcode), `category`, pagination size 24;
  - card: name, SKU, selling price (per pricing resolution when a client is selected — see
    FR-3.6), `stockAvailable`; out-of-stock cards stay clickable but visibly marked;
  - click adds a line or increments an existing one;
  - **Enter** in the search field with exactly one result adds it and clears the field
    (covers barcode scanners, which suffix Enter).
- **FR-3.5 (MUST)** Cart pane: per line qty stepper + editable qty input, editable unit price
  with `PriceSelectButton` (price options endpoint), line total, remove; totals block
  (subtotal / "Tax Total (X%)" when uniform / total); payment method select
  (`usePaymentMethods`, default `cash`); notes; **Save** issues the document (single step —
  cash sales have no draft). Save is disabled while the cart is empty.
- **FR-3.6 (MUST)** Client selection exactly as the current form: optional
  `ContactAutocompleteWithCreate` + `ContactPickerDialog` + ledger button. Selecting/changing
  the client re-resolves prices for every line **not manually overridden** (track an
  `overridden` flag per line; existing `reResolveOnChange` semantics) and re-renders card
  prices via `priceExplanation` steps.
- **FR-3.7 (MUST)** Preserve the pre-save stock flow: `stock-availability/check` →
  `StockTransferDialog` → `create-transfers` → `submitCreate({pendingTransferIds})`
  (`CashSaleFormView.vue:46-80` logic moves into the new screen unchanged).
- **FR-3.8 (MUST)** Existing documents (`/cash-sales/:id/edit`) open in the **same layout,
  read-only**: cart populated from the doc, no add/qty/remove/save controls, banner shows the
  real number + status chip, **Print** (ExportDialog) available. (API-level: PUT stays as-is;
  the UI simply doesn't offer editing, matching today's empty action bar.)
- **FR-3.9 (SHOULD)** Numpad-friendly qty entry and keyboard navigation (↑/↓ result list like
  `ProductLineDescription`); warehouse change re-fetches the catalog and re-checks nothing
  until save (validation happens server-side at issue).

### 2.3 Aggregated export

- **FR-3.10 (MUST)** `ExportDialog` gains an opt-in aggregate control: new props
  `showAggregate?: boolean` and `defaultAggregate?: boolean`; renders a checkbox
  *"Aggregate by product"* above the column list; emits `aggregated: boolean` in the confirm
  payload. Only the cash-sales list (`showAggregate default-aggregate`) and the reporting
  *cash register* card pass it; everywhere else the dialog is unchanged.
- **FR-3.11 (MUST)** When aggregated is ticked, the dialog swaps to an **aggregated column
  catalog** (mode radio hidden — modes are meaningless for the pivot):

  | key | default | notes |
  |---|---|---|
  | `productName` | ✔ (locked) | line description fallback when no productId |
  | `sku` | ✔ | |
  | `unit` | ✔ | |
  | `totalQuantity` | ✔ | Σ qty |
  | `avgUnitPrice` | ✔ | net Σ / qty (weighted) |
  | `netTotal` | ✔ | Σ line net |
  | `taxTotal` | ✔ | Σ line VAT |
  | `grossTotal` | ✔ | net + VAT |

- **FR-3.12 (MUST)** Server: `POST /invoicing/export/list` and `POST /export/kind/cash_register`
  accept `aggregated?: boolean` (+ the aggregated column keys in the allowlist). Valid only
  for `docType:'cash_sale'` / `kind:'cash_register'` — 400 otherwise. Semantics:
  - documents selected by the **same filters as today** (status/date/search);
  - implemented as a Mongo aggregation (`$match` → `$unwind: lines` → `$group` by
    `lines.productId`, falling back to `description+unit` for productId-less lines) — do NOT
    materialize documents, so the `MAX_ROWS=1000` doc cap doesn't distort sums; cap the
    **output** at 1000 product rows;
  - rows sorted by product name; a **grand-total row** at the bottom; the sheet/PDF header
    shows the org name + date range + "Cash sales — aggregated by product" (i18n);
  - no per-document columns (number/date/contact/status/payment method are absent by design);
  - multi-currency guard: if >1 currency matches the filter, group into per-currency sections
    (regal is single-currency; don't silently sum mixed currencies).
- **FR-3.13 (MUST)** Cash-sales list ExportDialog also gets the FR-02 defaults:
  `default-format="pdf"`; when the user unticks *aggregate*, the normal compact catalog applies
  with FR-02's Status/Currency-off + PaymentMethod-on defaults.
- **FR-3.14 (MUST)** i18n (proposals): `export.aggregated` = "Aggregate by product" /
  "Обобщено по продукт" / "Nach Produkt aggregieren" / "Збирно по производ";
  `export.aggregatedTitle` = "Cash sales — aggregated by product" / "Касови продажби —
  обобщено по продукт" / "Barverkäufe — nach Produkt aggregiert" / "Готовински продажби —
  збирно по производ"; plus the eight column labels.

## 3. Edge cases

1. **No warehouse selected** (fresh user, no pin, no org default): catalog loads without
   `warehouseId` (no stock badge); save still validates stock server-side per line warehouse.
   Show a hint chip "select a warehouse to see stock".
2. **Same product, different price** — clicking a card increments the existing line; if the
   user wants two price points they edit/duplicate manually (parity with POS; document).
3. **Client change after manual price edits** — overridden lines keep their price (FR-3.6);
   snackbar "N line prices kept (manually set)".
4. **Stock shortfall at save** → transfer dialog; declining aborts (no doc created — the
   backend rollback also protects the race where stock vanished between check and save; the
   consumed CS number gap is existing, accepted behavior).
5. **Erroneous issued cash sale**: still no void/delete (existing). Read-only view must make
   this obvious (status chip + no edit affordances). Correction remains an operational
   procedure — out of scope, listed for the user as a known limitation.
6. **Aggregated export across a period with a product renamed/merged** — grouping is by
   `productId`, so renames collapse correctly; productId-less legacy lines group by text.
7. **Aggregate + search filter** ("болт") — filters apply to *documents*, not lines; a
   matching doc contributes **all** its lines. Document this in the dialog hint.
8. **Draft cash sales don't exist**, but the list's status filter includes `draft` (legacy
   option) — harmless; aggregation respects whatever statuses are selected.
9. **Rounding**: aggregate VAT = Σ line `taxAmount` (not recomputed from summed net), so the
   totals reconcile with the per-document export to the cent.

## 4. Integration & regression

- `import-cash-register-sales` skill posts the same `POST /invoices` cash-sale payload —
  FR-3.3 keeps it intact; run the skill's dry-run after deploy.
- POS terminal, POS transactions, `pos.session.closed` accounting: untouched.
- SUPTO table 18.1 keeps reading cash-sale invoices — no change.
- e2e: cash-sale specs select Vuetify comboboxes by role (`CLAUDE.md` testing note) — new
  screen must keep labeled inputs (`aria`/label parity) so `getByRole('combobox', {name})` works.

## 5. Acceptance criteria

- [ ] Cash Sales appears under Outgoing Documents; Cash Register group gone; deep link `/invoicing/cash-sales` unchanged.
- [ ] `/cash-sales/new`: two-pane screen; search/category/pagination work; barcode-Enter adds; cart math matches the old form to the cent (incl. VAT rounding); client + warehouse + payment + notes present; save issues a `CS-…` doc that dispatches stock; transfer dialog flow still works.
- [ ] Existing cash sale opens read-only in the same layout with Print.
- [ ] Export dialog: aggregate ticked by default, PDF default; aggregated PDF/XLSX show per-product sums + grand total and **no** document headers; unticking aggregate yields the FR-02-default document export.
- [ ] Aggregated totals over a known day equal the sum of that day's cash-sale documents.
- [ ] `bun run build`, integration tests for the aggregation endpoint, e2e cash-sale spec updated and green.

## 6. Field test (lgrai.app / regal)

1. Create a real cash sale via the new screen: search a Cyrillic product (`болт`), one by SKU,
   one by scanner if available; verify stock badge vs `/inventory` stock; set client with a
   tag-based price group → verify resolved price + explanation; save → number continuity with
   the previous CS, stock decremented, doc in list.
2. Open yesterday's imported CSR document — renders read-only correctly (imported docs have
   productId-less edge lines? verify).
3. Aggregated export for the last full week → cross-check 2-3 products against the product
   ledger dispatch sums for the same period; verify Cyrillic in PDF; grand total equals the
   week's cash-sale total from the list footer.
4. Re-run the nightly `import-cash-register-sales` for a past day (idempotent) — must still
   dedupe/skip, proving the POST contract survived.
