---
paths:
  - "packages/api/src/invoicing/**"
  - "packages/web/src/modules/invoicing/**"
  - "packages/services/src/biz/*invoice*"
  - "packages/services/src/biz/issue-document*"
  - "packages/services/src/biz/receipt-bill*"
  - "packages/services/src/biz/bill-*"
  - "packages/services/src/biz/doc-email/**"
  - "packages/services/src/biz/contact-ledger*"
  - "packages/services/src/biz/dispatch-invoice*"
  - "packages/services/src/biz/document-*"
  - "packages/services/src/biz/document/**"
  - "packages/db/src/models/invoice*"
  - "packages/reporting/**"
---

# Rules and traps: Invoicing documents

Every ⚠ and every never/always rule of this area's history, copied whole with the bullet it sits in, by section.
Why each one exists, and what was built around it: [`docs/history/invoicing.md`](../../docs/history/invoicing.md).
`unit/claude-md.test.ts` fails when a ⚠ of that history is in neither this file nor `CLAUDE.md`.

## Draft+Issued Invoice Numbering (2026-04-28)

Drafts use per-type DRAFT_* counters (DRAFT_INV/PRF/OFR/CN/DN/BILL); cash sales skip drafts (CS direct). On `/send` or `/receive`, `issueDocument` allocates a new issued number from the canonical SALES_DOC/PROFORMA/OFFER/BILL counter (last, inside the issue's transaction: FR-29.11), sets `draftNumber = previousInvoiceNumber`, replaces `invoiceNumber`, and appends to `numberHistory[]`. Display prefix override (per-org-global) lives on the Sequence year=0 sentinel doc; future allocations only. **Documents are editable in EVERY status** — PUT applies no status or posting check. The edit-sent guard (409 when a posted JournalEntry referenced the invoice, with credit-note remediation) was **removed**; ⚠ an edit to a posted document does NOT re-post, so the JournalEntry keeps its pre-edit amounts and trial balance / P&L / balance sheet report the stale figures with nothing marking them so — repost is manual. DELETE keeps its draft-only guard. Configuration page at `/invoicing/configuration/sequences` (admin/manager only).

## A sales series without a year (2026-11-15)

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

- After counting, the number is written to **this year's row** as well. ⚠ That mirror is load-bearing: the legal
  mark on a master, the last numbers a person records after a promotion (`legalCounters`, which leave the
  year-0 row out) and a build that does not know the option all read the YEARLY rows. A document carries a number
  only after the mirror is written.

- ⚠ Do not move the count back onto the yearly rows. That was the first version: two years counted on at once
  (midnight on 31 December, two servers whose clocks disagree) had to look at each other's row afterwards and give
  a number up, which leaves holes in a legal series.

- ⚠ **Other readers of the number's FORM.** An importer that tells a document typed here from an imported one by
  the year in its number (`scripts/lib/invoice-index.ts`: `INV-<year>-<n>` = "entered by hand") sees both
  as `INV-<n>` once the org numbers without a year. Both were skipped before and both are skipped now; only
  the label in its log changes. Its audit (`scripts/audit-coverage-api.ts`) then compares such a document with
  the other system's invoice of the same number and lists a difference as `DIFF`, and lists one with no
  counterpart there. ⚠ One series, two systems: a number issued here stands for the other system's invoice of
  that number, so the two must not both issue.

## Offers („оферта") — a quote before the proforma (2026-11-12)

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

- ⚠ An older on-prem master (FR-20) does not know the type: an org moved to one carries offers its code
  treats as sales documents (the move copies raw). Say so in the next server release's notes.

## FR-10 — email an outgoing invoice (2026-08-25)

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

## A list's ticked documents by e-mail (2026-11-16)

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

- **Who mails what** is `internalOrderEmailSkip`, for the preview and the mail alike. The
  request takes what the sheet's export takes (`orders.view`, `sales-docs.export`) AND the work
  on orders (`orders.create|edit`): a role that only reads prints a sheet and mails none. ⚠ Its
  own access function, never the supplier order's: a customer order is read by `orders.view`
  alone. Per order: an id that names none in this org is `not_found`; a `draft` is held back
  (its sheet shows no number). ⚠ **A cancelled order GOES**, as every status but `draft`
  does: its sheet's title says it is cancelled, and telling the client so is a use. The
  `cancelled` reason stays a stock movement's.

- UI: `web/src/modules/invoicing/views/InternalOrdersView.vue` is a `fit`, `selectable` `ListScaffold` with
  `<DocEmailBar kind="internal-order">`; the button shows to
  `useDocEmailAccess().internalOrders()`, which `unit/doc-email-access` holds to the server's
  rule. ⚠ The list has nine columns beside its tick: the client's name is clipped at 9em (whole
  in its `title`) and a row's icons sit in one unwrapped row, which is what keeps a draft's row
  (four icons) one line at 1366 px.

- `POST /org/:orgId/warehouse/movement/email/preview { kind: 'movement', ids }` and
  `POST /org/:orgId/warehouse/movement/email { kind: 'movement', to, items: [{ id }], subject?,
  message?, locale? }`: the answers, the caps and the refusal order of the invoicing pair. A
  row's `docType` is the movement's type, its `partner` the movement's contact. ⚠ A transfer
  names no contact, so ticked transfers open the dialog on „До един адрес": that is how a
  transfer to or from an external warehouse reaches the people of the other site.

- The file is `renderStockMovementPdf`'s (`<movementNumber>.pdf`, no price on it), the mail
  names each movement by its type word (`reporting/stock-movement.i18n.ts`), `entityType:
  'stock_movement'`, audit module `warehouse`. ⚠ A movement keeps no `emailedTo` history, so the
  outbox worker needed NO branch: a master's queued mail settles its `EmailLog` rows by
  `outboxId` like any other.

- UI: `web/src/modules/inventory/views/MovementsView.vue` places its own table, so it carries the tick
  column (`show-select`, the ids) and `<BatchEmailBar kind="movement" …>` itself.
  `composables/movement-email-access.ts` names the server's capabilities again (the UI cannot
  import the warehouse API) and `unit/movement-email-access` holds the two together. ⚠ With the
  tick column the list is `list-fit` (`ui-shared/styles/list-fit.css`, the rules
  `ListScaffold`'s `fit` uses): its two warehouses and its contact are clipped at 9em and 10em,
  a row's icons are the size of a row menu, and the title row wraps, which is what keeps a
  390 px page from scrolling sideways.

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

## Invoice for a cash sale (2026-10-25, #171 / #203, FR-21 D-14 / §3.9)

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

- **Attaching an invoice that already exists** (2026-10-28, FR-21 §11): „Към касова продажба…" on
  an issued sales invoice written before the day's till export arrived — the till sold the goods,
  the invoice dispatched them again. `GET /invoices/:id/cash-sale-candidates` (the cash sales of
  its day it fits), `POST /invoices/:id/attach-to-cash-sale {cashSaleId}`, the dialog
  `web/src/modules/invoicing/components/AttachToCashSaleDialog.vue`. Attached, it becomes what R0 issues:
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

## A receipt first, then its bill (2026-10-26, FR-22 slice 3: FR-22.28–.33, #168)

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

## The goods first, then their invoice (2026-11-13, FR-22.61–.62, #725)

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

## Issue, print and get paid on the document (2026-10-26, FR-22 slice 2a: FR-22.16–.22)

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

- **`useDocumentForm` is built from parts** (FR-32.22): `document-form/parts/` (state, totals, lines, product-update,
  pricing, products, party, load, status, print, saving, issue), each at most 500 lines, a part reading only the
  parts before it; the composable keeps the bars' actions, what starts a print, the „Складова разписка" print and
  `issueFromForm`, and returns what it always did. ⚠ The parts are called in the order their hooks register, and
  the form's `onMounted` (`load.ts#mountForm`) is called last: `usePendingChanges` (state) registers its own
  `onMounted` first, and the clean state is taken when the load resolves (FR-31 A1). `unit/document-form-parts.test`
  holds the order and the sizes; `unit/document-form-actions.test` reads the actions and the print in
  `useDocumentForm.ts` itself, so those stay there.

- **The latest question wins** (FR-31.4): a search, a list page or a price lookup goes through
  `ui-shared/composables/latest-only.ts#latestOnly`, one wrapper per consumer. Only the latest call's answer is
  delivered; an earlier one's answer and error are dropped and its request aborted (`signal`), and `useHttpClient`
  says nothing of an abort. ⚠ A late answer to an earlier word once put the wrong article on a line on Enter.

- **A failure is said, and stays** (FR-31.6 to .9). `EntityFormShell` takes `load-error` (`loadFailureOf`:
  `not_found` / `forbidden` / `failed`) and shows that with Back and Retry (`@retry`), and no field and no action;
  `refusal` is an alert at the top of the form until `@dismiss-refusal` or the next success. A form gets both from
  `useFormFeedback()`; `refused()` says it on the message line too (where it was said before), and `succeeded()`
  withdraws it from both, so a success never waits behind a refusal that is no longer true. ⚠ A load that swallows its error (the document form's did) looks like an empty draft.

- **A line grid keys its rows by the line** (FR-31.12): `:key="rowKey(line)"` (`ui-shared/composables/row-key.ts`, a
  `WeakMap` on the line object, never a field on it), never by position: removing a row gave the rows below it to
  other lines, with their open menus, typed text and focus, and made them load again.

- **One formatter** (FR-31.13): money, numbers and dates go through `ui-shared/format` (`formatMoney`,
  `formatNumber`, `formatDate` / `formatDateTime`, `formatPrice`, `intlLocale()`), in the app's language
  (`declareLanguage` sets it). ⚠ No UI file names a formatting locale (`'bg-BG'`) or calls `toLocale*`, `Intl.*Format`
  or `numberFormat(` outside `ui-shared/src/format/`: `unit/one-formatter.test.ts` fails, with an empty allow-list.
  Dates are `dd.MM.yyyy` (bg, de, mk) and `dd/MM/yyyy` (en); a list shows `formatDate(x)`, never `x.split('T')[0]`.

- **The app asks, never the browser** (FR-31.17): `await askConfirm({ text, confirm: t('common.delete'), danger: true })`
  (`ui-shared/composables/confirm.ts`). ⚠ `unit/fields-and-dialogs.test.ts` fails on `confirm(`, `alert(` or
  `prompt(` of the browser, and on a new raw `type="number"` input: a figure is a `DecimalField`, which takes a comma.

- **A list keeps its place** (FR-31.18): every list on `usePaginatedTable` passes `urlSync: true`, and each filter a
  control on the page sets is a `useListQueryState` key, declared before the table. ⚠ `unit/list-place.test.ts` fails
  on a new table without it (a picker dialog and a record's own rows are its two listed exceptions) and on a settable
  filter left out of the address. Movements, Stock levels and Inventory counts are on `ListScaffold` (FR-31.19): the
  column picker, columns kept by route name, addresses as before.

- A list on `usePaginatedTable` / `useProductList` never throws a failed request any more: it puts it in
  `pagination.loadError`, and `ListScaffold` (or `ListLoadError` in a table of its own) says it with Retry, never "no
  data". An error on the message line (`useSnackbar`) stays until closed, and messages queue.

- **One issue path** (FR-22.17): `web/src/modules/invoicing/composables/document-issue.ts` holds the requests (the
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

- **A note from its invoice** (FR-22.21): „Кредитно известие" / „Дебитно известие" on an issued
  invoice or bill open `…/new?type=credit_note|debit_note&relatedInvoiceId=`, which starts as the
  invoice (`noteFromInvoice`: customer, the invoice, currency and rate, payment method, lines as
  sold). ⚠ The customer is set without `onContactChange`: its price re-resolution would replace the
  prices the invoice charged.

## One list of actions for a document's two bars; „Издай и печатай" asks how to print (2026-11-15)

- **One list, drawn twice.** `DocumentForm` hands `barActions` to `EntityFormShell`, which draws it
  under the title and, with `bottom-actions`, again at the foot (`ui-shared/FormActionBar.vue`). The
  list is `useDocumentForm#formActions` (the document's own steps) with e-mail, Print and a bill's
  „Складова разписка" put in before Import (`document-form/form-actions.ts#withOutputActions`). There
  is no second place that decides what a bar offers: ⚠ never add a button to the form's body or to one
  bar. `FormAction` grew what those buttons needed: `key`, `testId`, `title`, `disabledHint` (shown
  while disabled: e-mail on a draft), `more` (the split button's second half: Print's options),
  `note` (the last-sent chip), `collapse`.

- **Save is offered in every status**, in both bars (the cash-sale terminal apart): the foot always
  had it, the API takes an edit in every status, and `editSaveGate: 'draft-only'` (the sales invoice)
  now only keeps Import off an issued one. So Ctrl+S saves an issued invoice too.

- **One line where it fits** (`form-action-collapse.ts`, `COLLAPSE` in `form-actions.ts`): an action
  with a `collapse` rank gives up its label for its icon when the row would wrap, the rarest first
  (import → attach / a draft quote's converts → debit note → credit note → stock receipt → e-mail →
  print); Save, issue, receive and a payment never do. The label stays as `aria-label` and tooltip, so
  ⚠ find a bar's button by role and name, never by its text. A row that is two lines even as icons
  (a phone) shows every label and wraps.

## A bill's „Складова разписка" asks which price to print (2026-11-15, FR-22.33a)

- ⚠ **Only this document was renamed, and only in Bulgarian.** „Стокова разписка" stays the name of
  the receipt MOVEMENT („+ Нов", `goodsReceipt`), of the report type `receipt_note`, and of the
  imported document kinds, where „стокова" (`stokrazp`) and „складова" (`sklrazp`) разписка are two
  different PlusMinus documents. en/de/mk keep their wording (en „Stock receipt" / „GOODS RECEIPT").

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

## An article starts its documents: „Заприходи", „Продай", „Резервирай" (2026-10-26, FR-22.47)

- **Rules**: `web/src/modules/inventory/composables/product-doc-actions.ts` (pure, `unit/product-doc-actions.test`).
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

- Tests: `integration/contact-ledger.flow.test.ts` (the `#526` block), the Seller case in
  `seller-roles.flow.test.ts`, `e2e/tests/contact-ledger-search.spec.ts`. ⚠ A new e2e spec runs
  nowhere until a project in `playwright.config.ts` lists it by name.

## One meaning for a line's `lineTotal`: gross, imported documents too (2026-11-23, #598)

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
  adds up to the tax base, on every invoice.

## The contact ledger shows the stock movements (2026-11-12)

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
  document form, the cash-sale terminal, the contact form) and the invoicing module's `ContactLedgerView.vue`.
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
- ⚠ **What reaches a device stays in `api/src/invoicing`, and the route hands it in.** `services` does not depend on
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

## Typed API modules (2026-11-18, FR-32.24, #797)

- **Every request of the invoicing module is a function of its `api/`** (the rule is `web-app.md`'s). The order forms' base
  is handed its order's routes by its form (`OrderFormSpec#routes`: `api/orders#supplierOrderRoutes` or
  `api/internal-orders#customerOrderRoutes`), not a path to build.
- ⚠ **A document's one read (`GET /invoices/:id`) names its contact, or gives its id.** `contactId` is `{ _id,
  companyName… }` when the contact exists and the stored id when it is gone: read it by `typeof`, as
  `document-payload#contactIdOf` and `load#loadDocument` do. The model has no `supplierInvoiceNumber` (a bill's number
  is `reference`) and no `date` (a document's day is `issueDate`).
- **`PUT /fiscal/device/:id` names `status`** (fixed 2026-11-18: it did not, and the device list's and the till's
  status writes, `api/fiscal-devices#recordFiscalDeviceStatus`, were dropped with a 200). It takes the model's enum,
  `online | offline | error`; anything else is a 422. ⚠ **A written `error` stops sales**: a device in `error` that no
  bridge holds makes every sale on it a 503 until a connect or an `online`/`offline` write clears it. The create takes
  the form's `isActive` (default true). A device's warehouse is the model's required field: both schemas refuse `null`,
  and the form cannot clear it.
