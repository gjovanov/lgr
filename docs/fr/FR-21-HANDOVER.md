# FR-21 — handover (2026-10-25, updated 2026-10-28)

**To:** Atanas (@lazarovski) · **Tracking:** #171 · **Spec:** [FR-21](FR-21-cash-register-pos-and-cash-sales.md)

**Every release is on production (2026-10-27).** R1 shipped in `v20261026-ee6cc3b78103`, R2 (with
#278's fixes) in `v20261026-91340a8573f1`, then R3 (#284) and R4 (#286), R5a (#315) in
`v20261027-81b088ce53ca` and R5b (#316) in `v20261027-61d64b243f9f` (master `2aedabac`). Migrations
`0006`–`0009` are recorded, and `postransactions` is frozen and empty. Each field check matched the one
before it; after R3 only the day's imports had moved. This is what was done, what is left, and what
turned up on the way that the spec does not say.

## 0. FR-21 is done (2026-10-28)

**Every acceptance criterion in the spec's §9 is ticked**, each with its evidence. #171 is closed.

- **The whole e2e suite passes:** every project, the OCR and Eltrade stubs up, a fresh seeded
  database, master `eb002d50` plus #357: 401 passed, 0 failed, 17 skipped by their own conditions.
  The last four failures were wrong specs, not product bugs (#357):
  - `desktops-security.spec` named `POST /desktops/codes`, a route that never existed. The code is
    minted at `/enrollment-codes`. It now covers all 13 of the controller's routes.
  - `backup.spec:69` expected the restore section, which since 2026-09-10 renders only for a backup
    sys-admin. It now asserts that a non-sys-admin is not offered it.

  ⚠ CI does not run e2e, which is how a spec stayed wrong for four weeks.
- **The device test in `acme-corp` is skipped** (Atanas, 2026-10-28). The same flow runs end to end
  on the simulated Eltrade (`cash-register-fiscal.spec`, #337), through the real driver and protocol,
  so R5's "prints on its device" is ticked on that.
- **#351 is on production** (Goran's deploy, `eb002d50`): the digest's Payments line leaves out
  `origin: 'cash_register'` rows, so the till's money is only ever the Cash register line. The field
  check after it: only regal-sf's Payments moved.
- **What comes after FR-21** is the spec's §11: the accountant's decisions (revenue for cash sales
  without a session, back-office stornos in SUPTO 18.4/18.5, VAT credited to revenue) and the
  partial storno.
- **On production since 2026-10-28** (deploys `b3d8f7fe`, Goran, and `6de3e145`):
  - #334: **#281** (no storno of a fiscal sale while its device is offline) and `warehouse_manager`
    leaving `STORNO_ROLES`;
  - #335: **#279** (a refused sessionless cash sale draws no CS number);
  - #336: **#280** (a completed transfer is a single document's);
  - #343: attach an invoice to its day's cash sale;
  - #347: on the Bulgarian day, plus the script for the hand-repaired overlaps. **All 83 are attached**
    (82 regal-sf, 1 regal-pz). ⚠ The pod's filesystem is read-only, so such scripts run from the build
    host through a port-forward (#349).
- **Watch the daily cash-sale imports.** Since R5b `POST /invoices` checks a cash sale's total with
  `computePosTotals` (422 `cash_sale_total_mismatch`); an imported day is exempt, and none was refused
  on the first evening.

## 0a. Start here (2026-10-26, kept as the record)

Atanas takes FR-21 over from here. In order:

1. **R2 is merged into master and not deployed.** #272 (`75ff7c80`), #273 (`0ff55bc9`) and #274
   (`3e020145`) merged on 2026-10-26, each with CI green. The next deploy of master ships R2,
   whoever runs it.
2. **Merge #278 before that deploy.** A review of the stack (2026-10-26) found bugs in all three
   PRs, and the stack merged before the fixes. #278 carries them, one commit per step. What was
   fixed, and what was left because master does the same, is in §4.18–§4.21.
3. **Deploy R2 when the owner gives the go** (§5, R2 steps 4–5):
   - the field check before the deploy (the baseline);
   - the deploy;
   - `bun run migrate` on the build host;
   - the field check again, and the diff;
   - the device test in `acme-corp`.

   After the deploy, watch the first cash-sale import. regal-pz and regal-sf import a till day
   every day, so it is the busiest door R2d moved onto the new service.
4. **#276**, the void-path bug (§4.13). It is independent of FR-21's releases.
5. **Decide before R3–R5:**
   - **The e2e fiscal device** (§5, R2 step 2). The recommendation is no bypass of the SSRF guard:
     integration tests run printing on the Eltrade simulator, and the device test covers the real
     connection.
   - **SUPTO 18.4/18.5 and back-office stornos** (§4.16). This is the accountant's question.
   - **The terminal shows any open session** (§4.1). Settled 2026-10-27: the user's own (R5a).

⚠ **This repository is public.** Business figures never go into it, its issues or its PRs: sales
totals, a day's cash, SUPTO sums. The field check's output stays on the build host.

## 1. State

| Step | Requirements | State |
|---|---|---|
| **R1a** — the fixes the merge depends on | FR-21.1 – FR-21.6 (B-1 – B-5, B-7) | #244, merged and deployed 2026-10-26 |
| **R1b** — every reader counts a till sale once, whichever store holds it | FR-21.7 – FR-21.12 | #247, merged and deployed 2026-10-26 |
| **R1c** — one journal page in both apps | FR-21.13 (B-6) | #248, merged and deployed 2026-10-26 |
| Before R2 — the `regal` test sales | FR-21.14 | **Done 2026-10-26** (#269, owner's go): 74 test sales removed, see §5. |
| R2a — `pendingTransferIds` | FR-21.24 | #271, deployed 2026-10-26 (`v20261026-91340a8573f1`) |
| R2b — the till writes cash-register documents | FR-21.15 – FR-21.20 (the till's door) | #272 + #278's fixes, deployed 2026-10-26 |
| R2c — the copy migration and the restore | FR-21.21 – FR-21.22 | #273, deployed 2026-10-26, `0008` applied |
| R2d — the back office and the import; `docs/supto`; the field-check script | FR-21.15 (the other doors), FR-21.23 | #274, deployed 2026-10-26. The device test in `acme-corp` was skipped (2026-10-28; the simulated Eltrade covers it, #337) |
| R3 — freeze | FR-21.25 – FR-21.26 | #284, deployed 2026-10-27, `0009` applied |
| R4 — contract | FR-21.27 – FR-21.28 | #286, deployed 2026-10-27 |
| R5 — one terminal | FR-21.29 – FR-21.32 | R5a (#315, FR-21.31) and R5b (#316, FR-21.29/.30) deployed 2026-10-27. FR-21.32: in force since S-28, pinned by a test (§5, R5) |

⚠ **Merging a stack: retarget the next PR before deleting the merged branch.** GitHub CLOSED #247 when
#244's head branch was deleted with `gh pr merge --delete-branch`, instead of retargeting it. A closed
PR's base cannot be changed, and it cannot be reopened while its base branch is gone. The fix was to
restore the branch, reopen the PR, retarget it, and delete the branch again. For the rest of the stack:
`gh pr edit <next> --base master` first, then delete the old base, then merge.

**The R1 release, 2026-10-26:**
1. **Migrations.** `bun run migrate` ran from the build host's `~/lgr` (at the deployed commit, through a
   port-forward). `MIGRATIONS_AUTO` is off on production, so this is a step, not a side effect.
   - `0006-pos-out-record-only` marked 0 batches: prod had no POS-OUT movement.
   - `0007-cash-sale-line-totals-gross` converted 87 cash sales: all of regal-pz's 66 and regal-sf's 21
     imported days.
   - ⚠ The host's `node_modules` was stale, so `bun install --frozen-lockfile` comes first there.
2. **Release note (FR-21.5).** The product ledger's cash-register totals for imported days rise by the
   VAT they were missing.
3. **Field checks (§8.4), read-only.** One script ran against prod with the code before and after the
   release: same 30-day window, same digest day. The amounts stay off this public repository.

   | Org | Journal rows = POS + cash sales | SUPTO 18.1, 30 days | 18.2–18.5 | Digest 10-23 cash vs journal cash |
   |---|---|---|---|---|
   | regal | 82 = 74 + 8 | unchanged | unchanged | equal |
   | regal-pz | 66 = 0 + 66 | unchanged | unchanged | equal |
   | regal-sf | 21 = 0 + 21 | unchanged | unchanged | equal |

   In the demo org `acme-corp`:
   - Both journal pages render.
   - The API answers.
   - An invoiced cash sale (#249) is listed once, carrying its invoice.

## 2. The migration ids are not the spec's

The spec's ids were indicative (§5 says so), and master already had `0002`–`0005` when R1a landed.

| Spec | Actual |
|---|---|
| `0003-cash-sale-line-totals` | `0007-cash-sale-line-totals-gross` |
| `0004-pos-out-record-only` | `0006-pos-out-record-only` |
| `0005-cash-register-copy` (R2) | `0008-cash-register-copy` (#273) |
| `0006-cash-register-freeze` (R3) | `0009-cash-register-freeze` |

FR-21.28's startup check has to name the freeze migration's real id: `0009-cash-register-freeze`.

## 3. Decisions taken while building

Revisit any of these you disagree with. None is hard to change.

1. **The invoicing detail page (D-10).** A document still opens on `CashSaleFormView`
   (`/invoicing/cash-sales/:id/edit`), because print (with the companion documents) and email live
   there. The journal's own detail page, `CashRegisterDocument`, is used in two places:
   - for a till row that is not a document yet, at the new route `invoicing.cash-sales.view`;
   - in the POS app at `/pos/orders/:id`, with an "Open the document" button when the row is a
     document.

   After R2 every row is a document. Decide then whether `/view` goes, or whether the journal
   detail takes over `/edit` once it can print and email.
2. **Storno eligibility in R1.** Only a till sale still held as a POS row can be stornoed. A till
   sale held as a document (which only R2 writes) is refused by R1 code with 409
   `storno_needs_newer_release`. That is the rollback limitation in the spec's release table.
3. **Actions per app.**
   - The invoicing journal has Export, Import, Create, Email and #249's „Издай фактура".
   - The POS journal has View and Storno.

   The export is invoicing's endpoint and reads documents only. So until R2 copies the till's
   history, it does not carry till sales; e2e item 7 belongs to R2. The acceptance criterion asks
   for "the same actions" in both apps. After R2, consider moving Export into the shared
   component, hidden for roles without `invoicing.read`.
4. **Filters.**
   - In the UI: search, kind, origin, status, receipt state, payment method and the date range.
   - API-only: session, warehouse and cashier (`sessionId`, `warehouseId`, `cashierId`). They
     need entity pickers, which are not built.
5. **Column choices.** They are shared by both apps under one grid id, `cash-register.journal`
   (`ListScaffold`'s new `gridId` prop). The old per-route prefs (`pos.orders`,
   `invoicing.cash-sales`) are therefore not read, and everyone starts once on the defaults of
   §3.4.
6. **Filters across apps.** Filters ride the URL and survive a reload (tested). They do not
   follow you from one app's journal to the other's; e2e item 5 can be read either way.
7. **FR-22's list pattern is not applied to the journal yet.** FR-22.23 gave the document lists one ⋮
   row menu (`ui-shared/RowActionsMenu`) and `ListScaffold fit` for 1366 px. FR-22 left the cash
   register to FR-21 (its §6), so the journal keeps its own row buttons. Adopting both is a small
   follow-up, and R5 is the natural place.
8. **Print from the journal** is not built (§3.4 actions). In invoicing the document page prints.
   A POS row has no PDF until R2.
9. **Receipt state of older till rows.** A POS row rung before the receipt became a recorded step
   has no `fiscal.state`. The journal reads its receipt number instead (`printed` or `none`), in
   the filter and in the row alike.
10. **Test names follow §8.1.** `cash-register-immutability.flow.test.ts` also holds FR-21.10's
   keyed-lookup cases.

**R2 (#271–#274):**

11. **The service takes the fiscal device as a port.** `fiscal` imports `services`, so `services`
    cannot import `fiscal`. `register.service.ts` holds the steps and the print-once state machine;
    the till builds a `RegisterPrinter` from `fiscal/*` (`invoicing-api/src/lib/cash-register-till.ts`).
12. **A new till sale is the copy of the POS row it would have been** (`tillSaleDocument` maps a
    virtual row through `fromPosTransaction`). One mapping for new sales and copies, so R1's readers
    and an R1 rollback read both alike.
13. **The one failure rule, as code:** a failure removes the document only until the sale reached
    the device (receipt `pending`/`printed`/`unknown`) or the drawer (`sessionTotalsApplied`).
14. **The till's stock check** reads a new `settings.cashRegister.allowNegativeStock` (unset = allowed),
    not `settings.inventory.allowNegativeStock`: that one defaults to false and nothing read it, so it
    would have refused sales in every org. It has no UI yet.
15. **A storno's return restocks at the cost the goods left at** (the dispatch line's
    `resolvedUnitCost`), through `confirmMovement`, not through `reverseInvoiceStockMovement` (§4.13).
16. **An invoiced sale is not stornoed** (409 `cash_sale_invoiced`): its credit note corrects it, so a
    quantity is corrected once without partial stornos. The other way round, a stornoed sale cannot be
    invoiced (`cash_sale_stornoed`). The spec's per-quantity interplay waits for partial storno (§11).
17. **The till refuses `return` and `exchange`** (422 `register_type_unsupported`): no
    cash-register equivalent, and the terminal never sends them.
18. **No licence check on a `cash_storno`** (§4.10): it is a correction, like a credit note. The till's
    sales are gated where they always were, at opening a session.
19. **Audit names:** a till document keeps `entityType: 'pos_transaction'` (the ids are the rows', so
    the history stays continuous); a back-office or imported one is `invoice`, as before.
20. **A storno from the journal** has its own route, `POST /cash-register/documents/:id/storno`
    (write rule `pos.write` or `invoicing.write`, plus the storno roles). A till sale names the open
    session its refund leaves; a back-office sale needs none and prints nothing.
21. **A restore that cannot copy an old bundle's POS rows warns instead of failing:** the readers union
    both stores, and a blocker in an old bundle must not cost the operator the restore. The copy
    writes batch by batch before its parity check, so a copy that stops may have converted some rows;
    the warning says so. The preflight's own warnings (a parallel run, a duplicate УНП) are in the
    restore's warnings too.
22. **A voided storno keeps its payments** (with nothing paid): SUPTO 18.2 always listed them, and
    0008's parity holds the tables to what they printed before. A till storno whose receipt failed
    keeps its refund payments the same way. Readers that sum money skip `voided` documents: the
    digest and sales history by status, and the documents report's paid split explicitly (R2c).
23. **The digest checks a copied `TXN-` number on its own closed-series line**, so the history never
    reads as gaps in CS, and without the counter comparison (that counter stopped).

## 4. Found on the way

1. **The POS terminal shows ANY open session in the org.** `PosTerminalView.vue#fetchSessions`
   loads the org's last ten sessions, and `activeSession` is the first open one. So cashier B's
   terminal rings into cashier A's session, although the server lets each cashier open their own.
   - R5's D-13 ("the user's open session") builds on whichever of the two is meant. **Decided
     2026-10-27: the user's own.** R5a makes the terminal ask for the user's sessions and refuses
     a sale into another cashier's (403 `session_not_yours`).
   - The e2e fixtures close their sessions because of it.
   - FR-22's till walks (`e2e/tests/ux-budgets/p4-*`, #250) leave the admin's session open. So
     `pos-terminal.spec.ts` fails when it runs after them in the same database. The walks, that spec and
     the terminal's behaviour are all master's. A fresh database, or closing the session, clears it.
2. **`warehouse_manager` may storno but cannot open either journal.** The role is in
   `STORNO_ROLES` (#145) but holds neither `pos.read` nor `invoicing.read`. This predates FR-21.
3. **The digest counts credit notes as positive.** This is existing FR-11 behaviour. The storno
   sign R1b added does not change it.
4. **Over/short has no account until someone sets one.**
   `settings.accounting.cashOverShortAccountId` has no UI, like the other accounting defaults.
   Until it is set, a session's over/short is not posted (R1a).
5. **The e2e seed has no cash sale and no POS session.** The "7 cash sales" in
   `invoicing-export.spec.ts` are what other specs leave behind. The new specs make their own
   (`e2e/tests/helpers/cash-register.ts`).
6. **Two e2e failures predate FR-21.** On 2026-10-25 they failed the same way on origin/master:
   - `invoice-stock-adjustment.spec.ts:94` (credit notes → new form)
   - `stock-validation.spec.ts:42` (element outside the viewport)
7. **Playwright 1.64 needs `chromium_headless_shell-1248`.** Install it with
   `bunx playwright install chromium --only-shell`.
8. **#249 landed first, so this stack is rebased onto it (2026-10-25).** #249 adds an invoice for
   a cash sale („фактура към касова продажба", `cashSaleRef`, `taxEventDate`,
   `services/biz/sale-counting.ts`). It edits the same readers, and it also cites #171. In the
   rebase:
   - **Both counting rules are kept, #249's first.**
     - In totals, an invoice for a cash sale does not count.
     - Per customer, that invoice counts in place of its cash sale.
     - FR-21's rule applies on top: `cash-register/counting.ts`, the `cash_storno` sign −1, and
       leaving out `register.origin: 'pos'` where the union is read.
   - **The guards sit side by side.**
     - `/void` refuses a till document before it checks #249's statuses.
     - The Files rollback skips a till document before it checks for a live invoice.
   - **#249's cash-sales list additions are in the journal** (R1c):
     - The `invoiced=yes|no` filter. It covers sales only, and no POS row is ever invoiced.
     - `invoices` and `invoicingState` on cash-sale document rows, read through #249's
       `invoicingByCashSale`.
     - The Invoice column, on by default.
     - The „Издай фактура" action, in `CashSalesView.vue`'s row slot.

     `e2e/tests/cash-sale-invoice.spec.ts` now runs against the journal.
9. **FR-20 P3-1b (#242) journals every write of a class-R model on a master node.** Settled in R2:
   the capture is a change stream on the database, so it journals raw driver writes too. The copy's
   raw writes are listed in `home-write-guard.flow.test.ts`, each behind `assertHomeIsHere`.
10. **The licence gate and `cash_storno`.** Settled in R2: no gate on a storno (§3.18).
11. **`confirmTransferMovements` confirmed any draft stock movement by id, in any org** (R2a, #271).
    `/send` declares no body schema, so its `pendingTransferIds` reached it. Now only this org's draft
    transfers; anything else refuses the list (422 `pending_transfer_invalid`).
12. **`sequenceGroupFor('cash_storno')` fell through to `SALES_DOC`**: a storno would have drawn an
    INV number. Fixed in R2b.
13. ⚠ **`reverseInvoiceStockMovement` restocks a voided sale at its sale price.** The receipt it
    confirms carries `unitCost = unitPrice`, and `adjustStock` folds that into `avgCost`. So under WAC,
    the default costing method, every void of a sale that moved stock pulls `avgCost` toward the
    selling price — all the way to it when none of the product was left. A layer-costed product
    (FIFO/LIFO/FEFO) is worse: the consumed layers are restored first, and the receipt then layers the
    same goods again. R2's storno does not go through it (§3.15), and `/void` refuses
    cash-register documents. CLAUDE.md's till-overlap repair and the Files rollback do go through
    it. **Filed as #276** (assigned), with a measured repro. A sale of 1 at 15, from 10 units at 10,
    is voided: WAC then reads 10 @ 10.5, and FIFO's layers hold 11 units for 10 in stock.
14. **`createInvoiceStockMovement` had no retry on a taken `SM-` number** (the till's own code had one).
    Moving the till onto it would have lost a sale's stock to two tills selling at once. It retries now
    (`createNumberedMovement`).
15. **A failed storno's late retry could hand back another storno's claim.** The release was
    unconditional; the POS path had the same flaw. It now releases only its own claim.
16. **The SUPTO tables do not list a back-office storno.** 18.4 and 18.5 read the till's rows
    (`origin: 'pos'`), and 18.1 reads cash sales only. A storno of a back-office sale is new in R2;
    whether it belongs in 18.4/18.5 is the accountant's question before LGR is declared.
17. **`GET /trade/pos/session/:id/transaction` read POS rows only.** It reads both stores since R2b.

**The review of the R2 stack (2026-10-26).** The fixes follow the merged stack in one PR,
#278 (`fix/fr-21-r2-review`), one commit per step:

18. **Fixed in R2b:**
    - **A stornoed back-office sale could be voided, edited or deleted.** The journal stornos a
      back-office sale since R2, and a void on top reversed its dispatch a second time.
      `register.stornoState: 'full'` now makes a sale immutable like a till document (409
      `register_document_immutable`), the Files rollback included.
    - **A storno and „Издай фактура" could both pass.** Each now checks again after writing its
      own claim (`invoicedRefusal` after `claimForStorno`, and `stornoState` after the invoice's
      placeholder), so one of the two always sees the other.
    - **A storno receipt that failed to print is voided on the device** (`abandonReceipt`), as a
      sale's is.
    - **A keyed retry waiting on an older release's POS row** whose lease lapsed resumes it, no
      longer answering 409.
    - **A malformed session id** lists no till rows, no longer a 500.
19. **Fixed in R2c:**
    - **0008 could wedge for good.** The check before each insert did not compare everything parity
      compares after it (session, customer, change, the storno's original receipt, payment
      references, line names and discounts). A copy that failed only parity was already written, so
      every later run skipped it as copied and failed the same way. The pre-insert check now covers
      every field parity reads.
    - **One org's blocker held back every other org.** 0008 now copies each org on its own and
      throws at the end naming the orgs it could not copy. It is still not recorded.
    - **The restore's warnings** (§3.21), and the documents report's paid split (§3.22).
    - 0008's fingerprint was re-recorded, not given a new migration: it has run nowhere that keeps
      a record (the mars rehearsal's database is gone).
20. **Fixed in R2d:**
    - **A failure in `afterStock`** (the order counters) left a dispatched sale unfinished and
      answered 500, and saving again made a second sale. It is logged now, and the sale completes.
    - **Driver errors** (E11000) no longer reach the client as `{ code: 11000 }`.
    - **The field check reads every page of the digest day**, not only the first 500 rows.
21. **Left as they are, because master does the same** (worth their own issues):
    - **An unkeyed or failed cash sale leaves a gap in CS.** The number is drawn before the stock
      check, and a sale the check refuses is removed. Master does the same on both its keyed and
      unkeyed paths. Possible fix: a back-office sale, which prints nothing, draws its number only
      after its stock is checked.
    - **The FR-21.24 transfers stay confirmed when the sale is rolled back,** and a retry with the
      same ids is refused. The same as master's `finishCreate`.
    - **A till storno of a fiscal sale prints no receipt when the device is offline**
      (`printsReceipt` falls to false). The same as master. The journal's route reaches it too, and
      whether it should refuse instead is a fiscal decision.
    - **Accepted as designed:** a merge restore labels `register.origin` and links `invoiceId` on
      live documents (derived fields only); 0008's behaviour lives in `copy-org.ts`, outside its
      fingerprint, as 0002–0004's lives in `stored-path.ts`; preflight and parity hold an org's
      rows in memory (prod has none); `register.origin` reads the import's tag.

## 5. What remains

### R1
- Done: merged, deployed and field-checked on 2026-10-26 (§1).
- The checks run on 2026-10-26 against the final state of the stack, rebased onto master `96299b36` (after #249 and FR-22 up to #267):
  - `bun run test`: 3368 pass, 20 skip, 0 fail (3388 tests in 313 files).
  - `bun run build`: green.
  - E2E, serially against an isolated database (§7): `cash-register`, `cash-sales`, `cash-sale-invoice` (#249's, now against the journal), `pos-terminal`, `pos-transactions` and FR-22's `document-lists`: 29 pass, 1 skipped (`cash-sales` skips its terminal test when the terminal shows no product cards).
  - FR-22's walks (`--project=ux-budgets`): 17/17. The storno walk now reaches the journal by
    its new menu entry, „Касови продажби".

### Before R2: FR-21.14 — done 2026-10-26
`scripts/remove-test-pos-sales.ts` (#269, tested by `test-pos-sales-cleanup.flow`) ran from the build host's `~/lgr` at
`f89e22eb`, on the owner's go after the dry run.

**The window.** The dry run for March–April found 73 sales, and one more outside the window:
TXN-2026-0000074 of 2026-10-20 (4.97, non-fiscal), alone in its still-open session. The owner
called it a test too, so the window became 2026-03-01 … 2026-10-20, which holds every regal POS row.

**What the run did:**
- **Sales:** removed 74, all on the Tremol test device TRM20001 — 47 fiscal and 27 non-fiscal, 817.99 in total.
- **Dispatches:** reversed and removed 34. The other 40 sales never moved stock (the March–April
  SM-counter bug).
- **Stock:** 49 units came back across 12 product/warehouse levels. Nine of those levels were
  negative, because the tests sold stock that was not there, and they are exactly 0 now.
- **Sessions:** removed 48, one of them the open POS-2026-000051. There were no POS-OUT batches and no
  journal entries.
- **AuditLog:** 156 `cleanup` entries were added, and nothing was deleted.
- **Backup:** `mars:~/fr21-test-sales-regal-20261026T155134Z.ndjson`, 169 lines.
- **Verified:** no regal POS row is left. Every restored level equals its value before plus what came
  back. The journal lists regal's 8 cash sales. regal-pz and regal-sf are unchanged.

### R2 (FR-21.15 – FR-21.24)
Merged on 2026-10-26, and not deployed (§1). FR-21.19 needed no code: the session JE already reads the session's rows
through the union, and every till document carries its session. R1's readers already union both
stores and know `cash_storno`. All of R2 is on master and ships in one deploy, together with #278's
fixes. (Deployed alone, R2b would have read a copied `TXN-` number as gaps in CS: the digest gives
that series its own line only from R2c, §3.23.)

**Before the R2 deploy:**
1. **CI and the merge** — done 2026-10-26. Each PR went green (one guard test had failed and was
   fixed in `6c9bb779`), and they merged in order.
2. **E2E** — passed on the stack, 2026-10-26, against an isolated database (§7). Covered:
   `cash-register`, `cash-sales`, `cash-sale-invoice`, `pos-terminal`, `pos-transactions` and FR-22's
   walks. `cash-register.spec` gained §8.3 item 7: the cash-register report and both exports (the list
   and the per-product pivot) carry a till sale.
   **Written later:** §8.3 items 1, 4 and 9 (#337, 2026-10-28). They needed a fiscal device in
   Playwright, and `fiscal/tcp-target.ts` (the SSRF guard) refuses a loopback TCP device.
   - The seam is the `loopback-test` policy: `FISCAL_TCP_ALLOW_LOOPBACK=1`, ignored when
     `NODE_ENV=production`.
   - The device is `e2e/scripts/eltrade-tcp-stub.ts`.
   - The spec is `cash-register-fiscal.spec`, in its own project (§7).

   **Not written:** `cash-register-migration.spec.ts`. `cash-register-migration.flow` covers 0008 and
   the restore.
3. **The rehearsal on mars** (§8.4) — done 2026-10-26, on a mongodump of prod in a throwaway
   `mongod` (the same data as the nightly bundles, and newer).
   - **Preflight:** clean, with 0 POS rows in any org, so 0008 only labels `register.origin`.
   - **Migrate:** the first run took 201 ms, and the second was a no-op.
   - **Field checks:** identical with R1 before, with R2 after, and with R1 after (the rollback).
   - **Results:** posted on #273.
   An older bundle that still holds POS rows is converted by the restore, which
   `cash-register-migration.flow` covers.
4. **The device test** on prod, in `acme-corp` (§8.4), after the deploy: the non-fiscalized Eltrade A3
   over Web Serial, text mode — open a session, sell, storno, close; both journals agree.
5. **The deploy** itself, then `bun run migrate` on the build host (`MIGRATIONS_AUTO` is off), then
   the read-only field checks of §8.4. `scripts/cash-register-field-check.ts` (R2d) has the commands:
   - Take the baseline with the code still deployed, right before the deploy.
   - Run it again after `migrate`, over the same `FIELD_FROM`/`FIELD_TO`/`FIELD_DIGEST_DAY`.
   - Diff the two outputs. Only `code` and `origins` may change.
   - Keep the outputs on the build host.

   To rehearse again, for example R3's freeze migration, run `scripts/cash-register-rehearsal.sh
   <branch>` on the build host. It does what step 3 did.

### R3 (FR-21.25 – FR-21.26)
#284, deployed 2026-10-27; `0009` applied, no POS rows were left to copy:
- **FR-21.25:** `0009-cash-register-freeze` runs `copy-org.ts` over every org with POS rows. It copies the rows written since 0008 (a rollback to R1 between the two), then re-runs parity over the whole history, and throws naming the orgs that disagree.
- **FR-21.26:** `POSTransaction` carries `db/plugins/frozen.plugin.ts`. Every write through the model throws `FrozenCollectionError` ("postransactions is frozen (FR-21)"): save, insertMany, every query write, document writes and bulkWrite. Raw `Model.collection.*` writes pass, as they pass the home guard. Those are the restore, the move and the mirror, already listed in `home-write-guard.flow.test.ts`.
- **What still wrote through the model:**
  - the deprecated `erp.service` POS functions and their unit test, which only wrote POS rows: removed in R3, a step of FR-21.27 brought forward;
  - the FR-21.14 cleanup script, whose delete is raw now, behind its home check;
  - the test factory and six test files, which insert legacy rows raw now.

**The deploy:** as R2's. Take the field check, deploy, `bun run migrate` (0009), and diff the field check. Prod has no POS rows, so 0009 finds nothing to copy and only proves parity. Rolling back to R2 is safe, because R2 never writes `POSTransaction`.

### R4 (FR-21.27 – FR-21.28)
#286, deployed 2026-10-27 after R3.
- **FR-21.27, no runtime reader asks `postransactions`:**
  - `pos-union.ts` (`loadPosRows`, `findPosRow`) and the journal (`journal.service.ts`) read the till's documents only;
  - the till's keyed lookup and `POST /invoices` find a key on the documents, where 0008/0009 carried it;
  - a storno finds its sale there too, so R2's on-the-spot `copyPosRow` is gone;
  - removed: `GET /trade/pos/transactions` and `/transactions/:txnId` (the journal replaces them), and the DAL's `posTransactions` repository and `IPOSTransaction*` entities;
  - still reading it, through the driver: migrations, the restore of an older bundle (`copy-org.ts`) and the read-only scripts.
- **FR-21.28, `cash-register/freeze-check.ts`:**
  - the till's routes, the journal and SUPTO 18.1–18.5 answer 503 `cash_register_not_migrated`, naming the migration, until `0009-cash-register-freeze` is recorded;
  - ⚠ **this departs from the spec on purpose:** an empty `postransactions` counts as ready too. The danger is a POS row no reader sees, and a new database or master has none;
  - it is checked at startup (logged), then every 15 s until ready, so `bun run migrate` lifts it without a restart.
- **Tests:**
  - a test that seeds legacy POS rows first runs `helpers/migrate-till.ts` (the copy and the 0009 record), as a migrated node has them;
  - `pos-transaction.flow` is deleted with the DAL repository it tested;
  - the e2e walks `p4-storno` and `p4-till`, and `tenant-isolation.spec`, read the journal or the session's list.
- **The deploy** is as R3's, with no migration of its own. On prod, 0009 is recorded by R3's deploy, so the routes answer at once. Rolling back to R3 is safe: R3 still reads both stores.

### R5 (FR-21.29 – FR-21.32)
Split in two.

**R5a, the server (#315, deployed 2026-10-27, `v20261027-81b088ce53ca`):**
- **The terminal rings into the user's own session** (owner, 2026-10-27).
  - `PosTerminalView.vue#fetchSessions` passes `cashierId`.
  - `POST /session/:id/transaction` answers 403 `session_not_yours` for another cashier's session. A keyed retry of a sale already made is answered first.
- **FR-21.31 (D-13): a back-office sale joins its author's open session.** `POST /invoices` writes it with `register.origin: 'pos'`, `joinedFrom: 'backoffice'`, the session, its warehouse and the cashier. Because it is a till document:
  - it counts in the drawer's totals and in the close JE (`loadPosRows`), and in SUPTO;
  - it is immutable, and is reversed by a storno through a till.

  Its lines keep their own warehouses (§6 edge 14). A sale sent with only a header method gets its payment row, so the drawer sees the cash. A keyed retry resumes it in its own session. An imported day never joins.
- **The receipt prints on the session's device only when the request asks** (`receipt: 'fiscal' | 'text'`). The back-office form sends nothing today, so nothing prints unexpectedly. R5b's terminal sends the till's choice. The context (the device, the operator code) is built before the document, so a refusal leaves nothing behind.
- **Revenue is posted once.** A back-office cash sale never posted a JE of its own (`invoice.posted` fires only from `/send`), so a joined sale's revenue is the session close's alone.
- **Tests:**
  - `cash-register-session-join.flow`: 7 tests;
  - `till-world`'s `backOfficeSale` now posts as a clerk with no session, so the existing back-office cases mean what they meant; `cashierBackOfficeSale` joins.

**R5b, the UI (#316, deployed 2026-10-27, `v20261027-61d64b243f9f`):**
- **FR-21.29: `ui-shared/components/cash-register/RegisterTerminal.vue`.** It is the catalog, the cart and the totals of both `/pos/terminal` and `/invoicing/cash-sales/new`.
  - **The catalog:** search, category, and type and tags on the till; cards and paging; the scanner's Enter lookup with its queue and stale-answer guard.
  - **The cart:** −, a typed quantity, +, the price, remove, and each line's gross.
  - **What each app keeps, through slots:**
    - the till: the session bar, the fiscal bridge, the last sale, the document-wide price, and the payment and Complete;
    - the form: its header, its customer-aware `PriceCombobox`, notes, tags, the receipt, and Save.
  - **Found on the way:** the till's category filter sent the category's id, and the catalog filters by name, so it matched nothing. The one component sends the name.
  - ⚠ **Found by the e2e run, not the unit tests:** Vue casts an absent `boolean` prop to `false`, not `undefined`. `active?: boolean` left the back-office form's catalog empty, since the form never passes it. `active` and `readonly` now have defaults (`withDefaults`). The specs find the terminal by `.register-catalog`, `register-card` and `cart-line-N`.
- **FR-21.30: one totals function.** A cash sale's form totals and payload come from `computePosTotals` (`document-payload.ts#computeTotals`), as the till's do.
  - The form rounded net and VAT first, which can be a cent away: a valve at 17.8952 net and 20 % was 21.48 there, against 21.47 at the till and on the device.
  - `POST /invoices` now checks a back-office cash sale with the till's function and tolerance (0.02, 422 `cash_sale_total_mismatch`) and stores the server's figures. An imported day keeps the totals of its file.
  - `RegisterTerminal` takes the totals as props, because ui-shared does not depend on `config`.
- **The receipt choice (FR-21.31's last piece).** The form shows „Бон на устройството на сесията" (none / fiscal / text) only when its user has an open session, and sends it as `receipt` (`useDocumentForm`'s new `extraPayload`).
- **FR-21.32 (SHOULD): already in force.** The spec (2026-10-21) found no route checking `pos.read`/`pos.write`. S-28 (`e2e09d5b`, 2026-10-23) then gave every write under `trade/pos` and `pos` the rule `need: ['pos.write']` (`route-permission.ts`), enforced by every auth plugin before the body is read. Nothing was left to switch on.
  - **The preflight**, read-only on production on 2026-10-27: everyone who opened a session or wrote a till document (or a POS row) in the last 90 days, with permissions computed as `tokenize` does (org-scoped sets, else the role and its extras). Nobody lacked `pos.write`. Its output stays on the build host (`~/fr21-r2/fr21-32-preflight.json`).
  - `cash-register-till-permission.flow` pins it: every write route of `posController` resolves to `pos.write`, and `nra_auditor`, `accountant`, `warehouse_manager` and `member` get 403 `permission_required` at open, sale, storno and close, with nothing written; `sales` works the till.
  - A back-office sale that joins a session (FR-21.31) goes through `POST /invoices` and needs `invoicing.write`, not `pos.write`. Opening that session needed `pos.write`.

⚠ **Check on hardware:** the fiscal print of a back-office line with a **discount**. Till lines and form lines carry `discount` alike, but only the till's has been printed on a device.

## 6. Where things are

| What | Where |
|---|---|
| The counting rule | `services/src/biz/cash-register/counting.ts` (R1a) |
| The schema | `db/src/models/invoice.model.ts`: `register`, `cash_storno`, `payments[].tendered`, three indexes |
| The two-store reader | `services/src/biz/cash-register/pos-union.ts`: `loadPosRows`, `findPosRow` |
| POS row ⇄ document | `services/src/biz/cash-register/mapping.ts` |
| The D-8 guard | `services/src/biz/cash-register/immutability.ts` |
| The journal API | `services/src/biz/cash-register/journal.service.ts`, `invoicing-api/src/controllers/cash-register.controller.ts` |
| The journal UI | `ui-shared/src/components/cash-register/` (`CashRegisterJournal`, `CashRegisterDocument`, `StornoDialog`), `ui-shared/src/cash-register/storno.ts` |
| Its mounts | `pos-ui/src/views/PosTransactions*View.vue`, `invoicing-ui/src/views/CashSalesView.vue`, `CashSaleJournalDocumentView.vue` |
| Integration tests | `tests/src/integration/cash-register-{readers,immutability,journal}.flow.test.ts`, plus R1a's `pos-session-journal`, `pos-out-record-only`, `cash-sale-line-totals.migration`, `supto-period` |
| Unit tests | `tests/src/unit/cash-register-{counting,mapping}.test.ts`, `local-day.test.ts`, `grid-columns-default-hidden.test.ts` |
| E2E | `e2e/tests/cash-register.spec.ts`, `pos-transactions.spec.ts`, `cash-sales.spec.ts`, `helpers/cash-register.ts` |
| The write path (R2) | `services/src/biz/cash-register/register.service.ts` (the steps, the storno), `printer.ts` (the device port), `copy.ts` (one row on the spot) |
| The till's side (R2) | `invoicing-api/src/lib/cash-register-till.ts` (the device, the till's answers, the storno door) |
| The copy (R2) | `services/src/biz/cash-register/copy-org.ts`, `migrations/src/migrations/0008-cash-register-copy.ts`, `scripts/cash-register-preflight.ts` |
| The field check and the rehearsal | `scripts/cash-register-field-check.ts` (R2d), `scripts/cash-register-rehearsal.sh` (#275) |
| R2's tests | `tests/src/integration/cash-register-{sale,storno,idempotency,migration}.flow.test.ts`, `helpers/till-world.ts`, `helpers/till-row.ts` |

## 7. Running the tests

**Integration:** from `packages/tests`, run
`bun test <files> --env-file=../../.env.test --timeout 120000`. The default 5 s hook timeout is
too short for mongodb-memory-server on Windows.

**E2E against an isolated database** is how the specs above were run. It does not touch the
shared dev Mongo on 27018, and its seed wipes nothing that matters:

```bash
docker run -d --name lgr-e2e-mongo -p 27121:27017 mongo:7 mongod --replSet rs0 --bind_ip_all
docker exec lgr-e2e-mongo mongosh --quiet --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})"
# e2e.env = .env.test with NODE_ENV=development, HOST=127.0.0.1, a free PORT (4987 here) and
#   MONGODB_URI=mongodb://localhost:27121/lgr?replicaSet=rs0&directConnection=true
bun --env-file=e2e.env run packages/tests/src/helpers/seed.ts
bun run build
(cd packages/portal-api && bun --env-file=../../e2e.env src/unified.ts) &
cd packages/e2e && BASE_URL=http://127.0.0.1:4987 bunx playwright test \
  tests/cash-register.spec.ts tests/pos-transactions.spec.ts tests/cash-sales.spec.ts \
  tests/cash-sale-invoice.spec.ts tests/pos-terminal.spec.ts --project=invoicing-inventory --workers=1
```

With `BASE_URL` set, Playwright starts no server of its own.

**The till on a fiscal device** (#337) runs in its own project, with the simulated Eltrade and the
server allowed to reach it on loopback:

```bash
bun packages/e2e/scripts/eltrade-tcp-stub.ts &          # TCP 8299, its state on http://127.0.0.1:8300
(cd packages/portal-api && FISCAL_TCP_ALLOW_LOOPBACK=1 bun --env-file=../../e2e.env src/unified.ts) &
cd packages/e2e && BASE_URL=http://127.0.0.1:4987 bunx playwright test --project=cash-register-fiscal
```

- The spec makes its own cashier and manager: the seed's users have no operator code, which a fiscal
  receipt needs.
- It programs the device's VAT groups with the seed's rate (18 %): the driver refuses a line whose
  rate no group carries, as a real Eltrade does.
- It deactivates the device after itself, so no other spec prints on it.

Two fallbacks, both used on 2026-10-26:
- **Docker is down.** Use an in-memory replica set instead: from `packages/tests`, run
  `bun -e "import { MongoMemoryReplSet } from 'mongodb-memory-server'; const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, name: 'rs0' }, instanceOpts: [{ port: 27131 }] }); console.log(rs.getUri()); setInterval(() => {}, 1 << 30)"` in the background, and put `mongodb://127.0.0.1:27131/lgr?replicaSet=rs0` in the env file.
- **Playwright's browser build is missing.** A temporary config that spreads `playwright.config.ts` and sets `use.channel: 'chrome'` on every project runs on the installed Chrome. Pass it with `-c`, and delete it afterwards.

⚠ **Check that the port is free first** (`netstat -ano | grep ":4987 "`). On Windows, a server another session binds to `127.0.0.1` on the same port shadows yours for `localhost`. Your tests then run against its server and its database: a route you just added answers 404.
