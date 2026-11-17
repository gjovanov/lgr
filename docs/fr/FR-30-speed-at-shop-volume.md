# FR-30 — Speed at shop volume: lists, searches, reports, heavy screens, PDFs and the first load

| | |
|---|---|
| **Status** | Specified 2026-11-16. Slice A built (FR-30.1 to .4, §11). The defaults in §9 stand unless the owner answers otherwise on the issue. |
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
- **Caching.** Files whose names carry a content hash are served with `public, max-age=86400`, the static plugin's default (`portal-api/src/spa-fallback.ts`), and not as immutable.
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

**Turned off in the grids**, because the server never sorted by them (they are names looked up after the page): the contact on Sales invoices and Bills, the article's SKU and name and the warehouse on Stock levels.

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
| Opening a saved 3-line / 30-line invoice | the document read twice, an article and a set of price options per line (70 for 30 lines in the audit) | see the PR: the same count for 3 and 30 lines, the document read once |

**Tests.** `integration/list-projection.flow.test.ts` (the keys of a row with and without `fields=list` on every list, the size of 100 rows, the ceiling, the lean "all", the chart, the contact's figures, a document's line names); `unit/list-rows.test.ts` (the ceiling's arithmetic, the size control, the hand-over); `e2e/list-requests.spec.ts` (the list walk's request count, `fields=list` on the wire, a 3-line and a 30-line invoice opened with the same number of requests and the document read once, a line's options asked for when its price is opened, a bookmarked "All", "All" offered within the ceiling only).

**Decisions.** "No price tiers" (FR-30.7) is read as "no price slot's filters": the Products grid shows each slot's price in a column of its own (FR-22.44), so a row keeps the slot's name and price. A remembered "All" is read as 100 and not refetched as "All" once the total is known: §4 says it is read as the largest option.
