---
paths:
  - "packages/web/**"
  - "packages/ui-shared/**"
  - "packages/ui-shell/**"
  - "packages/desktop-ui/**"
  - "packages/e2e/**"
  - "packages/config/src/list-sorts*"
  - "packages/db/src/plugins/lowered-fields*"
---

# Rules and traps: The web app and its lists

Every ⚠ and every never/always rule of this area's history, copied whole with the bullet it sits in, by section.
Why each one exists, and what was built around it: [`docs/history/web-app.md`](../../docs/history/web-app.md).
`unit/claude-md.test.ts` fails when a ⚠ of that history is in neither this file nor `CLAUDE.md`.

## One app, step by step (FR-24, #402)

- ⚠ **Paths in routes, menus and back-to are relative to the MODULE** (`/orders`), never
  to a router base. `inModule(route, to)` adds the path of the module's shell record (`meta.module`).
  `unit/module-manifests.test.ts` resolves every one of them against its module's own routes.

- ⚠ **Every move goes through `ui-shared/nav/navigate.ts#goTo`**: a router push when the router serves
  the path, a page load otherwise. A page load drops a browser till's printer. Plain `<a href>` into
  the SPA follows the router (`installInAppLinks`, from `registerPlugins`). `unit/navigation-seam.test.ts`
  fails on any `window.location` assignment outside its list of deliberate page loads.

- `openPage` to the same view is a push plus a remount (`viewKey`), never a page load.

- **The one SPA, `packages/web`** (Phase 2; since Phase 3 the ONLY web build, FR-24.21). Its router is
  `web/src/modules/portal/routes.ts` (the portal's routes and `portalGuard`) plus every manifest (`web/src/modules.ts`)
  under ONE shell record (`OneShell` → `ModuleLayout`), so a move between modules never remounts the layout.
  One guard: portal rules for portal routes, an org session for a module's, after the till's rules
  (`web/src/modules/invoicing/pos/till-rules.ts#tillRedirect`).

- **Phase 3 deleted the seven split builds** (2026-11-01): each module's `index.html`, `vite.config.ts`,
  `main.ts`, `App.vue`, router and `DefaultLayout`; `UI_MODULES`/`moduleUiConfig`; the `dev:*-ui` /
  `build:*-ui` scripts; `devPort`; `portalBase`; `routerAppId`; `MovedToReportsView` (now named router
  redirects that keep the query); and the `?token=` dev handoff. ⚠ **Nothing reads a session token from a
  query string** (AC 7), and `unit/token-handoff.test.ts` fails on a UI source that does.

- ⚠ Redirects in a manifest go by NAME: a path names a router's base (the products redirect broke in the
  one SPA). `unit/module-manifests.test.ts` refuses a path redirect.

- **A move that fails has one rule, `stale.ts#installChunkRecovery`.** A deploy takes the files of every page
  a tab has not opened, and only a page load brings the new build, so it loads the page: for a chunk that did not
  arrive (any engine's wording, and Vite's `Unable to preload CSS`, the first failure a real deploy gives),
  once per build, with `/api/health` answering, and with no work in the tab. Never for a thrown guard, a bug
  or an API call. A lazy part of a page comes through `vite:preloadError`, which it never `preventDefault`s.
  ⚠ Asking the server takes a while, so what decides is read AFTER the wait: the newest failure is the one
  answered (a ticket per failure, never a latch, which a hung probe would hold), and a page the person reached
  or a move they started meanwhile stands. The probe has a time limit.
  ⚠ **"A new version" is the server's to say.** `/api/health` carries `x-lgr-build`, and only a build that differs
  from the page's offers the reload. A chunk that failed under the same build is a blip: the tab says the page
  did not load, and the same click may work. Calling that a new version also armed a forced load for the next
  move. ⚠ A first navigation that fails has nothing on screen: the tab says so (`deadStart`, App.vue), as
  `index.html` does once its entry's retries are spent, or at once with no storage to count them in.

- ⚠ **Two shells trade places in one document** in the one SPA: the portal's layout and `ModuleLayout`. The new
  one renders before the old one's unmount runs, so a shell-wide slot is set by a setter that returns its own
  undo, never cleared with `null` (`setRefusalTranslator`).

- Budget (FR-24.15, FR-30.25): `bun run check:web` (CI and the Dockerfile): first-load JS ≤ 360 KB gzipped, styles
  ≤ 60 KB gzipped, fonts ≤ 40 KB, 450 KB in all; no view in the entry, the fiscal bridge in one chunk. Read the
  bridge's status from `fiscalBridgeStatus`, never by importing `useFiscalBridge` into the shell's first load.

- ⚠ **No catalogue is in the first load** (FR-30.22): the session's language loads on demand, English too
  (`plugins/i18n#loadLocale`), and every SPA mounts after `whenI18nReady()`. Change a language with `loadLocale`,
  never by setting `locale.value`.

- ⚠ **The icon font is a subset** (FR-30.21): `ui-shared/src/styles/icons/`, written by
  `bun scripts/build-icon-subset.ts` from the `mdi-…` names the sources use. A new icon name fails
  `unit/icon-subset.test.ts` until that script has run and its three files are committed.

## Line Items Column Picker + Status Translatability (2026-04-28; defaults reworked 2026-07-26)

`ui-shared/composables/useInvoiceLineColumns(docType, { userId, orgId })` exposes 9-column catalog (description anchor, qty, unit, unitPrice, discount, taxRate, warehouse, **lineSubtotal** = qty×unitPrice net, lineTotal); per-doc-type localStorage key `lgr:invoice-line-cols:<userId>:<orgId>:<docType>` (falls back to the legacy `anon` key); Discount `defaultOn:false`; `discount` only on `invoice` + `proforma`. **Since 2026-07-26**: `lineSubtotal` defaultOn, `taxRate`/`warehouse`/`lineTotal` default OFF — the form shows doc-level single-value controls instead (TaxRateCombobox + WH autocomplete above the table, apply-to-all + seed for new lines; WH pin button persists a per-user default at `lgr:default-wh:<userId>:<orgId>`, init priority: loaded uniform → user default → org isDefault). Totals card shows "Tax Total (X%)" (`invoicing.taxTotalWithRate`) when all filled lines share one rate. Contact pickers in all 6 forms search server-side (debounced `search` + `size:20`; `contact.controller` `type` filter is `$in [type,'both']` so both-typed contacts appear as customer AND supplier). `LineColumnPickerDialog.vue` renders the checkbox grid with Select all / Clear / Reset Defaults. Cog button next to "+ Add line" on all 6 invoice form views drives `activeColumns` for thead/tbody. ⚠ A line's cells are rendered in that order too (`DocumentLineTable#lineCells`, 2026-11-15): they used to keep a fixed order of their own (subtotal before tax rate and warehouse), so with one of those two on a heading stood over another column's cells, and an order dragged in the picker moved only the headings. `usePaymentMethods()` in ui-shared returns translated `[{ value, text }]` from `pos.cash/card/bankTransfer/check`; v-selects use `item-title="text" item-value="value" persistent-placeholder` so labels render and placeholder stays visible. `StatusChip.vue` translates via `invoicing.status.<status>` with `te()` fallback to raw string. Status filter dropdowns (Sales/Purchase/Proforma/CreditNotes/DebitNotes/PaymentOrders) and kanban column titles migrated from raw string arrays / `statusDraft`-style flat keys to nested `invoicing.status.draft|sent|received|partially_paid|paid|overdue|voided|cancelled|completed|converted|issued|applied|approved|executed|accepted|expired` (16 keys × 4 locales).

- ⚠ A single-value select / combobox that draws its value through a **`#selection` slot** carries **`one-line-value`**, and `one-line-value--typing` while its `update:search` is non-empty (`PriceCombobox`, `TaxRateCombobox`, `LineUnitSelect`: the unit of a line, on every such table). Without it Vuetify puts the search input BESIDE the value and gives it 64 px on focus: in a narrow cell it wraps, the field grows from 32 to 60 px and the row jumps.

## Lists sort as they declare (FR-30 slice A, #795, 2026-11-16)

- Each key says how it is served: `index` (by name; `integration/list-plans.flow.test.ts` asserts from the profiler
  that the page reads at most five pages with no in-memory sort), `scan` (reads the filtered rows, with a reason) or
  `aggregate`. ⚠ A new `scan` key fails that test until it is added to its list there: it is a decision.

- ⚠ **`_id` is a key of every list** (2026-11-17), and no grid offers it. The import and audit tooling reads a
  whole list in pages with `sortBy=_id&sortOrder=asc` (`fetchAll` in `scripts/compare-stock-api.ts`,
  `.claude/skills/daily-import/predict.ts` and seven more), because pages need an order with no ties: rows whose
  sort keys are equal can come in another order for another skip, so a page repeats a row and leaves another out,
  and the reader's loop just ends. The first version of the table answered the id with the list's default sort (a
  name, a batch's insert moment, a movement's day: all with ties). `unit/list-sorts.test.ts` holds every `sortBy`
  the scripts and skills send to the table, so a key taken out of it, or a script asking for a new one, fails there.
  It holds their page sizes too: none above the ceiling below, none `size <= 0`. A script reads one answer and never
  looks at `truncated`, so "everything" in one request would be the first 1 000 rows, silently.

- ⚠ A list's default sort is an index's: `Product { orgId, createdAt }` / `{ orgId, name }`, `Invoice { orgId,
  direction, createdAt }` / `{ orgId, direction, invoiceNumber }`, `StockLevel { orgId, createdAt }`,
  `StockMovement { orgId, date }` / `{ orgId, createdAt }`. What is left in a list's time is its `countDocuments`.

- **A list answer carries at most 1 000 rows** (FR-30.8, `config/list-rows.ts#LIST_CEILING`): `findAll`,
  `paginateQuery` and the sorted-page helpers read "All" (`size <= 0`) and any larger size as the ceiling, and a cut
  answer says `truncated: true` with the real `total`. ⚠ Server code that needs every row uses `findMany`, or passes
  `unbounded: true` in the page request (the chart of accounts, the count form's `fields=count`): a `findAll` with
  `size: 0` or `size: 10000` is cut at 1 000 like any list.

## Cyrillic-Safe Search (2026-04-28)

⚠ **The product search reads one field, `Product.searchLower`** (FR-30.11): the five mirrors joined by U+001F, kept by
the plugin's `joined` option (`db/plugins/search-field.ts`) on save, `insertMany`, the update queries and `bulkWrite`,
with an index `{ orgId, searchLower, isActive, _id }` (`findAll`'s `hint`). A raw driver write leaves it unset: the
search still reads such an article by its mirrors, slower, until migration 0018 or
`scripts/backfill-product-search-field.ts` fills it. `PRODUCT_SEARCH_FIELD=off` is the switch back to the five fields.

## Generic grid column picker + price-select + Словом + perf (2026-07-26)

- **Per-user grid columns** (visibility + reorder) on EVERY `ListScaffold` grid: `ui-shared/composables/useGridColumns.ts` (localStorage `lgr:grid-cols:<userId>:<orgId>:<gridId>`, gridId = route name) + `GridColumnPickerDialog.vue`; a cog in the results header opens it. userId read from the JWT in localStorage (no app-store coupling). Grids NOT on ListScaffold (e.g. `StockLevelsView`) don't get it yet. ⚠ A saved order exists only after a MOVE and then wins, so a new default order reaches only users who never reordered; a column the saved order has never seen goes right after its catalog predecessor (`orderColumnKeys`, FR-22.46).

- **Price-select icon** (`ui-shared/PriceSelectButton.vue`) left of every invoice-line Unit Price: lists selling + all named tiers via `GET /pricing/options?...&all=true` (new `all` mode in `listPriceOptions` offers filterless Цена slots too); `onLinePriceSelected` sets price + base→chosen explanation.
  The same icon stands before every line's price on the **customer order** (`InternalOrderFormView`, new and saved;
  none on a closed order), for the order's client and the line's quantity: a pick is the line's `expectedUnitPrice`.
  **A price chosen on the line is the order's own** (`config/order-line-price`, one rule for the form, the route and
  the conversion): a pick or a typed figure sets `pricePinned` on the line, the button turns into a ticked tag
  (`data-pinned`), and **`/convert` charges that price**, from the customer order and from a supplier order that
  covers the line alike (`lib/reservation-convert.ts#pinnedOrderPrices`). The invoice line's trail keeps what the
  client resolves to and names the order after it as an `override` step (which the invoice form reads as "do not
  resolve again"). ⚠ A line nobody chose a price on is priced as before, by `resolvePrice` for the client on the day
  of the invoice, with `expectedUnitPrice` only its fallback when the article is gone: that is every line written
  before 2026-11-12, every order made from the Products list, and every line whose price is the default the form
  filled in (the article's selling price, NOT the client's price). ⚠ A pin needs a price above zero (an emptied
  field unpins); another article on a pinned line drops the pin and the price; the menu's first entry on a pinned
  line gives the choice back and shows the client's price of today. ⚠ A save that does not say `pricePinned` at all
  (a tab older than the field, a script) keeps the stored pin while the line's article and price are unchanged, and
  pins nothing new: the form therefore always sends `true` or `false`. ⚠ **Confirm and Convert save an unsaved edit
  first** (`InternalOrderFormView#saveIfNeeded`, quietly, as a document's Issue does): they used to act on the
  stored order and the reload after them dropped the edit, so "pick a price, press Convert" invoiced the client's
  price. The picker stands only while the order can still be saved, and by this person (draft or confirmed, the Save
  button's capability; else both buttons act on the stored order as before). The form's clean state is taken when
  its load resolves, never on a timer (FR-31.2), so a browser test may edit as soon as the order shows. ⚠ There it is `density="comfortable"` (20 px,
  the till's and the invoice's is 32 px) inside `.order-tree__num-group`, and the price column is 108 px to hold it:
  the tree's number columns are budgeted to the pixel, and `customer-order-tree.spec` measures the field, the button
  and the sideways scroll at 1366 px and 1920 px.

## Document lists: one row menu, fit 1366 px, a Create that says what (2026-10-26, FR-22 slice 2b: FR-22.23–.27, .50)

- **One menu per row** (FR-22.23/.24): `ui-shared/RowActionsMenu` (⋮, `row-action-<key>`). The
  rules are `web/src/modules/invoicing/composables/document-row-actions.ts` — pure, and
  `integration/document-row-actions.flow` holds each one against the real routes. ⚠ Void is offered
  on an ISSUED document (`sent`/`received`; an invoice for a cash sale when `paid`) and asks first;
  Delete on a DRAFT only. The lists had it the other way round („Анулирай" on drafts only, Delete on
  every row). A row also offers Печат (one click, the last print settings —
  `composables/print-settings.ts`, shared with the form), Копирай (`?copyOf=` → `copyOfDocument`:
  partner, terms, lines; dated today, numbered on save) and, on an issued invoice, the credit and
  debit note. A paid cash sale offers no Void any more (the till's storno is FR-21's).

- **Fits 1366 px** (`ListScaffold` `fit`): one line per row, 8 px gutters, a long name `cell-clip`ped
  (12em, or `--cell-clip`; the whole text in `title`). ⚠ On the sales list „Свързана фактура" and
  „Проформа #" are ONE column, „Свързан документ"; Currency is `defaultHidden` on all three lists
  (every amount is printed with its currency) and so is a bill's „Свързана фактура".
  `useGridColumns` knows `defaultHidden` (the cog shows it again; `shown` in the saved pref). With
  the widest rows (a 60-character name, a partly paid note, a converted proforma) the bg tables need
  1135 / 1143 of 1300 px; de shortened two labels to fit. Measure before adding a column.
  The rules are `ui-shared/styles/list-fit.css` (class `list-fit`, loaded by the Vuetify plugin):
  `ListScaffold` puts the class on its card, and a list with a table of its own (the stock
  movements, 2026-11-16) carries it itself.

- **Remembered per user and document type** (FR-22.26): the payment method
  (`lgr:pay-method:<docType>:<user>:<org>`), written when a NEW document is saved — editing an old
  one changes nothing; a cash sale's method is fixed and never remembered. „Последна цена за
  клиента" (`lgr:last-price:<docType>`) on the invoice and, now, the proforma.

## Typed API modules (FR-32.24, #797)

- **A screen of the inventory or invoicing module makes no HTTP call itself.** It calls a function
  of `web/src/modules/<module>/api/<resource>.ts`, which takes the body its route's schema declares and returns
  the answer its handler returns; the screen reads that answer as typed, never `data.x || data` or
  `_id || id`. A new call is a new function there, written from its controller. A composable is a
  screen here too (the document form's parts, the order forms' base). `unit/ui-api-modules.test.ts`
  fails on a file of either module outside its `api/` that imports or calls the HTTP client or
  reads an id both ways.
- **A route that reaches a fiscal device keeps its `Idempotency-Key`.** Its module function takes
  the attempt's `headers` (`createIdempotentAction#run`/`headers`) and sends them as the screen did:
  a document's create, a payment, a delivery receipt, a cash sale's invoice, a till session's open
  and close, a till sale.
- ⚠ **A write through an API module is a write for `unit/access-read-only` (FR-27.7).** A view
  writes when it sends `httpClient.post|put|patch|delete`, shows a Save, Delete or pencil, or calls a
  function it imports from a `src/api/` module whose body sends one of those. The write functions are
  read from the modules, so a new module needs no list; but a write function must send its request in
  its own body (a module function that only calls another helper that writes is not seen). Such a view
  must consult access (`v-cap`, a form action's `cap`, …) like any other: the bulk price adjustment
  and the opening-stock import pass by their `v-cap`. ⚠ `web/src/modules/invoicing/api/issue.ts` hands the
  client to `composables/document-issue.ts` (whose functions the integration tests drive with
  theirs): its functions are not seen as writes. A view issues through `useDocumentIssue`, never by
  importing them.
