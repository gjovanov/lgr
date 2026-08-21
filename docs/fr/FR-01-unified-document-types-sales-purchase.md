# FR-01 — Unified document types for Sales & Purchase documents

**Goal:** Sales invoices, credit notes and debit notes live in **one grid and one form**
(likewise purchase invoices + incoming credit/debit notes), distinguished by a **type badge**,
numbered from a **single prefix and single sequence** per side (sales / purchase). At creation
time the user picks the type (default *invoice*); picking *credit note* / *debit note* makes a
**related-invoice reference mandatory**.

Status: draft for implementation · Date: 2026-08-21 · Depends on: nothing · Feeds: FR-02, FR-03, FR-05

---

## 1. Current state (what exists today)

**Persistence is already unified.** There is one `Invoice` collection and one controller for
all six document kinds:

- `packages/db/src/models/invoice.model.ts:167` — `type: ['invoice','proforma','credit_note','debit_note','cash_sale']`, `:168` `direction: ['outgoing','incoming']`, `:256` `relatedInvoiceId` (optional, **no validation anywhere**), `:291` unique index `{orgId, invoiceNumber}`.
- `packages/invoicing-api/src/controllers/invoice.controller.ts:201` — single `/org/:orgId/invoices` controller. `type` and `direction` are body/query params; the list endpoint already supports `types` CSV → `$in` (`:234-238`). The per-type experience is **client-side**: each view pins its own filter (`SalesInvoicesView.vue:288` `{direction:'outgoing', type:'invoice'}`, `CreditNotesView.vue:177` `{type:'credit_note'}` — note: **no direction filter** on the CN/DN views).

**Numbering** (`packages/services/src/biz/sequence-registry.ts:53-76`):

| doc | issued counter | issued display | draft counter | draft display |
|---|---|---|---|---|
| sales invoice | `SALES_DOC` | `INV` | `DRAFT_INV` | `DRF-INV` |
| credit note | `SALES_DOC` (shared) | **`CRN`** | `DRAFT_CN` | `DRF-CN` |
| debit note | `SALES_DOC` (shared) | **`DBN`** | `DRAFT_DN` | `DRF-DN` |
| bill (invoice, incoming) | `BILL` | `BILL` | `DRAFT_BILL` | `DRF-BILL` |

So INV/CRN/DBN already **interleave on one counter** but render **three different prefixes**,
and drafts use three separate counters. `sequenceGroupFor(type, direction)`
(`sequence-registry.ts:79-87`) is **direction-blind** for credit/debit notes — an incoming
credit note would today be numbered from the outgoing CRN series.

**Side effects by type** (all existing):

- Stock (`packages/services/src/biz/invoicing.service.ts:257-265`): `credit_note` → `return` movement **into** the warehouse (restock, both directions!); other outgoing → `dispatch`; other incoming → `receipt`. Outgoing docs move stock on `/send` (`invoice.controller.ts:774`), incoming on `/receive` (`:844`). Void reverses (`:932`, mapping at `invoicing.service.ts:330-338`). Lines without both `productId` **and** `warehouseId` are skipped (`:244`) — value-only notes naturally never touch stock.
- Journal entries (`packages/services/src/biz/auto-journal.service.ts:95-136`): sign `-1` only for `credit_note` (direction-agnostic; negative sides are swapped `:139-142` — this already produces a correct *reversed* JE for an incoming CN). `debit_note` posts exactly like an invoice. **Only `/send` emits `invoice.posted`** (`invoice.controller.ts:807`); `/receive` emits nothing, so bills get no auto-JE today (pre-existing asymmetry, out of scope here).
- Contact ledger (`packages/services/src/biz/contact-ledger.service.ts:95-99,160-184`): line sign `-1` for credit notes; summary subtracts **outgoing** CNs from sales but counts an **incoming** CN as a positive purchase (wrong once incoming CNs exist).
- Reservations: `validateReservationLineRefs` (`invoice.controller.ts:60-119`) already rejects anything that isn't an **outgoing `type='invoice'`** — new incoming CN/DN inherit the guard with no change.
- Exports: `POST /invoicing/export/kind/outgoing` already merges the three types (`invoice-export.controller.ts:364`); `kind=incoming` filters `type='invoice'` only (`:368`). List export `POST /invoicing/export/list` maps `docType='bill'` → `{type:'invoice', direction:'incoming'}` (`:55-61`).
- SUPTO: sales invoices/CNs/DNs feed **no** NRA table directly (only `cash_sale` → 18.1, receipts → 18.6-18.8) — **no SUPTO impact**.

**UI:** separate routes/views/nav entries for Sales Invoices, Credit Notes, Debit Notes, Bills
(`packages/invoicing-ui/src/router/index.ts:17-27,48-55`; nav groups in
`packages/invoicing-ui/src/layouts/DefaultLayout.vue:63-121`). Forms are thin wrappers around a
config-driven `DocumentForm` (`packages/invoicing-ui/src/composables/document-form/configs.ts`)
— this is what makes the merge cheap. The CN/DN related-invoice picker is a plain
`v-autocomplete` **without a required rule**, loading only the server-default **10** invoices
with no search (`DocumentUpperSection.vue:29-37`, `useDocumentForm.ts:854-861`).

---

## 2. Scope

**In:** merged sales list + form (`invoice|credit_note|debit_note`, direction=outgoing); merged
purchase list + form (same three types, direction=incoming — incoming CN/DN are **new**
end-to-end: numbering, stock, ledger, exports); unified prefixes/sequences incl. drafts; type
badge; mandatory + validated related invoice; redirects and nav cleanup.

**Out:** proforma and cash-sale views (unchanged; FR-03 covers cash sales); POS; SUPTO export
changes; emitting `invoice.posted` from `/receive` (pre-existing gap — MAY be a follow-up);
crediting cash sales (related invoice stays restricted to `type='invoice'`); desktop/SQLite
(its CHECK constraint already allows both note types; no desktop UI ships these views).

---

## 3. Requirements

### 3.1 Numbering — one prefix, one sequence per side

- **FR-1.1 (MUST)** Registry change in `sequence-registry.ts`: the issued rows for
  `credit_note` and `debit_note` become `{ prefix: 'SALES_DOC', defaultDisplay: 'INV' }`; the
  draft rows become `{ prefix: 'DRAFT_INV', defaultDisplay: 'DRF-INV' }`. Result: every new
  sales-side document (all three types) is numbered `INV-YYYY-#####` (issued) /
  `DRF-INV-YYYY-#####` (draft) from the existing shared counters. `DRAFT_CN`/`DRAFT_DN`
  counters are retired (rows removed).
- **FR-1.2 (MUST)** `sequenceGroupFor(type, direction)` becomes direction-aware for the two
  note types: `credit_note`/`debit_note` + `direction='incoming'` → group `bill`. Incoming
  notes therefore draw `BILL-YYYY-#####` / `DRF-BILL-YYYY-#####` from the existing BILL
  counters — no new registry rows needed. Callers that pass only a type (e.g.
  `TYPE_PREFIX` at `invoice-numbering.service.ts:22-25`) must be updated to thread direction.
- **FR-1.3 (MUST)** Existing documents are **never renumbered**. Historic `CRN-`/`DBN-`/
  `DRF-CN-`/`DRF-DN-` numbers remain valid display strings; `numberHistory[]` untouched.
- **FR-1.4 (MUST)** Sequences config: remove `CRN`, `DBN`, `DRF-CN`, `DRF-DN` from
  `ALLOWED_PREFIXES` (`sequence-config.controller.ts:17`) and from the groups rendered by
  `SequencesConfigView.vue`. Existing year-0 display-override sentinel docs stored under
  `CRN`/`DBN` become inert (resolution now looks up `INV` then `SALES_DOC` —
  `sequence-registry.ts:118-124`); a cleanup script MAY delete them, it must not be required.
- **FR-1.5 (SHOULD)** Keep the legacy prefixes in the issued-number reconciliation scan:
  `currentMaxSuffix` (`invoice-numbering.service.ts:86-109`) derives its regex from the
  counter's display prefixes — after FR-1.1 that set collapses to `['INV']`. Append the
  literal legacy aliases `['CRN','DBN']` for the `SALES_DOC` counter so a lost/reset counter
  can still reconcile against historic numbers.
- **FR-1.6 (MUST)** `/peek-next` continues to work for every type: with `type=credit_note&status=draft`
  it now previews `DRF-INV-…`; with `type=credit_note&direction=incoming` it previews `BILL-…`.

### 3.2 API — validation & new incoming behavior

- **FR-1.7 (MUST)** `relatedInvoiceId` validation on `POST /invoices` and `PUT /invoices/:id`
  whenever the document's type is `credit_note` or `debit_note` (on PUT, the *stored* type —
  type stays immutable, `PUT` still strips it):
  1. present (422 `Related invoice is required for credit/debit notes`),
  2. resolves to a document in the same org with `type='invoice'` and the **same `direction`**,
  3. related status ∉ `{draft, voided, cancelled}`,
  4. `contactId` equal to the note's `contactId` (422 with both names in the message).
  Validation runs only on writes — legacy notes without a reference stay readable; editing one
  forces the user to pick a reference (accepted consequence, note in release notes).
- **FR-1.8 (MUST)** Stock movement matrix becomes direction-aware in
  `createInvoiceStockMovement` / `reverseInvoiceStockMovement` (`invoicing.service.ts`):

  | type + direction | on issue (`/send` out, `/receive` in) | on void |
  |---|---|---|
  | invoice, outgoing | dispatch (−) *(unchanged)* | receipt (+) |
  | credit_note, outgoing | return, `toWarehouseId` (+) *(unchanged)* | dispatch (−) |
  | debit_note, outgoing | dispatch (−) *(unchanged)* | receipt (+) |
  | invoice, incoming | receipt (+) *(unchanged)* | dispatch (−) |
  | **credit_note, incoming** | **return, `fromWarehouseId` (−)** — goods back to supplier | receipt (+) |
  | **debit_note, incoming** | receipt (+) | dispatch (−) |

  Lines without `productId`+`warehouseId` keep being skipped, so value-only notes move nothing.
- **FR-1.9 (MUST)** Journal entries: no code change expected — `auto-journal.service.ts` already
  yields correct entries for all six combinations (CN sign-flip + side-swap). **Add integration
  tests** proving: outgoing CN JE = reversed sales JE; incoming CN JE = reversed purchase JE;
  incoming DN JE = purchase JE. (Reminder: JEs only fire via `/send`.)
- **FR-1.10 (MUST)** Contact ledger summary (`contact-ledger.service.ts:160-184`): incoming
  `credit_note` subtracts from `totalPurchases`. Line-row sign (`-1` for CN) is already
  direction-agnostic and stays.
- **FR-1.11 (MUST)** Exports:
  - `POST /export/list` accepts optional `types` (CSV, subset of the three; validated, 400 on
    junk). `docType='invoice'|'bill'` keeps setting direction; `types` narrows/expands the type
    filter within that direction.
  - New export column `type` in the shared catalog (`useExportColumns.ts`) and server allowlist
    + `COLUMN_DEFS` (`invoice-export.controller.ts:18-22`, `reporting/src/excel/invoicing-list.excel.ts:78-102`
    and the PDF twin), rendering the localized doc-type label. `defaultOn: true`, modes
    `['compact','detailed']`, docs `['invoice','bill']`.
  - `kind=incoming` filter becomes `type: {$in:['invoice','credit_note','debit_note']}, direction:'incoming'`
    (`invoice-export.controller.ts:368`), and the incoming reporting tab
    (`ReportingTabGrid.vue:138`) sends the matching `types` CSV.
- **FR-1.12 (SHOULD)** Aging report (`aging-report.controller.ts:17-21`): add `received` to the
  status `$in` (open bills currently never appear in payables aging) and subtract credit-note
  amounts (sign `-1`) instead of adding them. This is a correctness fix exposed by the merge.

### 3.3 UI — merged lists

- **FR-1.13 (MUST)** `SalesInvoicesView` becomes the merged sales list (route **name/path
  unchanged**: `invoicing.sales` / `/invoices`):
  - server filter `{direction:'outgoing', types:'invoice,credit_note,debit_note'}`, narrowed by a
    new **Type multiselect** filter (chip-style like `StatusMultiselect`; default: all three);
  - new **Type badge column** after `number`: `v-chip size="x-small" label` with the color map
    already used in `useContactLedger.ts:53-59` (`invoice: primary`, `credit_note: warning`,
    `debit_note: error`) and label from new i18n keys (FR-1.19). Refactor `useContactLedger`'s
    hard-coded English labels to the same keys (SHOULD);
  - `relatedInvoiceNumber` column (defaultOn; the CN/DN views already batch-resolve it — reuse
    `invoice.controller.ts:275-299`);
  - status filter = union `{draft, sent, partially_paid, paid, overdue, voided}` (the CN/DN
    views' `issued`/`applied` options are dead — those statuses don't exist in the model enum;
    drop them);
  - KPI cards keep today's semantics (summary endpoint unchanged, scoped to `type='invoice'`) —
    do **not** silently mix note totals into "Outstanding".
- **FR-1.14 (MUST)** `PurchaseInvoicesView` mirrors FR-1.13 for `direction:'incoming'`
  (route `invoicing.purchases` / `/bills` unchanged): type multiselect + badge +
  `relatedInvoiceNumber`; status union `{draft, received, partially_paid, paid, overdue, voided, cancelled}`
  (adds the currently-missing `voided`). The `reference` (Supplier Invoice #) column stays.
- **FR-1.15 (MUST)** Export buttons pass the active type selection as `types` and docType
  `'invoice'`/`'bill'` (FR-1.11). FR-02's defaults apply on top.

### 3.4 UI — merged form

- **FR-1.16 (MUST)** Document-type selector on the form, **create mode only** (type is
  immutable after POST — PUT strips it): a 3-option segmented control
  (`v-btn-toggle`) in the banner: Invoice / Credit Note / Debit Note, default Invoice, also
  presettable via query `?type=credit_note` (used by redirects, FR-1.18). Switching swaps the
  wrapper's `config` (`DOCUMENT_CONFIGS[...]`) and re-peeks the number. In edit mode render the
  type as a static badge.
  - Sales wrapper: existing configs `invoice`/`credit_note`/`debit_note` as-is.
  - Purchase wrapper: two **new configs** `purchase_credit_note`, `purchase_debit_note` cloned
    from `purchase_invoice` (`direction:'incoming'`, `apiType:'credit_note'|'debit_note'`,
    supplier party + `contactFetchParams:{type:'supplier'}`, `showSupplierInvoiceNumber: true`
    — supplier's own note number goes to `reference` —, `showRelatedInvoice: true`,
    `relatedInvoiceAutofill: true`, notes field = `reason`, matching `peekParams`).
  - **SHOULD** carry over contact, dates, warehouse and lines when switching type pre-save
    (re-key wiping the form is acceptable v1 if carry-over proves fiddly — document choice).
- **FR-1.17 (MUST)** Related-invoice picker upgrade (both directions):
  - required rule + red state when type is CN/DN (client mirror of FR-1.7);
  - server-side search autocomplete (pattern of the contact picker,
    `useDocumentForm.ts:791-813`): `GET /invoices?types=invoice&direction=<dir>&search=<q>&size=20`,
    plus `contactId` filter once a contact is chosen; always `ensureSelected`-loads the current
    value so edits of old docs resolve;
  - keeps the existing line-autofill behavior (`useDocumentForm.ts:604-628`).
- **FR-1.18 (MUST)** Routes & nav:
  - `/credit-notes`, `/credit-notes/new`, `/credit-notes/:id/edit` → **named redirects** to
    `/invoices`, `/invoices/new?type=credit_note`, `/invoices/:id/edit` (same for debit notes).
    Keep the old route **names** on the redirect records so `router.push({name})` callers and
    bookmarks/favorites survive.
  - Update internal type→route maps to the merged routes: `ContactLedgerView.vue:134-140`,
    `ContactLedgerDialog`, `ReportingTabGrid.vue:171-173` — and **fix the pre-existing dead
    route name** `invoicing.purchase-invoices.edit` → `invoicing.purchases.edit`
    (`ReportingTabGrid.vue:171`; today clicking an incoming row throws).
  - Nav (`invoicing-ui/src/layouts/DefaultLayout.vue:64-73,83-89`): Outgoing Documents children
    become *Sales Documents*, *Proforma* (+ *Cash Sales* after FR-03); Incoming Documents child
    becomes *Purchase Documents*. Remove the Credit Notes / Debit Notes entries and the
    matching `PAGE_REGISTRY` rows (`ui-shared/src/nav/page-registry.ts`) — redirects keep old
    favorites working.
- **FR-1.19 (MUST)** i18n — new keys, all four locales (values below are proposals; have a
  native speaker confirm bg/mk):

  | key | en | bg | de | mk |
  |---|---|---|---|---|
  | `invoicing.docType.invoice` | Invoice | Фактура | Rechnung | Фактура |
  | `invoicing.docType.credit_note` | Credit Note | Кредитно известие | Gutschrift | Кредитна нота |
  | `invoicing.docType.debit_note` | Debit Note | Дебитно известие | Lastschrift | Дебитна нота |
  | `invoicing.docType.cash_sale` | Cash Sale | Касова продажба | Barverkauf | Готовинска продажба |
  | `invoicing.docType.proforma` | Proforma | Проформа | Proforma | Профактура |
  | `nav.salesDocs` | Sales Documents | Документи за продажба | Verkaufsbelege | Продажни документи |
  | `nav.purchaseDocs` | Purchase Documents | Документи за покупка | Einkaufsbelege | Набавни документи |
  | `invoicing.documentType` | Document Type | Тип документ | Belegart | Тип на документ |

---

## 4. Edge cases

1. **Interleaved numbering gaps per type** — INV-2026-00101 (invoice), INV-2026-00102 (credit
   note): expected and intended; the badge + `type` export column are the discriminator.
2. **Void of an outgoing CN** reverses via a *dispatch* → availability validation can 400 if
   the returned goods were since sold. Same behavior as today; surface the server message.
3. **Incoming CN with more qty than ever received** — the `return(−)` movement doesn't
   validate availability (it's not a dispatch) and can drive stock negative; mirror of today's
   lax behavior. MAY add validation later; document in the code.
4. **Over-crediting**: Σ credit notes may exceed the related invoice's total. Do **not** hard-block
   (partial/legacy data); SHOULD show a non-blocking warning in the form when
   `Σ(existing CN totals for related) + current > related.total`.
5. **Editing a legacy CN/DN without `relatedInvoiceId`** → 422 until a reference is picked
   (FR-1.7). Check production data first: `db.invoices.count({type:{$in:['credit_note','debit_note']}, relatedInvoiceId:null})` —
   if regal has many, add a one-off backfill or relax PUT to warn-only (decide at impl).
6. **Type immutability**: user saves a draft as Invoice, then realizes it's a CN → they must
   delete the draft (allowed: draft-only DELETE) and recreate. Acceptable; the selector is
   create-only by design.
7. **Related invoice later voided** — no cascade; the note keeps pointing at it. Ledger/aging
   treat each doc independently (existing semantics).
8. **`types` filter + `type` filter both sent** — server must treat `types` as authoritative
   when both present (today `type` then `types` overwrite in sequence — make it deterministic).
9. **Contact ledger `documentTypes` query param** values are unchanged (`credit_note` etc.);
   no client migration.
10. **Payments against notes**: `POST /:id/payments` is not type-gated today and stays so
    (recording a refund payment against a CN is legitimate).

## 5. Integration & regression constraints

- `bill-import` + `doc-import` create only `type='invoice'` bills — untouched paths; run the
  doc-import integration suite (`packages/tests/src/integration/doc-import.flow.test.ts`).
- `import-sales-invoices` / ORD flows: unchanged (`type='invoice'` only). Reservation guard
  already excludes notes.
- Sales-side `dedupe.ts` builds "already imported" patterns via `resolveDocPrefix` — after
  FR-1.1 it resolves `INV` for notes; imports never create notes, so no behavior change, but
  keep the unit tests green.
- e2e + gridId stability: list route names unchanged (constraint #3 in README).
- Legacy `invoice.dao.ts:4-9` has its own hardcoded `TYPE_PREFIX_MAP` (CRN/DBN) with a
  registry-bypassing allocator — confirm nothing in the live path calls it (it's legacy DAO);
  do **not** modernize it here, just add a comment pointing at the registry.
- `packages/config/src/constants.ts:55` `INVOICE_TYPES` is already divergent (missing
  `cash_sale`) — out of scope, leave.

## 6. Migration / rollout

1. Pure code deploy — **no data migration**. Counters continue; historic numbers immutable.
2. Deploy order within the release: backend (validation + registry + exports) and UI ship
   together (the UI's mandatory-related rule depends on the 422s; the merged list depends on
   `types` already existing — it does).
3. Release note for operators: "new credit/debit notes are numbered in the INV-/BILL- series;
   existing CRN-/DBN- documents keep their numbers".

## 7. Acceptance criteria

- [ ] Merged sales list shows all three types with badges; type filter works; CN row shows its related invoice number as a link.
- [ ] New CN from the merged form: type selector → related invoice becomes required + searchable; save draft → `DRF-INV-…`; send → next `INV-…` number in the shared sequence (create an invoice in between to prove interleaving).
- [ ] Sending the CN restocks (outgoing) — verify in product ledger; JE has reversed sides; contact ledger sales total drops.
- [ ] Purchase side: new incoming CN gets `BILL-…` on receive, stock **decreases**, ledger purchases total drops; incoming DN gets `BILL-…`, stock increases.
- [ ] POST/PUT of a CN without related invoice / wrong contact / draft related → 422 with the specified messages.
- [ ] `/credit-notes*` URLs redirect correctly (list, new, edit); old favorites still open.
- [ ] Export from merged list includes the Type column; reporting incoming tab shows incoming notes.
- [ ] `bun run test` (new numbering/validation/stock/JE specs) + `bun run build` + doc-import e2e green.

## 8. Field test plan (lgrai.app / regal, after deploy)

1. Preflight (read-only): count legacy notes without `relatedInvoiceId` (edge case 5); note the
   current `SALES_DOC` counter value from `/invoicing/configuration/sequences`.
2. Create + send a normal sales invoice → note its number N.
3. Create a credit note against it (real product line, warehouse СКЛАД-1) → verify number N+1
   with the same INV prefix, badge in the grid, restock in the product's ledger tab, reversed
   JE in Accounting, and the contact's ledger.
4. Void the CN → stock returns; aging unchanged.
5. Purchase side: pick a real supplier bill; create an incoming CN referencing it (1 unit of a
   high-stock product) → `BILL-…` number, stock −1, supplier ledger total drops. Then void.
6. Sequences page: CRN/DBN rows gone; INV/BILL display-prefix override still editable and
   applied to the *next* allocation only.
7. Regression: run one day's `import-sales-invoices` + `import-purchase-invoices` dry-run
   against the API — drafts and converts must behave byte-identically.
