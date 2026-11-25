# FR-30 — Speed at shop volume: lists, searches, reports, heavy screens, PDFs and the first load

| | |
|---|---|
| **Status** | Specified 2026-11-16. Slices A (FR-30.1 to .4), B (FR-30.6 to .10), C (FR-30.11 to .13), D (FR-30.14 to .16), E (FR-30.17), F (FR-30.19, .20) and G (FR-30.21 to .27) built, §11. Slice E was built by [FR-33](FR-33-stock-count-product-search.md) slice A: #848 had merged into a branch whose own pull request had already merged, and never reached master. The defaults in §9 stand unless the owner answers otherwise on the issue. |
| **Builds on** | FR-05 and FR-22 (`ListScaffold`, `usePaginatedTable`, grid state in the URL, the click-budget walks), FR-28 (the product search, its explain test and request-count test), FR-06 (the reports registry), FR-24 (one SPA, `scripts/check-web-bundle.ts`), the lowered search mirrors (`db/src/plugins/lowered-fields.plugin.ts`) |
| **Touches** | `db` (indexes on `Product`, `Invoice`, `StockLevel`, `StockMovement`; the lowered-fields plugin), `packages/migrations` (dropping indexes), `dal-mongo` and `services` (pagination, search, the stock-levels report, the contact ledger, dashboards), `invoicing-api` and `warehouse-api` (list endpoints), `reporting` (PDF), `ui-shared` (the list engine, the icon set, locales), `invoicing-ui` and `inventory-ui` (document open, the count form), `portal-api` (static files, two small endpoints), `packages/server` (the on-prem master's static files) |
| **Tracking** | [gjovanov/lgr#795](https://github.com/gjovanov/lgr/issues/795) |
| **Code anchors** | origin/master `cb7d18c5` (2026-11-16), re-read at `cb039b1a`. Anchors, not gospel. |
| **Batch** | One of the four FRs of the 2026-11-16 audit: [FR-29](FR-29-atomic-bookings-records-runtime.md) reliability, FR-30 (this one), [FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md) forms and lists, [FR-32](FR-32-code-health.md) code health. [`README.md`](README.md) maps every finding to its FR. |

## 0. The request (owner, 2026-11-16)

> identify what are the technical debts, code smells, performance bottle-necks and suboptimal UX aspects of the app and propose a solution to each of them

and, after reading the findings: create the FRs, grouped as much as makes sense.

**How it was measured.** `cb7d18c5` ran on a throwaway local copy: an in-memory replica set, one API process, a real browser at 1366x768, and the seeded demo organization filled to about one shop-year: 23 050 products with ten price tiers each, 46 120 stock levels, 620 contacts, 10 020 invoices of 12 lines (8 017 outgoing), 5 000 movements of 10 lines. The database profiler was on, so the plans below are the database's own. The first load was measured on production's public sign-in page, anonymously. Timings come from a developer laptop: read them as ratios, and re-measure in each slice's first PR.

**This FR** holds the thirteen findings about speed. Each keeps the id it had in the audit.

| Finding | In short | Today | Fix measured? | Requirements | Slice |
|---|---|---|---|---|---|
| P1 | Lists read the organization's whole collection to show ten rows | §1.1 | yes | FR-30.1, .2 | A |
| P9 | The contact ledger and the contact picker read every invoice | §1.1, §1.4 | the ledger: yes | FR-30.3, .15 | A, D |
| P11 | Seven text indexes are kept up on every write and nothing reads them | §1.1 | no | FR-30.4, .5 | A |
| P2 | A list asks for its rows twice when it opens | §1.2 | no | FR-30.6 | B |
| P3 | Lists return whole documents, and "All" has no limit | §1.2 | no | FR-30.7 to .9 | B |
| P4 | A saved document opens with two requests per line | §1.2 | no | FR-30.10 | B |
| P5 | A product search reads the whole catalogue, twice | §1.3 | yes | FR-30.11 to .13 | C |
| P6 | The stock-levels report joins every row before it limits | §1.4 | yes | FR-30.14 | D |
| P14 | Two dashboards re-read whole collections on every open | §1.4 | no | FR-30.16 | D |
| P7 | The stock count form renders every stock level as an input row | §1.5 | no | FR-30.17, .18 | E |
| P8 | Every PDF starts its own browser | §1.6 | no | FR-30.19, .20 | F |
| P10 | The first load carries more than it uses | §1.7 | no | FR-30.21 to .26 | G |
| U12 | "Not there" is answered 404, which the browser logs as an error | §1.7 | no | FR-30.27 | G |

**The budgets**, on the fixture above:

| What | Today | Target | Requirement |
|---|---|---|---|
| Products list, first page | 203 ms; 23 050 documents read for 10 rows | no in-memory sort; at most 50 documents read | FR-30.1 |
| Sales invoices list, first page | 194 ms; 8 017 read | the same | FR-30.1 |
| Stock levels list, first page | 68 ms; 46 120 read | the same | FR-30.1 |
| Movements list, first page | 5 000 read | the same | FR-30.1 |
| Opening a list | two identical requests on 12 of the 14 lists opened | one | FR-30.6 |
| 100 invoice rows | 528 KB | at most 120 KB | FR-30.7 |
| "All" on Products | 81.6 MB; the tab did not answer for the 200 s it was watched | never more than 1 000 rows | FR-30.8 |
| Opening a 30-line document | 70 requests | the same number as for 3 lines, and at most 15 | FR-30.10 |
| A product search | 65 to 390 ms; the catalogue read for the page and again for the count | at most 50 ms; no document read for a search without a match | FR-30.11 |
| Stock-levels report, no filter | 3.9 to 4.1 s; 138 154 documents read | at most 500 ms | FR-30.14 |
| Contact ledger, one contact | 171 ms; 8 017 invoices read | at most 20 ms | FR-30.3 |
| Stock count form, 23 040 levels | rows after 190 s; 438 104 DOM nodes; 7.3 s per keystroke | first rows within 3 s; at most 10 000 nodes; 100 ms per keystroke | FR-30.17 |
| An invoice PDF | 0.8 to 0.9 s, about 6 s for the first; a browser launch each time | no launch after the first | FR-30.19 |
| Sign-in page, first visit | 843 KB over the wire, 395 KB of it icons | at most 500 KB; icons at most 40 KB | FR-30.21, .25 |
| Console of the sign-in page | one failed request on every visit | clean | FR-30.27 |

## 1. What is wrong today

### 1.1 No index carries a default sort (P1, P9, P11)

- The list endpoints sort by `createdAt`, `name` or `date`. None of `Product`, `Invoice`, `StockLevel` or `StockMovement` has an index that starts with the organization and continues with that field. The profiler shows the same plan on all four: an index scan on the organization, every document fetched, an in-memory sort, ten rows returned.
- Measured with the index in place: products 203 ms to 2 ms (10 documents read), invoices 194 to 2 ms, stock levels 68 to 1 ms.
- `sortBy` accepts any field name on several lists, so a user can choose a sort no index serves. The movements list already has a whitelist (`MOVEMENT_SORT_FIELDS`).
- **The contact ledger** runs a `distinct` filtered on `cashSaleRef.contactId`, which reads all 8 017 outgoing invoices: 171 ms. With a partial index on `{ orgId, 'cashSaleRef.contactId' }`: 1 ms.
- **Text indexes.** `Account`, `Contact`, `Employee`, `Invoice`, `ProductCategory`, `Product` and `StockMovement` each declare one. The only `$text` query in the repository is in a DAO that only tests import. Every write maintains them. On the fixture an invoice carries 22 indexes (13.6 MB on 57 MB of data) and a product 14 (15.3 MB on 41 MB).
- Deep pages stay linear after the fix (page 700 of invoices: 504 ms to 342 ms). They are rare and not in this FR.

### 1.2 Requests and payloads (P2, P3, P4)

- **Twice per open (P2).** `usePaginatedTable` fetches on the table's `update:options`, which Vuetify emits when the table mounts. The views also fetch in `onMounted`. Of the 36 screens on the composable, 28 do both (counted at `cb039b1a`). Twelve of the fourteen lists opened in the walk sent the same request twice, on a full load and on a move between lists.
- **Whole documents (P3).** `findAll` and `findMany` (`dal-mongo/src/base.repository.ts`) take no projection. The invoice list spreads each stored invoice into its row. Lines are 5.0 of the 5.8 KB an invoice averages, so 100 rows are 528 KB where about 80 KB would do. The list's search by contact name loads whole contacts. The contact pickers receive whole contacts.
- **"All" (P3).** `size <= 0` means up to 100 000 documents in the repository, and no limit at all in `services/src/utils/pagination.ts`. Measured: Products 81.6 MB in 2.5 s, invoices 45.5 MB in 2.8 s. In the browser the Products tab did not answer for the 200 s it was watched, and the choice stays in the address (`?size=-1`) and in the list's remembered state, so it comes back.
- **Per line (P4).** Opening a saved 30-line draft makes 70 API requests: 30 reads of a whole product to show its name (`ProductLineDescription.vue`), 31 reads of price options (`PriceCombobox.vue`), the document itself twice, and 7 calls of the shell. A loaded line keeps its stored price, so its price options are not needed until someone opens them.

### 1.3 Product search (P5)

- `buildSearchFilter` (`services/src/biz/search.utils.ts`) builds, per keyword, an unanchored pattern over five lowered fields. No index helps, so every search reads all 23 050 products: 65 to 390 ms, whether it finds anything or not. Each search runs twice, for the page and for the count.
- Measured with one combined lowered field and an index on `{ orgId, searchLower }`: 19 to 34 ms in every case, a search without a match included, because the pattern is tested on the index keys and only matches are fetched. The planner preferred another index until it was hinted.
- A type-ahead does not show a total. Fetching one row more than the page, without the count, took 8 to 11 ms.
- The stock-levels list (`stock-level.controller.ts`) calls the same builder without the lowered mirrors, so it searches with a case-insensitive pattern, which is the path the repository left because of Cyrillic. It then loads every matching product whole to take its id.

### 1.4 A report and two dashboards (P6, P9, P14)

- **Stock-levels report.** `services/src/biz/reports/stock-levels.report.ts` joins the product and the warehouse onto all 46 120 levels and only then sorts and limits: 138 154 documents read, 3.9 to 4.1 s through the API. With the sort and the limit before the two joins, the same pipeline went from 5.5 s to 0.25 s and returned identical rows.
- **The contact picker's ranking** (`prefer=customer|supplier`, `contact.controller.ts`) runs an aggregate over the organization's invoices on every form open: about 45 ms.
- **Dashboards.** The invoice KPI summary aggregates every invoice (about 40 ms) and the dashboard's stock value every level (about 95 ms). Both grow with each year of data.

### 1.5 The stock count form (P7)

- `InventoryCountFormView.vue` asks for every stock level of the warehouse and renders a plain table with one number field per row, keyed by row index, with no search and no paging.
- At 23 040 levels: the request is 9.7 MB (2.4 s by itself); the rows appear after 190 s, and for about 185 s of that the page does not answer; 438 104 DOM nodes; 2.3 GB of heap; one keystroke in a quantity field takes 7.3 s to paint.

### 1.6 PDFs (P8)

- `reporting/src/pdf/base.pdf.ts` launches a browser for every render. An invoice PDF takes 0.8 to 0.9 s once warm and about 6 s for the first.
- Nothing limits how many renders run at once in an API process. The batch e-mail limits itself to two.

### 1.7 The first load (P10, U12)

Production's sign-in page, anonymous, over HTTP/2 with brotli: 22 requests, 843 KB.

- **Icons.** 395 KB of it is the icon font (`ui-shared/src/plugins/vuetify.ts` imports the whole webfont). The source names 291 icons; the font carries 7 461.
- **Languages.** The English catalogue is inside the entry chunk, so a Bulgarian session downloads English and Bulgarian. Key parity between the four catalogues is tested, so nothing needs English as a fallback.
- **The drag library** of the column picker is a static import of `ListScaffold.vue`, so its 185 KB (65 KB compressed) load with the first list and not when a picker opens.
- **Caching.** Files whose names carry a content hash are served with `public, max-age=86400`, the static plugin's default (`api/src/spa-fallback.ts`), and not as immutable.
- **The budget** (`scripts/check-web-bundle.ts`) counts JavaScript only. The stylesheet (617 KB, 87 KB compressed) and the font are outside it.
- **Compression** is the cloud ingress's doing. The app itself does not compress, so an on-prem master serves every file as it is.
- **404 by design (U12).** `/api/auth/idp/config` answers 404 when nothing is configured, on every visit to the sign-in page, and the organization's logo route does the same on Settings. The browser logs each as an error.

## 2. Design

### 2.1 Indexes

- Five list indexes: `Product { orgId, createdAt: -1 }` and `{ orgId, name: 1 }`; `Invoice { orgId, direction, createdAt: -1 }`; `StockLevel { orgId, createdAt: -1 }`; `StockMovement { orgId, date: -1 }`. Declared on the schemas, built as every index here is.
- A sort whitelist per list: each list declares the fields it can sort by, and each of those is index-backed or runs on a bounded set. Another value falls back to the list's default sort.
- The partial index for the ledger.
- The seven text indexes are dropped in a migration. Removing the schema line alone leaves the index in every existing database. ⚠ A released migration file is frozen: this is a new file.
- After these land, `$indexStats` on production (counters, no documents) shows which invoice indexes are never used; those are candidates for a second migration.

### 2.2 The list engine

- **One fetch.** `usePaginatedTable` de-duplicates: a fetch whose parameters equal those of the one in flight, or of the one that just answered in the same tick, is not sent. The views keep working unchanged. [FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).4 adds the latest-wins guard to the same function, so the two are built together.
- **Rows.** The repository's `findAll` and `findMany` take `select` (`paginateQuery` already does; the repository change is [FR-32](FR-32-code-health.md).14). Each large list declares a list projection: the fields its grid and its row actions read, and no line arrays.
- **Who gets rows (D-1).** The UI asks for `fields=list`. An answer without that parameter stays whole, so the importers and the skills are not touched. The default flips only after every in-repository caller of a list endpoint has been read.
- **A ceiling.** A page never carries more than 1 000 rows. `size <= 0` means "up to the ceiling", and the answer says `truncated: true` when more exist. An endpoint may declare a lean "all" mode with a fixed small projection (the count form's levels, an export); nothing else returns an unbounded answer. The two in-repository scripts that send `size=0` page instead.
- **In the browser.** "All" is offered only while the list's total is within the ceiling (`ProductPickerDialog.vue` already drops it for the till). A remembered `size=-1` is read as the largest option.

### 2.3 Opening a document

- The document's `GET` returns each line's product name and SKU, so no product is read per line.
- A line's price options load when its price control is first opened. A loaded line shows its stored price until then, which is today's rule.
- The document is read once.
- Stable row keys ([FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).12) stop the re-fetch after a line is removed.

### 2.4 Search

- `searchLower`: the five lowered fields joined by a separator that cannot be typed, maintained by the lowered-fields plugin next to the mirrors it already keeps, with an index on `{ orgId, searchLower }` and a backfill in the manner of `scripts/backfill-search-lowercase.ts`.
- The search path uses the one field and hints the index. Several keywords stay an AND.
- ⚠ Patterns are built from strings, never from Cyrillic regex literals: Bun rewrites those to `\uXXXX`, which the database refuses.
- A type-ahead asks for one row more than it shows and no count. A list keeps its count.

### 2.5 The report and the dashboards

- The stock-levels report sorts and limits before it joins whenever no filter needs the joined product. A product filter moves into the first `$match`; a category resolves to product ids first.
- The picker's ranking is kept per organization for a few minutes, or as a small counter updated on issue (D-4).
- The KPI summary matches open statuses first; the stock total is kept for a minute.

### 2.6 The count form

- A virtual table (`v-data-table-virtual`), rows keyed by product, a search box, and two filters: "not counted yet" and "with a difference".
- The levels load through a lean "all" mode: product id, name, SKU, unit, quantity.
- Later, if needed: the count's lines live on the server and the form pages through them.

### 2.7 PDFs

- One browser per process, started on the first render and closed after a while without one. Each render gets its own browser context, closed afterwards.
- Every guard the renderer has today stays: the deadline, the kill of a stalled browser, the retry, the page's lock from the network.
- A semaphore: at most two renders at once per process; the rest wait inside the same deadline.
- A browser that dies fails its renders into the existing retry, which starts a new one.

### 2.8 The first load

- **Icons (D-5).** A build step collects the icon names the source and the configuration use and emits a subset font and a stylesheet with only those. The templates keep their string names. A name that is used and missing fails a test; a name that only exists in data goes on an allow-list. The alternative, Vuetify's SVG icon set, removes the font altogether and touches every place an icon is named.
- **Languages.** No catalogue in the entry chunk. The session's language loads on demand, and the next one when the user switches.
- **The drag library** loads with the column picker (`defineAsyncComponent` for the two picker dialogs).
- **Caching.** `Cache-Control: public, max-age=31536000, immutable` for files whose names carry a content hash, and only for those. `index.html` stays `no-cache`.
- **The budget** counts styles and fonts, per kind and in total.
- **Compression without an ingress.** The build writes `.br` and `.gz` beside the assets; the Bun server and the on-prem master's server pick them by `Accept-Encoding`.
- **Not there.** The configuration endpoint answers 200 with `{ configured: false }`. The page asks for a logo only when the organization has one, or the route answers 204.

## 3. Requirements

### 3.1 Indexes (slice A)

**FR-30.1 — A default list reads a page, not the collection (MUST).** For the default query of the Products, Sales invoices, Bills, Stock levels and Movements lists, the plan has no in-memory sort and reads at most five times the page size. A test asserts it from `explain` on a fixture, for each list, with and without the lists' usual filters.

**FR-30.2 — A list offers only sorts it can serve (MUST).** Each list endpoint declares its sortable fields. A `sortBy` outside the list falls back to the default sort. The grid offers a sort only on declared fields. Each declared sort passes FR-30.1's test or is documented as bounded.

**FR-30.3 — The contact ledger's index (MUST).** The ledger of one contact reads documents of that contact only (`explain`), and answers within 20 ms on the fixture.

**FR-30.4 — Text indexes nothing reads are dropped (MUST).** A migration drops the seven text indexes and the schema lines go with it. The `hasTextIndex` option of the search builder, which four callers pass and the builder never reads, is removed with them. The `$text` query in the test-only DAO goes with that DAO ([FR-32](FR-32-code-health.md).9).

**FR-30.5 — The index set is reviewed against use (SHOULD).** After a week with FR-30.1 to .4 on production, `$indexStats` is read per collection (counters only). An index with no use since the process started is listed with its size, and dropped in a second migration unless a reason is written beside it.

### 3.2 Requests and payloads (slice B)

**FR-30.6 — One request per list open (MUST).** Opening any list that uses `usePaginatedTable`, by a full load or by a move inside the app, sends its list request once. An e2e test counts the requests of the lists the walk opens.

**FR-30.7 — Lists send rows (MUST).**
- With `fields=list`, the invoice, bill, product, contact, stock-level and movement lists answer with their list projection: no line arrays, no price tiers, no histories.
- 100 invoice rows weigh at most 120 KB.
- A contact picker receives the fields it shows.
- The grids and their row actions work unchanged: the list specs pass unmodified.

**FR-30.8 — A page has a ceiling (MUST).** No list endpoint returns more than 1 000 rows in one answer, whatever `size` says, except through a lean "all" mode that the endpoint declares. An answer that was cut says so (`truncated: true`, with the real `total`). No code path reads 100 000 whole documents for a request.

**FR-30.9 — "All" in the browser (MUST).** The page-size control offers "All" only while the total is within the ceiling. A stored or bookmarked `size=-1` opens the list at the largest option. Choosing the largest option on Products at fixture size leaves the page answering.

**FR-30.10 — A document opens with a fixed number of requests (MUST).** Opening a saved invoice, bill, proforma, offer or order of 30 lines makes as many API requests as one of 3 lines, and at most 15. The document is read once. The stored prices, the price explanations and the totals shown are unchanged.

### 3.3 Search (slice C)

**FR-30.11 — One indexed search field (MUST).**
- A product search answers within 50 ms on the fixture for a common word, a rare one and one without a match, and reads no document for the last.
- It finds what today's search finds: a test runs both builders over the fixture for a list of keywords, Cyrillic, Latin, mixed case, digits and several words, and compares the ids.
- No keyword can match across two of the joined fields.
- The backfill is idempotent and has a dry run.

**FR-30.12 — A type-ahead does not count (MUST).** The product and contact type-aheads make one query per keystroke that is sent. Lists keep their total.

**FR-30.13 — The stock-level search uses the lowered mirrors (MUST).** It searches the way the Products list does, finds Cyrillic regardless of case, and reads the matching products' ids, not the products.

### 3.4 Reports and dashboards (slice D)

**FR-30.14 — The stock-levels report limits before it joins (MUST).** Without a filter that needs the product, the report answers within 500 ms on the fixture and returns the rows today's pipeline returns (a test compares them). With a product or category filter, the filter runs before the joins.

**FR-30.15 — The picker's ranking is not recomputed per form (SHOULD).** Opening a form twice within a few minutes runs the ranking aggregate once.

**FR-30.16 — Dashboards do not re-read history (SHOULD).** The KPI summary's first stage matches the statuses its tiles count. The stock total is served from a value at most a minute old.

### 3.5 The count form (slice E)

**FR-30.17 — The count form at 25 000 levels (MUST).**
- First rows within 3 s; at most 10 000 DOM nodes; a keystroke paints within 100 ms.
- A search box narrows by name or SKU. "Not counted yet" and "with a difference" filter the rows.
- A quantity typed into a row stays with its product when the rows are filtered or scrolled.
- What is saved is what the plain table saved: the count's payload is unchanged.

**FR-30.18 — Count lines held by the server (MAY).** Only if FR-30.17's budget cannot be met in the browser.

### 3.6 PDFs (slice F)

**FR-30.19 — One browser per process (MUST).** After a process's first PDF, a render starts no browser (a test counts launches over ten renders). Two renders never share a browser context. The renderer's existing guards are in place and their tests pass unmodified. The browser closes after a set idle time.

**FR-30.20 — A limit on renders at once (MUST).** At most two renders run at the same time in a process. A third waits, inside the deadline a render already has. Ten PDFs asked for at once all arrive.

### 3.7 The first load (slice G)

**FR-30.21 — Only the icons that are used (MUST).** The icon assets of the first load weigh at most 40 KB over the wire. Every icon named in a template, a script, a manifest or the app registry renders. A test fails on a name that is used and not shipped.

**FR-30.22 — One language per session (MUST).** A session downloads the catalogue of its language and no other. Switching language loads the new one without a reload.

**FR-30.23 — The drag library loads with the picker (MUST).** Opening a list requests no drag-and-drop code. Opening the column picker does.

**FR-30.24 — Hashed assets are cached for good (MUST).** A file whose name carries a content hash is served `immutable` with a one-year lifetime. A file without a hash is not. `index.html` is never cached.

**FR-30.25 — The budget counts styles and fonts (MUST).** `check-web-bundle.ts` fails the build on the first load's JavaScript, styles and fonts, each and together. The sign-in page's first visit transfers at most 500 KB.

**FR-30.26 — Compression where there is no ingress (SHOULD).** An on-prem master serves compressed assets to a browser that accepts them.

**FR-30.27 — "Not there" is not an error (MUST).** The sign-in page and Settings → Organization load without a failed request in the console, with nothing configured and no logo. An e2e test asserts a clean console on the sign-in page.

### 3.8 Across this FR

**FR-30.28 — A fixture anyone can rebuild (MUST).** A script fills a throwaway local database to the sizes of §0 and refuses any other target. The timings recorded in §11 are taken on it. The plan assertions of FR-30.1, .3 and .11 run in CI on a small fixture: a plan does not depend on the size.

**FR-30.29 — Contracts that do not move (MUST).**
- An answer without `fields=list` keeps today's shape on every list endpoint, the response keys of each store included (`{ products, items, total, page, size, totalPages }` and its siblings).
- `POST /org/:orgId/invoices`, `POST /org/:orgId/bills/import/{extract,draft,convert}` and the movement routes are not touched.
- Route names stay: the e2e suite and the per-user column choice depend on them.
- The walks of FR-22 stay inside their budgets, and FR-28's request-count and explain tests pass unmodified.
- The one answer that changes on purpose: `size <= 0` on a large list is cut at the ceiling and says so.

**FR-30.30 — Guards, languages, data, Windows (MUST).** The tenant, access and replication guards pass unmodified. Every new text exists in `en`, `bg`, `de` and `mk`. No test, fixture, issue comment or PR carries a customer's name or figure. No new test uses `.rejects` or `.resolves`.

## 4. Migration

| What | Change | Procedure |
|---|---|---|
| Five list indexes, one partial index | declared on the schemas | They build when the server starts. The deploy log is read for the builds on `invoices` and `stocklevels`. An on-prem master builds them at its next start |
| Seven text indexes | dropped | A new migration; it drops by name and skips what is not there |
| `Product.searchLower` | new field and index | Written by the plugin on every save; a backfill script with a dry run fills the rest. Until it has run, the search falls back to today's builder for a product without the field |
| List answers | `fields=list` | Opt-in. Nothing stored |
| Remembered list state | `size=-1` | Read as the largest option. Nothing is rewritten |
| Icons | a generated subset | Built with the app. No data |
| Cache headers | longer | Only for hashed names, so an old file is never served for a new build |

## 5. Slices, dependencies and rollback

| Slice | Ships | Visible change | Exit |
|---|---|---|---|
| A | FR-30.1 to .4 (.5 a week later) | lists open faster | the explain tests; the list specs unmodified |
| B | FR-30.6 to .10 | "All" is gone above 1 000 rows; documents open faster | the request counts; the payload size; the walks inside their budgets |
| C | FR-30.11 to .13 | search answers faster | the equivalence test; the budget |
| D | FR-30.14 to .16 | the report answers faster | the row comparison |
| E | FR-30.17 | the count form has a search and filters | the three budgets at fixture size |
| F | FR-30.19, .20 | none | the launch count; the renderer's own tests |
| G | FR-30.21 to .27 | none, if every icon is found | the bundle budget; a walk that looks for a missing icon |

**Order.** A first: it is the cheapest and the largest effect. B and C next. D, E, F and G are independent of each other and of the rest. Inside B, FR-30.6 is built with [FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).4.

**Rollback.** A: an index that hurts is dropped by name; the text indexes can be declared again. B: `fields=list` and the ceiling are each one revert. C: the search falls back to today's builder by a switch, and the field is harmless. D, E, F: revert the PR. G: each requirement reverts alone; the icon subset can be replaced by the whole font in one line.

**Risks.**
- *An index slows writes.* Seven text indexes go and seven arrive (five for the lists, the ledger's partial one, the search field's), and FR-30.5 reviews the rest.
- *A caller that needs whole documents gets rows.* `fields=list` is opt-in (D-1).
- *A cut answer is taken for the whole.* `truncated` says so, and the two scripts that asked for everything are changed in the same PR.
- *An icon that only exists in data renders blank.* The allow-list, the test, and a walk over every module.
- *The new search misses something the old one found.* The equivalence test, and the switch back.
- *A long-lived browser grows.* It closes when idle, and a render's context is closed after it.

## 6. Tests

- **Plans** (`list-plans.flow`): FR-30.1, .2 and .3 from `explain`, on a small fixture.
- **Payloads** (`list-projection.flow`): the keys of a row with and without `fields=list`; the size of 100 rows; the ceiling and `truncated`.
- **Search** (`product-search-field.flow`): the equivalence of the two builders; the plugin keeps the field on save, on `insertMany` and on the update hooks; the backfill twice.
- **Report** (`stock-levels-report.flow`): the rows equal today's pipeline, with and without each filter.
- **PDF** (`pdf-browser.flow`): launches over ten renders; two contexts never shared; a browser killed mid-render.
- **Unit**: the fetch de-duplication; the icon subset holds every name the source uses; the bundle budget's arithmetic.
- **E2E**: the request count of a list and of a 3-line and a 30-line document; "All" at the ceiling; the count form's search and filters; a clean console on the sign-in page.
- **Guards, unmodified**: the list specs, `ux-budgets`, `products-supply-list.flow`, `tenant-isolation.flow`, the reports suites.

## 7. Acceptance criteria

1. Every row of §0's budget table meets its target on the fixture, and §11 records the measured figure beside the old one.
2. Each of the five lists shows the rows it showed, in the order it showed them.
3. A product search returns the ids today's search returns, for the keyword list of FR-30.11.
4. The stock-levels report returns the rows it returned.
5. A stock count of 25 000 levels can be filled in: search, type, filter, save.
6. Ten PDFs asked for at once arrive, and the process started one browser.
7. The sign-in page transfers at most 500 KB on a first visit, shows every icon, and logs nothing.
8. The existing suites pass unmodified. `bun run test`, `bun run build`, `bun run test:e2e` and CI are green.
9. No test, fixture, comment or PR carries a customer's name or figure.

## 8. Field test (production, after each slice; the demo organization, never a customer's)

The demo organization is small, so production proves that nothing changed, and the fixture proves the speed.

1. **Slice A.** Open each of the five lists and sort by every offered column: the same rows as before, in the same order. `explain` on production for the default query of each list in the largest organization: the plan names the new index (plans and counters only, no documents).
2. **Slice B.** Open a list and count its requests in the browser's network panel. Open a saved invoice of many lines: the prices are the stored ones; open a line's price options. Choose the largest page size.
3. **Slice C.** Search a Cyrillic word in lower and upper case, a SKU, a barcode, two words.
4. **Slice D.** Run the stock-levels report with no filter, by warehouse and by category, and compare with the Stock levels list.
5. **Slice E.** Make a count in a demo warehouse: search, type three quantities, filter to differences, save, open it again.
6. **Slice F.** Print an invoice, a proforma and an order sheet, then five at once.
7. **Slice G.** Open the sign-in page in a private window with the network panel open: the transfer size, no failed request. Walk every module's menu and three screens of each, looking for an empty icon.
8. **Clean up.** Delete the count and anything else the test made, and report the count left (0).

## 9. Decisions (defaults stand unless the owner answers otherwise)

| | Question | Default |
|---|---|---|
| D-1 | Who gets list rows instead of whole documents? | The UI, by asking (`fields=list`). The default answer flips after every in-repository caller of a list endpoint has been read |
| D-2 | The ceiling of a page | 1 000 rows |
| D-3 | Keep the invoice list's sort on creation, or sort by issue date? | Keep it, with a new index. An index on issue date already exists, so sorting by it would need none, but imported documents would move in the list |
| D-4 | The picker's ranking | Kept for five minutes per organization |
| D-5 | Icons | A subset font built from the names in use. Vuetify's SVG set is the alternative, and touches every place an icon is named |
| D-6 | Renders at once | Two per process |
| D-7 | How long an idle browser lives | Five minutes |

## 10. Not in this FR

- Deep pages. A list's page 700 stays linear in the rows skipped; a cursor instead of a page number would change every list's address.
- A search engine beside the database, fuzzy matching, or ranking by relevance.
- Catalogues split by module. One language per session is the larger part of the gain.
- A second database member, read replicas, or caching layers in front of the API.
- The accounting reports, the reservation queries and the journal queries: they were not measured.
- The first request after a rollout: [FR-29](FR-29-atomic-bookings-records-runtime.md).31.
- Time limits on queries: [FR-29](FR-29-atomic-bookings-records-runtime.md).26.

## 11. Build log

### Slice A (FR-30.1 to .4), 2026-11-16

**What was built.**
- `config/list-sorts.ts`: per list (products, invoices, stock levels, movements) the keys it sorts by, each `index` (named), `scan` (with its reason) or `aggregate`; `chooseListSort` (anything else is the list's default sort) and `sortableHeaders` (the grid offers only those keys). The four list routes and the four grids use it.
- Indexes: `Product { orgId, createdAt: -1 }`, `{ orgId, name: 1 }`; `Invoice { orgId, direction, createdAt: -1 }`, `{ orgId, direction, invoiceNumber: 1 }`, the ledger's partial `{ orgId, 'cashSaleRef.contactId' }`; `StockLevel { orgId, createdAt: -1 }`; `StockMovement { orgId, date: -1 }`, `{ orgId, createdAt: -1 }`.
  - Two more than §2.1 named. The Movements grid opens on `createdAt`, not `date` (the API's default), so both are kept. The № column of Sales invoices read every bill first through the unique key (`BILL-…` sorts before `INV-…`): 2 014 documents for 10 rows.
- The seven text indexes left the schemas; migration `0016-drop-unread-text-indexes` drops whatever text index each of the seven collections still has, by its name. `hasTextIndex` and the DAO's `$text` method went with them.
- Tests: `integration/list-plans.flow.test.ts` (the profiler on the real routes: no in-memory sort, at most five pages read, for each list's grid query, its API default, its usual filters, and every index-served key in both orders; the ledger; the migration), `unit/list-sorts.test.ts`.

**Measured** on the same data before (this slice's indexes dropped) and after, with `LGR_PERF=1` on the test file: 23 050 articles with ten tiers, 46 100 levels, 10 020 documents of 12 lines, 5 000 movements of 10 lines, in-memory replica set, a developer laptop (read as ratios). Median of 7 API calls.

| Query | Before: read, ms | After: read, ms |
|---|---|---|
| Products, the grid's first page | 23 050, 333 | 11, 193 |
| Products by name (API default) | 23 050, 201 | 10, 50 |
| Sales invoices | 8 016, 137 | 10, 101 |
| Sales invoices by № | 2 014, 114 | 10, 106 |
| Bills | 2 004, 110 | 10, 37 |
| Stock levels | 46 100, 412 | 10, 120 |
| Movements | 5 000, 57 | 10, 18 |
| Contact ledger, one contact (route) | 7 515, 223 | 3, 59 |
| — its cash-sale read alone | 7 515, 385 | 3, 6 |

**What is left in a list's time is its total.** The page's own query now takes 0 to 2 ms. `countDocuments` still reads every matching document where the filter is not covered by an index: Products with "active only" (`isActive: { $ne: false }`, about 300 ms), Sales invoices (`type` and the payment-receipt rule, about 90 ms); Stock levels counts 46 100 index keys (about 130 ms). That is outside this slice; it is a question for the owner (an index that covers the count, or a total that is not exact past a size).

**Sorts no index serves** (`scan` in the table, held by the test as a list): Products by type, unit, active, minimum, purchase and selling price; documents by status, type, currency, reference, subtotal, tax, total, amount due; Stock levels by quantity; Movements by status and total (and by the three looked-up names, an aggregation). Each still reads the filtered rows, as before. They stay offered: dropping them from the grids, or indexing them, is the owner's call (FR-30.2).

**The id, on every list, for what reads a whole list in pages.** The import and audit tooling (`fetchAll` in nine scripts and skills) sends `page=N&sortBy=_id&sortOrder=asc` until a page adds nothing. It needs an order with no ties: rows whose sort keys are equal can come in another order for another skip, so a page repeats a row and leaves another out, and the reader is not told. Every default sort above has ties. The first version of the table did not declare the id, so those reads would have run on the default sort; the table declares it now (`scan`: read in the id's order through the collection's `_id` index, as before this slice), no grid offers it, and `unit/list-sorts.test.ts` holds every `sortBy` the scripts and skills send to the table.

**Turned off in the grids**, because the server never sorted by them (they are names looked up after the page): the contact on Sales invoices and Bills, the article's SKU and name and the warehouse on Stock levels.

### FR-30.5, read 2026-11-23 (#868)

`scripts/index-usage.ts` reads `$indexStats` and the index sizes per collection (counters only, on the primary) and lists the indexes with no use since the member started. `0019-drop-unused-indexes` was released as the empty scaffold and ran on production on 2026-11-18, dropping nothing. A released migration is never edited, so the drops are migration **`0022-drop-unused-indexes-fr30-5`**: it drops by name, skips a collection or an index that is not there, is idempotent, and has a dry run (`bun run migrate --dry-run` lists each index it would drop). The schemas lose the same declarations in the same pull request, so no start builds them back; what is kept stays declared, and `integration/drop-unused-indexes-fr30-5.migration.test.ts` holds both.

**The reading.** Production's primary, 2026-11-23 about 19:20 CET, `--json`. Most counters ran from 2026-10-31T21:50Z, the member's start: 23 days, weekends and the weekly jobs included, the 31 October month-end just before. 481 indexes; **80** had no use and were not unique (not counting `_id_`): 32 556 KB.

**Decided.** An index stays if it is a TTL index (`$indexStats` does not count the expiry deletes), if its counter ran for less than 7 days, if it serves month-end or year-end work none of which ran inside the window, or if a query in the code reads it on data global does not have yet or on a master (store masters run the same code with other data). Everything else goes: no code path reads it, or another index with the same or a better prefix serves the read.

**Dropped: 33 indexes, 22 080 KB.**

| Collection | Index | Size | Why nothing needs it |
|---|---|---|---|
| `products` | `orgId_1_priceTiers.tags_1` | 10 788 KB | No query by a slot's tags: a price is resolved on the article read by its id |
| `products` | `categoryLower_1` | 3 928 KB | A search reads `searchLower` (FR-30.11); the five-field fallback's `$or` has the unindexed description beside it |
| `auditlogs` | `orgId_1_operatorCode_1_timestamp_-1` | 2 952 KB | The audit page has no operator filter; the SUPTO export filters documents by operator, not the trail |
| `contacts` | `taxIdLower_1`, `vatNumberLower_1`, `emailLower_1`, `firstNameLower_1`, `lastNameLower_1` | 3 496 KB | Read only inside the search's `$or`, whose other branches (phone, aliases, representative) no index serves. Exact lookups use `orgId_1_taxId_1`, `orgId_1_vatNumber_1`, `orgId_1_email_1`. `companyNameLower_1` stays: the document import matches a name on it |
| `invoices` | `orgId_1_internalOrderId_1` | 184 KB | Its one read (a customer order's documents) is an `$or` with `lines.orderRef.internalOrderId`, which has no index, so the planner cannot use it |
| `invoices` | `orgId_1_register.unp_1` | 24 KB | No lookup by УНП; the till journal's search is a case-insensitive pattern in an `$or` with `reference` |
| `docfiles` | `docDate_1` | 64 KB | Every read names the org: `orgId_1_docDate_1_docType_1` |
| `files` | `orgId_1_module_1` | 64 KB | `GET /file`'s module filter has no caller |
| `accounts` | `orgId_1_parentId_1` | 56 KB | The chart's tree is built in memory |
| `warehouses` | `nameLower_1`, `codeLower_1`, `orgId_1_tags_1` | 108 KB | A handful per org, read through the org; no page sends a tag filter |
| `postransactions` | `orgId_1_sessionId_1`, `orgId_1_type_1_createdAt_-1`, `orgId_1_unpNumber_1` | 96 KB | Frozen since FR-21: only migrations and the restore read it, by the org |
| `employees` | `orgId_1_managerId_1` | 36 KB | Nothing filters or sorts by the manager |
| `fixedassets` | `orgId_1_category_1` | 36 KB | No filter by category; the register's sort ends in `_id`, which this index cannot give |
| `payrollruns` | `orgId_1_period.from_-1` | 36 KB | A run is found by its id or `periodCode`; the grid's period column sorts by `period` |
| `productcategories` | `nameLower_1` | 36 KB | Not under the org. The one exact read (`quick-product`) names the org, whose few categories `orgId_1` finds |
| `taxreturns` | `orgId_1_type_1_period.from_-1` | 36 KB | The VAT flow reads by `kind` and `periodCode` (`tax_return_period_unique`) |
| `desktopenrollmentcodes` | `orgId_1_createdAt_-1` | 32 KB | No list of codes: one is read by its id or its hash |
| `din_catalog` | `baseNumber_1`, `categoryIndex_1` | 44 KB | Read whole by the scripts, upserted by `din` (unique) |
| `codes` | `userId_1` | 24 KB | `userId_1_type_1` has the same prefix |
| `costlayers` | `orgId_1_productId_1_warehouseId_1_isExhausted_1_receivedAt_-1` | 24 KB | LIFO's read is the FIFO index (`receivedAt_1`) read backwards |
| `journals` | `orgId_1_type_1` | 4 KB | The journals list filters by its search only |
| `stocklocations` | `orgId_1_barcode_1`, `orgId_1_parentId_1` | 8 KB | The list filters by its search only; the path walk reads a parent by its id |
| `timesheets` | `orgId_1_employeeId_1_date_-1` | 4 KB | The list filters by its search only; no payroll step reads a timesheet |

**Kept: 47 indexes, 10 476 KB**, each with its reason in the migration's `KEPT`.
- *TTL* (15): `auth_tokens.expiresAt_1`, `codes.validTo_1`, `desktopassertions.expiresAt_1`, `desktopenrollmentcodes.expiresAt_1`, `idp_codes.expiresAt_1`, `login_throttles.updatedAt_1`, `node_assertions.expiresAt_1`, `node_enrollment_codes.expiresAt_1`, `node_presence.heartbeatAt_1`, `node_traffic.lastAt_1`, `oauthhandoffs.expiresAt_1`, `oauthpendingregistrations.expiresAt_1`, `onprem_credentials.removedAt_1`, `relay_jobs.createdAt_1`, `relay_receipts.at_1`.
- *Counted for less than 7 days* (5): the three `draftNumber` indexes (`invoices`, `orders`, `internalorders`, since 2026-11-18: the top bar's jump by draft number, FR-31.22), `invoices.orgId_1_direction_1_invoiceNumber_1` (since 2026-11-17: the № column, FR-30.2), `node_traffic.nodeId_1_day_1` (since 2026-11-20).
- *Month-end and year-end work* (7): `absenceentries.orgId_1_employeeId_1_from_1` (the payroll run), `payslips.orgId_1_employeeId_1_period.from_-1` (the run's year so far), `journalentries.orgId_1_fiscalPeriodId_1` (the trial balance of a period or year, 3 144 KB), `accounts.orgId_1_type_1` (the profit and loss), `bankreconciliations.orgId_1_bankAccountId_1_statementDate_-1`, `archiveunits.orgId_1_createdAt_-1` (the year's archive), `products.orgId_1_categoryId_1` (the stock-levels report by product group, 3 944 KB).
- *A query reads it, on data global does not have yet* (8): `auditlogs.orgId_1_correlationId_1` (the audit page's related entries, 1 632 KB), `invoices.orgId_1_tags_1` (the documents lists' tag filter, 540 KB), `employees.orgId_1_tags_1` and `orgId_1_department_1` (the Employees list's filter and sort), `payrollruns.orgId_1_status_1` (the runs list's sort), `internalorders.orgId_1_requestedDeliveryDate_1` (the Customer orders list's sort), `productsuppliers.orgId_1_supplierId_1` (the Products list's supplier filter), `costlayers.…_expiryDate_1` (FEFO costing).
- *Masters, moves and replication* (12): `outbox.state_1_nextAt_1`, `emaillogs.outboxId_1` (a master's outbox), `relay_jobs.nodeId_1_op_1_createdAt_1`, `relay_receipts.nodeId_1_at_1` (the relays' caps per server), `repl_journal.coll_1_docId_1` (a master's capture of a delete), `mirror_blobs.orgId_1_state_1`, `org_moves.from_1_state_1`, `org_moves.to_1_state_1` (`movesForNode`), `invoices.orgId_1_importedFrom.exportId_1` (a fenced import's undo, FR-20.84), `desktopenrollmentkeys.orgId_1_createdAt_-1`, `desktopenrollmentkeyuses.orgId_1_keyId_1_createdAt_-1` (pairing a till), `identities.migration.runId_1` (an identity migration's rollback).

**Run.** After the deploy, by hand on global: `bun run migrate --dry-run`, then `bun run migrate`. The masters run it on their next update. Rollback: the previous release declares the indexes again, and its first start builds them back; nothing is lost.

**Seen on the way, not changed here.** A customer order's linked documents (`internal-order.controller`) read every document of the org: the `$or`'s `lines.orderRef.internalOrderId` branch has no index. An index on it would let both branches be served; it is a decision for its own pull request.

### Slice B (FR-30.6 to .10), 2026-11-17

**What was built.**
- **One request per list open (FR-30.6).** Measured first: on master the 15 lists the new walk opens (`e2e/list-requests.spec.ts`: Sales invoices, Bills, Proforma, Offers, Contacts, Products, Stock levels, Movements, Warehouses, Inventory counts, Orders, Internal orders, Reservations, Payment orders, Cash orders) each already send their list request once, on a full load and on a move inside the app. FR-31.4 (#810) made the view's `onMounted` call the latest question, which aborts the table's mount-time call before axios has sent it. No de-duplication was added on top: it would change what `unit/latest-only.test.ts` holds (two calls, two requests). The walk holds the count.
- **Rows (FR-30.7, D-1).** `config/list-rows.ts`: per list, what a row leaves out, as an exclusion (a field a grid reads that nobody listed is still sent). With `fields=list`: invoices without `lines`; articles without the legacy price arrays, variants, pictures, a slot's filters and the search mirrors (a slot keeps its name, percent, final price and lock, which the grid's price columns and the cost redaction read); contacts without `notes` and the mirrors (a document's party block reads the picked contact's addresses and tax numbers, so they stay); movements read a line's article and quantity only (the list never sent lines). Asked for by the grids (`usePaginatedTable({ listFields: true })` on Sales invoices, Bills, Proforma, Offers, the Reports tabs, Contacts, Stock levels, Movements; `useProductList` on Products and its picker) and the contact pickers (the document forms, the order forms, the cash-sale invoice dialog, `ContactPickerDialog`; `useContactSearch` keeps its request, which `unit/form-composables.test.ts` holds as it is). Without the parameter every answer is as it was. The lookups behind a page read what the row takes (a contact's name, a related document's number, an article's name and SKU, a warehouse's name), and the invoice list's search by contact name reads the matching ids only.
- **A ceiling (FR-30.8, D-2).** `LIST_CEILING = 1000`, applied where every list reads its page: the repository's `findAll`, `paginateQuery`, and the sorted-page helpers (a sort by a price slot, by stock, by a looked-up name). "All" (`size <= 0`) and any size above it read at most 1 000 rows; a cut answer says `truncated: true` with the real `total`, and an answer that was not cut has no such key. Declared exceptions (`PageRequest.unbounded`): the stock levels' lean "all" for the count form (`fields=count`: the article's id, name, SKU and unit, quantity and average cost; the count form uses it now, ahead of slice E), and the chart of accounts (every accounting picker looks an account up in it; its tree needs every account). The contact's figures (`/stats/contact/:id`) read four fields of each document instead of up to 10 000 whole ones. `scripts/import-contacts-api.ts` and `scripts/import-payroll.ts` page by 500.
- **"All" in the browser (FR-30.9).** `ui-shared/composables/page-sizes.ts`: the size control offers "All" only while the list's total is within the ceiling (`ListScaffold`, the product picker); a stored or bookmarked `size=-1` opens at 100, the largest option; a list on "All" whose answer comes back cut moves to 100 by itself.
- **A document opens with a fixed number of requests (FR-30.10).** `GET /invoices/:id` gives each line its article's `productName` and `productSku` (one query), and the line's article field uses it (`ProductLineDescription#known`) while the line holds that article. The orders' forms use the names their read already carried (`lookup.products`). A line that keeps its price (loaded, or pinned) asks for its price options when its price control is first focused (`PriceCombobox`), not as it mounts; a line that applies the resolved price asks at once, and a change of contact still re-resolves. The sales and purchase views read the document to choose the form and hand that answer to the form (`document-preread.ts`), which read it a second time.

**Measured.**

| What | Before | After |
|---|---|---|
| 100 invoice rows of 12 lines (`list-projection.flow`, `LGR_PERF=1`) | 561.2 KB | 88.6 KB with `fields=list` (budget 120 KB) |
| Opening a list (15 lists, full load and move) | 1 request each (since FR-31.4) | 1 |
| "All" on a list of 1 100 contacts | 1 100 whole documents | 1 000 rows, `truncated: true`, `total: 1100` |
| Opening a saved 3-line / 30-line invoice | the document read twice, an article and a set of price options per line (70 for 30 lines in the audit) | 3 API requests for either, moving to it inside the app (the document once, the contact picker, the warehouses) |

**Tests.** `integration/list-projection.flow.test.ts` (the keys of a row with and without `fields=list` on every list, the size of 100 rows, the ceiling, the lean "all", the chart, the contact's figures, a document's line names); `unit/list-rows.test.ts` (the ceiling's arithmetic, the size control, the hand-over); `e2e/list-requests.spec.ts` (the list walk's request count, `fields=list` on the wire, a 3-line and a 30-line invoice opened with the same number of requests and the document read once, a line's options asked for when its price is opened, a bookmarked "All", "All" offered within the ceiling only).

**Decisions.** "No price tiers" (FR-30.7) is read as "no price slot's filters": the Products grid shows each slot's price in a column of its own (FR-22.44), so a row keeps the slot's name and price. A remembered "All" is read as 100 and not refetched as "All" once the total is known: §4 says it is read as the largest option.

### Slice C (FR-30.11 to .13), 2026-11-17

**What was built.**
- **One indexed search field (FR-30.11).** `Product.searchLower`: the five lowered mirrors joined by U+001F, a character nobody types, so no keyword matches across two of them. Kept by the lowered-fields plugin (`joined`, `db/plugins/search-field.ts`) after the mirrors: a save and an `insertMany` compute it; an update that names a source or a mirror refreshes it afterwards in the database from the stored mirrors, in the update's session; a `bulkWrite` gets the same refresh right after it, in its session (so inside its transaction), without touching the caller's list of operations. Index `{ orgId, searchLower, isActive, _id }`.
- **The read.** The search tests its pattern on the index keys only. The repository (`findAll` with `hint`) first reads the matches' ids from the keys (up to 300, nothing fetched): none, nothing more is read; few, they are the count and the page is read by id; many, they are counted from the keys and the page is the planner's own plan (the sort's index, stopping at the page's last row). Through the search index alone a common word fetched every match to sort it (125 ms for `болт`), which is why the hint is not used for the page then.
- **Articles without the field.** A search also reads them by their mirrors while the org has one (`productSearchFieldComplete`: one index read at `searchLower: null`). Migration `0018-product-search-field` fills the field on every article written before (a master has no operator to run a script); `scripts/backfill-product-search-field.ts` does the same by hand, with a dry run. Both are idempotent.
- **The switch back.** `PRODUCT_SEARCH_FIELD=off` runs the five-field search, as before.
- **A type-ahead does not count (FR-30.12).** `count=none` reads one row more than the page and no count (`hasMore`); `count=when-more` counts only when more follow. The line search uses `when-more`, because it shows "Show all N results" (FR-28.25, and `e2e/product-search.spec` holds N); with the search field that count is read from the keys. The document forms' and the order forms' contact type-aheads and the cash-sale invoice dialog's use `none` (the picker's ranking included). `useContactSearch` keeps its request: `unit/form-composables.test.ts` holds its parameters.
- **The stock-level search (FR-30.13)** is the product search (`buildProductSearchFilter`, Cyrillic in any case) and reads the matching articles' ids only.

**Measured** (`LGR_PERF=1` on `product-search-field.flow`: 23 370 articles, through the API with its request overhead, median of 7, a developer laptop).

| Search | Five fields | One field |
|---|---|---|
| `болт` (about a third of the catalogue) | 86 ms | 40 ms |
| `поцинкован` (46 articles) | 472 ms | 39 ms |
| `zzzz-nothing` | 70 ms | 30 ms, no article read |

**Tests.** `integration/product-search-field.flow.test.ts`: the two builders over one fixture for 36 keywords (Cyrillic, Latin, mixed case, look-alike letters, digits, several words, punctuation, none) give the same ids; no keyword bridges two parts; the profiler on the route (the matches read from the keys, no article for a search without a match, the page by id); the field on create, `insertMany`, `findOneAndUpdate`, `updateOne`, `updateMany` whose filter the update moves, `$unset`, `bulkWrite` in a transaction; an article without the field still found; the backfill's dry run and two runs; migration 0018 twice; the switch; the type-ahead modes; the stock-level search.

**Decisions.** FR-30.12 says one query per keystroke. The line search keeps its "Show all N results", so when more than ten match it also counts, from the index keys (no article read). The search is not given its index when a keyword also finds articles by a supplier's code (FR-28.10): that branch is answered by `_id`, which those keys cannot.

### Slice D (FR-30.14 to .16), 2026-11-17

**What was built.**
- **The stock-levels report limits before it joins (FR-30.14).** Without the reorder filter, the report sorts by value and cuts at its row cap before it joins the article and the warehouse; the joins then read one article and one warehouse per row kept. An article or a category narrows the levels in the first `$match` (a category is resolved to its articles' ids, descendants included, first). With "below minimum", which compares with the article's minimum, the joins still come first, but on the levels the article and category filters left.
- **The picker's ranking (FR-30.15, D-4)** is kept five minutes per organization and side (`rankedContactIds`, `services/utils/ttl-cache.ts`, per process). A contact first used in the last five minutes may still sort by name until then.
- **Dashboards (FR-30.16).** The KPI summary's first stage matches the statuses its tiles count (`SUMMARY_STATUSES`: sent, received, partially paid, overdue, paid, draft); a voided, cancelled or converted document is no longer read and dropped by each facet. The dashboard's stock value is at most a minute old (`cachedStockValuationTotals`).

**Measured** (`LGR_PERF=1` on `stock-levels-report.flow`: 15 400 articles in three warehouses, 46 200 levels, a developer laptop, the handler itself, median of 5).

| Stock-levels report, no filter | Before | After |
|---|---|---|
| time | 9 120 ms | 392 ms (budget 500) |
| articles read by the joins | one per level | one per row kept (at most the cap + 1) |

**Tests.** `integration/stock-levels-report.flow.test.ts`: the rows, totals and meta equal the old pipeline's (frozen in `helpers/stock-levels-report-legacy.ts`) for twelve parameter sets (none, zero rows, rolled up, below minimum, a warehouse, an article, a category with descendants, combinations) in two outputs; the joins read at most the cap + 1 articles; a category narrows the first stage; the ranking aggregated once for two forms; the cache's lifetime and a failed read not kept; the summary's first stage and its figures with voided and cancelled documents beside them; the stock value read once a minute.

### Slice E (FR-30.17), built by FR-33 slice A, 2026-11-25

First built on 2026-11-17 in #848 (`a34e3d30`), which merged into a stale stacked branch and never reached master. [FR-33](FR-33-stock-count-product-search.md) slice A (#933) ported it to the moved file; FR-33 §11 has the rest.

**What was built** (`web/src/modules/inventory/views/InventoryCountFormView.vue`).
- The lines are a virtual table above 200 rows (`v-data-table-virtual`: only the rows in view are drawn), a plain table of all rows below, both keyed by the article. The count's levels come through the stock levels' lean "all" (`fields=count`, slice B): the article's id, name, SKU, barcode and unit, its quantity and average cost.
- A line filter (name, SKU or barcode, every word, Latin and Cyrillic look-alikes as one letter, FR-33.2), and two toggles: "Not counted yet" (no quantity typed for the article since the form opened; on a saved count, the lines that differ from the system count are taken as counted) and "With a difference". The shown and total line counts beside them.
- The counted-quantity column is keyed `qty`, not `countedQuantity`: the table reads every row's value of each column's key, and a typed quantity made it read all the rows again on each keystroke (#848 measured 167 ms a keystroke at 25 000 rows, 33 ms after).
- What Save sends is what the plain table sent (the same keys, every line).

**Measured by #848** (25 000 levels given to the browser, a developer laptop, Chromium at 1280×720).

| | Before (the audit, 23 040 levels) | After (25 000) | Budget |
|---|---|---|---|
| First rows after "Load products" | 190 s | 414 ms | 3 s |
| DOM nodes | 438 104 | 706 | 10 000 |
| A keystroke painted | 7.3 s | 33 ms (median of 5, Playwright's round trip included) | 100 ms |

`e2e/count-form-scale.spec.ts` holds the three budgets on every nightly run. FR-30.18 (lines held by the server) is not needed: the budget is met in the browser.

**Tests.** `e2e/count-form-scale.spec.ts`: the three budgets, the filter by name, SKU, barcode and a look-alike, a quantity typed into a found row that stays with its article through the filters, both toggles' counts, and the saved payload (25 000 lines, the plain table's keys, the typed figures). `e2e/inventory-count.spec.ts` unchanged.

### Slice F (FR-30.19, .20), 2026-11-17

**What was built** (`reporting/src/pdf/base.pdf.ts`).
- **One Chrome per process (FR-30.19, D-7).** The first render starts it; it closes after `PDF_BROWSER_IDLE_MS` (5 minutes) without a render, on a timer that never keeps the process alive. Each render opens a browser context of its own and closes it afterwards, so two renders share no page, storage or cache. A browser that disconnects (a crash, a kill) is forgotten at once, and `markdownToPdf`'s retry starts another.
- **The guards stay.** The deadline (`PDF_RENDER_TIMEOUT_MS`) now counts from when the render was asked for; a stalled render still fails and its Chrome is killed (`closePdfBrowser`), so the next starts a fresh one; the page lock, the no-network flags, the retry and the empty-PDF check are as they were.
- **A limit on renders at once (FR-30.20, D-6).** `PDF_RENDER_CONCURRENCY` (2) renders at a time per process; the rest wait for a slot inside their deadline.

**Measured** (a developer laptop, 11 renders of a one-page document in one process, then ten at once).

| | Before (the audit) | After |
|---|---|---|
| The first PDF of a process | about 6 s | 767 ms here (the launch) |
| A PDF after that | 0.8 to 0.9 s, a launch each | 219 ms median, no launch |
| Ten at once | ten launches | 1.4 s in all, one launch |

**Tests.** `unit/pdf-shared-browser.test.ts`: no launch over ten renders after the first; two renders at once in two contexts, neither the default, both closed after; a browser killed mid-render, and the render beside it still prints through the retry; ten at once all arrive with at most two rendering together; a render waiting for its turn fails at its own deadline. The renderer's own tests (`pdf-render-deadline`, `pdf-page-lock`, `pdf-renderer`) are unchanged.

### Slice G (FR-30.21 to .27), 2026-11-17

**What was built.**
- **Icons (FR-30.21, D-5).** `scripts/build-icon-subset.ts` collects the `mdi-…` names the UI sources use (every package's `src`, the web shell), Vuetify's own (`vuetify/lib/iconsets/mdi`) and an allow-list (empty: no name is built at runtime), and writes a subset font (`subset-font`, a dev dependency), its stylesheet and the names into `ui-shared/src/styles/icons/`, committed. The templates keep their string names. `unit/icon-subset.test.ts` fails on a name used and not shipped. 320 of 7 447 icons: 17.4 KB woff2, against 393.8 KB. Rollback: import `@mdi/font/css/materialdesignicons.css` again in `plugins/vuetify.ts`.
- **One language per session (FR-30.22).** English left the entry chunk: every catalogue loads on demand, the session's own before the app mounts, another when the person switches. A catalogue that does not arrive falls back to English.
- **The drag library with its picker (FR-30.23).** The grid and line column pickers are async components, mounted when opened (`ListScaffold`, the product picker, the document lines, the accounting lists, the report runner).
- **Caching (FR-30.24).** A file whose name carries Vite's hash is served `public, max-age=31536000, immutable` (`spa-fallback.ts#uiStaticPlugin`); any other keeps the plugin's default; the shell stays `no-store`.
- **The budget (FR-30.25).** `check-web-bundle.ts` counts the first load's styles (gzipped, 60 KB) and the fonts they ask for (40 KB), each and with the JavaScript (450 KB in all).
- **Compression without an ingress (FR-30.26).** The web build writes `.br` and `.gz` beside each text asset (`packages/web/scripts/compress-assets.ts`); the server sends the one the browser accepts for a hashed file. An on-prem master's ingress passes it through.
- **Not there is not an error (FR-30.27).** `GET /api/auth/idp/config` answers `{ enabled: false }`, 200, where "Sign in with LGR" is not offered (it was a 404 on every visit to the sign-in page); an org without a logo answers 204, and Settings → Organization shows its placeholder. `integration/sign-in-with-lgr.flow` asserted the 404 and now asserts the 200: the one changed assertion, the behaviour FR-30.27 changes.

**Measured.** The icon font: 393.8 KB → 17.4 KB. The bundle's figures are what CI's `check:web` prints on the pull request (recorded there).

**Tests.** `unit/icon-subset.test.ts`, `integration/static-cache.flow.test.ts` (hash detection, immutable and not, Brotli and gzip with their types, both static modes), `e2e/first-load.spec.ts` (a clean sign-in page, one language, the picker's chunk only on opening it, the cache headers), `integration/sign-in-with-lgr.flow` (the 200).
