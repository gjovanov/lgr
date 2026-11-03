# FR-26 — Seller and Sales Consultant roles; an Administrator who does not see Reports

| | |
|---|---|
| **Status** | Specified 2026-11-03. The defaults in §7 stand unless the owner answers otherwise on the issue. Nothing built. |
| **Tracking** | [gjovanov/lgr#493](https://github.com/gjovanov/lgr/issues/493). Implementer: @lazarovski |
| **Builds on** | S-28/S-29 (`route-permission.ts`: every route has a read and a write rule), FR-22 §5.8 (`canOpenPage`, the one rule for who may open which page), FR-24 (one SPA, module manifests), FR-19 (person + memberships, `tokenVersion`), FR-06 P2 (`reports.read`) |
| **Code anchors** | origin/master `cf7dac86` (2026-11-03), which is what production ran that day (`v20261103-cac525f5deeb`). Anchors, not gospel. |

## 0. The request (owner, 2026-11-03)

1. An administrator of org `regal` (the test org; added 2026-11-02) does not see the Reports app.
2. Two new roles:
   - **Seller.**
     - Invoicing without Orders, Incoming Documents, Payments and Configuration → Sequences.
     - Inventory without Price Lists. Products are kept, without the Export option.
     - Warehouse → Warehouses and Stock Movement Documents. There „Нова стокова разписка" is renamed and only Type = Transfer is available.
     - No access to, and no sight of, Portal, Accounting, Payroll, Reports or Files.
   - **Sales Consultant.** The same, plus Orders: incoming orders, outgoing orders and reservations.

The request names the new label „Нова стоково движение". „Движение" is neuter, so the label is **„Ново стоково движение"**.

## 1. A — an Administrator who does not see Reports

### 1.1 What was checked (2026-11-03, read-only, production)

- **Her membership.** Role `admin`, one permission set: the org's own `Administrator` set, `isAdmin: true`, same org. `tokenize()` gives an `isAdmin` set every permission (`services/biz/auth.service.ts:632`), `reports.read` included.
- **The org.** Its `reports` app row is enabled.
- **The code.** `GET /org/:orgId/apps` lists the apps the session's permissions open (`services/biz/app-hub.service.ts:47`). The App Hub draws every app it gets (`portal-ui/src/views/AppHubView.vue`), and so does the app switcher (`ui-shell/src/components/AppSwitcher.vue`). No request-time step narrows a session's permissions (`session-token.ts#asSessionUser`, `identity/session.service.ts#liveSessionUser`).
- **A live check, as the demo org's Administrator.** The session holds `reports.read`. `/apps` returns `accounting inventory invoicing payroll reports files`. The hub and the switcher show „Справки", the Reports app lists 27 reports, and the console shows no errors.

So it does not reproduce from her data or from the deployed code.

### 1.2 What it can still be, most likely first

1. **The name.** In Bulgarian the app is „Справки", not "Reports".
2. **The fold.** The hub puts four apps in a row. „Справки" is the first tile of the second row, below any pinned favourites. On a laptop that row can be off-screen.
3. **Another session in her tab.** A tab keeps its own session, and a new tab adopts the one the browser stored last. On a shared counter PC that can be someone else's session, in another org.
4. **A PlusMinus справка by its own name.** For example, „справка за продажни фактури" is Reports → sales documents here.

### 1.3 Requirements

- **FR-26.1 MUST — find it with her.**
  - Get the URL and a screenshot of the App Hub and of the app switcher (⊞ in the top bar), in her language, and go through 1.2.
  - If the tile is missing after she signs out of every tab and signs in again, decode her session token's payload in her browser and see whether `permissions` holds `reports.read`. Never paste the token anywhere.
  - Find the layer that drops it, fix it with a regression test, and write the cause on the issue.
- **FR-26.2 SHOULD — the hub follows the server's rule for `admin`.**
  - The server refuses an `admin` no read and no write (`route-permission.ts#readRefusal`, `#writeRefusal`), and `canOpenPage` opens every page for one. `getAvailableApps` lists tiles by permissions alone.
  - So an admin whose set lacks an app's permission (a legacy non-`isAdmin` set, say) gets every page of the app and no tile for it, which is exactly this symptom.
  - Not her case, but it is one way to produce it. Fix: list every app for role `admin`.

## 2. B — the two roles

### 2.1 What each role gets

| | Seller | Sales Consultant |
|---|---|---|
| **Invoicing** | | |
| Outgoing documents: sales documents (invoice, credit note, debit note), proforma | ✓ | ✓ |
| The till: Terminal, cash-sale journal, sessions (D-8) | ✓ | ✓ |
| Orders: incoming orders (ORDI), outgoing orders (ORDO), reservations (D-7) | ✗ | ✓ |
| Incoming documents (bills) | ✗ | ✗ |
| Payments: payment orders, cash orders (D-2) | ✗ | ✗ |
| Configuration: Contacts | ✓ | ✓ |
| Configuration: Sequences | ✗ | ✗ |
| Configuration: Devices (read-only, as for any till user) | ✓ | ✓ |
| **Inventory** | | |
| Products: read-only (D-4), **no Export** | ✓ | ✓ |
| Categories: read-only (D-3) | ✓ | ✓ |
| Warehouses: read-only | ✓ | ✓ |
| Stock movement documents: **Transfer only** | ✓ | ✓ |
| Stock levels, Inventory counts, Inventory valuation, Opening stock (D-3) | ✗ | ✗ |
| Price lists, Bulk pricing | ✗ | ✗ |
| **Other apps** | | |
| Portal (App Hub, Dashboard, Settings, Admin) | ✗ | ✗ |
| Accounting, Payroll, Reports, Files | ✗ | ✗ |
| **Their own** | | |
| Account (password), the org menu, sign-out, notifications, language, ★ | ✓ | ✓ |

✗ means hidden **and** refused by the server. A hidden page whose data a kept page needs stays readable; §2.4 says which.

### 2.2 What the code does today

1. **Permissions are per module.**
   - `config/src/constants.ts:14` lists `invoicing.read|write|send`, `inventory.read|write|adjust`, `pos.read|write`, and so on. Nothing names orders, bills, payments, price lists or a movement type.
   - The nearest role, `sales` (`constants.ts:65`), sees all of Invoicing, reads all of Inventory and opens Reports.
2. **The server decides by route prefix** (`services/biz/route-permission.ts`).
   - Reads under `invoicing` need any invoicing permission (`:173`). Writes under `warehouse` need `inventory.write` (`:103`).
   - Bills share `/invoices` with sales invoices: only `direction` tells them apart (`invoicing-api/src/controllers/invoice.controller.ts`, the list's `direction` filter, ~`:559`). No prefix can separate them.
3. **The UI asks `canOpenPage`** (`ui-shared/src/nav/page-registry.ts:254`). The invoicing menu filters every entry through it (`invoicing-ui/src/pos/till-rules.ts#withTillRules`). **The inventory menu filters nothing**: `inventory-ui/src/manifest.ts` lists its eleven entries to anyone in Inventory.
4. **Sequences.**
   - The server already lets only admin and manager in (`route-permission.ts:172`).
   - The page row has no rule (`page-registry.ts:85`). Every invoicing user gets a menu entry the server refuses.
5. **Portal.**
   - The switcher's Portal tile is hard-coded, both mobile and desktop (`AppSwitcher.vue`).
   - `portalPagesFor` offers Dashboard to any invoicing reader, and Organization and Users to anyone holding a back-office permission (`page-registry.ts:276`).
6. **The movement form.**
   - It defaults to `receipt` and offers four types (`inventory-ui/src/views/MovementFormView.vue:372,380`).
   - The list's button reads „Нова стокова разписка" (`nav.newDocPage.goodsReceipt`, `MovementsView.vue:11`), and so does the ★/search row (`page-registry.ts:108`).
7. **Products' Export menu is a stub** (`ProductsView.vue:14`; `onExport` at `:325` only logs). No product export route exists.
8. **The reports API never checks `reports.read`.**
   - `/reports/catalog`, `/:id/run` and `/:id/export` gate on each report's own module permission (`reports-api/src/controllers/report.controller.ts:170,181,219` → `canAccessReport`).
   - So hiding the tile does not keep anyone out. `purchase-documents` and `order-sheet` would read bills and orders past any restriction set in this FR.
9. **The role and the sets can disagree, and the sets win:** `tokenize()` uses a user's permission sets whenever one resolves.
   1. **A role change keeps the sets.** It rewrites only the user's own `permissions` (`portal-api/src/controllers/user.controller.ts:183-204`). A user on the `Administrator` set who is made a Seller stays an administrator in all but the role name.
   2. **An invite gets the org's default set.** An invite accepted with any non-admin role gets „Member (Read Only)" (`services/biz/identity/account.service.ts:243-249`), not its role's set. An invited Seller would read Accounting and open Reports.
   3. **A session keeps what it was issued with for 24 h** (`portal-api/src/auth/session-cookie.ts:4`). A demoted administrator stays one until it expires.

### 2.3 Design: areas

Why not new positive permissions (`invoicing.orders`, …)? Every stored set, user list and invite would need a migration, on the pattern of `0013-accounting-file-permission`. Worse, every session issued before it would lose Orders, Bills and Payments until its owner signs in again. That is the trap FR-6.2 documents for `reports.read`.

Areas restrict only the sets that opt in, so nothing that exists today changes.

**Vocabulary** (`config/src/constants.ts`, a new `AREAS`):

| Area | Pages | Server |
|---|---|---|
| `portal` | App Hub, Dashboard, Settings, Admin | `dashboard` reads |
| `orders` | Incoming orders, outgoing orders, reservations, and their `/new` rows | `invoicing/orders`, `invoicing/internal-orders`, `invoicing/reservations`; order links on invoices |
| `purchases` | Bills and `/bills/new` | `bills/import`, `invoicing/bills`; incoming documents under `/invoices` (controller) |
| `payments` | Payment orders, cash orders | `invoicing/payment-order`, `invoicing/cash-order` |
| `pricing` | Price lists, Bulk pricing | `warehouse/price-list`, `warehouse/bulk-pricing` |
| `stockControl` | Stock levels, Inventory counts, Inventory valuation, Opening stock | `warehouse/inventory-count`, `warehouse/opening-stock`, `warehouse/cost-layer/valuation` |
| `catalogExport` | Products → Export | none yet; a product export route names it |

**Model.** `PermissionSet.areas?: Area[]`, `UserTokenized.areas?: Area[]`, and `DEFAULT_ROLE_AREAS: Partial<Record<Role, Area[]>>` for users without sets. Only the two new roles have an entry.

> ⚠ **Absent and `[]` mean opposite things.** Absent: unrestricted, today's behaviour, every
> existing set and every token already issued. `[]`: no area at all. Three places get this wrong
> by default, and each one fails OPEN or locks everyone out:
> - **Mongoose gives an array path `[]` by default.** Declare
>   `areas: { type: [String], default: undefined }`, or every existing set reads as "no area" on its
>   next save. A test saves a set without areas and asserts the key is absent when read back.
> - **JSON cannot send `undefined`.** The set API takes `areas: null` for "unrestricted" (the service
>   `$unset`s it) and `[]` for "none".
> - **Every path that mints a session must carry the claim.** That is password, Google/OAuth,
>   `/auth/switch`, an accepted invite, and the FR-20 IdP and PIN. A path that drops it issues an
>   UNRESTRICTED session. Test each one.

**Merging several sets** follows `ownRecordsOnly`'s rule, most permissive wins:
- an `isAdmin` set, or any set without `areas`, means no claim (unrestricted);
- otherwise the claim is the union of the sets' lists.

**Checks.**
- A route rule gains an optional `area`.
- `readRefusal` and `writeRefusal` refuse a session whose claim exists and lacks the rule's area. `admin` passes, as it does today.
- `canOpenPage` does the same with `PageDef.area`. `PageViewer.areas` comes from the session's claims.

**Transfers** are a permission, not an area. The new **`inventory.transfer`** writes transfer movements and nothing else. `inventory.write` keeps every type, so nobody else changes and nothing is migrated.

### 2.4 Requirements

**FR-26.3 — the roles.** `seller` and `sales_consultant` join `ROLES` (`constants.ts:11`). The Users screen's picker and `user.controller`'s body schema follow from it.

| Role | `DEFAULT_ROLE_PERMISSIONS` | `DEFAULT_ROLE_AREAS` |
|---|---|---|
| `seller` | `invoicing.read`, `invoicing.write`, `invoicing.send`, `pos.read`, `pos.write`, `inventory.read`, `inventory.transfer` | `[]` |
| `sales_consultant` | the same | `['orders']` |

- Neither role holds `accounting.*`, `payroll.*`, `reports.*` or `admin.*`. Those tiles disappear by themselves, and the server already refuses those modules.
- Labels: `settings.roles.seller` and `settings.roles.sales_consultant`, ×4 locales (D-9).
- `sales` and the other roles do not change.

**FR-26.4 — the system sets.**
- Add „Seller" and „Sales Consultant" to `DEFAULT_PERMISSION_SETS` and `ROLE_TO_PERMISSION_SET` (`services/biz/permission-set.seed.ts`), with the permissions and areas above.
- A new migration seeds them into every org. Use the next free number, and check open PRs: released migration files are frozen.
- `seedDefaultPermissionSets` matches by name, so it would adopt a custom set already called „Seller" as it is. The migration reports such a collision instead of adopting it.

**FR-26.5 — areas.** Implement §2.3: the model, `tokenize()`, the claim on every session path, `canOpenPage`, and the two refusals.
- A set's `areas` are validated against `AREAS` on write.
- The Permission sets screen edits them: "all areas" (the default, stored absent) or "only:" with one checkbox per area.

**FR-26.6 — what the server refuses, and what stays open.** For a session whose claim lacks the area:

| Area | Refused (reads and writes) | Controller checks | Stays open, because a kept page needs it |
|---|---|---|---|
| `portal` | `dashboard` | | the org (`''`), `user`, `apps`, `notification`, `logo`, `tags`, `licence`, `home`: the shell and the pickers |
| `orders` | `invoicing/orders`, `invoicing/internal-orders`, `invoicing/reservations` | An invoice POST/PUT that **adds or changes** `orderId`, `orderGroupId`, `internalOrderId` or a line's `orderRef`: 403. The form round-trips `orderRef` verbatim, so a document that already carries links saves unchanged. `invoicing/product-supply` (#203) answers quantities without order or reservation numbers. | `stock-availability`, including `create-transfers` from the invoice form |
| `purchases` | `bills/import`, `invoicing/bills` | In `invoice.controller.ts`: `GET /invoices` lists outgoing documents only, whatever `direction` asks. By id, an incoming document is 404 for GET, PUT, DELETE, send, receive, void, payments, convert and to-invoice. POST with `direction: 'incoming'`: 403. `doc-import` with a bill target: 403. `invoicing/export/kind/incoming` and a list export of incoming documents: 403. The contact ledger and `invoicing/contact/:id/summary` leave incoming documents out. | `invoicing/contact`: the Contacts page, suppliers included |
| `payments` | `invoicing/payment-order`, `invoicing/cash-order` | | `POST /invoices/:id/payments` on an outgoing document, with its FR-23 receipt (D-2) |
| `pricing` | `warehouse/price-list`, `warehouse/bulk-pricing` | | `pricing/*`: the invoice form resolves and offers prices through it |
| `stockControl` | `warehouse/inventory-count`, `warehouse/opening-stock`, `warehouse/cost-layer/valuation` | | `warehouse/stock-level`: the product page and the transfer form read it. The Stock levels page is only hidden. |
| `catalogExport` | — | Any product export route added later names this area. | |

Two refusals that are not areas:
- **Reports.** `reports/catalog`, `reports/:id/run` and `reports/:id/export` require `reports.read` on top of `canAccessReport` (§2.2 item 8); admins pass. Every default role holds `reports.read` today, so no role changes. A custom set without it loses the API as it already lost the tile.
- **Sequences.** Already admin and manager only on the server.

The route table:
- `route-permission.flow.test.ts` keeps failing on a route with no rule.
- A new assertion fails on a route under a carved-out prefix that has no area.

**FR-26.7 — transfers only.**
- Writes under `warehouse/movement` need `inventory.write` or `inventory.transfer`: a rule placed ahead of `warehouse`.
- For a caller without `inventory.write`, the controller (`warehouse-api/src/controllers/movement.controller.ts`) refuses with 403:
  - create (`POST /`) and edit (`PUT /:id`) with any type but `transfer`;
  - confirm (`POST /:id/confirm`) and delete (`DELETE /:id`) of a movement that is not a transfer;
  - `POST /with-update`, which only books receipts.
- A transfer needs both warehouses.

**FR-26.8 — the UI.**
1. **Page rows get their areas** (§2.3). The ★ menu, „+ Нов", the page search and the invoicing menu follow, through `canOpenPage`.
2. **The inventory menu filters through `canOpenPage`** like the invoicing one. Empty groups vanish.
3. **Sequences: admin and manager only.** The row gets `need: []` and `roles: ['admin', 'manager']`, as the server already decides. This also removes the entry for every other role, which the server refuses today.
4. **Portal.**
   - There is no Portal tile in the switcher, and no App Hub, Dashboard, Settings or Admin page.
   - Sign-in, an org switch, `/`, `/apps`, `/dashboard`, `/settings/*` and `/admin/*` land on the first app they may open: Invoicing.
   - `/account`, `/orgs`, sign-out, notifications, language, theme and ★ stay.
5. **The movement form**, for a session without `inventory.write`:
   - Type offers Transfer only, preselected, and both warehouses are required.
   - The receipt-only parts never show: the product-update chip and the bill link.
   - A movement that is not a transfer opens read-only.
6. **The rename (D-1).**
   - A new key, `nav.newDocPage.stockMovement`, reads „Ново стоково движение" (en "New stock movement", de "Neue Lagerbewegung", mk „Ново движење на стока").
   - It replaces `nav.newDocPage.goodsReceipt` on the list button (`MovementsView.vue:11`) and on the `/inventory/movements/new` row (`page-registry.ts:108`). That row's `need` becomes `['inventory.write', 'inventory.transfer']`. `unit/page-registry.test.ts:115` pins the old key.
   - In „+ Нов", whoever can make a receipt keeps „Стокова разписка". A transfer-only session sees „Стоково движение".
7. **Products, Categories and Warehouses** open read-only without `inventory.write`: no New, Save or Delete. Products shows no Export without `catalogExport`.
8. **The invoice form** offers no order or reservation links without `orders`. The product page's supply panel shows quantities only.

**FR-26.9 — assigning a role takes effect.**
1. **A role change replaces the user's system role set** with the new role's (`ROLE_TO_PERMISSION_SET`). Custom sets stay. This closes §2.2 item 9.1.
2. **An invite accepted with a role that has a system set gets that set**, not the org's default (§2.2 item 9.2).
3. **The Users screen warns** when a user's role and sets disagree, and shows the effective permissions and areas.
4. **A change of a user's role or sets ends their sessions within a minute**: bump the person's `tokenVersion`, as a password change does. `identityStillValid` caches for 60 s. This closes §2.2 item 9.3 (D-10).

**FR-26.10 — nothing else changes.**
- Existing roles, `sales` and existing permission sets behave as before.
- The existing suites pass unmodified, except the tests that pin the renamed label and the Sequences row.

### 2.5 Edge cases

- **Several sets.** An unrestricted set wins. Seller plus Sales Consultant is the union, so Sales Consultant.
- **Several orgs.** Sessions are per membership: a person can be a Seller in one org and an admin in another.
- **A tab.** Each tab keeps its own session (FR-19 Phase 3). A Seller's tab never adopts a role from another tab.
- **A PIN session** (FR-20) still reaches the till only, whatever the role.
- **An on-prem master** (FR-20).
  - Permission sets replicate, `areas` with them.
  - A master on an older release ignores `areas`, so it would serve a Seller UNRESTRICTED.
  - Assign these roles only where the master runs this release.
- **A link to a bill or an order** (a shared URL or a ★ pinned by someone else) shows a not-found page. It must not crash.
- **An invoice converted from an order**, edited by a Seller: it saves with its links unchanged (FR-26.6).
- **Storno.** At the till and in the journal it stays with admin, manager and warehouse manager (FISCAL_ADMIN_ROLES).
- **Links into Reports** from Inventory or Invoicing (`product-doc-actions.ts`) already ask `canOpenPage`, so they disappear.

## 3. Rollout and rollback

- **One release, expand and contract.** The previous release ignores `areas` and `inventory.transfer`.
- **Order.** Deploy, then `bun run migrate` (the two sets in every org), then the owner assigns roles. Nobody else needs a backfill or a fresh sign-in.
- **Rollback.** First move every user holding `seller` or `sales_consultant` to another role: the previous release rejects those names in `user.controller`'s schema and would ignore their areas. Then roll the image back. The seeded sets can stay.

## 4. Tests

- **Unit.**
  - `page-registry.test.ts`: areas; absent against `[]`; the Sequences row; the renamed label.
  - `route-permission`: area refusals, and the transfer rule.
  - `tokenize()`: absent, `[]`, union, `isAdmin`, and an unrestricted set winning.
  - The permission-set model: saved without areas, read back without the key.
- **Integration.**
  - `route-permission.flow`: every route under a carved-out prefix has an area.
  - `read-permission.flow` gains both roles. Every read their pages make passes, and the carved-out reads answer 403.
  - A new `seller-roles.flow.test.ts`:
    - bills by direction: the list, by id, create, and the incoming export;
    - order links: added → 403, unchanged → 200;
    - movements: create, edit, confirm, delete and with-update;
    - `reports.read` on the three report routes;
    - a role change replaces the system set and ends sessions;
    - an accepted invite gets the role's set;
    - the migration is idempotent and reports a name collision.
- **e2e** (`roles.spec.ts`). Sign in as each role and check:
  - the switcher shows exactly Фактуриране and Склад, with no Portal tile;
  - the menus match §2.1, and „+ Нов" matches per role;
  - the movement form offers Transfer only;
  - `/apps` lands on Invoicing.
- ⚠ Never `.rejects` or `.resolves` in this suite (CLAUDE.md, Known Issues).

## 5. Acceptance criteria

1. Part A is closed, with the cause written on #493 (FR-26.1). The hub lists every app for role `admin` (FR-26.2).
2. §2.1 holds for both roles, in the UI and on the server, in bg and en.
3. Nothing changes for any existing role (FR-26.10).
4. A role change and an invite give exactly the role's set, and the old sessions end within a minute.
5. `bun run test`, `bun run build`, `bun run test:e2e` and CI are green.
6. The field test (§6) passes on production, and its users are dropped.

## 6. Field test (production, after deploy and migrate)

Run it in the demo org `acme-corp`, never in `regal`.

1. Create two temporary users with `scripts/seed-user.ts --role seller` and `--role sales_consultant`.
2. Sign each in by API. Check the claim: `areas: []` and `['orders']`.
3. Walk §2.1 in a headless browser, in bg: the switcher, both menus, „+ Нов", and the movement form.
4. Through the API, check every refused route of FR-26.6 (403, or 404 for an incoming document by id), and every read the kept pages make (200).
5. A draft transfer saves (201) and is deleted. A draft receipt is refused (403).
6. An admin changes one user's role. That user's session ends within a minute.
7. Drop both users and confirm that their sign-in answers 401.

## 7. Decisions (defaults stand unless the owner answers otherwise)

| | Question | Default |
|---|---|---|
| D-1 | Who gets the rename? | Everyone, on the list button and the ★/search row: the form makes every type. In „+ Нов", receipt-capable sessions keep „Стокова разписка". |
| D-2 | Is a payment on their own outgoing invoice "Payments"? | No: it stays allowed, with its FR-23 receipt. "Payments" means the Payment orders and Cash orders pages. |
| D-3 | What about the inventory pages the request does not name? | Categories stay, read-only (they are part of Products). Bulk pricing goes with Price lists. Stock levels, Inventory counts, Inventory valuation and Opening stock are hidden. The product page's own stock tabs stay. |
| D-4 | May they create or edit products, categories or warehouses? | No, read-only. |
| D-5 | Do they see cost figures on products (purchase price, average cost, „Доставна цена")? | Yes, as today: not asked. |
| D-6 | Only their own documents? | No: every outgoing document of the org, as `sales` sees today. |
| D-7 | Does the Sales Consultant get supplier orders (ORDO) too? | Yes, the whole Orders group. |
| D-8 | The till? | Both roles get it: Terminal, the cash-sale journal, sessions. Storno stays with admin, manager and warehouse manager. Devices are read-only. |
| D-9 | Names | „Продавач" / „Търговски консултант"; en Seller / Sales Consultant; de Verkäufer / Verkaufsberater; mk Продавач / Консултант за продажба |
| D-10 | Does a role change sign the person out only in this org? | No, everywhere (`tokenVersion` is the person's). Role changes are rare, and a demotion must not wait 24 h. |
