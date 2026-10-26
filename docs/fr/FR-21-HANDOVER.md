# FR-21 — handover (2026-10-25)

**To:** Atanas (@lazarovski) · **Tracking:** #171 · **Spec:** [FR-21](FR-21-cash-register-pos-and-cash-sales.md)

R1, the read side, is merged and on production since 2026-10-26: master `ddfd167f`, image
`v20261026-ee6cc3b78103`. Its two migrations ran there, and the field checks match the baseline taken
before the release. FR-21.14 ran on the owner's go the same day. This
is what is done, what is left, and what turned up on the way that the spec does not say.

## 1. State

| Step | Requirements | State |
|---|---|---|
| **R1a** — the fixes the merge depends on | FR-21.1 – FR-21.6 (B-1 – B-5, B-7) | #244, merged and deployed 2026-10-26 |
| **R1b** — every reader counts a till sale once, whichever store holds it | FR-21.7 – FR-21.12 | #247, merged and deployed 2026-10-26 |
| **R1c** — one journal page in both apps | FR-21.13 (B-6) | #248, merged and deployed 2026-10-26 |
| Before R2 — the `regal` test sales | FR-21.14 | **Done 2026-10-26** (#269, owner's go): 74 test sales removed, see §5. |
| R2 — the write side and the copy | FR-21.15 – FR-21.24 | not started |
| R3 — freeze | FR-21.25 – FR-21.26 | not started |
| R4 — contract | FR-21.27 – FR-21.28 | not started |
| R5 — one terminal | FR-21.29 – FR-21.32 | not started |

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
   release: same 30-day window, same digest day.

   | Org | Journal rows = POS + cash sales | SUPTO 18.1, 30 days | 18.2–18.5 | Digest 10-23 cash = journal cash |
   |---|---|---|---|---|
   | regal | 82 = 74 + 8 | unchanged | unchanged | 0 = 0 |
   | regal-pz | 66 = 0 + 66 | unchanged (20, 4563.13) | unchanged | 287.34 = 287.34 |
   | regal-sf | 21 = 0 + 21 | unchanged (21, 16303.18) | unchanged | 7447.04 = 7447.04 |

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
| `0005-cash-register-copy` (R2) | the next free id when it lands (`0008` today) |
| `0006-cash-register-freeze` (R3) | the next one after it |

FR-21.28's startup check has to name the freeze migration's real id.

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

## 4. Found on the way

1. **The POS terminal shows ANY open session in the org.** `PosTerminalView.vue#fetchSessions`
   loads the org's last ten sessions, and `activeSession` is the first open one. So cashier B's
   terminal rings into cashier A's session, although the server lets each cashier open their own.
   - R5's D-13 ("the user's open session") builds on whichever of the two is meant. Decide it
     before R5.
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
9. **FR-20 P3-1b (#242) journals every write of a class-R model on a master node.** Invoice is
   class R. R2's copy writes Invoice documents in bulk, and a master's mirror misses any of them
   that bypass the capture. So check that the copy goes through the capture, or that its raw
   writes are listed in `home-write-guard.flow.test.ts`.
10. **The licence gate and `cash_storno`.** `licence-gate.ts`'s `NEW_SALES_DOCUMENT_TYPES` is
    invoice, proforma and cash_sale. In R2, decide whether a `cash_storno`, or the till's document
    writes, needs that check.

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
- **What to build:**
  - the service of D-4, with its three doors;
  - `CASH_SALE` numbering, with TXN as a closed legacy row;
  - the storno of D-2;
  - the close JE over documents;
  - stock through `createInvoiceStockMovement` with `invoiceId`;
  - the copy migration with its parity check;
  - restore converting older bundles;
  - `docs/supto`;
  - `pendingTransferIds` (FR-21.24).
- **What is ready for it:**
  - `cash-register/mapping.ts`. `fromPosTransaction` is the copy's row builder, and
    `toPosTransaction` builds the till's response from a document. Their round trip is
    unit-tested (`unit/cash-register-mapping.test.ts`).
  - `answerFromDocument` in `pos.controller.ts`, which already replays a keyed till request from a
    document.
  - The R1 readers, which already read both stores and know `cash_storno` and `register`.
- **The e2e fiscal device** for items 1, 4 and 9 of §8.3 is still to write:
  `scripts/eltrade-tcp-stub.ts`.

### R3 – R5
As the spec has them, after the points in §4 are settled.

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

Two fallbacks, both used on 2026-10-26:
- **Docker is down.** Use an in-memory replica set instead: from `packages/tests`, run
  `bun -e "import { MongoMemoryReplSet } from 'mongodb-memory-server'; const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, name: 'rs0' }, instanceOpts: [{ port: 27131 }] }); console.log(rs.getUri()); setInterval(() => {}, 1 << 30)"` in the background, and put `mongodb://127.0.0.1:27131/lgr?replicaSet=rs0` in the env file.
- **Playwright's browser build is missing.** A temporary config that spreads `playwright.config.ts` and sets `use.channel: 'chrome'` on every project runs on the installed Chrome. Pass it with `-c`, and delete it afterwards.

⚠ **Check that the port is free first** (`netstat -ano | grep ":4987 "`). On Windows, a server another session binds to `127.0.0.1` on the same port shadows yours for `localhost`. Your tests then run against its server and its database: a route you just added answers 404.
