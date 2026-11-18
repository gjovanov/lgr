---
paths:
  - "packages/portal-api/src/auth/**"
  - "packages/portal-api/src/controllers/**"
  - "packages/services/src/access/**"
  - "packages/services/src/biz/access/**"
  - "packages/services/src/biz/identity/**"
  - "packages/services/src/biz/*auth*"
  - "packages/services/src/biz/org-clone/**"
  - "packages/services/src/http/**"
  - "packages/ui-shared/src/session/**"
  - "packages/ui-shell/**"
  - "packages/portal-ui/**"
  - "packages/config/src/**"
  - "scripts/access-model.ts"
---

# Rules and traps: Access: people, orgs, sessions, roles

Every ⚠ and every never/always rule of this area's history, copied whole with the bullet it sits in, by section.
Why each one exists, and what was built around it: [`docs/history/access.md`](../../docs/history/access.md).
`unit/claude-md.test.ts` fails when a ⚠ of that history is in neither this file nor `CLAUDE.md`.

## People and their orgs (multi-org sign-in, 2026-10)

- ⚠ A linked membership signs in with its **person's** password, never its legacy per-org
  `User.password` copy.

- The same check reads the MEMBERSHIP (`membershipSwitchedOff`): a session whose membership says
  `isActive: false` is refused, whoever switched it off (the two user routes end the person's sessions
  themselves; a script, a restore or an import used to leave the session good for up to a day, and so did a
  membership with no person linked). ⚠ Only a row that is there and switched off refuses: one that is missing
  or cannot be read decides nothing, because this runs on every request of every org. "Active" is cached a
  minute; "switched off" never, so a member switched on again is not kept out.

- An org admin never sets the password, email or name of someone active in another org
  (`identity_shared`), and never creates a user at an address that is already someone's
  (`identity_exists`: they invite instead).

- **Backups carry the people.** Each org bundle has an `Identity` section with the persons its
  users point at, password hash included (`backup-bundle.service.ts#PEOPLE_MODEL`). ⚠ A restore
  only ever INSERTS a missing person. It never updates, deletes or remaps one, in either mode,
  because the person is shared with other orgs and the live row holds the current password and
  `tokenVersion`. A rollback removes only the people that restore added.

## Each browser tab keeps its own org (the SPAs, Phase 3)

- ⚠ **Never read `lgr_token` / `lgr_org` yourself.** Every SPA reads and writes its session
  through `ui-shared/src/session/session.ts` (`getToken`, `getOrg`, `claims`, `setSession`,
  `logoutEverywhere`), and `unit/session-keys.test.ts` fails if any other UI source names the
  keys. A tab's session is in `sessionStorage`; `localStorage` only holds what a NEW tab starts in
  (adopted once, never read live). A tab reading localStorage directly would act in whichever
  org another tab switched to last, with a valid token: requests succeed, in the wrong org.

- **Downloads go through the session, never a plain link** (`useSessionDownload.ts`): an
  `<a href="/api/…">` carries only the session cookie (`__Host-auth`), which names the org this
  browser entered LAST, in any tab.

- ⚠ **The portal's side menu offers what `canOpenPage` lets them open** (`portalPagesFor`, #461 D10): a till-only person
  and a PIN session see Apps and nothing else. Presentation, as ever: portal routes have no guard.

- ⚠ A session issued before its membership was linked to a person carries no `iid`: it sees only
  its own org (`/auth/orgs`) and cannot switch until it signs in again. That is deliberate: such a
  token has no `tv`, so letting it mint switched sessions would bypass revocation.

## Seller and Sales Consultant (2026-11-03, FR-26, #493)

- ⚠ **FR-27 P3-6 (#529): FR-26's areas are gone** (`AREAS`, `holdsArea`, `mergeAreas`, `DEFAULT_ROLE_AREAS`, `route-permission.ts#AREA_PREFIXES`, `PageDef.area`, the `areas` claim). What they carved out is what the two built-in roles' capabilities leave out (`config/access/template-caps.ts`), and the route rules (`config/access/routes.ts`) and page rules (`PAGE_ACCESS`) refuse it as for any role. The areas live on only in `config/access/legacy.ts`, frozen for migration 0015.

- **UI.** A session without the portal (`page-registry#holdsPortal`, `PORTAL_CAPS`) has no Portal tile and lands in its first app (`portalGuard`, `landingWithoutPortal`). The Products list's export is `exportsCatalog` (`products.export`). `isTransferOnly` gives the movement form Transfer only; `writesInventory` makes Products, Categories and Warehouses read-only.

- **Migration `0014-seller-permission-sets`** seeded both system sets in every org (released; it writes through the driver). Sets have no model since P3-6, and migration 0017 (#820) archives them.

## One access model: Phase 0 (FR-27, #529)

- **The role decides every request** (P3-2), and since P3-6 nothing else exists to decide. A new route needs a rule in
  `config/access/routes.ts` alone.

- ⚠ **`config/access/legacy.ts` is FROZEN** (`compileLegacy`, `legacyClaimsOf`, `LEGACY_BRIDGE`): released migration
  0015 imports it. `unit/access-legacy-frozen.test.ts` pins its checksum and that nothing outside `packages/migrations/`
  (and the access files 0015 reads it through) names it. Tests name an access by capabilities, a built-in role by
  `templateGrant(key)`, or a legacy permission's old capabilities by `tests/helpers/permission-caps.ts`.

- **Nothing outside the access model decides by the legacy one** (P3-8): `unit/access-no-legacy.test.ts` fails on a
  legacy role key used as a check, `permissions` / `areas` / `role` read off a token or session, the legacy compiler,
  or a person's stored `role` outside `config/access/`, `services/biz/access/`, the migrations and the tests. A
  display-only use goes on its allow-list with why; anything that decides takes the grant (`can`, `grantOf`).

- ⚠ **Where another app's session reaches it, `services/biz/access/partition.ts#seesBills` / `seesOrders`**: the
  partition's capabilities (`bills.view`; `orders.view|browse|lookup`). FR-27 P3-6 removed their legacy branch
  (FR-26's area, under which a warehouse manager was told of the bill behind a receipt); no session took it since
  P3-2. `product-supply` and the invoice's order links read `seesOrders`.

- ⚠ Legacy grants the three together from the invoicing permissions, and an `areas` list without `purchases`
  takes `bills` away, so nobody's answer changed. A grant that reads every kind and works
  on every kind costs no query.

## One access model: Phase 1, roles (FR-27, #529)

- Built-in (`isBuiltin`, `templateKey`): the ten legacy roles. Never edited, it takes its grant from its template (`config/access/templates.ts`, the role's defaults compiled), so it follows the catalogue.

- ⚠ It reads live code (`legacyClaimsOf`, `compileLegacy`) on purpose: they are the oracle. It checks each person before it assigns them (`sameGrant`); a person it cannot match keeps no role.

- The session gets the role's grant (`user.access`, non-enumerable, never serialised), and nothing else of the legacy model (P3-5).

- ⚠ FR-27 P3-5: only the role model is written. No projection (`legacy`), no `needsRelease`, no "Role · <name>" set,
  and nothing of the legacy model on a person or an invitation (`role`, `permissions`, `permissionSetIds`,
  `assignRole`; the schemas have no defaults for them). What a role or person from before holds stays, frozen, until P3-7.

- Read off the legacy role (the built-in of that key): recorded only when it grants exactly what the person's
  legacy fields do, and those are left alone. ⚠ So an org whose system set was edited changes nobody's access: that
  person gets no role yet, and their claims decide.

- **A page the role does not open (FR-27.7, Phase 2) shows "Not available for your role"** (`ui-shell/NotAvailable.vue`):
  both layouts (`ModuleLayout`, the portal's `DefaultLayout`) ask `ui-shared/access/page-access#usePageAccess`, and its
  view never mounts. The page is `pageAt(path, query)`: a registry page at its own path (a list, a new-document form)
  or a portal page under Settings or Admin, never the Dashboard; any other route shows. The rule is `canOpenPage`, the
  menus' own, so an offered page always opens.

- ⚠ A module's record route is never blocked: other apps link to records (an invoice's product, a bill's receipt)
  that their people read through the feature's `lookup`, so the server decides those.

- ⚠ An org on `roles` (`rid` in the claims) whose `/auth/me` has not answered yet: a page the claims (the role's
  projection, never more than the role) do not open WAITS (`accessSettled` / `settleAccess`, one `/auth/me`), then
  decides. A failed `/auth/me` ends the wait, and the claims decide. Legacy orgs decide at once and ask nothing.

- ⚠ The ratchet, `unit/access-read-only.test.ts`: a view that shows Save, Delete or an edit pencil, or sends a
  write, must consult access (`useAccess`, `v-cap`, a `cap`, a page rule), or be on `NOT_YET`, which only shrinks.
  Every capability id a view names must be in the catalogue (an unknown one hides the control).

- **Screens** (`portal-ui` Settings → Roles & access, `RolesView` / `RoleEditorView`; `/settings/roles`, page rule
  `roles.edit`). The editor is a level per feature, None / View / Work / Full, plus the extras beyond it
  (`config/access/levels.ts`). A level is never stored: Save sends capabilities, and the server adds the helpers their
  forms read (`withImplied`). `summarize(grant)` gives the three lines under a role, in the editor and the Users
  dialog. Users and Invites show one Role select once the org has roles, the legacy controls until then.

- ⚠ Permission sets stay reachable (the empty Roles page links there) while an org has no roles, and hold the roles'
  projections. Phase 3 removes them.

- ⚠ The legacy compiler grants it with any product read (`PRODUCT_READERS`), so nobody's answer changes. The
  legacy model cannot withhold it (`LEGACY_CANNOT_WITHHOLD`): a role without it projects as `needsRelease`.

- ⚠ A new serializer that sends a product or a stock level's cost goes through `redactProduct` /
  `redactStockCost` (a cost on a line: `redactMovementLine`).

- **Reports**: a column with `fieldGroup: 'costs'` (`ReportColumn`) is dropped by the runner, its cells and total
  with it, on screen and in the file (`withoutFieldGroups`, `meta.withheld` names the keys): valuation, stock levels,
  product ledger, stock movements, and warehouse operations' cost and profit (on the purchases side its prices too,
  which are what the goods cost). ⚠ A new report column that carries a cost says so.
  A report that is nothing but costs (`inventory-valuation`) carries `fieldGroup: 'costs'` itself: not listed, and
  404 to run, for a role without them (`canAccessReport`).

- ⚠ Legacy grants every level with any product read (`PRICE_LEVEL_CAPS`, `LEGACY_CANNOT_WITHHOLD`): enforced only
  on `roles`, and a role hiding one is `needsRelease`. What sells implies the selling price; what writes prices
  (price lists, bulk pricing, opening stock, `movements.create`) implies them all; `products.edit` none.

- **Templates (D-11, D-12)**: `TEMPLATE_WITHHOLDS` (Seller, Sales Consultant: the costs, Цена на едро, Цена 0) applies
  only where a role is MADE (`templateDefaults`: a new org's `seedBuiltinRoles`, stored as edited; "New role → from
  a template"). ⚠ `templateGrant` stays the legacy role's access: unedited built-ins, migration 0015 and every
  "same access" check read it, so nobody's access changes.

- **C.6 a document's stored price trail** (`priceExplanation`): `access/price-trails#withVisibleTrails` on every
  answer of the invoice and the till controllers (their `onAfterHandle`), and on the draft the two order
  conversions answer with (`lib/reservation-convert#conversionAnswer`: `/internal-orders/:id/convert`,
  `/orders/:id/convert`). ⚠ A new route that answers an invoice from any other controller says it the same way.

- **A typed line price (2026-11-12) is `sales-docs.manual-price`**: `invoicing.write` grants it, the role NAME `seller` withholds
  it (`LEGACY_ROLE_WITHHOLDS`). The forms lock the field (`PriceCombobox :typed`), and since #724 the routes hold it too
  (`services/biz/sales-lines.ts#typedPriceRefusal`: `/invoices` POST/PUT of an outgoing document, the till's sale, a
  customer order's PINNED price): without it a line price must be one the form could have given, i.e. the selling price,
  a `listPriceOptions(all)` price or the resolved one, a price the document or its related invoice already carries, one
  the client was already charged for the article, or the customer order line it converts. Else **403
  `price_not_offered`** naming the lines (translated by `receiptRefusalKey`). ⚠ Widen that list, never narrow it, when
  a form gains a new way to put a price on a line: a price the form offers and the route refuses blocks the Seller's
  sale.

- **The SPA follows the role live** (`ui-shared/access/live-grant.ts`): `/auth/me` and every sign-in answer `access`
  (`{ all, caps, role }`, null for a person with no role). `sessionViewer()` carries it as `grant`, the only grant it has
  (FR-27 P3-5: the token carries no claims, and a viewer without its grant holds nothing), so every page gate and
  `useAccess()` follow it, reactively. ⚠ A page load or a new tab learns it before the router's first decision
  (`web/src/router.ts` awaits `whenAccessSettled`, one `/auth/me`). A response whose `x-access-version` is not the one held asks `/auth/me`
  again, once (`followAccessVersion`, from `useHttpClient`). The grant belongs to one membership (`id@orgId`).

## Test copies of real orgs, and the PROD / DEV badge (2026-11-09)

- ⚠ **`Org.settings.environment` (`prod` | `dev`, unset = no badge) is not an org admin's to set.** The `PUT /org/:orgId`
  body does not list it (asserted in `org-environment.flow.test.ts`); only `org-clone.ts mark` writes it. It is also
  the guard: a copy is written ONLY into an org marked `dev` and never from one (`assertCloneAllowed`), so a sync
  pointed at the wrong slug stops with `[target_not_dev]` instead of overwriting a company's books.

- ⚠ **"A source document's id" is wider than it looks, and a copy that keeps one is a link into another tenant.** The
  rewrite also follows a whole 24-hex token INSIDE a longer string (a tag `<word>:<24-hex>`, an audit entry's text),
  and the ids it knows are every `_id` of the real org in EVERY collection with an `orgId`, the never-copied and
  operational ones (backup runs, background tasks) included: an audit entry about a backup names a record the copy
  does not hold, and that id becomes the one the copy WOULD have (it points at nothing) instead of staying a real
  org's. Both gaps shipped in the first version and were found, on 2026-11-10, only by scanning the real copies (the
  fixture had neither shape; it has both now). **`bun scripts/org-clone.ts leaks --pairs …`** is that scan:
  read-only, counts only, every collection of the database, every 24-hex window of every document (stricter than
  the rewrite's whole-token rule, so a second opinion and not a repeat), exit 1 on a hit. Run it on the real copies
  after any change to `remap.ts` or a new model with an `orgId`; the fixture cannot stand in for it.

- ⚠ **Never copied** (`policy.ts#NEVER_CLONED`, and `org-clone.flow.test.ts` makes every model with an `orgId` take a
  side): the file store (files, documents, archives, backups; owner's rule), fiscal devices and workstations, enrolled
  desktops, invites, mail logs, inboxes, credentials. A model added to the app must be listed there or in the test's
  `CARRIED`, or the test fails: copied by default would be a leak by default.

- **Source wins** on a document both orgs hold; a tester's edit of a copied document is overwritten at the next run,
  documents only the test org holds are never touched, a deletion in the real org is not propagated, numbering is
  `max(copy, real)`, and a unique-index clash is a counted `clash`, not a failure.
