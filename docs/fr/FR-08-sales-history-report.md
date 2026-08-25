# FR-08 — „История на продажбите" / Sales History & cash reconciliation report

**Goal:** One chronological report of **all register-related sales** for a period — sales
invoices paid **in cash**, sales invoices paid **by card** (clearly distinguished), and
**cash sales** — with columns date, **time**, register, user, operation number, contact,
status, invoice number, value, payment method, and an **end summary** comparing system
sales ↔ expected cash ↔ card payments for end-of-day reconciliation.

Status: draft for implementation · Date: 2026-08-25 · Depends on: **FR-06** (registry
entry + handler in the Reports app, issue #14) · Feeds: FR-09 (the day-close screen shows
the same expected amounts).

Source requirement: „Spravki ledger.docx" §2 — verbatim text in the appendix. Legacy
layout (`word/media/image3.png`): flat listing (ДАТА, ЧАС, каса, НОМЕР, ПАРТНЬОР, СТАТУС,
-ФЕ №, СУМА, ПЛАЩАНЕ В брой/С карта, КОМЕНТАР) mixing anonymous register receipts with
invoiced sales, Всичко totals row, refresh + filter + export toolbar.

**⚠ Scope decision this FR makes explicit (flag to goran):** LGR has **two disjoint sale
worlds** — `Invoice` documents (`type: 'invoice' | 'cash_sale'`) and `POSTransaction` docs
(the POS terminal). No reference links them (`POSTransaction.invoiceId` is declared but
never written). This report includes **both**, as a union — the same pattern the SUPTO
18.1 export already uses (`supto-export.service.ts:22-43`). At regal today the volume is
in documents (imported CSRs + sales invoices); POS rows appear if/when the terminal is
used.

---

## 1. Current state (master @ `dc1422c`)

**Invoice payment identity** (`packages/db/src/models/invoice.model.ts`):
- `paymentMethod: String` (`:245`) — **untyped, optional**; the de-facto set is
  `cash|card|bank_transfer|check` (UI DDL `usePaymentMethods()` — which omits
  `other/mobile/voucher`).
- `payments[]` subdocs (`:235-244`): `{date, amount, method ∈
  [cash,bank_transfer,card,check,other], reference, bankAccountId, journalEntryId}`.
  **`POST /invoices` has no `payments` key** (`invoice.controller.ts:529-609`) — every
  UI-created document carries the method **only on the header**; payment rows come solely
  from `POST /invoices/:id/payments` (`:907-973`).
- Cash sales are born `status:'paid'`, `amountPaid = total`, `paidAt = now`,
  `createdBy = user.id` (`invoice.controller.ts:427, 451-468`). `createdBy` is required
  on every invoice (`invoice.model.ts:273`). `operatorCode` is **never persisted on
  documents** (only on AuditLog rows and inside POS `unpNumber`).
- **No `date` field exists** — only `issueDate` (midnight, date-only strings from the UI:
  `useDocumentForm.ts:61-63`, `document-payload.ts:274-279`; the emitted `p.date` is
  silently dropped by strict mode). Full timestamps exist only on
  `createdAt`/`paidAt`/`statusHistory[].changedAt`.
- `buildPaymentMethodFilter` (`invoice.controller.ts:190-204`) matches
  `$or: [payments.method $in, paymentMethod $in]` — an OR, so a doc with a stray payment
  row matches **both** cash and card; a naïve split double-counts.
- The export collapse (`invoice-export.controller.ts:111-120`) sums `payments[]` by
  method and **infers `cash` for any cash-sale with `amountPaid > 0` and no payment
  rows — ignoring an explicit `paymentMethod: 'card'`**. The list summary precedent is
  `computeAggregates`/`summaryLines` + `REPORTED_METHODS = ['cash','card','bank_transfer']`
  (`reporting/src/excel/invoicing-list.excel.ts:142-217`) — zero lines included by design,
  mixed currency → no grand total.

**POS side** (`pos-transaction.model.ts`, `pos-session.model.ts`,
`invoicing-api/src/controllers/pos.controller.ts` prefix `/org/:orgId/trade/pos`):
- `POSTransaction`: `sessionId`, `transactionNumber` (TXN seq), `type ∈
  [sale,return,exchange,storno]`, `status ∈ [completed,cancelled]`, `customerId?`,
  `lines[]`, totals, **`payments[{method ∈ cash|card|mobile|voucher, amount}]`**
  (multi-tender, `changeDue`), `fiscalReceiptNumber`, **`fiscalDeviceNumber` (string —
  the only register identifier anywhere)**, `unpNumber`, `isFiscal`, `createdBy`,
  timestamps. Index `{orgId, type, createdAt:-1}`. **True sale time = `createdAt`.**
- `POSSession`: `warehouseId`, `cashierId`, `totalCash`/`totalCard` accumulated on sale
  (`pos.controller.ts:443-452`) — **storno does NOT decrement them** (`:617-619`), so
  `session.expectedBalance` drifts after a cash storno; reconciliation must recompute
  from transactions.
- `GET /transactions` (`:661-689`) filters `createdAt` (with a `T23:59:59` day-end hack),
  no payment-method/cashier/warehouse filters, no hydration.
- POS sales create **no Invoice**; session close creates a JE + an unconfirmed batch
  movement (`auto-journal.service.ts:327-500`).

**Register identity gap:** `Invoice` has **no** `warehouseId` (header), `sessionId`,
`workstationId`, or `fiscalDeviceNumber` — nothing identifies the register for document
rows. `Workstation.code/name` exists but `workstationId` is never written to any
transactional document. Only `lines[].warehouseId` hints at location.

**Time truth table:** POS rows — real wall-clock (`createdAt`). UI-created documents —
`createdAt` ≈ sale time (same-day entry). **Imported CSR cash sales — no time exists**
(`createdAt` = import batch run; the source XLSX is a per-day aggregate; rows carry
`tags: ['cash-register-import']`, `reference: 'salesAnalysis:<date>'` —
`map-cash-sale.ts:36-39, 84-103`).

**Adjacent bug (leftover §A of the handover):** `CashSalesView.vue:198,47` renders
`item.date` which the API never returns → the ДАТА column is blank for that grid.

**Missing indexes:** none on `Invoice.createdAt`, `Invoice.paymentMethod`,
`Invoice.payments.method`.

## 2. Requirements

### 2.1 Registry entry & params

- **FR-8.1 (MUST)** Report-registry entry `id: 'sales-history'`, category `sales`,
  `permission: 'invoicing.read'`, `outputs: ['table','xlsx','pdf']` — one registry entry +
  one handler per FR-6.6, rendered by the generic runner (URL-synced params, post-
  generation column cog, ExportDialog — all per FR-06).
- **FR-8.2 (MUST)** Params: `dateFrom`/`dateTo` (required, presets per FR-6.11; default =
  today — the legacy screen opens on the current day), `paymentMethods[]` (default
  `[cash, card]`), `source: 'all'|'documents'|'pos'` (default `all`), `userId?`,
  `warehouseId?`, `contactId?`, `includeNonRegister?: boolean` (default **false** — when
  true, adds bank-transfer/check-paid sales invoices; the docx scopes the report to the
  register, but the toggle answers "where is the rest?").

### 2.2 Row union

- **FR-8.3 (MUST)** Document rows: `Invoice` with `direction:'outgoing'`,
  `type $in ['invoice','cash_sale']`, `status $nin ['draft','voided','cancelled',
  'converted']`, whose **effective payment method** (FR-8.4) intersects
  `paymentMethods[]`. Window on **`issueDate`** (business day). Credit notes **SHOULD**
  be included as negative rows when cash/card-paid (flag in meta how many were included);
  proformas never.
- **FR-8.4 (MUST — the precedence rule)** Effective payment method(s) of a document:
  1. `payments[]` entries when present (per-method amounts; a split-tender doc
     contributes each method's amount to the summary and renders the joined label);
  2. else the header `paymentMethod`;
  3. else, for `type:'cash_sale'` with `amountPaid > 0`, infer `cash`.
  This **fixes, for this report, the export fallback that misreports an explicit
  `paymentMethod:'card'` cash sale as cash** — do not change the existing export
  controller's behavior (its outputs are contract-frozen); implement the rule in the new
  handler and add a unit test for the card-cash-sale case.
- **FR-8.5 (MUST)** POS rows: `POSTransaction` with `status:'completed'`, all types
  (`return`/`storno` negative, rendered with the original-receipt reference when
  present). Window on **`createdAt`** (the SUPTO-export asymmetry, stated in the report
  meta). Method filter applies to `payments[].method` (`mobile`/`voucher` count as
  „other").

### 2.3 Columns

- **FR-8.6 (MUST)** Columns (catalog for the cog + export, defaults per legacy layout):
  | Column | Document row | POS row |
  |---|---|---|
  | Дата | `issueDate` | `createdAt` (local day) |
  | Час | `createdAt` time; **blank** when `tags` contains `cash-register-import` (no true time exists — meta footnote) | `createdAt` time |
  | Каса (register) | blank (no register identity on Invoice — see FR-8.11); SHOULD show the dominant `lines[].warehouseId` name as a proxy, visually distinct | `fiscalDeviceNumber` → device name → `Workstation.code` when linked |
  | Потребител | `createdBy` → user display name | `createdBy` |
  | Номер | `invoiceNumber` (CS/CSR or INV) | `transactionNumber` (+ `fiscalReceiptNumber` in tooltip) |
  | Партньор | contact name (blank for anonymous) | `customerId` name |
  | Статус | localized `invoicing.status.*` | localized |
  | Фактура № | `invoiceNumber` when `type:'invoice'` (the legacy „-ФЕ №"); blank for cash sales | blank (no POS→invoice link exists) |
  | Стойност | `total` (negatives for credit notes) | `total` (negatives for return/storno) |
  | Плащане | effective method label(s), cash vs card visually distinct (chip colors) | joined `payments[].method` labels |
  Sorted by timestamp descending by default. Rows are heterogeneous — a `rowType:
  'document'|'pos'` field drives per-row link targets (document rows link to
  `/invoicing/...`, POS rows to `/pos/orders/:id` — cross-app `href`s, not router links).
- **FR-8.7 (MUST)** Summary block (the docx's „Обобщение"), per currency when mixed:
  count of operations; **Продажби в системата** (Σ value); **Очаквани в брой** (Σ cash
  amounts by FR-8.4/8.5 — POS amounts recomputed from `POSTransaction.payments[]`, NOT
  from `session.expectedBalance`, which is storno-blind); **Плащания с карта** (Σ card);
  **Други** (non-zero only). Follows the `summaryLines`/`REPORTED_METHODS` house pattern
  incl. deliberate zero lines for cash/card.

### 2.4 Non-functional

- **FR-8.8 (MUST)** Read-only, aggregation/lean-projection based, row cap per FR-6.15
  („narrow the period"), exports via the `packages/reporting` house style; new i18n
  header keys (`time`, `register`, `user`, `operationNumber`) ×4 in
  `reporting/src/i18n.ts`.
- **FR-8.9 (SHOULD)** Add index `{orgId, type, createdAt: -1}` on `Invoice` if the
  time-window queries show a scan at regal scale (~40k invoices); measure first.
- **FR-8.10 (SHOULD)** Fix the blank ДАТА column on `CashSalesView.vue` (render
  `item.issueDate`) — pre-existing bug the fieldwork already logged; this report renders
  dates correctly regardless.
- **FR-8.11 (MAY — flagged decision)** Add a header-level register identity to `Invoice`
  (`workstationId?` or `fiscalDeviceNumber?`) populated going forward by the cash-sale
  terminal, so document rows can fill the Каса column. Schema-only + one write site;
  historic rows stay blank. Goran decides whether the column matters enough for
  documents.

## 3. Edge cases

1. **Split tender** (POS multi-payment, invoice part-cash part-card payment rows): one
   row, joined method label, per-method amounts feed the summary — Σ summary must equal Σ
   value column (assert in tests).
2. **Cash sale explicitly marked card** (regal uses this to record card days): must land
   in the card bucket (FR-8.4 rule; regression test).
3. **Imported CSR day-aggregate rows**: one row per imported day (value = whole day's
   register turnover, method cash, time blank) — the meta footnote explains why the day
   shows one big row instead of individual receipts.
4. **Storno/returns**: negative, summary nets them; a period containing only a storno
   shows negative totals.
5. **Voided/cancelled documents are excluded** — reconciliation wants money actually
   taken. (The legacy СТАТУС column showed завършена; LGR shows the live status of
   included rows.)
6. **Overlap risk**: a POS transaction has no invoice twin today, but if a future flow
   ever writes `POSTransaction.invoiceId`, the union must dedupe (skip the invoice row
   when its POS twin is present) — state the rule now, cheap insurance.
7. **TZ/day boundary**: `issueDate` is midnight UTC; POS `createdAt` is real time. Day
   windows use `Europe/Sofia` calendar days consistently (`dateTo + T23:59:59` semantics
   like the POS list). Note the ±2/3h skew this hides is irrelevant at day granularity
   except around midnight sales — accepted.
8. **Mixed currency**: per-currency sections/summaries, no cross-currency grand total
   (house rule).
9. **User deleted/deactivated**: render stored name, never crash on missing lookup.

## 4. Integration & regression constraints

1. Rides FR-06's registry/runner — no bespoke page, no new top-level routes.
2. **No existing endpoint changes**: `/invoices` list, `/invoicing/export/*`,
   `/trade/pos/*` stay byte-identical (import skills + e2e + SUPTO export depend on
   them). The FR-8.4 precedence rule lives in the new handler only.
3. New tests: handler integration (union windows, precedence matrix incl.
   card-cash-sale, split tender, storno negatives, CSR-import time-blank, summary
   reconciliation vs per-row sums), export layout via `build*Html`. No
   `.rejects`/`.resolves` (Windows Bun deadlock — try/catch capture).

## 5. Acceptance criteria

- [ ] Reports hub card „История на продажбите" opens the runner; default view = today; rows show date/time/user/number/contact/status/value/method per the column table.
- [ ] Cash vs card clearly distinguished (chips + filter); a card-marked cash sale lands under card.
- [ ] Summary block shows system sales ↔ expected cash ↔ card ↔ other, per currency, equal to the column sums.
- [ ] POS transactions appear with true time and register; imported CSR rows show blank time with the footnote.
- [ ] Storno/credit rows are negative and net correctly.
- [ ] Column cog + URL state + XLSX/PDF export work per FR-06; localized ×4.
- [ ] `bun run test` + `bun run build` green.

## 6. Field test (lgrai.app / regal)

1. Pick an imported day (e.g. a CSR day already reconciled during migration): the report
   for that day must show the CSR aggregate row + every cash/card sales invoice of the
   day; the summary's cash+card must equal the legacy day totals (image3 shows 849.30 for
   18.08 as the reference shape).
2. Filter card-only → only card-paid invoices remain; totals match the card summary line.
3. Create a POS session + one POS cash sale on a test warehouse → the row appears with
   real time and register; storno it → negative row; summary nets to zero.
4. Export PDF/XLSX for a week; verify Cyrillic, summary block, per-currency behavior.

---

## Appendix — authoritative requirement wording (Spravki ledger.docx §2)

```
История на продажбите
Цел: справка за всички продажби, свързани с касата, за избран период; контрол и засичане
на касата.
2.1 Включва: продажни фактури, платени в брой; продажни фактури, платени с карта; касови
продажби. Плащанията с карта ясно разграничени от брой.
2.2 Информация: дата; час; каса; потребител; номер на операцията/продажбата; контрагент
(когато има); статус; номер на фактура (когато има); стойност; начин на плащане.
2.3 Обобщение: в края — общи суми за сравнение: Продажби в системата ↔ реална касова
наличност ↔ плащания с карта. Целта: в края на деня да се установи дали отчетените
плащания съответстват на реалните суми.
```
