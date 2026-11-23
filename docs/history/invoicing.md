# History: Invoicing documents

What was built in this area, release by release: numbering, offers, cash-sale invoices, receipts and bills, issue/print/pay, e-mail, the contact ledger.

Moved here whole from `CLAUDE.md` by FR-32.13 (#797), section by section and word for word, so "below" and
"above" in it speak of the file it came from. The traps and the never/always rules of these sections are also in
the rule file [`.claude/rules/invoicing.md`](../../.claude/rules/invoicing.md), which a session loads when it touches
this area's files. A new trap goes there (or in `CLAUDE.md` if it is not one area's); what was built goes here.

## Draft+Issued Invoice Numbering (2026-04-28)

Drafts use per-type DRAFT_* counters (DRAFT_INV/PRF/OFR/CN/DN/BILL); cash sales skip drafts (CS direct). On `/send` or `/receive`, `issueDocument` allocates a new issued number from the canonical SALES_DOC/PROFORMA/OFFER/BILL counter (last, inside the issue's transaction: FR-29.11), sets `draftNumber = previousInvoiceNumber`, replaces `invoiceNumber`, and appends to `numberHistory[]`. Display prefix override (per-org-global) lives on the Sequence year=0 sentinel doc; future allocations only. **Documents are editable in EVERY status** — PUT applies no status or posting check. The edit-sent guard (409 when a posted JournalEntry referenced the invoice, with credit-note remediation) was **removed**; ⚠ an edit to a posted document does NOT re-post, so the JournalEntry keeps its pre-edit amounts and trial balance / P&L / balance sheet report the stale figures with nothing marking them so — repost is manual. DELETE keeps its draft-only guard. Configuration page at `/invoicing/configuration/sequences` (admin/manager only).

### A sales series without a year (2026-11-15)

An org may number its sales documents (invoices and their notes, the `SALES_DOC` series) **without a year**:
`INV-3000004107`, ten digits that go on from one year into the next. It is the form a number brought in from
another system already has (`convertDraftInvoice` issues `<prefix>-<original number>` and raises the counter past
it), so an org that imports and also issues by hand read two ways until it chose this: `INV-3000004104` imported,
`INV-2026-3000004106` issued here. Every other org, and every other series, keeps a number per year.

- **The switch** is on the sequences page (`/invoicing/configuration/sequences`, the "Numbering" column) and is
  stored as `continuous: true` on the series' year-0 Sequence row, beside its display prefix
  (`sequence.service#isContinuousSeries` / `setContinuousSeries`). `PUT /invoicing/sequences/:prefix` takes
  `{ displayPrefix?, continuous? }` and changes only what a request names; `continuous` on any other series is
  **422 `not_continuous_series`** (the registry's `mayBeContinuous` says which series may). Audit-logged. Future
  allocations only: a document keeps the number it has.
- **The documents issued with a year BEFORE the choice** keep it unless the org asks:
  `scripts/drop-year-from-sales-numbers.ts` (`services/biz/yearless-numbers.ts`; dry run by default, `--execute`
  needs `--backup`, `--restore` puts a backup back) brings `INV-2026-3000004106` to `INV-3000004106`. Only the year
  goes: the running number, the counters and every link by id stay, and `numberHistory` names the number the
  document had. It refuses an org whose series is numbered per year, and it leaves, counted by reason, a number
  another document already holds (`taken`), one that two years would share (`twice`: a series that started again
  each year cannot be brought over), BOTH documents of a number issued twice (`clash_pair`), a draft, and a
  document of another series. Text that quotes the old number (a reversal movement's note, a journal entry, the
  audit log) stays as written and is counted. ⚠ From then on every reader of the number's form takes such a
  document for an imported one: the daily importer's index, its audit's content compare, and the passes that
  act on `INV-<number>` (`scripts/lib/void-annulled.ts`, `scripts/repair-invoices-from-plusminus.ts`).
- **It counts on ONE row**, the year-0 row's `lastNumber` (`getNextContinuousNumber`): the same atomic `$inc`
  as every counter, so no number is given twice and none is skipped, whatever year a request's clock says.
  - Before counting, that row is raised to the highest of every row of the series and of every number of the series
    on a document, **with a year or without** (`currentMaxSuffix(…, { everyYear: true })`).
  - After counting, the number is written to **this year's row** as well. ⚠ That mirror is load-bearing: the legal
    mark on a master, the last numbers a person records after a promotion (`legalCounters`, which leave the
    year-0 row out) and a build that does not know the option all read the YEARLY rows. A document carries a number
    only after the mirror is written.
  - ⚠ Do not move the count back onto the yearly rows. That was the first version: two years counted on at once
    (midnight on 31 December, two servers whose clocks disagree) had to look at each other's row afterwards and give
    a number up, which leaves holes in a legal series.
- **The form's preview and the issue agree**: `peekNextInvoiceNumber` is the one reading behind
  `GET /invoice/peek-next` for an issued number, in both modes. Drafts are numbered per year as before.
- `scripts/reconcile-sequences.ts` leaves a continuous series out: every allocation of it catches up by itself.
- ⚠ **Other readers of the number's FORM.** An importer that tells a document typed here from an imported one by
  the year in its number (`scripts/lib/invoice-index.ts`: `INV-<year>-<n>` = "entered by hand") sees both
  as `INV-<n>` once the org numbers without a year. Both were skipped before and both are skipped now; only
  the label in its log changes. Its audit (`scripts/audit-coverage-api.ts`) then compares such a document with
  the other system's invoice of the same number and lists a difference as `DIFF`, and lists one with no
  counterpart there. ⚠ One series, two systems: a number issued here stands for the other system's invoice of
  that number, so the two must not both issue.
- **The highest number is counted in the database** (`currentMaxSuffix` is one `$group`, index-covered): a
  continuous series matches every sales document the org holds, and the reading runs at each issue and each
  time a form asks for the next number.
- **The legal mark's ceiling is ten digits** (`legal-mark.service#SERIES_MAX`). It was nine: a ten-digit
  counter's mark was dropped as damage at every read, so a series standing where another system's numbers
  left it had no mark on a master, and a database put back below it locked nothing.

## Offers („оферта") — a quote before the proforma (2026-11-12)

Invoice `type: 'offer'`, at `/invoicing/offer` (list, `/new`, `/:id/edit`): the proforma's form and list
(`DOCUMENT_CONFIGS.offer`, `OffersView.vue`), in a series of its own — `DRAFT_OFR`/`DRF-OFR` while a draft,
`OFFER`/`OFR` once issued (`sequence-registry.ts`; renamable on the sequences page). Not a legal series.

- **Converted once** — `POST /invoices/:id/convert { target }`: an offer into a `proforma` or an `invoice`
  (default), a proforma into an `invoice` only (`config/constants#QUOTE_CONVERTS_TO`). The new document is a
  DRAFT of the target's draft series; it carries the deal over and names its source (`proformaId`,
  `offerId`; a proforma made from an offer passes `offerId` on to its invoice). The quote becomes
  `converted` with `convertedInvoiceId`; the list returns `convertedInvoiceType`, `offerNumber`.
  ⚠ Once by a compare-and-set AFTER the draft exists: two presses at once (two tabs, „→ Проформа" and
  „→ Фактура") make one document, the loser deletes its draft and answers 409. A voided quote converts
  into nothing (400 `quote_withdrawn`; the API took a voided proforma until this). The target's kind must
  be the role's to create (403 `capability_required`, `sales-docs.create` for an invoice).
- ⚠ **A quote is no money** — `QUOTE_TYPES = ['proforma', 'offer']`, `isQuoteType()` in `config/constants`.
  Issued it is `sent` with `amountDue = total`, which is exactly what a receivable reader counts. Every
  reader of money or stock leaves the quotes out: stock booking (`movesNoStock`), the journal handler,
  the fenced import, `/payments` (422 `quote_takes_no_payment`), `getInvoiceSummary` (when no type is
  named), both agings, the contact form's balance, `/stats/contact`, `checkOverdueInvoices`, and the
  contact ledger's TOTALS (its rows list them). Until this, every issued proforma never converted counted
  as owed on the dashboard and in the aging. A new reader of outgoing `sent` documents must do the same.
- **Access** rides on the `proforma` feature (`config/access/partition.ts`): the quotes are one kind, so
  every role that works proformas works offers, and no stored role needed migrating. The role editor
  labels it „Проформи и оферти".
- ⚠ An older on-prem master (FR-20) does not know the type: an org moved to one carries offers its code
  treats as sales documents (the move copies raw). Say so in the next server release's notes.

## FR-10 — email an outgoing invoice (2026-08-25)

- **`sendEmail` no longer returns `void`.** It returned nothing and swallowed both failure
  modes (missing key → warn+return; non-2xx → warn+return), so a caller could not tell a
  delivered invoice from one that vanished. Now returns
  `{ok:true} | {ok:false, reason:'not_configured'|'provider_error', detail?}`; the two
  fire-and-forget auth callers are unaffected. Attachments map to SendGrid v3
  (`content` base64, `disposition:'attachment'`), capped at 20 MB.
- `EmailLog` gains `status`/`error`/`entityType`/`entityId`/`attachmentNames` and logs
  **failures too**. Attachment CONTENT is never stored (asserted in a test).
- `POST /invoicing/export/:id/email` — sibling of the single export, sharing
  `lib/invoice-pdf.ts#renderInvoicePdf` so the attachment is byte-identical to Print (the
  extraction is refactor-only; the 46 export tests stay green unmodified).
  Guards: `canWrite` (read-only roles incl. `nra_auditor` → 403), outgoing only (422),
  **draft blocked** (422 — a `DRF-` number in a customer inbox is worse than no email),
  60s duplicate-send guard (429), `not_configured` → **503, never a fake success**,
  provider failure → 502.
- ⚠ **Naming landmine**: `POST /invoices/:id/send` already means *issue the document*. The
  email action never uses "send" in a route. ⚠ **i18n landmine**: `invoicing.email` is an
  existing *string* key — the new keys live under `invoicing.sendEmail.*` (the seeding script
  asserts this before writing).
- `.env.example` now documents `SENDGRID_API_KEY` + `FROM_EMAIL`. **Ops: `FROM_EMAIL` must be
  a SendGrid-verified sender** or every send 502s; prod's `lgr-secret` already carries the key.

## A list's ticked documents by e-mail (2026-11-16)

Seven lists tick rows and mail them: sales documents, proformas, offers and bills (kind `invoice`:
any document of the invoice collection), supplier orders (kind `order`: one sheet per supplier
group), customer orders (kind `internal-order`: the order's one sheet, see its bullet below) and
stock movements (kind `movement`: each as its printed sheet, by the warehouse API's own two
routes, see its bullet below). The dialog, the composable and the engine take a kind as a name and
two routes. FR-10's single route above (`SendEmailDialog`, `useRowEmail`) is untouched.

- **Two routes**: `invoicing-api/controllers/doc-email.controller.ts`, everything they decide in
  `lib/doc-email.ts`. The wire types and the dialog's planning are **`config/doc-email`**
  (import-pure, read by the server and the UI alike).
  - `POST /org/:orgId/invoicing/export/email/preview { kind, ids }` → `{ documents: [{ id,
    groupId?, number, docType, date?, status?, partner?: { id, name, email? }, blocked? }] }`.
    Writes nothing. At most 100 ids (`MAX_SELECTION`).
  - `POST /org/:orgId/invoicing/export/email { kind, to, items: [{ id, groupId? }], subject?,
    message?, locale?, columns? }` → `{ to, mails, queued, results: [{ id, groupId?, number,
    status: sent | queued | skipped | failed, reason?, message? }] }`. **One recipient and at most
    ten documents a request** (`MAX_DOCS_PER_MAIL`); the dialog asks once per recipient, in turn.
- ⚠ **A refused DOCUMENT is a row of a 200, never the request's status**: a draft among ten is
  `skipped` and the other nine are `sent`. The request is refused only for what is true of all of
  it, in this order: 403 (the session mails no document of the kind) → 400 (no valid address, no
  items, an unknown column) → 422 `selection_too_large` → **503 `not_configured`, before a single
  PDF is printed**.
- **Who mails what** is `lib/email-guards.ts` (`invoiceEmailSkip`, `orderEmailSkip`,
  `internalOrderEmailSkip`), and the SAME
  function decides the preview and the mail, so the two cannot disagree. A document of the invoice
  collection goes when the session WORKS on its kind (`writesKind(grant, kind, 'edit')`, FR-27.6);
  one of a kind it does not read is `not_found`, exactly like an id that names nothing. Only a
  `draft` is held back by status. ⚠ Wider than FR-10 on purpose: an INCOMING document goes (a bill
  forwarded to the accountant). An order's sheet takes the orders' read, `sales-docs.export` and
  `orders.create|edit`. `just_sent` (the 60 s double-click window) is per document AND address.
- **The engine** is `services/biz/doc-email/` and knows no kind. `emailDocuments({ orgId, userId,
  to, replyTo?, documents: [{ entityType, entityId, number, render }], subject, html })` renders
  two at a time, packs the files into mails that fit this node (`pack.ts`: ten attachments, and
  `config.relay.maxAttachmentBytes` on a master, the provider's cap anywhere else), sends each and
  answers per document. A render that fails drops that document only; a file no mail can carry is
  `too_large`. On a master the answer is `queued`, never `sent` (FR-20.86).
- **`sendEmail` takes `entities`** (`[{ entityType, entityId, attachmentName }]`): one `EmailLog`
  row per document a mail carries, each naming its own file. That is what lets the resend guard
  and a document's history read ONE document, whatever travelled with it. On a master the outbox
  payload carries the list. Absent, nothing changes.
- Every document that went or was queued gets an audit entry (`action: 'email'`). An invoice's
  `emailedTo` / `lastEmailedAt` change only when the mail has LEFT: at once when sent, from
  `relay/outbox-worker.ts` when a master's queued mail has gone.
- An invoice is attached as its Print prints it: the dialog passes the person's saved print
  columns (`readPrintSettings().columns`). An order's sheet is the SUPPLIER variant, and a role
  that does not see costs gets it without expected prices, as from the export route.
- **UI**: `ui-shared/components/BatchEmailBar.vue` (the bar in `ListScaffold`'s `#bulk-bar`, and
  the dialog's owner), `BatchEmailDialog.vue`, `composables/useBatchEmail.ts` (the state and the
  requests, without words; unit-tested with an injected `post`). Invoicing wraps them once:
  `invoicing-ui/components/DocEmailBar.vue` + `composables/doc-email-access.ts`, which asks the
  same `writesKind` the server does. A role that only reads ticks and clears, and sees no button.
  - **„До клиента / доставчика"** (the default when a document has a partner): a line per partner
    with the address on its card, each editable. A line left empty is not sent and its documents
    stay ticked. **„До един адрес"**: one field, prefilled with the address this person last
    mailed this kind to in this org (`lgr:doc-email-to-<kind>:<user>:<org>`, written only after a
    mail to it went).
  - One request per recipient per ten documents, one after the other. **503 `not_configured`,
    401, 403 and 409 stop the rest** (`stopsTheBatch`); any other failure is that recipient's.
  - Everything asked went → the dialog closes with a snackbar; otherwise it stays on the results.
    Either way only what went leaves the selection (an order, when every sheet of it went).
- **Customer orders** (kind `internal-order`, the customer orders list): each ticked order as the
  sheet its Print button downloads (`renderInternalOrderPdf`, no price on it), on the invoicing
  pair of routes. An item is the order's id; a `groupId` beside it is not read. In
  `lib/doc-email.ts` a kind is an entry of `PREVIEW_ROWS` and of `MAIL_ROWS`: one without both
  does not compile.
  - **Who mails what** is `internalOrderEmailSkip`, for the preview and the mail alike. The
    request takes what the sheet's export takes (`orders.view`, `sales-docs.export`) AND the work
    on orders (`orders.create|edit`): a role that only reads prints a sheet and mails none. ⚠ Its
    own access function, never the supplier order's: a customer order is read by `orders.view`
    alone. Per order: an id that names none in this org is `not_found`; a `draft` is held back
    (its sheet shows no number). ⚠ **A cancelled order GOES**, as every status but `draft`
    does: its sheet's title says it is cancelled, and telling the client so is a use. The
    `cancelled` reason stays a stock movement's.
  - A row's `docType` is `internal_order` and its `partner` the order's contact, so the dialog
    opens on „До клиента / доставчика" with a line per client. The mail names an order as its
    sheet is titled, in sentence case (`customerOrderDocName`: „Потвърждение на поръчка",
    „Поръчка (отказана)"), and states no total. `entityType: 'internal_order'`, audit module
    `invoicing`. An order keeps no send history, so the outbox worker needed no branch.
  - UI: `invoicing-ui/views/InternalOrdersView.vue` is a `fit`, `selectable` `ListScaffold` with
    `<DocEmailBar kind="internal-order">`; the button shows to
    `useDocEmailAccess().internalOrders()`, which `unit/doc-email-access` holds to the server's
    rule. ⚠ The list has nine columns beside its tick: the client's name is clipped at 9em (whole
    in its `title`) and a row's icons sit in one unwrapped row, which is what keeps a draft's row
    (four icons) one line at 1366 px.
- **Stock movements** (kind `movement`, the movements list): each ticked movement as its printed
  sheet. `warehouse-api/controllers/movement-email.controller.ts`, everything the two routes
  decide in `lib/movement-email.ts`.
  - `POST /org/:orgId/warehouse/movement/email/preview { kind: 'movement', ids }` and
    `POST /org/:orgId/warehouse/movement/email { kind: 'movement', to, items: [{ id }], subject?,
    message?, locale? }`: the answers, the caps and the refusal order of the invoicing pair. A
    row's `docType` is the movement's type, its `partner` the movement's contact. ⚠ A transfer
    names no contact, so ticked transfers open the dialog on „До един адрес": that is how a
    transfer to or from an external warehouse reaches the people of the other site.
  - **Who mails what** is `lib/movement-email-guards.ts#movementEmailSkip`, for the preview and
    the mail alike. The request: a session that works on movements (`movements.create|edit|delete`)
    or writes a Seller's transfers (`movements.create:transfer`, FR-26.7). That is the rule both
    route tables already reach every `warehouse/movement` write by, so NO row was added to
    either. Per movement, in this order: one the session does not read is `not_found`; a
    transfer-only session mails transfers, and any other type is `forbidden`
    (`lib/movement-access.ts#writesTransfersOnly`, the one rule the movement controller writes
    by); a `draft` is `draft`; a cancelled one is **`cancelled`**, a block reason this kind
    added (it moved nothing, so its sheet says nothing true); `confirmed` and `completed` go.
  - The file is `renderStockMovementPdf`'s (`<movementNumber>.pdf`, no price on it), the mail
    names each movement by its type word (`reporting/stock-movement.i18n.ts`), `entityType:
    'stock_movement'`, audit module `warehouse`. ⚠ A movement keeps no `emailedTo` history, so the
    outbox worker needed NO branch: a master's queued mail settles its `EmailLog` rows by
    `outboxId` like any other.
  - UI: `inventory-ui/views/MovementsView.vue` places its own table, so it carries the tick
    column (`show-select`, the ids) and `<BatchEmailBar kind="movement" …>` itself.
    `composables/movement-email-access.ts` names the server's capabilities again (the UI cannot
    import the warehouse API) and `unit/movement-email-access` holds the two together. ⚠ With the
    tick column the list is `list-fit` (`ui-shared/styles/list-fit.css`, the rules
    `ListScaffold`'s `fit` uses): its two warehouses and its contact are clipped at 9em and 10em,
    a row's icons are the size of a row menu, and the title row wraps, which is what keeps a
    390 px page from scrolling sideways.
- **What every kind's two routes share** is `services/biz/doc-email/request.ts`: the three
  whole-request refusals, `distinctItems`, `partnersOf`, `recentlyMailed` (the 60 s window,
  `RESEND_WINDOW_MS` in `config/doc-email`), `docEmailResults`, `auditMailed`.
- **Another kind** (the movement kind is the model) brings: two routes speaking
  `config/doc-email`'s types; its own loading and rules, handing `emailDocuments` an
  `EmailableDocument` with a `render` per document; the right rule for each route in BOTH route
  tables (`config/access/routes.ts`, `services/biz/route-permission.ts`), by a row of its own
  or by a prefix row that already reaches it, shown over the real route table (a role that only
  reads posts `{}` and gets 403, never 422); and on its list
  `<BatchEmailBar v-model:selected kind org-url preview-path email-path :may-email>`. A reason the
  catalogue does not know needs a `docEmail.reason.<code>` key ×4, or it reads as its code.
- ⚠ The outbox worker settles the send history of `invoice` entities only. A kind with a history
  of its own adds its branch there, or a mail queued on a master never marks its document.
- ⚠ The preview is a POST that reads, and is deliberately NOT in `route-class.ts#READ_ONLY_WRITES`:
  an org that is read-only here could mail nothing (the mail writes `EmailLog` and audit rows), so
  its dialog is told at once (409 `org_home_elsewhere`) instead of after the form is filled in.
- ⚠ `lib/doc-email.ts#docEmailRenderers` is the seam a test swaps to mail without a browser: a
  render is a fresh Chrome, and the suites ask who gets which file, not what the file looks like.
  The movement kind's is `lib/movement-email.ts#movementEmailRenderers`.
- ⚠ Never "send" in a route or a handler name here either: `POST /invoices/:id/send` ISSUES.
- ⚠ No mail leaves the e2e (`batch-email.spec.ts`): the mail request is answered by `page.route`,
  and the one case that needs the server's own 503 first asks, with a draft that is never mailed,
  whether the server can mail, and is skipped where it can.
- Tests: `unit/doc-email`, `unit/doc-email-guards`, `unit/batch-email`,
  `integration/doc-email-engine`, `integration/doc-email.flow`, `e2e/tests/batch-email.spec.ts`.
  The movement kind: `unit/movement-email-guards`, `unit/movement-email-access`,
  `integration/movement-email.flow`, `e2e/tests/movement-email.spec.ts` (the Bulgarian UI; its
  mail request is answered by `page.route` too, and it holds the list's fit at 1366 and 390 px).
  The customer-order kind: `unit/doc-email-guards` and `unit/doc-email-access` (its rule, on the
  server and in the UI), `integration/customer-order-email.flow`,
  `e2e/tests/customer-order-email.spec.ts` (the same walk on the customer orders list).

## Invoice for a cash sale (2026-10-25, #171 / #203, FR-21 D-14 / §3.9)

„Издай фактура" on a paid cash sale issues the customer's invoice for it:
`GET`/`POST /org/:orgId/invoices/:id/to-invoice`, `services/biz/cash-sale-invoice.service.ts`, the dialog
`invoicing-ui/src/components/CashSaleInvoiceDialog.vue`.

- The cash sale moved the goods and took the money; the invoice is the tax document of that sale.
  So it **moves no stock** (`stockSource` = `cash_sale:<number>`), is **born paid** (payment rows
  with `origin: 'cash_register'`, no `payment.recorded`) and **posts no journal entry** (`/send`
  emits no `invoice.posted` for it; the handler and `syncCashSettlement` skip it too).
- ⚠ **Only the invoice stores the link** (`cashSaleRef`, `lines[].cashSaleLineId`). Nothing of it is
  written to the cash sale (FR-20.51): its invoices are a query on `{orgId, 'cashSaleRef.cashSaleId'}`.
  The one exception is the ORDER claims are judged in, `register.invoiceClaims` (#446), kept on the sale
  as a storno's claims are (`register.stornoClaims`).
  ⚠ The DAL's entity mapper drops nested `_id`s, so cash-sale line ids come from Mongoose, never
  from `getRepos()` documents (`invoicingByCashSale` takes ids for that reason).
- Quantities: a cash sale that **names a customer is invoiced whole, once**; one without (an imported
  till day, a walk-in) **in parts**, never beyond what was sold. Each line is a budget across live
  invoices, drafts included. Claims are inserted under a `~pending:` number and checked in the order
  each then takes atomically on the sale (`takeTurn`, #446; `_id` order let a later id that read first
  and an earlier one written after it both pass) — the earlier claim wins, a later one that does not
  fit deletes itself — so nothing locks
  the sale and a refused request burns no SALES_DOC number.
- ⚠ **Every reader counts the sale once** (`services/biz/sale-counting.ts`): totals count the cash
  sale and skip invoices with `cashSaleRef`; per customer the invoice counts for its customer and
  the cash sale stops counting for its own contact. Applied in sales history, the digest (KPIs,
  FR-11.10, FR-11.11), the product and contact ledgers and the dashboard's paid-30d. The sales
  register keeps the invoice (new `cashSale` column, `meta.forCashSales`). **A new reader of
  sales must use the helper**, or it counts an invoiced cash sale twice.
- Credit and debit notes against such an invoice are **ordinary** (owner, 2026-10-25): a credit note
  returns the goods and counts negative. `cashSaleRef` is only ever on type `invoice`.
- Guards: an issued one keeps the sale's lines and dates (customer and text may change); a draft may
  invoice less; `/void` accepts `paid` and releases the quantities; a cash sale's lines cannot
  change while an invoice points at them (409 `cash_sale_invoiced`); the Files rollback of such a
  sale is blocked; `POST`/`PUT /invoices` strip the link from any other document.
- The PDF prints „Към касова продажба № … / дата" and `taxEventDate` (the sale's date) as
  „Дата на данъчното събитие". „Словом" is written server-side (`config/amount-in-words`).
- Also fixed on the way: every document form took its "clean" snapshot on a 500 ms timer, so a slow
  load counted as an edit and leaving an untouched document asked about unsaved changes —
  `loadDocument` now re-snapshots when it finishes.
- **Attaching an invoice that already exists** (2026-10-28, FR-21 §11): „Към касова продажба…" on
  an issued sales invoice written before the day's till export arrived — the till sold the goods,
  the invoice dispatched them again. `GET /invoices/:id/cash-sale-candidates` (the cash sales of
  its day it fits), `POST /invoices/:id/attach-to-cash-sale {cashSaleId}`, the dialog
  `invoicing-ui/src/components/AttachToCashSaleDialog.vue`. Attached, it becomes what R0 issues:
  its dispatch comes back ONCE (a reversal at cost, noted „Attached to cash sale …"), then it
  carries `cashSaleRef` and the `stockSource` marker, is paid by the till (`cash_register`
  payments replace `cash_on_issue`/`card_on_issue`, whose entries are retired), and its
  `taxEventDate` is the sale's date. Its number and amounts never change.
  - It fits a sale of the SAME day (UTC date) that sold every one of its lines, within what that
    sale has not invoiced yet. Against a single sale (till or back office) a line must match the
    article, price (½ cent), discount and VAT. ⚠ **An imported till day matches on article and VAT
    only**: it carries one line per article at the day's AVERAGE price (1,899 of 3,418 regal lines
    are priced beyond the cent), so 9 of the 82 snapshot-verified overlaps (2026-10-28) differed in
    price from their own invoice. With that rule all 82 fit.
  - ⚠ **Its claim comes LAST** (`fitsAsLast`), not in `_id` order: the invoice existed before the
    claim, so its older `_id` would let it in over a newer conversion (`overClaimed` checks a
    claim only against older ones).
  - ⚠ **Overlaps repaired by hand before this button attach too**: dispatch reversed, then
    `stockSource.marker` set to the till day's `reference` (`salesAnalysis:<date>`). They need it,
    because without `cashSaleRef` every total counts those sales twice (83 such invoices on
    2026-10-28: 82 in regal-sf, 1 in regal-pz). Such an invoice attaches to that day only and nothing is reversed again. If its
    dispatch is not all back, it is refused (`attach_needs_attention`): with a marker set,
    `reverseInvoiceStockMovement` does not even run (`movesNoStock`). The old marker and its
    arbitration note go into the audit entry.
  - Refused, never guessed: a draft (issue from the sale instead), a payment entered by hand, an
    invoice that serves an order or moves no stock for any other reason, and one whose OWN journal
    entry is posted (`invoice_in_ledger`: void it first). ⚠ A payment's entry carries the invoice as its
    `sourceId` too, so `ownEntriesOf` leaves out the entries the invoice's payments name; an own
    entry still in draft is voided on attach.
  - Claim (with `leaseUntil` on the invoice) → storno re-read → fit → reverse → finish. A retry of
    the same pair resumes once the lease lapses; a dispatch that is partly back already refuses
    (`attach_needs_attention`) rather than reversing twice. ⚠ There is no detach. A void frees the
    sale's quantities but moves nothing (the dispatch came back on attach), so an invoice attached
    by mistake — a separate sale after all — needs a new invoice that dispatches its goods.
- Tests: `integration/cash-sale-invoice.flow` (16), `cash-sale-invoice-readers.flow` (6),
  `unit/cash-sale-invoice` (12), `e2e/tests/cash-sale-invoice.spec.ts` (3); the attach:
  `integration/cash-sale-attach.flow` (10), `unit/cash-sale-attach` (9).

## A receipt first, then its bill (2026-10-26, FR-22 slice 3: FR-22.28–.33, #168)

Goods arrive before the supplier's invoice: a receipt books them, the bill comes days later. A bill
receives its own goods, so a bill typed in for them booked the stock twice (FR-22 B-4).
`services/biz/receipt-bill.service.ts`, routes `/org/:orgId/invoicing/bills/{from-receipt,
billable-receipts,:id/link-receipts}`.

- „Входяща фактура" on a completed receipt makes a DRAFT bill from it (one bill may
  cover several receipts of ONE supplier, D-2). The bill carries `stockSource { marker:
  'movement:<ids>', detectedBy: 'manual' }`, so receive, issue, void and the Files rollback move no
  stock (`movesNoStock`). The receipt's `invoiceId` is the CLAIM, a compare-and-set: a receipt is
  billed once (409), and the product ledger names the bill next to it.
- ⚠ Void, DELETE and a Files rollback of such a bill give the receipts back (`releaseReceiptLinks`,
  only the claims that bill still holds). A Files rollback of a receipt a live document stands on is blocked — for
  ANY `stockSource` link (§5.4). ⚠ DELETE releases BEFORE it deletes: the bill is the only record of
  the supplier it wrote. A void writes first, so a crash leaves a voided bill listing a receipt it still
  holds: the next touch of that receipt finishes the release (`finishReleases`: its page, a bill or a
  link naming it), which is why a GET can write here.
- ⚠ PUT keeps the bill to what was received (D-2: billed once and whole): every stock-tracked
  quantity must equal the receipts' (422 `receipt_quantity_mismatch`), the supplier cannot change.
  Prices, text and lines that hold no stock (a fee, a service) stay free.
- Receiving it moves `purchasePrice` to the billed price for future receipts — only where it still
  equals the receipts' cost (a newer price stays), or the „Цена 2" / 1.2 approximation when the bill
  states a price of its own, one that differs from every receipt's cost (2026-11-15: a bill that only
  repeats an imported receipt would put the delivery price back); avgCost and cost layers are never
  re-costed, and
  posting is unchanged (FR-22's D-2 note).
- `POST`/`PUT /invoices` strip `stockSource` (Elysia's schema already drops it; this is defence in
  depth). `link-receipts` takes an EMPTY draft, or a draft with lines given `replaceLines: true`
  (FR-22.32a): lines left on a bill would silently never be received once it is linked. A bill on a
  supplier order keeps its lines (`bill_on_order`): they book the delivery onto the order. ⚠ A bill
  in another currency is not linked (`bill_foreign_currency`): the delivery's lines carry costs in the
  org's. ⚠ The undo after a lost claim holds on the draft still carrying the marker it just wrote: it
  restores lines read several awaits earlier. ⚠ The audit entry keeps the typed lines and old totals,
  because the bill no longer does. ⚠ The save before a link sends no `productUpdates`, from lines about
  to be replaced; „Запази и получи" that ends in the question is the person's own save and does.
- A receipt with no supplier is billable (FR-22.31a): `from-receipt` takes `contactId`, required
  then. ⚠ The supplier is written in the claim's own compare-and-set, guarded on the receipt still
  naming none, never in a second write. ⚠ Releasing the claim takes it off again
  (`stockSource.supplierGivenTo`): a completed receipt cannot be edited, so a supplier that stayed
  would refuse every other one for ever. ⚠ Link with the `contactId` the form shows: a saved bill may
  name someone else, and the receipt would silently take the wrong supplier.
- ⚠ **No supplier does not mean a delivery**, and linking a real bill to a receipt that is none means
  the real delivery is never booked. `billingStateOf` keeps out what names nobody: the mirror of a
  removed document (`(docdelete:`, `reverseMovement`); a no-supplier receipt whose notes mark a
  correction, a reconcile delta, a day's aggregate or the back half of a transfer or write-off note
  (`receipt_not_a_delivery`, `config/movement-notes`: ⚠ every writer of those notes imports it, so
  they cannot drift from the reader); and one whose `invoiceId` names nothing (a claim always writes
  a supplier, so that was never a claim: it is what a rolled-back till sale leaves). A receipt rolled
  back with its document stays `completed`, so `reverseMovement` stamps it (`reversedBy`,
  `receipt_rolled_back`). Own-store and „склад" разписки carry no mark: the dialogs show their notes
  on the row. ⚠ Neither dialog ever ticks a receipt that names nobody (`preselectedReceipts`).
- ⚠ **`/receive` leaves draft once**: it takes `/send`'s issue lease with a compare-and-set on `status: 'draft'`,
  and the loser answers 409 `bill_not_draft` with nothing booked. Since FR-29 B a bill whose booking fails stays the
  draft it was, with its draft number (`issueDocument`). ⚠ What booking refuses is checked before
  the number is drawn (`stockBookingRefusal`, shared with `createInvoiceStockMovement`).
- ⚠ **`/receive` and `/send` ask before a bill books goods a receipt may have booked** (FR-22.31c,
  `receiptsOverlapping`): 409 `receipt_overlap`, answered by `{ acknowledgeOverlap: true }` or by
  linking. ⚠ It runs BEFORE the issued number is drawn. An API client or script that receives a bill
  now has to expect this answer; the imports do not get it (`persist.ts`, `bills/import`), so an
  imported bill can still book goods a receipt booked.
- ⚠ **A movement's warehouses must fit its type** (FR-22.31b, `config/movement-warehouses`): a
  `dispatch` never names To, a `receipt` never names From, a `transfer` naming To names From too, and
  an `adjustment` names one side, because `confirmMovement` ignores `type` and each of those ADDS
  stock or books it out and straight back. A to-only adjustment stays legal: a count and a true-up write
  one. ⚠ The rule stands at the doors a user comes through (`POST`, `/with-update`, `PUT`, `/confirm`,
  `/doc-import/convert`, `/doc-import/commit`), NOT inside `confirmMovement`, which replays what a site
  already booked (`importMovement`). A new door that confirms a user's draft calls
  `movementWarehouseRefusal` itself.
- ⚠ `PUT /warehouse/movement/:id` takes `null` to clear a warehouse or the partner. Left out, it stays:
  sending `undefined` for an emptied field silently kept the old one.
- ⚠ The form clears the unused warehouse in the type field's own `update:model-value`, never in a
  `watch` on `form.type`: loading a movement changes that too, and a booked document would lose a
  warehouse on screen. A field the type does not use still shows when the movement names one.
  ⚠ A new movement's To is the form's guess for a receipt (`form.toGuessed`), and goes when the type
  changes: left there, a write-off typed in the form added stock. A To the person picked stays.
- ⚠ A fenced or kept import reads a movement with an `invoiceId` as made by its sale, whose import
  books it again, EXCEPT one that document lists in `stockSource.movementIds`: that document moved
  nothing, so the goods would vanish. ⚠ Match the pair (`isListedByItsDocument`), never the movement
  alone: an invoice for a cash sale lists the sale's dispatch, whose `invoiceId` names the sale.
- ⚠ The warehouse report and the digest date a billed receipt by its OWN date
  (`warehouse-operations.report.ts#EFFECTIVE_DATE`): the bill's issueDate would move the delivery to
  the day its invoice came, and the digest would count it twice.
- „+ Нов продукт „…"" on a receipt or bill line: `POST /warehouse/product/quick`
  (`quick-product.service.ts`), built by doc-import's own `newProductDoc` (next SKU, tier template)
  at the org's currency and VAT, in „Общи" (made when the org has none). A name the catalog has, or
  has but for separators, is 409 with that article. The search offers creation only once it has
  answered for what is typed — offered earlier, a quick click created an existing article.
- Receipt form: „Към склад" from the user's pinned document warehouse (`lgr:default-wh:…`) else the
  org default; the product-update switch remembered (`lgr:gr-with-update:<user>:<org>`, both via
  `ui-shared/composables/useUserDefaults`); „Запази и потвърди" first; „Наличност" reads the
  destination on a receipt. `useGridNavigation` lives in ui-shared now.
- Tests: `integration/receipt-bill.flow`, `movement-warehouses.flow`, `quick-product.flow` (2);
  `e2e/receipt-to-bill.spec`; walks P2 (17 clicks · 12 typed · 0 hops) and P3 (3 · 1 · 1, stock
  unchanged).

## The goods first, then their invoice (2026-11-13, FR-22.61–.62, #725)

The sales twin of the section above. Goods leave on a dispatch that names the customer (a stock
note); an invoice typed for them later dispatched them a second time. `services/biz/dispatch-invoice.service.ts`
is the one place that knows the rules; `invoicing-api/…/dispatch-invoice.controller.ts` its routes
(`/invoicing/sales/{from-dispatch, invoiceable-dispatches, :id/link-dispatches, :id/dispatch-overlap}`).

- An invoice made from notes carries `stockSource { marker: 'dispatch:<ids>', movementIds, detectedBy:
  'manual' }` and claims each note by a compare-and-set on its `invoiceId`. ⚠ The marker is NOT
  `movement:`: `isReceiptLinked` must stay false for an invoice, or the bill's paths run on it (its
  form is sent the receipts' costs, its edit is refused in a bill's words). The paths that read
  `stockSource.movementIds` (the ledgers, the org move, `movesNoStock`, a rollback's guard) serve both.
- ⚠ **A note carries costs, an invoice charges prices.** Lines take `resolvePrice` for that customer,
  with the trail; a note's `unitCost` never reaches an invoice, and the picker sends no amount at all.
- ⚠ **A typed invoice keeps its lines when it is linked**, where its stock-held quantities already
  equal the notes' (the bill side always replaces). Only a difference is replaced, and only with
  `replaceLines`, after 422 `invoice_lines_differ` named it. The link is a compare-and-set on
  `updatedAt`: the lines were judged from that read.
- The question (FR-22.61b) is asked by `/send`, 409 `dispatch_overlap`, answered by a link or
  `acknowledgeOverlap`. ⚠ The UI asks FIRST (`prepareIssue`, `GET …/dispatch-overlap`), before the
  payment method and the stock check: an invoice about to be linked takes no stock, and a stock check
  run first offered a transfer to cover goods that had already left. `checksStockOnIssue` is false
  for any document with a `stockSource`.
- ⚠ The notes are found by `invoiceId: null` IN THE QUERY (`freeOf`), never by reading the newest
  few hundred dispatches and filtering: nearly every dispatch of a customer is one an invoice booked
  for itself.
- ⚠ A dispatch held by a purchase document (a voided bill's mirror) is a reversal, and the bill is
  not named: a session that makes sales invoices need not read the purchases.
- ⚠ FR-07 and the digest read MOVEMENTS, and a hand-booked note carries what the goods cost. A note an
  ISSUED invoice claims is valued at that invoice's price per article (`CLAIMED_SALE_UNIT_PRICE`,
  weighted over the invoice's lines of it), on the note's own day; read at its own figures, a sale
  through a note had no sale value and no profit. A note nobody has invoiced, or one a draft holds,
  keeps its own figures. FR-08 reads documents and needed nothing.
- Tests: `integration/dispatch-invoice.flow` (34, with 23 mutations caught), `e2e/stock-note-to-invoice.spec` (9).

## Issue, print and get paid on the document (2026-10-26, FR-22 slice 2a: FR-22.16–.22)

A sales document is finished on its own form: „Издай и печатай" saves it, issues it, settles a card
or cash sale and prints it (P5-invoice 20 → 14 clicks, 2 dialogs → 0 at the time). Since 2026-11-15 it
asks HOW to print first, in the Print dialog, and that dialog's confirmation is what saves, issues and
prints: „One list of actions for a document's two bars" below.

- **Save stays on the document** (every invoicing document form but the cash sale, which FR-21
  owns): a new one moves onto its own edit route. The views key `DocumentForm` on
  `document-form/useDocumentRouteKey`: a different document remounts the form (Vue Router reuses the
  view when only the id or query changes, so A's form used to stay up under B's address), and the
  form's own create keeps it (`onCreated` → `adopt`) — it goes on issuing or printing what it made.
  ⚠ `usePendingChanges`' leave guard now FOLLOWS the route record: `onBeforeRouteLeave` binds to
  the record of the moment, and after new → edit in the same form it never ran again.
  - ⚠ **Saving never switches the guard off** (FR-31.1, 2026-11-16). `markSaved()` takes the clean state again and
    keeps guarding: it used to raise a flag nothing lowered, and on the eight forms that stay open after a save
    (movement, count, price list, warehouse, category, POS device, timesheet, payroll run) an edit made afterwards
    was dropped on leaving without a word.
  - **The clean state is taken when the load resolves** (FR-31.2): `markLoaded(apply)`, with the assignment of the
    stored values as `apply`, on the first load and a reload. A new record is clean once it has mounted. No timer: the
    500 ms one counted a slower load as an edit and an edit in the first half second as loaded. An edit made while the
    load runs is put back over the loaded field and stays an edit (`editsSince`), unless the load is of another record.
  - A value the form only reads (a line's stock, a device's status) is left out of `getFormData`: its late arrival
    would read as an edit. Tested in `unit/pending-changes-guard.test.ts` (no DOM: a no-op renderer) and
    `e2e/tests/unsaved-after-save.spec.ts`.
  - **The latest question wins** (FR-31.4): a search, a list page or a price lookup goes through
    `ui-shared/composables/latest-only.ts#latestOnly`, one wrapper per consumer. Only the latest call's answer is
    delivered; an earlier one's answer and error are dropped and its request aborted (`signal`), and `useHttpClient`
    says nothing of an abort. ⚠ A late answer to an earlier word once put the wrong article on a line on Enter.
  - The line's price lookup waits 250 ms after the quantity's last change (FR-31.5); leaving the quantity field and
    `useDocumentForm.validate` (every save, issue, print) run a waiting one at once (`price-lookups.ts`).
  - **A failure is said, and stays** (FR-31.6 to .9). `EntityFormShell` takes `load-error` (`loadFailureOf`:
    `not_found` / `forbidden` / `failed`) and shows that with Back and Retry (`@retry`), and no field and no action;
    `refusal` is an alert at the top of the form until `@dismiss-refusal` or the next success. A form gets both from
    `useFormFeedback()`; `refused()` says it on the message line too (where it was said before), and `succeeded()`
    withdraws it from both, so a success never waits behind a refusal that is no longer true. ⚠ A load that swallows its error (the document form's did) looks like an empty draft.
  - A refused issue also marks the LINES it is about (`useDocumentForm#lineRefusalOf`, `data-testid="line-refusal"`):
    the stock check's shortfalls by article and warehouse, a cost-layer refusal by the article's name (a refusal carries
    no id). The mark goes with the alert, and from a line whose article, warehouse or quantity changed since.
  - **A line grid keys its rows by the line** (FR-31.12): `:key="rowKey(line)"` (`ui-shared/composables/row-key.ts`, a
    `WeakMap` on the line object, never a field on it), never by position: removing a row gave the rows below it to
    other lines, with their open menus, typed text and focus, and made them load again.
  - **One formatter** (FR-31.13): money, numbers and dates go through `ui-shared/format` (`formatMoney`,
    `formatNumber`, `formatDate` / `formatDateTime`, `formatPrice`, `intlLocale()`), in the app's language
    (`declareLanguage` sets it). ⚠ No UI file names a formatting locale (`'bg-BG'`) or calls `toLocale*`, `Intl.*Format`
    or `numberFormat(` outside `ui-shared/src/format/`: `unit/one-formatter.test.ts` fails, with an empty allow-list.
    Dates are `dd.MM.yyyy` (bg, de, mk) and `dd/MM/yyyy` (en); a list shows `formatDate(x)`, never `x.split('T')[0]`.
  - **No English labels** (FR-31.15): a Pending Changes label is the field's own key (`t('common.name')`);
    `unit/pending-labels.test.ts` fails on a literal, and `e2e/bg-walk.spec.ts` reads ten daily screens in Bulgarian.
  - **The app asks, never the browser** (FR-31.17): `await askConfirm({ text, confirm: t('common.delete'), danger: true })`
    (`ui-shared/composables/confirm.ts`). ⚠ `unit/fields-and-dialogs.test.ts` fails on `confirm(`, `alert(` or
    `prompt(` of the browser, and on a new raw `type="number"` input: a figure is a `DecimalField`, which takes a comma.
  - A list on `usePaginatedTable` / `useProductList` never throws a failed request any more: it puts it in
    `pagination.loadError`, and `ListScaffold` (or `ListLoadError` in a table of its own) says it with Retry, never "no
    data". An error on the message line (`useSnackbar`) stays until closed, and messages queue.
  - The shell's translator (`HomeBanner`, `setRefusalTranslator`) is asked for EVERY coded answer, not a 409's only,
    and for `UNEXPECTED_ERROR_CODE`, the last fallback: the server's English is shown only for a code it does not know.
- **One issue path** (FR-22.17): `invoicing-ui/composables/document-issue.ts` holds the requests (the
  document, `/stock-availability/check`, `create-transfers`, `/send`) with no Vue in it — the
  integration test drives the same functions — and `useDocumentIssue` adds the transfer dialog, the
  idempotent `/send` and the messages. The sales list's „Изпрати", the form's „Издай" / „Запази и
  издай" / „Издай и печатай" and the cash-sale form's pre-create check (`useStockTransfer`) use it.
  A proforma is never stock-checked, nor is a credit note: its return brings the goods in. Refused, or the transfer dialog closed: nothing prints, and the
  draft says why (`issueError`).
- **„Печат" prints in one click** with the user's last settings (`lgr:doc-print:<user>:<org>`:
  format, mode, columns — never the companion documents); „Печат с настройки…" beside it opens the
  dialog on them (`ExportDialog` `initialColumns`), its columns folded. An edited document is saved first. A printed
  draft says ЧЕРНОВА, as one copy, without its DRF- number (`invoice.pdf.ts`).
- **Card is paid on issue like cash** (D-3): `syncCashSettlement` records `card_on_issue`; cash ↔
  card moves the automatic payment; hand-recorded payments are untouched; bank transfer and cash on
  delivery stay open. Card invoices issued earlier are settled by `scripts/settle-cash-invoices.ts`. It takes every
  method settled on issue, or one via `--method`, and is a dry-run by default; run it after this deploys. On 2026-10-26 that is
  regal-pz 173 and regal-sf 195, €23.8k shown as owed.
- **A proforma is issued** from the PROFORMA series and moves no stock on any path (`movesNoStock`),
  announces no `invoice.posted`; `/convert` carries the payment method, place of deal and tags, and
  Convert (form and list) lands on the new invoice's form.
- **A note from its invoice** (FR-22.21): „Кредитно известие" / „Дебитно известие" on an issued
  invoice or bill open `…/new?type=credit_note|debit_note&relatedInvoiceId=`, which starts as the
  invoice (`noteFromInvoice`: customer, the invoice, currency and rate, payment method, lines as
  sold). ⚠ The customer is set without `onContactChange`: its price re-resolution would replace the
  prices the invoice charged.
- Tests: `integration/cash-settlement.flow` (+7 card), `proforma-issue.flow` (6),
  `document-form-flow.flow` (6), `unit/invoice-pdf-form` (+4); walks P5-invoice 14 · 6 · 0 dialogs,
  P5-credit 5 · 1, P6 12 · 5 · 0 (since 2026-11-15, with the payment-method question of 11-12 and the
  Print dialog: P5-invoice 16 · 6 · 2, P6 15 · 5 · 3).

### One list of actions for a document's two bars; „Издай и печатай" asks how to print (2026-11-15)

The owner's two asks: an issued sales invoice had its Save only at the foot of the form, and „Изпрати по
имейл" / „Печат" sat in a third row inside the document; and „Издай и печатай" should open the Print
dialog first, its columns folded.

- **One list, drawn twice.** `DocumentForm` hands `barActions` to `EntityFormShell`, which draws it
  under the title and, with `bottom-actions`, again at the foot (`ui-shared/FormActionBar.vue`). The
  list is `useDocumentForm#formActions` (the document's own steps) with e-mail, Print and a bill's
  „Складова разписка" put in before Import (`document-form/form-actions.ts#withOutputActions`). There
  is no second place that decides what a bar offers: ⚠ never add a button to the form's body or to one
  bar. `FormAction` grew what those buttons needed: `key`, `testId`, `title`, `disabledHint` (shown
  while disabled: e-mail on a draft), `more` (the split button's second half: Print's options),
  `note` (the last-sent chip), `collapse`.
- **Test ids**: the bar under the title has `print-now`, `print-options`, `print-stock-receipt` (as the
  row in the body had) and `issue-and-print`; the foot's are the same with `-bottom`. Every action carries `data-action="<key>"`
  in both. `.form-actions-bar` is the title's bar ONLY (specs scope to it); the foot is
  `[data-testid="form-bottom-actions"]`. A label looked up with no scope now matches twice on every
  document form: `.first()`, or scope it.
- **Save is offered in every status**, in both bars (the cash-sale terminal apart): the foot always
  had it, the API takes an edit in every status, and `editSaveGate: 'draft-only'` (the sales invoice)
  now only keeps Import off an issued one. So Ctrl+S saves an issued invoice too.
- **One line where it fits** (`form-action-collapse.ts`, `COLLAPSE` in `form-actions.ts`): an action
  with a `collapse` rank gives up its label for its icon when the row would wrap, the rarest first
  (import → attach / a draft quote's converts → debit note → credit note → stock receipt → e-mail →
  print); Save, issue, receive and a payment never do. The label stays as `aria-label` and tooltip, so
  ⚠ find a bar's button by role and name, never by its text. A row that is two lines even as icons
  (a phone) shows every label and wraps.
- **„Издай и печатай"** (`onIssueAndPrint` → `onPrintDialogConfirm` → `issueFromForm(print)`): a new
  or edited form is validated, then the Print dialog opens and NOTHING has happened: closing it saves
  nothing, issues nothing, prints nothing. Its confirmation (the button says „Издай и печатай") closes it, then
  saves, issues (the payment-method question and the transfer dialog are asked over the form, as
  before) and prints with what it chose, companions included; refused, nothing prints. The settings
  are remembered only by a print that happened. „Издай" and plain „Печат" are unchanged.
- **`ExportDialog`**: `collapsibleColumns` (every document's Print dialog, the cash-sale terminal's
  too; list exports are as they were) folds the columns on every open under a header that counts
  them (`export-columns-toggle`, `-count`, `export-columns`); `confirmLabel`; `export-confirm` /
  `export-cancel`. It is `scrollable`: opened, the columns no longer push its buttons off a laptop
  screen.
- Tests: `unit/document-form-actions.test.ts` (28: the list's order, the collapse order, and guards
  that the form's template holds no button of its own), `e2e/tests/document-form-actions.spec.ts`
  (9, project `invoicing-inventory`), walks P5-invoice and P6.

### A bill's „Складова разписка" asks which price to print (2026-11-15, FR-22.33a)

The owner's ask: the sheet goes to the people in the warehouse, who price the goods from it. So the
bill's action (in Bulgarian „Стокова разписка" until then) was renamed, asks for a price level before
it prints, and the sheet lost its „Общо без ДДС" box.

- ⚠ **Only this document was renamed, and only in Bulgarian.** „Стокова разписка" stays the name of
  the receipt MOVEMENT („+ Нов", `goodsReceipt`), of the report type `receipt_note`, and of the
  imported document kinds, where „стокова" (`stokrazp`) and „складова" (`sklrazp`) разписка are two
  different PlusMinus documents. en/de/mk keep their wording (en „Stock receipt" / „GOODS RECEIPT").
- **One list of levels**, `config/stock-receipt-price` (import-pure), read by the dialog AND by the
  route: `selling`, every `PRICE_TIERS` slot by its STORED name (drawn through `tierLabel`: „Доставна
  цена" reads „Цена с ТО"), and `booked` last: the receipt's own unit prices, which is what the sheet
  printed before it asked. An org's own-named tier is no level here.
- **The dialog** (`invoicing-ui/StockReceiptPrintDialog.vue`: `stock-receipt-dialog`, `-price`,
  `-confirm`, `-cancel`) opens on „Цена на едро", or on the first level the role sees. The level
  PRINTED last is kept per user and org (`lgr:stock-receipt-price:<user>:<org>`,
  `composables/stock-receipt-price.ts`); one the role no longer sees gives way to the default.
  Cancel prints nothing and remembers nothing.
- **The route**: `GET /invoicing/export/:id?doc=stock_receipt&priceLevel=<key>`. ⚠ The server decides
  (FR-27.11, `stockReceiptLevelFor`): a level the role does not see is 403 `capability_required`, a
  name that is no level is 422 `unknown_price_level` (never the default in its place), and no
  parameter prints what the dialog would open on. `booked` asks nothing beyond the print itself. The
  route declares no query schema, so there is nothing to add the parameter to and nothing drops it.
- **The sheet** (`reporting/pdf/stock-receipt.pdf.ts`): „Цена" is the article's price at that level AS
  THE CATALOGUE HOLDS IT ON THE DAY IT IS PRINTED (`sellingPrice`, or the slot's `finalPrice`), in the
  org's currency; „Стойност" is quantity × that. An article with no price there (no slot, a zero, no
  article any more) prints a dash in both cells, never another level's figure. The level is named
  under the bill („Цена: Цена на едро (€)"): the currency mark stands there because only the removed
  total showed it.
- Tests: `unit/stock-receipt-price` (15), `unit/stock-receipt-dialog-levels` (9),
  `unit/stock-receipt-export` (17), `integration/bill-stock-receipt.flow` (18),
  `e2e/tests/bill-stock-receipt.spec.ts` (2).

## An article starts its documents: „Заприходи", „Продай", „Резервирай" (2026-10-26, FR-22.47)

- **Where**: the Products list's row menu (one ⋮ now — Edit, Stock, the three, Delete apart) and the
  article's page header on every tab (`inventory-ui/ProductDocActions`, in `EntityFormShell`'s
  `#header-actions` slot and in the stock view's header). The page reads the article AS STORED: its
  „Активен" switch means nothing until it is saved.
- **Rules**: `inventory-ui/composables/product-doc-actions.ts` (pure, `unit/product-doc-actions.test`).
  Each action IS the „+ Нов" form's PAGE_REGISTRY row, so it is offered exactly to whom that form's
  Save is (§5.8: Заприходи `inventory.write`; Продай and Резервирай `invoicing.write`). A service
  (`trackInventory: false`) is never received or reserved; a deactivated article's Продай and
  Резервирай are listed disabled, the reason in a tooltip; Заприходи stays. Into another app the
  action is an `href` from `appHref`, in this one a route (`useProductDocActions`); `RowActionsMenu`
  takes `href`, `disabled` and `hint` for that.
- ⚠ **The `?productId=` contract**: a NEW document opened with it starts with that article on its
  first line, filled by the very handler a pick on the line calls — never a hand-built line, which
  would skip the pricing chain, the stock shown or the staged product update. It runs after the
  form's own defaults, so the line sits in the right warehouse, and stays in the URL (as `copyOf`
  does): a reload starts the same document again.
  - `/inventory/movements/new?productId=` (receipt): `onLineProductSelected` — the purchase price as
    the cost, what the DESTINATION holds, the product update when that switch is on, the next blank
    line, the cursor in the quantity. A movement line has no unit.
  - `/invoicing/<document>/new?productId=` (every `useDocumentForm` form): `onProductSelected` —
    unit, VAT, the price the chain resolves (a purchase document's is the purchase price, B-10), the
    document-wide or last-customer price when on, the next blank line. `copyOf` and
    `relatedInvoiceId` win over it; it is part of a new document's `useDocumentRouteKey`.
  - `/invoicing/reservations/new?productId=` (slice 4a): the list with its create dialog open on
    the article; the list then takes both parameters out of the URL.
- Tests: `unit/product-doc-actions` (7), e2e `product-actions.spec` (10: both places × three
  landings, deactivated, service, two roles, the list at 1366 px); walk P1-act: the row menu →
  „Продай", 2 clicks · 0 typed · 1 page load (the invoice is another app).

## The contact ledger searches by product and by number (2026-11-09, #526)

`GET /invoicing/contact-ledger/:contactId` takes `productSearch` (the Products page's matching,
`buildProductSearchFilter`) and `documentNumber` (part of the number, any case). The page and the
line-picking dialog (`useContactLedger`) send them debounced. Both narrow through an `$and`, never a
key of their own, so `outgoingOnly` (FR-26.6) still decides what a session sees.
- ⚠ **With a product search the summary is per line, from the documents' own money.** Each matching
  line takes the share of its document's `subtotal` / `taxTotal` / `total` that its terms (quantity ×
  price, discount, rate) weigh among the document's lines. Never sum the stored `lineTotal`: an
  imported document's header is the paper's, and its lines' rounded VAT can sum a cent or two away
  from it. (Until #598 an imported line's `lineTotal` was also NET where a form's is gross; it is
  gross everywhere now.) A search that finds every line gives exactly the unfiltered summary, and a
  test holds that.
- The cost behind profitability keeps a Type filter. Its `type: { $nin: … }` used to REPLACE the
  filter's, so under Type = Invoice it cost every type sold.
- Rows sort with the line's place in its document as the last key: a page boundary inside a
  document is the same on every request. The page is cut before the lookups.
- Tests: `integration/contact-ledger.flow.test.ts` (the `#526` block), the Seller case in
  `seller-roles.flow.test.ts`, `e2e/tests/contact-ledger-search.spec.ts`. ⚠ A new e2e spec runs
  nowhere until a project in `playwright.config.ts` lists it by name.

## One meaning for a line's `lineTotal`: gross, imported documents too (2026-11-23, #598)

The document import (`doc-import/map-invoice.ts`, which the PlusMinus API import goes through too)
stored the paper's NET line value in `lineTotal`, where everything LGR makes stores net after discount
plus VAT. On production 12,259 outgoing invoice lines and 20 note lines of the two importing orgs were
net, beside 282 gross lines of the one that also issues in LGR, so one customer's documents carried
both. The contact ledger's Total column and the Reports `contact-ledger` read one row's net beside
another's gross, the product ledger's invoice sales were net where its cash sales are gross, and the
journal would have posted an imported invoice's net less its VAT as revenue (none was posted).
- ⚠ **`lineTotal` is gross on every document; the net is `lineTotal − taxAmount`.** The mapper
  stores the line value plus its VAT (VAT and header unchanged; with no net total on the document, as
  from the PlusMinus API, the subtotal is the lines' nets). Migration `0023-imported-line-totals-gross`
  converts the lines imported before.
- ⚠ **0023 decides per LINE, by the line's own terms, never per document.** It takes invoices,
  credit and debit notes tagged `ocr-import` or whose first status says `ocr_import`, both directions
  (a cash sale is 0007/0011's). A line is net when its `lineTotal` is nearer `quantity × unitPrice ×
  (1 − discount%)` than that plus its `taxAmount`, within half the VAT (at least a cent); gross the
  other way round; without VAT when the VAT rounds to 0.00; neither when far from both (left alone,
  counted, and named by `--dry-run`). A copy ("Копирай" carries the tag) and an imported draft saved
  through the form are gross already, and stay. Only `lineTotal` is written, each write guarded by the
  values it read; a second run changes nothing. It logs per org: documents and lines converted, lines
  already gross, without VAT, matching neither.
- **The print** (`invoice.pdf.ts`): „Стойност" prints `lineTotal − taxAmount`, the net the totals box
  adds up to the tax base, on every invoice. An imported invoice prints what its paper shows, as
  before; an LGR-made one used to print its gross under that heading and now prints its net.
- `scripts/fix-imported-invoice-lines.ts` reprices from the net (`lineTotal − taxAmount`), or it
  would price every line at its gross.
- Readers that needed nothing but the data: the contact ledger and its report, the product ledger's
  sales, `auto-journal.service.ts` (`lineTotal − taxAmount` is the revenue), the list exports' „Line
  total". The Files review (`DocImportLines.vue`) shows the mapped `lineTotal` under „Line Total", gross
  now as in the form.
- Tests: `integration/imported-line-totals.migration.test.ts` (0023), `integration/imported-line-totals.flow.test.ts`
  (the mapper from a PDF, a note and the PlusMinus API; the contact ledger, the product ledger and the
  journal with an imported and an LGR-made invoice), the print in `unit/invoice-pdf-form.test.ts`.

## The contact ledger shows the stock movements (2026-11-12)

The owner's ask: the Contact Ledger — its page and the dialog the invoice, bill and proforma forms open
from their contact field — shows the stock movements: in the row of the document that carries one, and
a movement with no document as a row of its own, with "Stock Movement Document" in the Type filter.

A movement is in the ledger one of two ways, never both (`services/biz/contact-ledger.service.ts`):
- **With its document.** Each document line's row carries `movements[]` (`{ id, number, type,
  reference? }`): the movements the document booked (`invoiceId`) and the ones it stands for
  (`stockSource.movementIds`: the receipts a bill was made from, the stock note or the till sale an
  invoice was issued for), those that carry the line's article, and of those the ones of the line's
  own warehouse when any is (a document selling from two warehouses books a movement for each). Read
  for the page's rows alone, after the page is cut.
- **On a row of its own** (`documentType: 'stock_movement'`, `movementType`, `documentNumber: ''`,
  `documentId` = the movement's): a movement that names the contact and no document (`invoiceId`
  unset), booked (`confirmed` / `completed`), not `recordOnly`, not `reversedBy`. One row per line, at
  the movement's `date`, joined to the documents' lines by `$unionWith` before the sort and the page.
  ⚠ A receipt a bill still in DRAFT holds is such a row too: a draft is no row of the ledger, and the
  delivery it will pay for happened (`heldByDrafts`). Without that, making a bill from a receipt took
  the receipt off the supplier's ledger until the bill was received.
- ⚠ **A movement's own row is valued at COST** (`unitPrice` = the line's `unitCost`, `lineTotal` = its
  `totalCost`; a `return` negative, as a credit note's line). Both are absent for a role without
  `products.costs`: `withoutLedgerCosts`, one definition for the route and the report. It has no
  `taxRate`.
- **The summary counts documents**, with the movements listed or not: a movement owes nobody anything.
- **Type** (`documentTypes`): `stock_movement` beside the document types. None chosen: everything.
- **FR-26.6**: without the purchases side there is no bill, and of the movements' own rows no goods
  receipt and no return to the supplier (`type: 'return'` out of a warehouse).
- **Invoice #** (`documentNumber`) also finds a movement by its number or by the document it was
  booked from (`reference`, „sklrazp_0000615713"), and brings the document that carries it. Looked for
  among the contact's own movements and the ones its documents stand for, in two indexed reads.
- ⚠ **A period's last day is whole.** A calendar date bounds a day in the shop's time
  (`local-day.ts`); `new Date('2026-11-12')` as the END of a period is that day's first instant, which
  dropped every till document and every movement made during it. The documents' filter had this from
  the start; both go through `periodOf` now.
- **UI**: `ui-shared` `useContactLedger` (headers, `typeLabel` / `typeColor`, `isMovementRow`),
  `LedgerMovementLinks.vue` (the numbers, links for a role that opens Stock Movement Documents; a
  movement's own row prints its `reference` under the number), `ContactLedgerDialog.vue` (every
  document form, the cash-sale terminal, the contact form) and `invoicing-ui` `ContactLedgerView.vue`.
- ⚠ **In the dialog a movement's row has no checkbox.** A document made from its lines would move its
  goods a second time: nothing links a hand-made invoice to the stock note it is for (only the
  import's `findStockNoteConversion` does), and a bill has „Свържи с доставка" for exactly this.
- **Reports** `contact-ledger`: a `movementNumbers` column, the `stock_movement` type option, and a
  movement's row drills down to `/inventory/movements/:id`.
- ⚠ **A report that reads a ledger is told its caller** (`ReportHandlerContext.sees: { bills, costs }`,
  filled by the reports controller, #704). The contact-ledger and product-ledger reports ran their
  services with no caller, so they listed incoming documents and carried cost figures the ledgers' own
  routes withhold; the product ledger (route and report) and the warehouse operations report now name
  no bill to a session without the purchases side, as the movement routes do (#493). A handler run with
  no caller reads everything.
- Tests: `integration/contact-ledger-movements.flow.test.ts` (the fixture's table is its header),
  `seller-roles.flow`, `access-price-levels.flow`, `reports-p2.flow`,
  `e2e/tests/contact-ledger-movements.spec.ts` (the page, and the dialog of a new invoice, bill and
  proforma).

## The document services (2026-11-18, FR-32.21, #797)

- **Where it lives.** Creating, updating and issuing a document are `services/biz/document`: `createDocument`
  (`POST /invoices`), `updateDocument` (`PUT /invoices/:id`) and `sendDocument` (`POST /invoices/:id/send`, around
  FR-29.8's `issueDocument`), with `convertQuote` and the list's `listFilter` / `listRows`. A handler of
  `invoice.controller.ts` reads its request, says who may, calls one and answers what it says;
  `unit/invoice-handler-size.test.ts` holds every handler there to 80 lines (they were up to 326).
- ⚠ **A route that calls a document service answers through `answered(status, …)`.** A service refuses by returning
  `refuse(code, body)` (`services/biz/document/refused`), never by calling the route's `status`: returned as it is, a
  `Refused` is a 200 whose body is `{ statusCode, body }`. A helper that takes a `Status` (`whoHolds`, `draftTaken`,
  `receiptPrinting`) takes `refuse` inside a service and `status` inside a route.
- ⚠ **What reaches a device stays in `invoicing-api`, and the route hands it in.** `services` does not depend on
  `fiscal`: a cash sale's drawer and receipt (`lib/cash-register-sale#cashSaleTill`), the receipt or refund at issue
  (`lib/counter-issue#counterAtIssue`) and finishing a dead receipt before an edit (`finishInterruptedDocuments`) are
  passed to the service by the route, which calls them by name. That call is how `unit/fiscal-route-declared` sees the
  route reach a device: a port passed as a plain object would hide it.

## One base for the two order forms (2026-11-18, FR-32.23, #797)

- **Where it lives.** The supplier order (`OrderFormView.vue`, ORDO) and the customer order
  (`InternalOrderFormView.vue`, ORDI) stand on `composables/order-form/useOrderFormBase.ts`: the number and status on
  the screen, the reservations and invoices the GET returns, the contact pools and the warehouses, Delete, the number
  a new order gets, and the order-wide actions with Cancel and Complete asking first. `components/order-form/` holds
  the foot both share (`OrderFormFooter`: notes, terms, tags, the totals and Save) and each form's own cards and
  dialogs; `composables/order-form/` holds each form's body, its load and its tree's cells. `unit/order-form-size`
  holds each form to 900 lines (they were 1 544 and 1 564).
- ⚠ **A form's `usePendingChanges` stays in the view, after `useOrderFormBase` and before its `onMounted`.** The clean
  state is taken when the load resolves (FR-31.2, `snapshotPending()` at the end of `loadOrder`): a base that
  registered the guard or the mount itself would change the order the hooks run in.
- ⚠ **Code moved from a `.vue` into a `.ts` file is linted for floating promises.** oxlint reads the `.ts` files, not
  the script blocks of `.vue` files: a `router.push(…)`, a `nextTick(…)` or an action left unawaited there is written
  `void …`, as `useOrderFormBase#deleteOrder` does.
