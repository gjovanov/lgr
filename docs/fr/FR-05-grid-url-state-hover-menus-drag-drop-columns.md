# FR-05 — Grid state in the URL, hover-open menus, drag & drop column reorder

**Goal:** (a) Every grid's search/filters/page/size/sort live in the **querystring**, so
navigating into a detail page and going back restores the exact list state, and the URL is
shareable. (b) Top-nav group menus and the Apps menu **open on mouse-over** (desktop only).
(c) Column reordering in the column pickers becomes **drag & drop** instead of up/down arrows.
All three are global, across all apps.

Status: draft for implementation · Date: 2026-08-21 · Depends on: FR-01/FR-03 (build URL sync
into the final merged views, not the ones being replaced) · Feeds: —

---

## 1. Current state

**Grid state (nothing is in the URL today):**
- Page/size/sort live in `usePaginatedTable` (`packages/ui-shared/src/composables/usePaginatedTable.ts:33-40`):
  `{page: 0-indexed, size (default 10), sortBy: 'createdAt', sortOrder: 'desc'}`; wire params
  `page,size,sortBy,sortOrder,…filters`, `size=-1` ("All") sent as `0` (`:51-61`); filter
  changes reset page (`:93-98`).
- Search lives per-view in `useSearchDebounce` (300 ms, `useSearchDebounce.ts:8`); filters are
  view-local refs composed into a `filters` computed (e.g. `SalesInvoicesView.vue:287-301` —
  `search`, `status` CSV, `startDate`, `endDate`, `tags` CSV).
- `ListScaffold` is fully controlled (props in, `update:options` out) and touches the route
  only for `gridId` (`ListScaffold.vue:170,181`). **No view reads/writes `route.query`** for
  list state; the only query users are the auth-token handoff (stripped in `beforeEach`) and
  the pending-changes `?restore=<id>` deep-link (`DefaultLayout.vue:126` in every app).
- Routers: `createWebHistory` everywhere, **no `scrollBehavior`** anywhere.
- Consumers: 13 `ListScaffold` views (12 invoicing + `ProductsView`); ~27 further grids render
  `v-data-table(-server)` directly (inventory 8, accounting 8, portal 4, payroll 4, pos 3 —
  full list in section 2.1).

**Menus (all click-only):** `TopMenuBar.vue:6` (`v-menu :close-on-content-click="true" offset-y`),
`AppSwitcher.vue:46`, `UserMenu.vue:2`, `LocaleSwitcher.vue:2`, `NavFavoritesMenu.vue:2`,
`NotificationBell.vue:2`. `open-on-hover` appears nowhere in the repo. Mobile: TopMenuBar
renders a hamburger + `v-list-group` accordion (`:47-82`, `useDisplay().mobile`); AppSwitcher
renders a bottom sheet.

**Column reorder:** arrows in `GridColumnPickerDialog.vue:21-38` and
`LineColumnPickerDialog.vue:29-30`, backed by `move(key, ±1)` (`useGridColumns.ts:120-129`,
`useInvoiceLineColumns`). Persistence `{order: string[], hidden: string[]}` under
`lgr:grid-cols:<user>:<org>:<gridId>` / `lgr:invoice-line-cols:<user>:<org>:<docType>`.
No drag library exists in the repo (`vuedraggable`/`sortablejs`: not found in `bun.lock`).
Locked entries: `NEVER_HIDE = ['actions','data-table-expand','data-table-select']`
(`useGridColumns.ts:26`); line picker anchors `description` first + locked.

---

## 2. Requirements

### 2.1 Grid state in the querystring

- **FR-5.1 (MUST)** New composable `useListQueryState` in `ui-shared`:
  - declarative param schema per view: `{ key, ref, codec: 'string'|'int'|'csv'|'date', default }`;
  - **reads** `route.query` once at setup (before the first fetch) and hydrates the refs;
    invalid values fall back to defaults (clamp `size` to `{10,25,50,100,-1}`, drop unknown
    CSV members, reject unparsable dates);
  - **writes** via `router.replace({query})` (never `push` — Back must leave the list, not
    step through filter history), debounced ~250 ms, **merging**: only owned keys are
    touched, all foreign query params (`restore`, future ones) are preserved verbatim;
  - omits params at their default (clean URLs: `/invoices` not `/invoices?page=1&size=10`);
  - loop-guarded (skip write when the serialized owned-subset is unchanged; skip apply when
    the change originated from self).
- **FR-5.2 (MUST)** `usePaginatedTable` gains an opt-in `urlSync: true` that registers
  `page` (**1-based in the URL**, internal stays 0-based), `size`, `sortBy`, `sortOrder`
  through FR-5.1. Existing behavior (filter change resets page) must also reset the URL param.
- **FR-5.3 (MUST)** Canonical param names, shared by convention across every view:
  `q` (search), `page`, `size`, `sortBy`, `sortOrder`, `status` (CSV), `type`/`types` (CSV),
  `from`/`to` (ISO `YYYY-MM-DD` dates), `tags` (CSV), plus view-specific keys (`warehouse`,
  `category`, `contact`, …) named after the filter, not the wire param.
- **FR-5.4 (MUST)** Restore semantics: returning to the list via browser **Back** (or a link
  preserving the query) reproduces page, size, sort, search text (input field shows it —
  seed `search` so the debouncer doesn't refire a second fetch), every filter, and the view
  mode where a `ViewSwitcher` exists (`view=kanban`). Entering the bare URL yields defaults.
- **FR-5.5 (MUST)** Adoption wave 1 — all 13 ListScaffold views: SalesInvoices (merged),
  PurchaseInvoices (merged), Proforma, CashSales, CashOrders, PaymentOrders, Orders,
  InternalOrders, Reservations, Contacts (invoicing) + Products (inventory)
  (+ CreditNotes/DebitNotes only if FR-01 has not landed first).
- **FR-5.6 (MUST)** Adoption wave 2 — the non-ListScaffold grids: inventory (MovementsView,
  StockLevelsView, CategoriesView, WarehousesView, PriceListsView, InventoryCountView,
  InventoryValuationView), accounting (Accounts, JournalEntries, GeneralLedger,
  FinancialStatements, TaxReturns, BankAccounts, ExchangeRates, FixedAssets), portal
  (AuditLog, Users, Invites, PermissionSets), payroll (Employees, PayrollRuns, Payslips,
  Timesheets), pos (Transactions, Sessions, Devices). Same composable; these views wire their
  hand-rolled filters explicitly.
- **FR-5.7 (SHOULD)** Add `scrollBehavior` to every app router: return `savedPosition` on
  back/forward, else `{top: 0}` — so Back also restores the scroll offset.
- **FR-5.8 (SHOULD)** React to `route.query` changes while mounted (popstate between two
  filter states of the same list) by re-hydrating — guarded by FR-5.1's loop protection.

### 2.2 Hover-open menus (desktop only)

- **FR-5.9 (MUST)** Shared capability signal in `ui-shared`, e.g. `useHoverMenus()`:
  `enabled = !useDisplay().mobile && matchMedia('(hover: hover) and (pointer: fine)').matches`.
  Touch devices and the mobile breakpoint keep click/tap-only behavior (the mobile accordion
  and bottom sheet are untouched by construction).
- **FR-5.10 (MUST)** `TopMenuBar.vue` group menus: `:open-on-hover="hoverEnabled"` +
  `open-on-click` (both — hover opens, click still toggles for hybrid devices),
  `:open-delay="100"`, `:close-delay="250"` (delays tuned so sweeping the cursor across the
  bar doesn't flicker adjacent groups, and moving from activator into the list doesn't close
  it — Vuetify keeps a hover-opened menu open while the pointer is over its content).
- **FR-5.11 (MUST)** `AppSwitcher.vue` desktop menu: same treatment.
- **FR-5.12 (SHOULD)** `UserMenu` and `LocaleSwitcher` (simple navigation lists): same.
  **Explicitly unchanged**: `NotificationBell` and `NavFavoritesMenu` — interactive panels
  (`:close-on-content-click="false"`, buttons inside); hover-close semantics fight with
  clicking around inside them.
- **FR-5.13 (MUST)** Keyboard behavior unchanged (activator focus + Enter still opens; menu
  items tabbable) — hover is additive, not a replacement.

### 2.3 Drag & drop column reorder

- **FR-5.14 (MUST)** Replace the up/down arrow buttons in **both**
  `GridColumnPickerDialog.vue` and `LineColumnPickerDialog.vue` with drag & drop:
  a `mdi-drag-vertical` handle per row, whole-row draggable, drop reorders and persists via
  the existing `pref.order` mechanism (storage shape unchanged — no migration).
- **FR-5.15 (MUST)** Implementation: add `vuedraggable@^4.1` (SortableJS) to `ui-shared` —
  touch support (long-press) and ghost/placeholder styling out of the box. (Alternative if a
  new dependency is vetoed: hand-rolled HTML5 DnD `dragstart/dragover/drop` — accept that
  native HTML5 DnD has no touch support and FR-5.17 becomes the touch path.)
- **FR-5.16 (MUST)** Constraints preserved: line picker's `description` anchor row is pinned
  first — excluded from dragging and an invalid drop target above it; `NEVER_HIDE` entries
  remain visible-locked but stay reorderable (same as arrows today). Reset button behavior
  unchanged.
- **FR-5.17 (SHOULD)** Keyboard accessibility replacement for the removed arrows: rows
  focusable, `Alt+↑/↓` moves the focused row (reuses the existing `move(key, ±1)` — keep that
  function; only the buttons go away).

## 3. Edge cases

1. **`?restore=<id>`** (pending-changes deep link) and any unknown param **must survive**
   every URL write (FR-5.1 merge rule). The auth `?token/org` params are stripped by the
   router guard *before* views mount — no interaction.
2. **`size=-1` ("All")** round-trips as `size=-1` in the URL; wire conversion to `0` stays
   internal.
3. **Invalid/hostile query values** (`page=999999`, `status=<script>`) — clamp page into
   `1..totalPages` after the first fetch (refetch page 1 if out of range), CSV members
   validated against the view's known option set, everything else is plain text sent as a
   search param (server already treats it as data).
4. **Two tabs, same list, different filters** — independent URLs; localStorage column prefs
   remain shared (unchanged, correct).
5. **Locale switch / theme toggle** re-renders — refs persist; URL untouched.
6. **Kanban↔list view switch** must not drop the query (single merged write).
7. **Debounced search vs. Back**: the URL carries the *debounced* value; hydration sets both
   `search` and `debouncedSearch` so exactly one fetch fires.
8. **Hover + open menu while navigating**: route change closes menus (Vuetify default) — keep.
9. **Drag in a 9-row dialog on a 320px phone**: SortableJS long-press delay ≥150 ms so the
   dialog can still scroll by touch; verify on a real device.
10. **gridId stability**: URL sync must not change route names — column prefs are keyed by
    them (README constraint #3).

## 4. Integration & regression

- e2e specs that navigate lists must keep passing — default URLs stay clean (FR-5.1 omission
  rule), so existing `page.goto('/invoicing/invoices')` flows see no query noise.
- `usePaginatedTable` is used by pickers/dialogs too (ContactPickerDialog,
  ProductPickerDialog) — `urlSync` is opt-in; dialogs must NOT opt in.
- The pending-changes restore flow and page-favorites tracking (`router.afterEach` →
  `matchPage(pathname)`) ignore query strings — verified unaffected (`matchPage` uses
  `pathname` only).
- Bundle: vuedraggable+sortablejs ≈ 45 kB min — acceptable; goes into `ui-shared` (shared
  chunk across apps).

## 5. Acceptance criteria

- [ ] Products: search "болт", page 3, size 50, category filter → open a product → browser Back → identical grid (inputs, chips, page, scroll).
- [ ] The same URL pasted into a new tab reproduces the state; bare URL = defaults, clean address bar.
- [ ] Works on every wave-1 view + at least MovementsView/AuditLog from wave 2; kanban mode round-trips.
- [ ] `?restore=` survives filtering; token/org handoff still logs in.
- [ ] Desktop: hovering "Products" opens the submenu without click; moving across groups switches cleanly; Apps menu opens on hover; everything still click-openable. Mobile + touch: unchanged (tap only).
- [ ] Column picker: drag a column between positions → order applies live and persists across reload; anchor/locked rows behave; works by touch; `Alt+↑/↓` (SHOULD) works.
- [ ] `bun run build` all UIs; e2e list specs green; new e2e: back-restores-state spec.

## 6. Field test (lgrai.app / regal)

1. Real workflow: Products → search a DIN tag → page through → open product → Back — state
   held. Repeat on Sales Documents with status+date filters and on Stock Movement Documents.
2. Share a filtered URL between two browsers/users — same view (modulo their own column prefs).
3. Verify pending-changes restore banner still round-trips (`?restore=`).
4. Laptop with touchscreen: hover opens menus with the trackpad, touch taps still work.
5. Phone (real device): menus tap-only; column dialog drag by long-press; list state survives
   Back on mobile Chrome.
6. Watch for double-fetches in the network tab on list load (hydration must not fire two
   requests) — one request per state change.
