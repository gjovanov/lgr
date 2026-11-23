---
paths:
  - "packages/files-api/**"
  - "packages/files-ui/**"
  - "packages/ocr-server/**"
  - "packages/services/src/biz/files/**"
  - "packages/services/src/biz/doc-import/**"
  - "packages/services/src/biz/backup/**"
  - "packages/services/src/biz/*storage*"
  - "packages/services/src/biz/file*"
  - "packages/portal-api/src/controllers/file*"
  - "packages/portal-api/src/controllers/backup*"
  - "packages/portal-api/src/controllers/integrations*"
  - "scripts/backup*"
  - "scripts/configure-backup.ts"
---

# Rules and traps: Files, document import, storage and backups

Every ⚠ and every never/always rule of this area's history, copied whole with the bullet it sits in, by section.
Why each one exists, and what was built around it: [`docs/history/files.md`](../../docs/history/files.md).
`unit/claude-md.test.ts` fails when a ⚠ of that history is in neither this file nor `CLAUDE.md`.

## Stored file paths (FR-20.24, plan step P0b-8)

- **Every reader goes through `resolveStored(stored, orgId)`** (release N, #177), which takes either form,
  maps a legacy absolute path from a known root (this server's, `/app/uploads`, `UPLOAD_LEGACY_ROOTS`) onto
  this root, refuses `..`, drive letters and another org's tree, and returns the absolute path. ⚠
  `unit/stored-path.test.ts` fails on any file operation applied to a stored path directly.

- ⚠ **0003 reads the files**: run `bun run migrate` where the uploads volume is mounted (it refuses where the
  upload root is missing). It repoints a `File` row the inbox move left behind to its document, and LISTS rows
  with no bytes and no document, never deletes them.

- ⚠ **Once 0003 has run, roll back only to a release that has #177's readers.**

## Document Import (2026-08-21)

⚠ **`store_operations` is the one docType that does not determine its own target** (2026-10-02).
„Складови операции" is a GENERIC report and its `Операция:` filter decides the meaning — and both
variants are live: `Доставки` (Тип на док. СТ) is a delivery, stock IN, a movement; **`Продажби`
(СР) is a day of till takings, stock OUT, a CASH SALE** — the same business document as a
`salesAnalysis` export in a different layout (`Име/Мярка/Количество/Цена/Стойност` vs
`Артикул/Количество/Стойност`). regal-pz sent three `Доставки` files in July; regal-sf exports its
register this way daily. So `targetForDocType` is refined by `targetForItem(declared, item)` AFTER
the sheet is parsed (`StoreOperationsResult.books`), the analyzed target is persisted and preferred
over the docType on read-back, and `typeOrder` sorts the export with the receipts or the sales
documents accordingly. `mapCashSaleExport` serves **both** layouts (its parameter asks for
`{rows}`, not a whole result) and the reference stays **`salesAnalysis:<date>`** whichever file
produced it — the key names the DAY, so a day arriving in both formats collides instead of double
booking, and the guard on every already-booked cash sale keeps working. An operation that is
neither is refused, not guessed: read as receipts a sales day invents stock, read as sales a
delivery dispatches stock that just arrived.

⚠ **Over the API, PlusMinus records which invoices moved no stock** (2026-11-02,
`map-plusminus-invoice.ts#plusminusStockSource`). A line on its `БЕЗСКЛАД` store moved nothing; its
`fromDocument` names what did: `pos:<day>-<n>` (comment `КБ <dd.mm.yyyy>/<UNP>`) is a till receipt,
and `СР:<n>` is a till ticket at regal-sf but a складова разписка at regal-pz. The importer issues
such an invoice with no dispatch and attaches a till sale's to its till day. The containment test
below is for what a PDF leaves us, and over the API it only warns.

⚠ **A till sale can ALSO be invoiced, and then the invoice must not dispatch** (2026-10-02). A
counter shop rings the sale on the till and prints a фактура when asked, so the day's till export
already carries it — booking the invoice's dispatch too takes the same goods out twice. regal-sf's
first day had 3 of 46 invoices like this (17 lines, two products driven negative); regal-pz had
0 of 44. **PlusMinus is the arbiter, not the documents**: `snapshot − LGR == invoice quantity` on
every affected line means it deducted once, so the till is the stock-mover. Repair = reverse via
`reverseInvoiceStockMovement` (restores the WAC layers, unlike a hand-rolled compensating entry)
then set `stockSource.marker`, which is what `movesNoStock` reads to stop a re-dispatch. Since
2026-10-28 that repair is a button: „Към касова продажба…" on the invoice attaches it to the day's
cash sale (FR-21 §11, see "Invoice for a cash sale").
`doc-import/till-overlap.ts` detects the containment at analyze time and **only warns** — the
message carries "VERIFY before committing", which is the `BLOCKING` pattern the Files review uses.
It must never suppress: containment is not proof (the till may simply have sold as much of every
article independently), the only reliable arbiter arrives with the next snapshot, and the errors
are asymmetric — a missed overlap shows up in tomorrow's reconciliation, a false hit silently
leaves stock in LGR that is no longer on the shelf and nothing catches it. It runs as a second pass
over the batch, because a day is uploaded whole and the till export's own mapping does not exist
until every document in the batch has been analyzed.
**Costing rule:** existing product → `unitCost = current avgCost` (confirm-time WAC recompute
is a no-op); new product → разписка `Цена` opens its avgCost.
**Pricing rule (2026-08-29, corrected 2026-08-31):** a разписка's `Цена` is the DELIVERY price and
`Прод. цена` is what we sell for. `Прод. цена` → `sellingPrice`, and a line without one leaves it
alone: filling it from `Цена` sets the price to what we paid (`scripts/receive-new-products.ts` still
did until 2026-11-02);
`Цена N` → the tier named `Цена N`, and only the N the document carries. `purchasePrice` and the
cost tiers (`Доставна цена`, `Цена на едро`, `Цена 0` — `PROTECTED_TIERS`) are **never written**
by an import; the cost tiers belong to the storeAvailability re-baseline, and `purchasePrice` to no
import at all (2026-11-15: it is „Цена 2" / 1.2, see Tag-Based Pricing). A NEW product is the
exception — nothing to protect: `Цена` opens its „Доставна цена" slot and its avgCost, and its
`purchasePrice` is „Цена 2" / 1.2 when the document carries a „Цена 2", `Цена` only when it does
not (`purchasePriceForNewProduct`). Two traps this closed:
the staged `priceTiers` array REPLACED the product's on commit and was built from a blank slate
(wiping every slot the document didn't carry — it now merges by name from the product's current
tiers), and `persistMovement` strips `purchasePrice` from any staged payload so a pre-rule
analysis can't reintroduce the old write.
**Idempotency** lives in `notes` (`stokrazp:` / `corr:` / `sklrazp:` / `sklisk:` /
`storeOperations:`) — the markers `check-doc-sequences` verifies. `StockMovement.reference`
carries the same document as a real field (`sklrazp_0000615698`), shown in the product ledger
after Invoice and searchable in the movements list; backfill via
`scripts/backfill-movement-reference.ts` (marker → DocFile → `INV-<10 digits>`, 772/813 on
regal-pz; the rest are genuinely document-less). Unmatched lines can't be booked, so the review step offers
inline product creation (SKU sequence continued, `buildTiers`/`repriceTiers` with tier-name
tags; new products land in „Общи" → re-run `assign-din-tags`).

**OCR sidecar** — `POST /draft` gained `profile` (`invoice` | `goods_receipt` | `stock_note`),
auto-detected from the header when omitted and echoed back in the response. Two new skills:
`draft-goods-receipt` (Кол / Цена / Цена 1..N columns + the КОРЕКЦИЯ signed variant) and
`draft-stock-note`. `validateExtraction(ext, profile)` is kind-aware — stock notes get
number/date/quantity checks instead of the VAT/totals ones. ⚠ The sidecar image must be
rebuilt for the new skills: `./scripts/deploy-prod.sh --ocr`.

⚠ **An imported line's `lineTotal` is GROSS** (2026-11-23, #598): `map-invoice.ts` stores the paper's net
line value plus its VAT, as every document LGR makes stores it; the net is `lineTotal − taxAmount`.
Migration `0023` converted the lines imported net before. The story is `docs/history/invoicing.md`.

**Prefixes are never hardcoded.** `services/biz/sequence-registry.ts` is the single table
behind `/invoicing/configuration/sequences` AND every allocation path
(`invoice-numbering.service`, order / internal-order / reservation / companion numbering).
`resolveDocPrefix(orgId, type, direction, variant)` returns the org's configured prefix;
`dedupe.ts` builds its "already imported?" patterns from it rather than from a literal `INV`.

⚠ **E2E gotchas** (both cost real time to find):
1. Playwright spawns its workers with `process.execPath`. Under `bunx` on a machine with no
   **Node** on PATH, every worker dies with `code=143` before the browser launches — for
   every spec in the package, not just the new one. Install Node, or run E2E on CI/mars.
2. A **spec** file cannot `import type` from `@playwright/test` under this setup (the build
   fails with an opaque `BuildMessage {}`); a **helper** module can. That is why no spec in
   this repo type-imports, and why the doc-import helpers live in `tests/helpers/doc-import.ts`.
3. **Vuetify `v-switch` has role `checkbox`, not `switch`** — it renders a plain
   `<input type="checkbox">` carrying an `aria-label`. `getByRole('switch')` matches nothing;
   use `getByLabel(/…/i)`. Same family as the v-select/combobox gotcha above.
4. **Ad-hoc Playwright scripts must run under `node`, not `bun`** — `chromium.launch()` under
   Bun hangs until the 180s launch timeout. The `bunx playwright test` runner is fine (it
   spawns its workers with `process.execPath` → Node); only direct driver use in a Bun script
   breaks.
5. The default `workers: 4` can overwhelm a dev laptop: a whole spec file failed with blank
   pages that all passed at `--workers=1`. Re-run serially before believing a mass failure.
6. **A v-select cannot be opened by clicking the combobox you found it with.**
   `getByRole('combobox', {name}).click()` resolves the real `<input>`, which is painted under
   its own `.v-field__input` wrapper — the click times out with "intercepts pointer events",
   naming the interceptor rather than the cause, so it reads like a flake. Find by role, click
   the wrapper: `tests/helpers/vuetify.ts#openSelect`. Its options live in a detached overlay
   at the end of `<body>` (never inside the card you scoped to) and a `multiple` select stays
   open after a choice — `chooseOption` handles both. And assert a select's value with
   `toHaveValue`, never `toHaveText`: an `<input>`'s text content is always `""`, so a
   `toHaveText` assertion passes against every value.
7. **`locator.isVisible({ timeout })` does not wait.** Playwright ignores the option and answers
   at once, so a guard on it skips its test, or drops its step, whenever the page is still
   rendering, and the run stays green. Use `tests/helpers/vuetify.ts#appears`. A green run says
   what it skipped and what only passed on a retry in its job summary
   (`e2e/scripts/night-summary.ts`): read it. #408 tracks the 94 conditional sites left.
8. **"Passed on its second try" is not "flaky" until it is counted.** A retry starts a fresh
   worker, which is slower, so a test that one runner loses every time still passes there. On
   2026-11-13 the night's one retried test failed 20 of 20 on the faster runner and passed 20 of
   20 on the other, at the same commit (`--repeat-each=20 --retries=0` on a runner of each host).
   A scheduled night with a retried test therefore opens the issue "Nightly e2e needed a retry"
   and names the test, and a red night's issue names its tests too (`e2e-nightly.yml`'s `report`
   job, fed by `e2e/scripts/night-findings.ts`).

## Google Drive: one owned root folder (2026-09-09; split 2026-09-15)

⚠ The SECTION sits above the org. Backups and archives rotate on completely
different rules — 14 kept generations against a ten-year legal retention (ЗСч
чл. 12; payroll fifty) — and the split is what stops a prune, or a human tidying
the Drive, treating a fiscal year's only cold copy as an old backup.

The scope is `drive.file`: per-file access to what this app created. It cannot
read anything else in the account, and files a human drops into `LGR/` are
invisible to it. ⚠ That also means the document-import side of
`CloudStorageAdapter` can only ever list what the backup job itself uploaded.

The consent script takes the OAuth client from `.secrets/google-oauth-client.json`
(gitignored) unless `BACKUP_GOOGLE_DRIVE_CLIENT_ID`/`_SECRET` are already set, and
`--append-env` writes that pair next to the refresh token. ⚠ A refresh token is
bound to the client that issued it: sealing the token without its client leaves the
app refreshing with `GOOGLE_CLIENT_ID` and failing `invalid_client` on the first
nightly run. Requires the Drive API enabled on the client's project.

## Object storage: the tier Drive cannot be (2026-09-15, FR-13.58)

- `BACKUP_S3_OBJECT_LOCK_MODE=COMPLIANCE|GOVERNANCE` sends the retention headers.
  ⚠ Object Lock must be enabled **when the bucket is created**; most providers
  cannot add it afterwards, and COMPLIANCE retention cannot be shortened by anyone.

- Archives are never pruned from this tier, whatever `keep` says, and retention is
  skipped entirely under a lock (the delete would be refused anyway).

## The backup screen: the org's admin backs up, an operator restores (2026-11-15)

- ⚠ Anyone can found an org and be its admin, so an org admin's create is bounded where an
  operator's is not: the `data` variant only (`full` answers 403), `offsite: false` and
  `mail: false` on the run, one at a time (409 `backup_running`) and `BACKUP_MANUAL_PER_DAY` (3)
  per org in 24 hours (429 `backup_daily_limit`). The count is over `claimKey` starting
  `manual-`, so a master's `pre-update-…` bundles and the nights are not in it.

- ⚠ **Why not off-site:** every destination counts its generations in ONE folder, so each press
  would push a night out of Drive. The row's empty `destinations` is what the screen shows as
  "no off-site copy".

- `pruneBundles` keeps the bundles a person asked for in a class of their own
  (`BACKUP_KEEP_MANUAL_PER_ORG`, 5). ⚠ `isManualBundle` reads the END of the filename
  (`…-<date>-manual-<variant>-<HHMMSS>.ndjson.zst`): the slug comes first and is the org's own
  text, so looking for `-manual-` anywhere would misfile an org named `acme-manual-co`.
