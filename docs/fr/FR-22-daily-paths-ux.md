# FR-22 — Daily paths: fewer clicks, the next step on the same screen

| | |
|---|---|
| **Status** | Approved by the owner on 2026-10-25, together with every decision in §4 as recommended (D-1 with the subtitles). Slice 1 is in progress. |
| **Tracking** | none yet; an issue is opened once the owner approves |
| **Staff issues** | [#203](https://github.com/gjovanov/lgr/issues/203), [#168](https://github.com/gjovanov/lgr/issues/168), and the open items of [#4](https://github.com/gjovanov/lgr/issues/4) and [#3](https://github.com/gjovanov/lgr/issues/3) |
| **Measured on** | origin/master `4c6c362f` · the acme-corp seed · Bulgarian UI · 1366×768 |
| **Harness** | `packages/e2e/tests/ux-budgets/` (project `ux-budgets`) · `bun run ux:report` in `packages/e2e` |

> **Request (owner, 2026-10-25):** "create a prompt to yourself for user friendliness and better UX of LGR. e.g. less steps to click, functions close to each other... usually most users functions are: /inventory/products · /inventory/movements/new (with product update) — entering new products in the inventory without a financial document like an invoice, later connecting this movement to an invoice […] then in a later phase we enter the purchase invoice in LGR (but without stock movements) · /pos/terminal, /pos/orders & /invoicing/cash-sales (which will be merged into one function) · /invoicing/invoices · /invoicing/proforma · /invoicing/internal-orders, /invoicing/orders, /invoicing/reservations (missing CRUD)"

## 0. Goal

The regal staff have entered their documents in LGR every day since 2026-10-05. They work in the
Bulgarian UI at a laptop and at a till. Their feedback (#203, #168, #4, #3) says the same two
things: too many clicks, and the next function is somewhere else.

- **Every daily path costs less**: fewer clicks, fewer full page loads, nothing retyped.
- **The next step is on the screen you are on**: a receipt offers its bill, an invoice its credit
  note, an order its reservations and its invoice.
- **One action, one place**: Create, Save, Issue, Print sit in the same spot with the same words
  on every list and form.
- **Every linked document is a link.**
- **Nothing the walks found broken stays broken**: §1.2 lists defects that cost money or stock.

Success is measured, not asserted. Each daily path has a walk that counts what it costs today
(§1.1). Every slice lowers a budget, and the walk then asserts the new one, so a later change
cannot quietly put the clicks back.

## 1. Current state — measured

### 1.1 What the daily paths cost today

Each walk replays one daily job as a mouse user taking the shortest route the UI offers. It counts
every click, typed field, key, full page load and dialog. Navigation to the starting list is setup
and is not counted. All 14 walks pass in one run (2.0 min) on a fresh seed.

| Walk | The job | Clicks | Typed | Page loads | Dialogs |
|---|---|--:|--:|--:|--:|
| P1 | Products: find an article, check its stock, change its selling price | 6 | 2 | 0 | 0 |
| P2 | Receive goods ahead of the invoice, *with* product update, one article new | **fails at Save** (32 clicks in) | 14 | 0 | 0 |
| P2b | The same delivery by the route that works today | 43 | 16 | 0 | 0 |
| P3 | Enter the supplier's bill for goods already received | 14 | 7 | 0 | 0 |
| P4-open | Till: open the day's session | 5 | 1 | 0 | 1 |
| P4-till | Till: 2 articles, paid by card | 8 | 2 | 0 | 0 |
| P4-backoffice | The same sale as a back-office cash sale, then the next one | 9 | 2 | 0 | 0 |
| P4-storno | Storno a till sale, starting at the till | 3 | 0 | 0 | 1 |
| P5-invoice | Invoice: 3 lines, card, issue, print, mark paid | 22 | 6 | 0 | 2 |
| P5-credit | Credit note for one returned article | 14 | 5 | 0 | 0 |
| P6 | Proforma → invoice → issue → print | 17 | 5 | 0 | 1 |
| P7-chain | Client order → reserve → supplier order → send → invoice → issue | 30 | 8 | 0 | 1 |
| P7-repeat | A reservation cancelled by mistake, made again | 4 | 0 | 0 | 1 |
| P7-who | Who reserved how much on a supplier order's line | 2 + a second page | 0 | 0 | 0 |

Every path stays inside one SPA, so none of the walks costs a full page load. The cost lies in
two places instead: lists you have to go back to (Issue, Receive and payment exist only as list-row
icons), and numbers the UI shows only in a three-second snackbar.

### 1.2 Defects the walks found

These are wrong results or broken flows, independent of any UX choice.

| | Defect | Evidence |
|---|---|---|
| B-1 | **A receipt "with product update" cannot be saved** for any article that has a selling price: HTTP 422 "priceTiers exceeds maximum of 10 slots". The form pads every line to 13 tier slots (`MAX_PRICE_TIERS = 13`, 04d2c5f4 / d6606bde, August), while the server's `sanitizeProductUpdates` still caps them at 10 (`services/src/biz/product-update.service.ts:64`). The bill form's product update goes through the same check. | P2 |
| B-2 | The new-article form throws `ReferenceError: ensureTenTiers is not defined` on load (`inventory-ui/src/views/ProductFormView.vue:648`; 04d2c5f4 renamed it `ensureTierSlots`), so a new article gets no price-tier slots. | P2, P2b |
| B-3 | A new article's VAT starts at 0 % (`ProductFormView.vue:296`) instead of `org.settings.taxConfig.defaultVatRate`. | P2b |
| B-4 | **A bill for goods already received books the stock a second time**: 10 received units raised the stock by 20. Nothing links the bill to the receipt or warns (#168). | P3 |
| B-5 | **Converting a proforma burns an invoice number**: the converted draft takes one from the issued counter (`invoicing-api/src/controllers/invoice.controller.ts:1338`), and issuing takes another (`:1083`). | P6 |
| B-6 | **A credit note made from a discounted invoice credits the undiscounted price** (204.00 instead of 183.60) and loses the unit (`invoicing-ui/src/composables/document-form/useDocumentForm.ts:842-866`). | P5-credit |
| B-7 | **Converting a client order invoices goods that have not arrived**: Convert takes every open reservation, including those held on a sent but unreceived supplier order, and Issue's stock check exempts them. Stock went 404 → −10, and the order read „Доставена". | P7-chain |
| B-8 | The receipt form's supplier field loads `GET /invoicing/contact` with no size, so it offers the API's first 10 of 20 contacts (`MovementFormView.vue:714`), customers included. Three of eight suppliers could not be picked. | P2 |
| B-9 | The record-payment dialog defaults the method to bank transfer, whatever the invoice says. Its amount reads `item.paidAmount`, but the API returns `amountPaid`, so a partly paid invoice suggests the full total. | P5-invoice; research |
| B-10 | A bill line pre-fills the article's **selling** price: the purchase document resolves the sales price chain. | P3 |
| B-11 | A proforma's validity date is shown (+30 days) but not saved. | P6 |
| B-12 | Sorting by № does nothing on the client-order and reservation lists: the server sorts on a field computed after the query. | research |
| B-13 | The invoice's smart buttons are English („Journal Entry", „Payments", „Deliveries") and route to paths the invoicing app does not have (`useDocumentForm.ts:905,914`). | P5-invoice |
| B-14 | **English in the Bulgarian UI:** 11 keys missing from `bg.json`, among them `common.download`, `common.subtotal`, `common.qty`, `common.unit` and `common.statusHistory`. `common.remove` is missing in bg and en, so screens show the raw key. More English: the snackbar's „Close" (hard-coded in every SPA's `App.vue`); the `/pos/orders` journal; the movement status steps (draft → confirmed → completed); the product type „goods"; API validation messages. | all |
| B-15 | Leaving an untouched invoice within ~500 ms of its load raises a false „Незапазени промени": the form snapshots itself on a timer, not when the document has loaded. | P6 |
| B-16 | Issuing a credit note reports „Фактурата е изпратена". | P5-credit |
| B-17 | Status filters offer statuses the model doesn't have (cash sales `completed`, proforma `accepted` / `expired`) and miss real ones. The type filter's placeholder reads „Всички статуси". | P5-invoice, P3; research |
| B-18 | The till keeps the last payment method after a sale, so the next cash customer is booked as card. | P4-till |

### 1.3 Friction, by path

- **P1.**
  - Nothing on the list or on the article's stock tab says what is reserved or on order (#203.8, #4.5).
  - Unit comes before Stock in the default column order (#4.1).
  - There is no "receive", "sell" or "reserve" next to an article.
- **P2.**
  - The receipt can't create an article; the user detours through Products.
  - „Към склад" is not preselected.
  - The product-update switch starts off every time.
  - Picking an article doesn't add the next line.
  - The line table is wider than 1366 px.
  - Save leaves a draft that needs a separate „Потвърди", and the page never shows the receipt's number.
- **P3.**
  - Nothing goes from a receipt to a bill.
  - Receiving is a list-row icon only.
  - Payment method starts as cash on a supplier bill.
- **P4.** All of it is FR-21 territory (§6).
  - **Till sale:**
    - A scan only filters the grid; there is no Enter-to-add.
    - After a sale the search keeps the last text and loses focus.
    - The line shows a net price to 4 decimals.
    - No receipt or УНП is shown.
  - **Open session:** the warehouse is picked by hand every morning, and the float starts at 0.
  - **Storno:** it means leaving the till for an English journal that shows no articles, time or cashier.
  - **Back-office sale:** Save lands on the list, and the next sale starts again from Create.
- **P5.**
  - Save returns to the list.
  - Issue and Record payment exist only as list-row icons; Print exists only on a reopened document.
  - The row actions sit past the table's right edge at 1366 px, behind a scrollbar ~1,900 px down the page, and only about two rows fit on screen.
  - The customer list opens unsorted, with suppliers mixed in.
  - Place of deal has no field.
  - No credit note can be started from an invoice.
- **P6.**
  - A proforma can never be issued or emailed.
  - Convert asks nothing and leaves the user on the proforma list. The invoice is then issued on another list and printed after reopening it.
  - The payment method is dropped by the conversion.
- **P7.**
  - The new supplier-order and invoice numbers appear only in snackbars. Of the hand-offs, only ORDO → ORDI is a link.
  - The client order never shows its invoice.
  - Reservations have no Create, detail, edit or repeat, and cancel always releases everything.
  - The supplier order cannot say which client reserved what.
  - Cascading cancels confirm nothing.

## 2. Requirements

Each requirement names its evidence: a walk, a defect from §1.2, or a staff ask. Slices (§8) group
them into PRs.

### 2.1 Fix what is broken (slice 1)

- **FR-22.1 (MUST)** One tier-slot limit, the model's 13, shared by the receipt form, the bill
  form and `sanitizeProductUpdates`. (B-1; integration test: a 13-slot update on both paths)
- **FR-22.2 (MUST)** The new-article form seeds its tier slots (B-2). VAT defaults to
  `taxConfig.defaultVatRate` through the same `TaxRateCombobox` the documents use (B-3).
- **FR-22.3 (MUST)** A converted proforma becomes a draft with a draft number. Only issuing
  allocates from the issued series, so convert + issue yields consecutive numbers. (B-5;
  integration test)
- **FR-22.4 (MUST)** Credit and debit notes made from an invoice keep each line's discount and
  unit, and a credit note can show a discount column. (B-6)
- **FR-22.5 (MUST)** Converting a client order invoices only what can be dispatched. A
  reservation held on a supplier order counts only up to what its allocation has received, and
  the rest stays reserved for a later invoice. Issue's pre-check applies the same rule. (B-7;
  integration test reproducing −10)
- **FR-22.6 (MUST)** The receipt's partner field searches the server and is called „Доставчик"
  on a receipt; every supplier is reachable. Promote `ContactAutocompleteWithCreate` to ui-shared.
  (B-8)
- **FR-22.7 (MUST)** The record-payment dialog defaults to the document's payment method and to
  the outstanding amount (total − `amountPaid`). **SHOULD:** the API refuses an amount above the
  outstanding. (B-9)
- **FR-22.8 (MUST)** Purchase documents pre-fill the purchase price, never the sales chain.
  (B-10)
- **FR-22.9 (MUST)** A proforma's validity is stored and listed. (B-11)
- **FR-22.10 (MUST)** № sorting works on the client-order and reservation lists. (B-12)
- **FR-22.11 (MUST)** Every key the daily paths use exists in en, bg, de and mk. The hard-coded
  English in B-14 moves into the catalog: the snackbar „Close", smart buttons, movement statuses
  and product types. `/pos/orders` follows D-6. A unit test fails when bg lacks a key that en
  has. (B-14)
- **FR-22.12 (SHOULD)** Smart buttons open the right app through `appHref`, or are removed.
  (B-13)
- **FR-22.13 (MUST)** A form takes its clean snapshot after the document has loaded, so it raises
  no false unsaved-changes prompt. (B-15)
- **FR-22.14 (SHOULD)** Success messages name the document type. (B-16)
- **FR-22.15 (MUST)** Status filters offer exactly the model's statuses and declare their
  defaults, so a bare URL stays bare. The type filter says „Всички типове". (B-17)

### 2.2 Issue, print and get paid without leaving the document (slice 2: P5, P6)

- **FR-22.16 (MUST)** Save keeps the user on the saved document, on every invoicing document
  form.
- **FR-22.17 (MUST)** The form issues.
  - A draft offers „Издай"; a new or edited document offers „Запази и издай".
  - The stock check and transfer dialog move out of `SalesInvoicesView` into a shared composable
    that the list and the form both use.
- **FR-22.18 (MUST)** One primary action finishes the job: „Издай и печатай" saves, issues and
  prints.
  - Print on an unsaved document saves first (#4.13).
  - A draft that is printed is marked „ЧЕРНОВА" and never shows a number it will lose.
- **FR-22.19 (MUST)** A card payment settles on issue, as cash does since e3ebe8e1 (#203.3, D-3).
- **FR-22.20 (SHOULD)** „Печат" produces the PDF in one click with the user's last settings. The
  options dialog stays one click further away.
- **FR-22.21 (MUST)** An issued invoice offers „Кредитно известие" and „Дебитно известие" on its
  form and in its row menu. Each opens a note pre-filled from the invoice per FR-22.4.
- **FR-22.22 (MUST)** Proforma:
  - it can be issued (it gets its PRF number) and emailed;
  - Convert lands on the new invoice's form, which carries over payment method, place of deal,
    notes, tags and due date, ready for „Издай и печатай".
- **FR-22.23 (MUST)** Document lists fit 1366 px. Row actions live in one compact menu that needs
  no sideways scroll, and a row is one line tall. Each action shows exactly when the API allows
  it: Void on issued documents, Delete on drafts only.
- **FR-22.24 (SHOULD)** Row menus offer Печат, Копирай and Кредитно известие.
- **FR-22.25 (SHOULD)** The partner picker shows the right side first, ordered by recent use:
  customers on outgoing documents, suppliers on incoming ones.
- **FR-22.26 (SHOULD)** Payment method and „Последна цена за клиента" are remembered per user
  and document type. Proformas get last price too.
- **FR-22.27 (SHOULD)** Outgoing documents get a place-of-deal field, defaulted per D-7 (#4.9).

### 2.3 Receive the goods, then bill them (slice 3: P2, P3, #168)

- **FR-22.28 (MUST)** The receipt form:
  - preselects the user's pinned or the org's default warehouse;
  - remembers „С актуализация на продукт" per user;
  - adds a line when the last one gets an article;
  - navigates its grid by keyboard (move `useGridNavigation` to ui-shared);
  - fits 1366 px;
  - shows the destination warehouse's stock.
- **FR-22.29 (MUST)** „Запази и потвърди" books a new receipt in one action. The saved receipt
  shows its SM- number, and its status steps are in Bulgarian.
- **FR-22.30 (MUST)** A new article can be created from a receipt line, and from a bill line:
  „+ Нов продукт „…"" in the article search. The dialog has:
  - name, unit, category (org default) and VAT (org default);
  - purchase and selling price, with tiers from the org's tier template;
  - an SKU continued from the sequence.
  It reuses doc-import's article creation (#3).
- **FR-22.31 (MUST)** On a completed receipt with a supplier, „Входяща фактура" opens a new bill
  (#168).
  - The bill is pre-filled with supplier, warehouse, lines, quantities and the receipt's unit
    costs.
  - It is linked by `stockSource {marker: 'movement:<id>', docNumber, movementIds, detectedBy:
    'manual'}`, so receiving it moves no stock.
  - The receipt links to its bill and the bill to its receipt.
  - A receipt is billed once; a second link answers 409.
  - Several receipts per bill, and price differences, follow D-2.
- **FR-22.32 (SHOULD)** The bill form has „Свържи с доставка": pick received, not-yet-billed
  receipts of the chosen supplier, with the same linkage.
- **FR-22.33 (MUST)** The bill form offers „Запази и получи". Payment method starts empty, then
  per FR-22.26.

### 2.4 Orders and reservations (slice 4: P7)

- **FR-22.34 (MUST)** Order names per D-1, in all four languages (#203.4).
- **FR-22.35 (MUST)** Every number on the chain is a link, in lists, forms and cards: client order
  (ORDI), supplier order (ORDO), reservation (RES), invoice. After „Създай външна поръчка" and
  „Преобразувай във фактура" the user lands on the new document. No number exists only in a
  snackbar.
- **FR-22.36 (MUST)** The client-order and supplier-order forms list their invoices; the API
  already returns them.
- **FR-22.37 (MUST)** Reservations get a screen:
  - Create on the list: client, article, quantity, and a source of free stock in a warehouse or an
    ORDO allocation, with an optional ORDI line;
  - a detail page at `/reservations/:id` with history and links;
  - „Повтори" on a cancelled reservation (#203.7, D-4);
  - partial release;
  - a cancel dialog whose buttons cannot be confused („Не" / „Освободи резервацията").
- **FR-22.38 (SHOULD)** An active reservation's quantity can be edited (D-4).
- **FR-22.39 (MUST)** The Reservations list:
  - filters by source and by order;
  - searches order numbers and article SKU or name;
  - labels the source as client order or supplier order, as links (#203.6).
- **FR-22.40 (MUST)** The supplier-order form shows, per allocation, the reserving clients with
  their client order and quantity; its reservations card gets a product column (#203.5).
  - The allocation chip says „резервирано" instead of „R", and fits 1366 px.
  - The list shows how many clients have reservations on each order.
- **FR-22.41 (MUST)** Cascading cancels (ORDO Cancel, ORDI Complete and Cancel) confirm with the
  number of reservations and orders they release. ORDO Cancel names the affected client orders.
- **FR-22.42 (SHOULD)** Generating a supplier order:
  - offers to add to an existing draft ORDO for that supplier;
  - shows the destination warehouse.
- **FR-22.43 (SHOULD)** The client-order form adds a line once the last one gets an article.
  „Резервирай от склад" names the short lines when nothing is free.
- **FR-22.44 (SHOULD)** A line covered only by an unsent supplier order reads „Поръчана", not
  „Резервирана".

### 2.5 Products (slice 5: P1)

- **FR-22.45 (MUST)** Every article shows two figures, per warehouse (#203.8, #4.5):
  - **Reserved**: from `StockLevel.reservedQuantity`.
  - **On order**: Σ (ordered − received) over sent and partially received supplier orders, from a
    new product-scoped endpoint.
  - Both appear as columns on the Products list (cog-selectable, on by default) and on the stock
    tab. Each figure links to the reservations or supplier orders behind it.
- **FR-22.46 (MUST)** The default column order puts Stock before Unit (#4.1).
- **FR-22.47 (SHOULD)** An article offers „Заприходи", „Продай" and „Резервирай", in the row menu
  and on its page. Each opens the document with the article on its first line.
- **FR-22.48 (SHOULD)** Deactivated articles are hidden unless the filter asks for them.

### 2.6 Anywhere in one move (slice 6: navigation)

- **FR-22.49 (MUST)** A „+ Нов" menu in every app's top bar opens a new daily document (#4.14):
  - outgoing invoice, credit note, proforma;
  - cash sale;
  - supplier bill, goods receipt;
  - client order, supplier order, reservation.
  It crosses apps through `appHref`.
- **FR-22.50 (MUST)** A Create button says what it creates („Нова фактура", „Нова разписка"…)
  and sits in the same place on every list. The sales list's Create offers invoice, credit note
  and debit note (#203.1, D-8).
- **FR-22.51 (SHOULD)** ★ (favorites):
  - pins forms (`/new`) and filtered lists;
  - opens on hover;
  - appears on the App Hub and the dashboard.
- **FR-22.52 (SHOULD)** Keyboard:
  - Ctrl+S saves;
  - Ctrl+Enter runs the primary action;
  - a new document focuses its first field;
  - Esc closes a dialog.
  Tooltips name each shortcut.
- **FR-22.53 (SHOULD)** After a 401, signing in returns to the page the user was on.

### 2.7 At the counter (slice 7: P4 — FR-21 inputs, or quick fixes per D-6)

- **FR-22.54 (MUST)** After a till sale:
  - the payment method resets to cash (B-18);
  - the search is cleared and focused;
  - the result (number, total, change) stays visible until the next scan.
- **FR-22.55 (MUST)** Enter adds the exact barcode or SKU match, at the till and in the back
  office, whatever the search debounce is doing.
- **FR-22.56 (SHOULD)** Payment is one button per method („Брой", „Карта"), with tendered amount
  and change for cash.
- **FR-22.57 (SHOULD)** Opening a session preselects the device's last warehouse and offers the
  last counted cash as the float.
- **FR-22.58 (SHOULD)** The back-office cash sale saves into a fresh sale („Запази и нова") and
  shows what it saved.
- **FR-22.59 (SHOULD)** Storno is reachable from the till for permitted roles. The journal shows
  articles, time and cashier (FR-21 §3.4 builds that journal).
- **FR-22.60 (D-5)** A cash sale can be turned into an invoice (#203.2). Use a `stockSource` link
  that does **not** re-point the sale's movements, so voiding the cash sale still finds them.

## 3. Budgets — today → target

The targets assume the MUST requirements. A slice is done when its walks meet them, and the walk
then asserts them.

| Walk | Today | Target | What gets it there |
|---|---|---|---|
| P1 | 6 clicks · 2 typed · no reserved / on order | ≤ 6 · 2 · both figures on the row and the stock tab | FR-22.45 |
| P2 | fails at Save | ≤ 20 clicks · ≤ 13 typed · 0 page loads | FR-22.1, .2, .28–.30 |
| P2b | 43 · 16 | retired: P2 is the route | — |
| P3 | 14 · 7 · stock booked twice | ≤ 4 clicks · 1 typed · ≤ 1 page load · stock unchanged | FR-22.31, .33 |
| P4-open | 5 · 1 · 1 dialog | ≤ 2 · 0 | FR-22.57 |
| P4-till | 8 · 2 | ≤ 4 · scans by Enter | FR-22.54–.56 |
| P4-backoffice | 9 · 2 | ≤ 6 · 2 | FR-22.55, .58 |
| P4-storno | 3 · 1 dialog (best case) | ≤ 3 from the till, any sale findable | FR-22.59 |
| P5-invoice | 22 · 6 · 2 dialogs | ≤ 14 · 6 · ≤ 1 dialog · paid with no extra step | FR-22.16–.20, .23, .26 |
| P5-credit | 14 · 5 | ≤ 6 · 1 | FR-22.4, .21 |
| P6 | 17 · 5 · 1 dialog | ≤ 12 · 5 | FR-22.3, .18, .22 |
| P7-chain | 30 · 8 · numbers from snackbars | ≤ 22 · 8 · no number typed or remembered | FR-22.5, .35, .36, .43 |
| P7-repeat | 4 · only for reservations with a client order | ≤ 4 for every reservation | FR-22.37 |
| P7-who | 2 + a second page | 1 click, answered on the supplier order | FR-22.40 |
| *new* P0-new | — | from any page to any new daily document: ≤ 2 clicks | FR-22.49 |
| *new* P7-new | — | a reservation made on the Reservations list: ≤ 4 clicks, ending on its own page | FR-22.37 |

## 4. Owner decisions

The owner decided all eight on 2026-10-25, each as recommended. For D-1 that includes the
subtitles.

| | Decision | Decided |
|---|---|---|
| **D-1** | The staff asked for internal → „Входящи поръчки" and external → „Изходящи поръчки". The same menu says „Изходящи документи" for documents to clients and „Входящи документи" for supplier bills, so incoming orders would lead to outgoing documents. | Keep the staff's words, with a subtitle that settles the direction: „Входящи поръчки — от клиенти" and „Изходящи поръчки — към доставчици". Use en "Customer orders" / "Supplier orders" and the equivalents in de and mk. Route names stay. |
| **D-2** | A bill for goods already received (#168): several receipts on one bill? One receipt billed in parts? When prices differ, does the bill correct `purchasePrice` / `avgCost`? In an org that keeps journals, which side posts the inventory? | One bill may cover several receipts of one supplier; a receipt is billed once and whole, with no partial billing in v1. The bill updates `purchasePrice` for future receipts but does not re-cost goods already received, and it shows the difference per line. Journals: verify the `stock.movement.confirmed` and `invoice.posted` handlers first. If both post inventory, the linked bill must post against "received, not invoiced", and that is its own slice. No prod org keeps journals today (e3ebe8e1). |
| **D-3** | Does a card payment settle the invoice on issue? | Yes. Extend `syncCashSettlement` to `card` with origin `card_on_issue`. Bank transfer and cash on delivery stay open. |
| **D-4** | What may change on an active reservation? What does "repeat" do? | Quantity only: down to what is already invoiced or dispatched, up to what the source can still hold. To change warehouse, client or order, cancel and repeat. Repeat creates a new reservation pre-filled from the cancelled one, which keeps the audit trail. |
| **D-5** | Cash sale → invoice: now, or inside FR-21? | Now, as a small slice: the staff need it, and FR-21 §11 defers it. Agree with Atanas that R2's migration carries the link. |
| **D-6** | Today's till: quick fixes before FR-21 R5, or R5 requirements only? | Two contained fixes now: FR-22.54 (reset, refocus, show the result) and FR-22.55 (Enter adds). The rest becomes R5 requirements, agreed with Atanas. |
| **D-7** | Place of deal: from the warehouse, or per user? | The document warehouse's `address.city`, falling back to the org address. Editable on the form. |
| **D-8** | #203.1 asks for "Create buttons in one place", but every list's Create is already rightmost in its header. Which inconsistency did the staff mean? | Ask them. Meanwhile ship what removes every candidate: FR-22.50 (labelled buttons, one notes menu), FR-22.16–.18 (one action bar on every form) and FR-22.49 (one „+ Нов" everywhere). |

**D-2, the journals question, verified on 2026-10-25: no separate slice is needed.**
- A confirmed receipt posts Dr inventory / Cr purchases (`auto-journal.service.ts`,
  `createMovementValuationEntry`).
- A received bill posts Dr expense / Cr payable (the `invoice.posted` handler). It never posts
  inventory.
- A bill linked to an earlier receipt by `stockSource` creates no second movement, so the books end
  exactly where they do today for a bill that books its own receipt: inventory once, payable once,
  and the purchases account nets out.
- A price difference between the receipt's cost and the bill stays in purchases, which is where it
  belongs.
- What B-4 does today is book the inventory twice, along with the stock.

## 5. Edge cases

1. **Issuing from the form when stock is short** opens the same transfer dialog the list opens
   today. The shared composable keeps the list's behaviour byte for byte.
2. **„Издай и печатай" when issuing fails** (stock, validation): nothing prints, and the document
   stays a draft that says why.
3. **A receipt billed, then the bill voided**: the link goes. The receipt can be billed again, and
   no stock moves either way (`movesNoStock` guards the reverse path too).
4. **A receipt voided after it was billed** is refused while a bill links it (409). Unlink first.
5. **Converting a client order whose reservations are only on unreceived supplier orders**:
   nothing can be invoiced yet. Convert says so instead of creating an empty draft.
6. **Card settlement on a document edited after issue** follows `syncCashSettlement`'s rules for
   cash: the automatic payment tracks the total, and hand-recorded payments are never touched.
7. **Repeat on a cancelled reservation whose source has no free quantity any more** opens the
   dialog with the shortage named, and creates nothing.
8. **„+ Нов" for a document the user has no permission for** is not listed. The menu reads the
   same `PAGE_REGISTRY` permissions as ★.
9. **Remembered defaults** (payment method, product-update switch, warehouse) are per user and per
   org, under the existing `lgr:` keys pattern, through the session module (never reading
   `lgr_token` directly).
10. **Keyboard shortcuts** never fire inside a dialog's text area or the line grid's own keys
    (Enter adds a line there).

## 6. Integration constraints

- **FR-21 owns the cash register** (#171, Atanas). The journal and terminal are rebuilt once, in
  ui-shared, at R5. Slice 7 sends its requirements there unless D-6 says otherwise. FR-21's
  decisions hold, whatever D-6 says:
  - route names `pos.orders`, `pos.orders.detail` and `invoicing.cash-sales(.new/.edit)`;
  - storno only on whole receipts, and only for the roles FR-21 lists;
  - till and storno documents are immutable (409);
  - both write contracts stay as they are.
- **FR-20 is changing pos-ui and portal-ui.** A till change must also work on an on-prem master.
- **Frozen contracts:**
  - `POST /invoices` stays backward-compatible;
  - `/bills/import/{extract,draft,convert}` stays byte-compatible;
  - route names and paths stay, because e2e and `useGridColumns` key on them;
  - prefixes come from `sequence-registry`.
- **Money, stock and numbering rules** change only through a requirement here that names its
  decision. Each such change has an integration test, not just e2e.

## 7. Migration notes

- No data migration for the UX slices. Remembered defaults start empty and fall back to today's
  behaviour.
- FR-22.3 changes numbering for future conversions only. Numbers already burned stay burned. The
  digest's sequence check already lists such gaps (FR-11).
- FR-22.31 adds `detectedBy: 'manual'` links. Existing `stockSource` links from doc-import are
  untouched.
- B-4 left past double bookings in place. Finding them needs the receipts and bills of the same
  supplier compared over the same period, and that is a one-off script (dry-run first). It is not
  in scope until the owner asks.

## 8. Slices, in order

| # | Slice | Requirements | Walks it moves |
|---|---|---|---|
| 1 | Fix what is broken | FR-22.1–.15 | P2 (unblocked), P5-credit, P6, P7-chain |
| 2 | Documents: issue, print, pay in place | FR-22.16–.27 | P5-invoice, P5-credit, P6 |
| 3 | Receive, then bill | FR-22.28–.33 | P2, P3 |
| 4 | Orders and reservations | FR-22.34–.44 | P7-* |
| 5 | Products: reserved and on order | FR-22.45–.48 | P1 |
| 6 | Anywhere in one move | FR-22.49–.53 | P0-new (new walk) |
| 7 | Counter | FR-22.54–.60, per D-5/D-6 | P4-* |

Slice 1 goes first and ships on its own. B-1 alone blocks the receipt flow the staff use every
day.

## 9. Acceptance criteria

- [ ] Every walk meets its target in §3. The `ux-budgets` project asserts the targets, and it
      passes in CI.
- [ ] Every defect in §1.2 has a test that fails on the old code: integration tests for B-1, B-4,
      B-5, B-6 and B-7; unit or e2e tests for the rest.
- [ ] A receipt with product update and one new article saves and confirms in one action. Its
      bill moves no stock, and the receipt and the bill link to each other.
- [ ] An invoice paid by card is issued, printed and shown as paid without leaving its form.
- [ ] Every client order, supplier order, reservation and invoice number on the chain is a link.
      A reservation can be created, opened, edited (per D-4), released in part and repeated.
- [ ] Products shows reserved and on-order quantities, and their sums reconcile with the
      Reservations list and the open supplier orders.
- [ ] `bg.json` has every key `en.json` has, and the walks find no English in the Bulgarian UI.
- [ ] `bun run build`, `bun run test` and the e2e projects are green.

## 10. Field test (lgrai.app)

Writes go to **acme-corp** only, signed in through the API and undone afterwards. Customer orgs
(regal, regal-pz, regal-sf) get read-only checks.

1. Run the `ux-budgets` walks against `https://lgrai.app` on acme-corp. The budgets must hold on
   the production build, which a local run cannot prove.
2. Receipt with product update on an acme article that has 13 tiers: it saves and confirms. Then
   bill it from the receipt, and check that the stock is unchanged after receiving the bill.
3. Card invoice: issue and print from the form; it shows paid.
4. Proforma → convert → issue: the invoice numbers are consecutive.
5. Client order with one line short → generate the supplier order → convert: the invoice holds
   only what is in stock.
6. Read-only on regal-pz: open Products, a supplier order and the Reservations list, and check
   that reserved and on-order quantities match what the staff expect for three articles they
   name.
7. Hand the bg note per issue (#203, #168, #4) to the owner to post.

## 11. Progress

Updated 2026-10-26 (afternoon). "Merged" means on master; deploys follow the `deploy-prod` skill when
the owner asks. Everything merged is on production.

| Slice | Requirements | State |
|---|---|---|
| Baseline | the walks, this FR | merged: #250 |
| 1: defects | FR-22.1–.2 (B-1..B-3) | merged: #251. P2 completes: 33 clicks, up from a dead end |
| 1 | FR-22.5, .10 (B-7, B-12) | merged: #254. P7-chain 30 → 27 |
| 1 | FR-22.6, .11 (B-8, B-14) | merged: #255. i18n parity is now a unit test |
| 1 | FR-22.3, .4, .7, .8, .9, .12, .13, .14, .15, invoice-list № sort | merged: #258. P5-invoice 22 → 20, P5-credit 14 → 11, P3 14 → 12 |
| 1 | FR-22.13 (B-15) | merged: #249 (the load-time re-snapshot) and #258 (the leave-before-load gap) |
| 2a: documents flow | FR-22.16–.22 (save stays, the form issues, „Издай и печатай", one-click print, notes from the invoice, card paid on issue, proforma) | merged: #264. P5-invoice 20 → 14, P5-credit 11 → 5, P6 17 → 12 |
| 2b | FR-22.23–.27, .50 (one row menu at 1366 px, partner picker by recent use, remembered method and last price, place of deal, labelled Create) | merged: #266 |
| 3: receipt → bill (#168) | FR-22.28–.33 | merged: #261. P2 17 clicks (was a dead end, target ≤ 20); P3 3 clicks with stock unchanged (was 14 and stock booked twice) |
| 4: orders and reservations | FR-22.34 (names), .35–.36 (links, linked invoices), .37 (repeat, quantity edit only), .39–.40 (list links, who reserved what) | merged: #252 (owned by another session). P7-chain 27 → 26, P7-repeat 4 → 3, P7-who → 1 |
| 4 | D-1 subtitles | merged: #260 |
| 4a | FR-22.37 rest (create on the list, `/reservations/:id`, partial release, cancel-dialog wording); the reservation in „+ Нов"; RES numbers link to their page | merged: #265. P7-new: 4 clicks |
| 4b | FR-22.41–.44; FR-22.35 for Generate and Convert; FR-22.36 on both order forms; FR-22.13 on both order forms; FR-22.39 search; FR-22.15 defaults; translated refusals; FR-22.34 English / German / Macedonian names per D-1 | merged: #267. P7-chain 26 → 18 |
| 5: products | FR-22.45 stock tab | merged: #252 |
| 5 | FR-22.45 list columns, .46, .48 | merged: #263. P1 6 → 5 |
| 5 | FR-22.47 (row actions „Заприходи", „Продай", „Резервирай") | merged: #268. P1-act: 2 clicks to a sale of the article |
| 6: navigation | FR-22.49, .51, .52, .53 | merged: #259. P0-new: 1 click per leg |
| 7: counter | FR-22.54, .55 (D-6) | merged: #256. P4-till 8 → 3, P4-backoffice 9 → 6 |
| 7 | FR-22.60 cash sale → invoice (D-5) | merged: #249 (owned by another session) |
| 7 | FR-22.56–.59 | FR-21 R5 requirements |

Found along the way and fixed on its own:
- the fiscal-device address check (#257; S-30, GHSA-5qqr-5jf7-pq2q, published 2026-10-26);
- stale e2e locators: the till search, the invoice line description and the cash-sales Create
  button (#262), and the order-line product field (#267). CI runs no e2e, so they had sat red.
  Only the till one came from FR-22: it broke when #256 started putting the cursor in the search
  field;
- saving a product erased a category name no category record carried (#263): every product of the
  `regal` org, and the acme seed;
- voiding a DRAFT invoice booked its lines back into stock although nothing had left (#264). On
  production it had happened once: in `regal`, DRF-INV-2026-00002 added 1,257 units in May. It
  was reversed on 2026-10-26 by SM-2026-00097;
- an outgoing credit note was stock-checked on issue although its return brings goods in (#264);
- both order forms dropped any edit made after their first save (#267).

Production (lgr:v20261026-a9dae7528a8c, 2026-10-26, master f89e22eb) carries everything above that
is merged, and FR-21 R1. Each deploy was field-tested on the acme-corp demo org.

Data follow-ups run on production, 2026-10-26:
- the 368 card invoices issued before FR-22.19 were settled with `scripts/settle-cash-invoices.ts
  --method card` (€23,777.48: regal-pz 173, regal-sf 195);
- the 502 cash invoices issued before the cash rule were settled with `--method cash` (€35,722.55:
  regal-pz 387, regal-sf 115). No counter-paid invoice of either org shows money owed any more.
