# History: Access: people, orgs, sessions, roles

What was built in this area, release by release: multi-org sign-in, each tab its own org, OAuth, FR-27 roles and areas, test copies of orgs.

Moved here whole from `CLAUDE.md` by FR-32.13 (#797), section by section and word for word, so "below" and
"above" in it speak of the file it came from. The traps and the never/always rules of these sections are also in
the rule file [`.claude/rules/access.md`](../../.claude/rules/access.md), which a session loads when it touches
this area's files. A new trap goes there (or in `CLAUDE.md` if it is not one area's); what was built goes here.

## People and their orgs (multi-org sign-in, 2026-10)

A person is an **`Identity`** (global: email, password, OAuth links); each org's `User` is their
**membership** there (`identityId`). A session is still ORG-SCOPED (`tokenize()` of one membership),
so the tenant guard and every permission check are unchanged. Plan:
`~/.claude/plans/scalable-seeking-summit.md`; model page `docs/models/core/identity.md`.
- **Login** (`POST /api/auth/login`): `username` takes a username or an email. Without `orgSlug` it
  names a person and lands in the org this browser was last in (`preferredOrgId`), their last org,
  or their only one; otherwise it answers `needsOrgChoice` with an **identity-only token** (no
  `id`/`orgId`) that reaches only `services/biz/identity-routes.ts` (`GET /auth/orgs`,
  `POST /auth/switch`). A username several people use is **409 `ambiguous_login`**. `orgSlug`
  keeps the legacy one-org path that scripts, skills and the old UI use.
- ⚠ A linked membership signs in with its **person's** password, never its legacy per-org
  `User.password` copy.
- `iid`/`tv` on a session tie it to the person: a password change bumps `tokenVersion` and every
  session they hold stops working (`liveSessionUser`, cached a minute per process).
  - The same check reads the MEMBERSHIP (`membershipSwitchedOff`): a session whose membership says
    `isActive: false` is refused, whoever switched it off (the two user routes end the person's sessions
    themselves; a script, a restore or an import used to leave the session good for up to a day, and so did a
    membership with no person linked). ⚠ Only a row that is there and switched off refuses: one that is missing
    or cannot be read decides nothing, because this runs on every request of every org. "Active" is cached a
    minute; "switched off" never, so a member switched on again is not kept out.
- An org admin never sets the password, email or name of someone active in another org
  (`identity_shared`), and never creates a user at an address that is already someone's
  (`identity_exists`: they invite instead).
- Seed credentials: `admin@acme.com` / `test123` (org-less `admin` is ambiguous between acme-corp
  and beta-inc, by design), or `acme-corp` / `admin` / `test123` on the org path.
  `multi@lgr.test` / `test123` works in both demo orgs.
- **The person's own account** (`services/biz/identity/account.service.ts`):
  - `POST /auth/password`: change it, proving the current one;
  - `POST /auth/password/forgot` + `/reset`: by email. The token is stored only as a SHA-256 in
    `auth_tokens` and rides in the link's fragment;
  - `POST /auth/orgs`: found an org;
  - `POST /invite/:code/accept`: join one.
  The last two need a credential the person OWNS (rule 3, `own_password_required`): a password
  set by an admin or carried over by the migration must be changed first, while provider-only
  sign-in passes.
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
- **Switching** (`ui-shell/OrgSwitcher.vue`, `ui-shared/session/useOrgSession.ts`) moves THIS tab
  only: `POST /auth/switch`, then a full reload into the other org. It is refused while the tab
  holds something a reload would orphan (`session/switch-guards.ts`: a POS sale, a bridged fiscal
  printer) and asks first over unsaved form edits.
- **Downloads go through the session, never a plain link** (`useSessionDownload.ts`): an
  `<a href="/api/…">` carries only the session cookie (`__Host-auth`), which names the org this
  browser entered LAST, in any tab.
- **A 401 signs out this tab only**; a sign-out signs out every tab of the same person
  (BroadcastChannel). An identity-only session (no org chosen yet) may use only `/orgs`.
- ⚠ **The portal's side menu offers what `canOpenPage` lets them open** (`portalPagesFor`, #461 D10): a till-only person
  and a PIN session see Apps and nothing else. Presentation, as ever: portal routes have no guard.
- Portal pages: `/auth/login` (no org field until asked for), `/orgs` (picker), `/account`,
  `/auth/forgot-password`, `/auth/reset-password#token=…`. The OAuth callback redirects to
  `/auth/login?error=<code>`, and the page translates only codes it knows.
- ⚠ A session issued before its membership was linked to a person carries no `iid`: it sees only
  its own org (`/auth/orgs`) and cannot switch until it signs in again. That is deliberate: such a
  token has no `tv`, so letting it mint switched sessions would bypass revocation.

## OAuth Social Login

OAuth controller at `/api/oauth/:provider` supports Google, Facebook, GitHub, LinkedIn, Microsoft.

**Flow**: `GET /api/oauth/:provider` (optionally `?org_slug=xxx` for the one-org path, `?prefer=<orgId>` for where to land) → redirect to provider → callback at `/api/oauth/callback/:provider` → find the person → handoff cookie → `/auth/oauth-callback` (an org session, or the org picker). Which buttons the login page shows comes from `GET /api/oauth/providers`.

**Callback URLs** (register in provider apps):
```
http://localhost:4001/api/oauth/callback/google
http://localhost:4001/api/oauth/callback/facebook
http://localhost:4001/api/oauth/callback/github
http://localhost:4001/api/oauth/callback/linkedin
http://localhost:4001/api/oauth/callback/microsoft
```

**Env vars**: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `OAUTH_BASE_URL`, `OAUTH_FRONTEND_URL`. Production values live on mars at `gjovanov@mars:/home/gjovanov/.lgr.oauth`.

OAuth users have `oauthProviders[]` on User model and `password` is optional (OAuth-only users have no password).

## NRA Auditor Role

Role `nra_auditor` — read-only access for Bulgarian tax inspectors: `accounting.read`, `trade.read`, `erp.read`, `admin.audit`. Can view all sales data, audit logs, and SUPTO exports. Cannot create/modify/delete.

## User Model Extensions (SUPTO)

- `middleName` — Bulgarian three-part names (from identity document)
- `operatorCode` — 4-digit fiscal operator code (unique per org, atomic assignment, included in JWT)
- `position` — job title
- `roleHistory[]` — `{ roleId, roleName, startDate, endDate, assignedBy, assignedAt }` for audit trail (entries from
  before FR-27 P3-5 name the legacy key, `role`)

## Seller and Sales Consultant (2026-11-03, FR-26, #493)

Spec: `docs/fr/FR-26-seller-and-sales-consultant-roles.md`. Roles `seller` („Продавач") and `sales_consultant` („Търговски консултант"): invoicing, the till, inventory read and transfers, and nothing of Orders (the Sales Consultant keeps them), bills, payments, prices, stock control, the catalog's export or the Portal.
- ⚠ **FR-27 P3-6 (#529): FR-26's areas are gone** (`AREAS`, `holdsArea`, `mergeAreas`, `DEFAULT_ROLE_AREAS`, `route-permission.ts#AREA_PREFIXES`, `PageDef.area`, the `areas` claim). What they carved out is what the two built-in roles' capabilities leave out (`config/access/template-caps.ts`), and the route rules (`config/access/routes.ts`) and page rules (`PAGE_ACCESS`) refuse it as for any role. The areas live on only in `config/access/legacy.ts`, frozen for migration 0015.
- **Server.** What no prefix can say is the controllers', by capability: an incoming document under `/invoices` is 404 by id and absent from the list, summary, exports, ledger and aging (`bills.view`, FR-27.6 partitions, below); an invoice adds or changes no order link (`orders.*`); `product-supply` names no order (`seesOrders`). A movement write takes `movements.create` or `movements.create:transfer`, and the controller holds a transfer-only caller to transfers with both warehouses (`movement.controller#transferRefusal`).
- **UI.** A session without the portal (`page-registry#holdsPortal`, `PORTAL_CAPS`) has no Portal tile and lands in its first app (`portalGuard`, `landingWithoutPortal`). The Products list's export is `exportsCatalog` (`products.export`). `isTransferOnly` gives the movement form Transfer only; `writesInventory` makes Products, Categories and Warehouses read-only.
- **Migration `0014-seller-permission-sets`** seeded both system sets in every org (released; it writes through the driver). Sets have no model since P3-6, migration 0017 (#820) archives them, and 0020 (P3-9) drops them.

## One access model: Phase 0 (FR-27, #529)

Spec and catalogue: `docs/fr/FR-27-one-access-model.md` (Appendix A is `config/src/access` as a table). A person
gets a **grant**: everything (`{ all: true }`) or a set of **capabilities** `feature.action` (`movements.create:transfer`).
- **`config/src/access`** (`config/access`, import-pure):
  - `catalogue.ts`: every feature and its actions. `CapabilityId` is typed from it.
  - `routes.ts`: what each org route needs, by exact key then the longest prefix, as `anyOf | self | member`.
  - `pages.ts`: which capabilities open each page, keyed by page-registry id.
  - `legacy.ts`: `compileLegacy(claims)`, today's token (role, permissions, areas) as a grant. `LEGACY_BRIDGE` maps permissions, `LEGACY_ROLE_CAPS` maps the role names the controllers check, `AREA_OF` maps FR-26's areas.
  - Actions: `view` opens a feature's page, `browse` opens it for another app's role, `lookup` reads its records without the page.
- **Server.** `services/biz/access/evaluate.ts`:
  - `accessRefusal(user, method, route)`, with the PIN scope first, unchanged;
  - `can(user, cap)`, which controllers move onto slice by slice (Phase 0 PRs 2–5);
  - `grantOf(user)`, memoised per claims.
- **The role decides every request** (P3-2), and since P3-6 nothing else exists to decide: the legacy route rules,
  `permissionRefusal`, `legacyCanOpenPage`, the areas, `ownRecordsOnly`/`scopedRepos`, `FISCAL_ADMIN_ROLES`, permission
  sets (model, controller, service, seed) and shadow mode (`shadow.ts`, `AccessShadowDiff`, the differential test) are
  deleted. A new route needs a rule in `config/access/routes.ts` alone.
  - ⚠ **`config/access/legacy.ts` is FROZEN** (`compileLegacy`, `legacyClaimsOf`, `LEGACY_BRIDGE`): released migration
    0015 imports it. `unit/access-legacy-frozen.test.ts` pins its checksum and that nothing outside `packages/migrations/`
    (and the access files 0015 reads it through) names it. Tests name an access by capabilities, a built-in role by
    `templateGrant(key)`, or a legacy permission's old capabilities by `tests/helpers/permission-caps.ts`.
  - `DEFAULT_ROLE_PERMISSIONS` stays in `config/constants`, frozen: legacy.ts and the templates' `legacy` claims (0015)
    read it, and test fixtures. Nothing decides by it.
  - `scripts/access-model.ts` lists who has no role and gives the people from before roles theirs (`--give-roles`,
    0015's own `up`); `--set`/`--report` are refused. `Org.settings.access.model` is read by nothing.
- **Client.** `ui-shared/access/useAccess` gives `can()` and `canOpen()` on the same grant, compiled from the tab's token as `sessionViewer` reads it.
- **#493 items 2–5 ride on it (FR-27 D-8): capabilities, not areas.** A session whose claim carries an `areas` list, the Seller and the Sales Consultant, does not get these (`legacy.ts#NOT_WITH_AN_AREAS_LIST`):
  - `sales-docs.totals` and `bills.totals`: the strip, and `GET invoices/summary`, which answers 403 `capability_required`;
  - `sales-docs.import`: the invoices list's Import button, and (Phase 2) the import itself: `doc-import`'s
    `targetRefusal` answers 403 `capability_required` for a sales invoice or a cash sale without it;
  - `org.switch`: `OrgSwitcher` shows the org read-only, and `/orgs` redirects inside an org.
  - Such a session lands on Products where it can open them (`landingWithoutPortal`).
- **Partitions (FR-27.6, Phase 2): sales documents, proforma and bills share `/invoices`** (`config/access/partition.ts`).
  `kindOfDocument`: incoming is `bills`, an outgoing `proforma` is `proforma`, the rest `sales-docs`. A role reads the
  kinds whose `view` it holds (`readsKind`) and writes those whose `create`/`edit` it holds (`writesKind`; deleting
  takes the kind's `delete`).
  - `invoice.controller`: by id, another kind is 404 (as an unknown id) and a kind it only reads is 403
    `capability_required`; the list adds `partitionFilter(grant)` (`{ direction }` or an `$or`); the summary covers
    `readableDirection`; a create of a kind it does not make is refused before anything is written. The exports,
    contact ledger and card, aging, stats, movements' bill links read `seesBills` and the import's bill target
    `bills.create`, where they read the `purchases` area.
  - ⚠ **Where another app's session reaches it, `services/biz/access/partition.ts#seesBills` / `seesOrders`**: the
    partition's capabilities (`bills.view`; `orders.view|browse|lookup`). FR-27 P3-6 removed their legacy branch
    (FR-26's area, under which a warehouse manager was told of the bill behind a receipt); no session took it since
    P3-2. `product-supply` and the invoice's order links read `seesOrders`.
  - Route rules: `invoices` reads take any kind's `view`, writes any kind's work; the controller does the rest.
  - ⚠ Legacy grants the three together from the invoicing permissions, and an `areas` list without `purchases`
    takes `bills` away, so nobody's answer changed. A grant that reads every kind and works
    on every kind costs no query.

## One access model: Phase 1, roles (FR-27, #529)

- **`Role`** (`db/models/role.model.ts`, class R): one per person per org (`User.roleId`).
  - Built-in (`isBuiltin`, `templateKey`): the ten legacy roles. Never edited, it takes its grant from its template (`config/access/templates.ts`, the role's defaults compiled), so it follows the catalogue.
  - Imported (`legacyKey`): migration 0015's. `all`: the Administrator. `legacy`: the role key, permissions and areas a release that reads no roles serves.
  - `grantOfRole` (`config/access/roles.ts`) resolves it. An id the catalogue does not know grants nothing (`unknownCaps` lists it).
- **`legacyClaimsOf(user, sets)`** (`config/access/legacy.ts`) is what `tokenize()` reads: one function, so the migration reads a person as their token does.
- **Migration `0015-roles-from-sets`** gives every person one role with exactly their token's access (`bun run migrate --dry-run` is §4's dry run).
  - Their role's defaults, or an `admin`: the built-in role. Anything else: an imported role per distinct access, named after their sets ("A + B", told apart by the role where two accesses share it) or "Role + extras".
  - ⚠ It reads live code (`legacyClaimsOf`, `compileLegacy`) on purpose: they are the oracle. It checks each person before it assigns them (`sameGrant`); a person it cannot match keeps no role.
  - Nothing reads `roleId` until an org's access model is `roles`.
- **An org on `roles`** (`scripts/access-model.ts --set roles`; refused while anyone has no role):
  - Both auth plugins call `attachAccess` (`services/biz/access/live.ts`). It reads the person's role live, membership and role each cached 60 s per process (`forgetMember`, `forgetRole` in the writing process), through the driver, not the models: the query budgets count only a request's own queries.
  - The session gets the role's grant (`user.access`, non-enumerable, never serialised), and nothing else of the legacy model (P3-5).
  - Responses carry `x-access-version: <roleId>:<version>`.
  - `decideAccess` decides by the evaluator. (Shadow mode, which counted where the legacy rules differed, is gone: P3-6.)
  - Sign-in issues `rid`/`rv`, and answers the grant (`access`, as `/auth/me`; `live.ts#accessAnswerFor`).
  - A person with no role keeps their token's claims. Back to `legacy` at any time.
- **Roles API** (`portal-api/.../role.controller.ts`; `GET/POST /roles`, `GET/PUT/DELETE /roles/:id`; a person's role through `PUT /user/:id` `roleId`).
  - Every write goes through `services/biz/access/role.service.ts`, which holds FR-27.8: managing takes `roles.edit`; not your own role, nor your own assignment; nothing beyond the actor's grant; `*` and `roles.*` an Administrator's only; the Administrator role is fixed; the last active Administrator keeps it and stays active; roles are the org's own; everything audited with caps before and after.
  - ⚠ FR-27 P3-5: only the role model is written. No projection (`legacy`), no `needsRelease`, no "Role · <name>" set,
    and nothing of the legacy model on a person or an invitation (`role`, `permissions`, `permissionSetIds`,
    `assignRole`; the schemas have no defaults for them). What a role or person from before holds stays, frozen, until P3-7.
  - On the legacy model, an assignment or a role edit ends the affected people's sessions; on `roles` it is live.
  - `scripts/restore-administrator.ts --org --user [--execute]` gives a locked-out org its Administrator back, audited.
- ⚠ **FR-27 P3-9 (#529): the legacy access paths are gone, and never come back.** No schema names `User.role` /
  `permissions` / `permissionSetIds` / `legacyArchive`, `Invite.assignRole` / `legacyArchive`, or `Role.legacy` /
  `needsRelease`. Migration 0017 took the fields off every person and invitation into `legacyArchive`; 0020
  (`0020-legacy-access-archive-drop`) unsets the archive and any leftover field, and deletes the permission sets
  (`permissionsets`, `permissionsets_archive`), dropping each collection only once no other org's sets are left in
  it. A path put back reads nothing, and with a default writes the legacy model back on every save. Released
  migrations (0014, 0015, 0017, 0020) and the test factory read and write the fields through the driver. One-way: the
  only way back is the backup taken before 0020 runs (a mongodump of `users`, `invites`, `permissionsets`,
  `permissionsets_archive`), or the one taken before 0017, restored by hand. `scripts/access-model.ts --give-roles`
  (0015 for the people from before roles) is refused: there are none left to read.
- **A person's first role** (`startingRoleOf` / `giveStartingRole`): a new org's founder (`provisionNewOrg` seeds the
  ten built-ins, `seedBuiltinRoles`), an invite accepted, a member an admin creates.
  - Chosen: a role named (`assignRoleId` on the invite, `roleId` on the create), or, when neither a role nor a legacy
    role is named, the org's default (`Org.settings.access.defaultRoleId`, `PUT /roles/default`; an invite resolves it
    when it is made). Written as an assignment: `roleId` and a role history entry (id and name).
  - Read off the legacy role (the built-in of that key): recorded only when it grants exactly what the person's
    legacy fields do, and those are left alone. ⚠ So an org whose system set was edited changes nobody's access: that
    person gets no role yet, and their claims decide.
- **A user route names the role by `roleId` or `roleKey`** (FR-27.3, #529, the owner's answer 3): `POST`/`PUT /user`
  take `roleKey`, a built-in role's template key (`seller`, `manager`…), which is the same in every org where a role id
  is not, resolved to that org's built-in role (`role.service#namedRoleId`). An unknown key is 422 `unknown_role_key`,
  `roleId` with `roleKey` 422 `role_id_and_key`, either with the legacy `role` 422 `role_and_legacy`. Tests and e2e
  files send `roleKey`.
  - ⚠ A legacy `role` key on `POST`/`PUT /user` is still the built-in role of that key in this release, and every use
    is logged at warn (`legacy role field on a user route`: the route, the org and the key, never the person). The
    next release refuses it, 422 `legacy_role_field`, as invitations refuse `assignRole`: read that release's logs
    first. A new caller sends `roleKey`.
- **How a role is named outside the roles screens** (`config/access/roles.ts#roleDisplay`: the org menu, the org picker,
  an invitation, the SUPTO operators export): a built-in role by its template key, which the SPA translates, while it
  still carries its template's name; else the role's own name, as on the Roles screen.
  - ⚠ A built-in role the org renamed shows the org's name (#529, answer 4): the key would be translated back to the
    template's name, and the org menu and the export would disagree with the Roles screen.
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
- **Generic read-only (FR-27.7)**: a role that reads a feature and does not work on it is offered no New, Save or
  Delete. `v-cap="'contacts.delete'"` (or a list: any one) hides a control (`ui-shared/access/v-cap.ts`, registered
  by `registerPlugins`; `data-cap`, and `data-cap-hidden` while hidden; it follows the live grant). A form's action
  and a row action take `cap` (`EntityFormShell`, `RowActionsMenu`): a hidden Save takes Ctrl+S with it.
  `CreateButton` shows itself only for a form the role opens (`opensTarget`), or for a dialog its `cap`.
  - ⚠ The ratchet, `unit/access-read-only.test.ts`: a view that shows Save, Delete or an edit pencil, or sends a
    write, must consult access (`useAccess`, `v-cap`, a `cap`, a page rule), or be on `NOT_YET`, which only shrinks.
    Every capability id a view names must be in the catalogue (an unknown one hides the control).
  - Keep a record's pencil when it is the only way to READ the record (a dialog): gate the dialog's Save instead.
  - The Files app reads with `files.view` and changes documents with `files.manage` (`file.controller#writeGate`:
    upload, OCR, book, undo, reconcile, delete, pack and unpack); analyses and the snapshot diff are reads. Legacy
    grants both with `admin.settings`.
- **Role tools (FR-27.9)**, import-pure in `config/access/compare.ts`, on the roles screens: "Who can…" (`whoCan` over
  `ASKABLE_CAPABILITIES`, with the people count), "Compare" (`compareGrants`: each feature's level per role and the
  capabilities one holds the other does not) and the editor's preview (`pagesOpenedBy`: the pages the role as it
  stands opens, by app). All from the grants and page rules the server and the menus decide by; nothing is stored.
- **A role's start page (FR-27.4)**: `Role.landing`, a page id the role opens (`role.service#cleanLanding`: 422
  `landing_unknown` / `landing_not_open`; capabilities that stop opening it drop it). A change bumps the role's
  version, and `/auth/me` answers it as `access.landing`. `startPage(who)`: the landing, else the Dashboard, else
  (no portal) `landingWithoutPortal`, which prefers a landing outside the portal. The first Dashboard of a
  membership in a tab goes there (`useRoleLanding`, once, `sessionStorage` `lgr_landed`), and "Not available" offers it.
- **Screens** (`portal-ui` Settings → Roles & access, `RolesView` / `RoleEditorView`; `/settings/roles`, page rule
  `roles.edit`). The editor is a level per feature, None / View / Work / Full, plus the extras beyond it
  (`config/access/levels.ts`). A level is never stored: Save sends capabilities, and the server adds the helpers their
  forms read (`withImplied`). `summarize(grant)` gives the three lines under a role, in the editor and the Users
  dialog. Users and Invites show one Role select once the org has roles, the legacy controls until then.
  - ⚠ Permission sets stay reachable (the empty Roles page links there) while an org has no roles, and hold the roles'
    projections. Phase 3 removes them.
- **Field groups (FR-27.6, Phase 2): `products.costs`** (`config/access/fields.ts`, "Cost figures" in the editor).
  `purchasePrice`, `standardCost`, the „Доставна цена" slot (drawn as „Цена с ТО"), every slot's `percent` (a margin gives the cost back)
  and a stock level's `avgCost` are ABSENT from the JSON for a role without it: the product list (`products` and
  `items`), by id, create, quick create, update, `/pricing/options`, `/warehouse/stock-level`; `/warehouse/cost-layer`
  answers 403 `capability_required`. A write by such a role keeps the stored costs (`keepStoredCosts`: the cost slot
  goes back first, margins by name, duplicates dropped).
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
- **Price levels (FR-27.11, owner 2026-11-10; D-5 revised, D-11 to D-13)**: a role carries the prices it may see.
  `products.price:selling`, a level per `PRICE_TIERS` slot but „Доставна цена" (`products.price:wholesale`,
  `products.price:0` … `:10`, found by name, spaces ignored: `capOfTier`), and `products.price:other` (an org's own tier
  names, the legacy tag and contact prices); „Доставна цена", `percent` and every cost stay `products.costs`.
  `config/access/fields.ts` is the one rule; levels are "Prices it may see" extras on the editor's Products row.
  - ⚠ Legacy grants every level with any product read (`PRICE_LEVEL_CAPS`, `LEGACY_CANNOT_WITHHOLD`): enforced only
    on `roles`, and a role hiding one is `needsRelease`. What sells implies the selling price; what writes prices
    (price lists, bulk pricing, opening stock, `movements.create`) implies them all; `products.edit` none.
  - **Templates (D-11, D-12)**: `TEMPLATE_WITHHOLDS` (Seller, Sales Consultant: the costs, Цена на едро, Цена 0) applies
    only where a role is MADE (`templateDefaults`: a new org's `seedBuiltinRoles`, stored as edited; "New role → from
    a template"). ⚠ `templateGrant` stays the legacy role's access: unedited built-ins, migration 0015 and every
    "same access" check read it, so nobody's access changes.
  - **C.1 reads**: `redactProduct` (list, by id, the pickers, create and quick replies), `redactPriceOptions` /
    `redactResolution` (`/pricing/options`, `/pricing/resolve`: the final price stays, whoever looks; a hidden winning
    level is "Customer price", a hidden losing one is not named, D-13), `redactMovementLine` (a movement's lines by id,
    the product ledger), a count's `varianceCost`, an outgoing order's `expectedUnitPrice` (the order controller's
    `onAfterHandle`), `canSeeSupplierPrices` = `bills.view` and `products.costs`.
  - **C.6 a document's stored price trail** (`priceExplanation`): `access/price-trails#withVisibleTrails` on every
    answer of the invoice and the till controllers (their `onAfterHandle`), and on the draft the two order
    conversions answer with (`lib/reservation-convert#conversionAnswer`: `/internal-orders/:id/convert`,
    `/orders/:id/convert`). ⚠ A new route that answers an invoice from any other controller says it the same way.
  - **C.2 derived**: the contact ledger's row `purchasePrice` and its profitability, the dashboard's `stock.totalValue`
    (its tile is not drawn without it).
  - **C.3 sort**: both auth plugins refuse `?sortBy=` naming a level the role lacks (`sortAccessRefusal`, 403
    `capability_required`), on every route: `tier_<slot>`, a cost by any name or path, `priceTiers.*`. The list
    composables drop such a key from an old URL (`sortKeyFromUrl`).
  - **C.4 writes**: `keepStoredPrices` (product create and update) merges `priceTiers` by slot, a hidden slot staying
    byte-identical where it stood; the server prices an inventory count itself (`inventory-count-pricing.ts`: variance
    × the stock level's `avgCost`, on save and on complete; the body's `varianceCost` is ignored); an order's save
    keeps each line's stored `expectedUnitPrice`.
  - **C.5 history**: `audit-log.service#visibleChanges` drops a change of a hidden field in both readers
    (`queryAuditLogs` `viewer`, `queryByCorrelationId`): the record history, the correlation lookup, the dashboard's
    recent activity, the Files audit.
  - **C.7 / D views**: the Products grid offers only the levels held (`useProductColumns`), the product form edits
    only those, and an open product list re-reads its rows when `x-access-version` changes.
- **A typed line price (2026-11-12) is `sales-docs.manual-price`**: `invoicing.write` grants it, the role NAME `seller` withholds
  it (`LEGACY_ROLE_WITHHOLDS`). The forms lock the field (`PriceCombobox :typed`), and since #724 the routes hold it too
  (`services/biz/sales-lines.ts#typedPriceRefusal`: `/invoices` POST/PUT of an outgoing document, the till's sale, a
  customer order's PINNED price): without it a line price must be one the form could have given, i.e. the selling price,
  a `listPriceOptions(all)` price or the resolved one, a price the document or its related invoice already carries, one
  the client was already charged for the article, or the customer order line it converts. Else **403
  `price_not_offered`** naming the lines (translated by `receiptRefusalKey`). ⚠ Widen that list, never narrow it, when
  a form gains a new way to put a price on a line: a price the form offers and the route refuses blocks the Seller's
  sale.
- **An outgoing article line's unit is its article's** (#724, `withArticleUnits`): the routes write the article's unit
  over any other, except where the stored document already holds the article at that unit. Nothing is refused; the
  importers send the article's unit already. The form locks the field (`DocumentLineTable#unitLocked`).
- **The SPA follows the role live** (`ui-shared/access/live-grant.ts`): `/auth/me` and every sign-in answer `access`
  (`{ all, caps, role }`, null for a person with no role). `sessionViewer()` carries it as `grant`, the only grant it has
  (FR-27 P3-5: the token carries no claims, and a viewer without its grant holds nothing), so every page gate and
  `useAccess()` follow it, reactively. ⚠ A page load or a new tab learns it before the router's first decision
  (`web/src/router.ts` awaits `whenAccessSettled`, one `/auth/me`). A response whose `x-access-version` is not the one held asks `/auth/me`
  again, once (`followAccessVersion`, from `useHttpClient`). The grant belongs to one membership (`id@orgId`).
- **A page whose data needs more than its app** names it: `PAGE_ACCESS[id].alsoAnyOf`, and the same in the legacy
  oracle (`PageDef.alsoNeed`, permissions), which the differential test holds equal. `/reports/aging` and
  `/reports/export` read invoices: Reports alone opened them, and their data answered 403. `startPage` picks the
  Dashboard only for a role that opens it; the Dashboard sends anyone else to their start page once the grant is known.
- **The walks (FR-27 acceptance 3, 4)**, opt-in Playwright (`--project=field-walk`, `WALK_ORG` an org on `roles`), each
  writing `test-results/*.md` before it asserts:
  - `field-walk-roles`: every built-in role over every page it opens: no 403 while it loads, no "Not available", no
    `data-cap` control the role lacks, no unmarked New / Save / Delete / Import / Export without the feature's action,
    no page error; a sample of the pages it does not open shows "Not available" or sends it away.
  - `field-walk-blank-roles`: Seller and Sales Consultant rebuilt from a blank role in the editor equal the built-ins,
    and pass FR-26 §2.1 and #493 items 1 to 5, beside a built-in user as the control.
  - Locally: an in-memory replica set, `bun run seed`, `bun run migrate`, `scripts/access-model.ts --org acme-corp --set
    roles`, a server from `packages/portal-api` on its own port, `BASE_URL` at it.

## Test copies of real orgs, and the PROD / DEV badge (2026-11-09)

`test-regal-pz` and `test-regal-sf` are copies of `regal-pz` and `regal-sf` (data, numbering, memberships) in orgs
marked **dev**, where nothing can print a fiscal receipt, mail a customer or touch a real shelf. Skill:
**`sync-test-orgs`**; CLI `scripts/org-clone.ts`; engine `packages/services/src/biz/org-clone/` (its header lists
the rules); daily job: CronJob `lgr-org-sync` in lgr-deploy (04:30 Europe/Sofia).

- ⚠ **`Org.settings.environment` (`prod` | `dev`, unset = no badge) is not an org admin's to set.** The `PUT /org/:orgId`
  body does not list it (asserted in `org-environment.flow.test.ts`); only `org-clone.ts mark` writes it. It is also
  the guard: a copy is written ONLY into an org marked `dev` and never from one (`assertCloneAllowed`), so a sync
  pointed at the wrong slug stops with `[target_not_dev]` instead of overwriting a company's books.
- **The badge** (`ui-shell/EnvBadge.vue`: PROD = the theme's error red darkened to pass AA, DEV = a neutral gray from
  `on-surface`, both themes) sits beside the org's name in the org menu button and list, the sidebar header and the
  org picker. Every sign-in answer carries `org.environment` (`session-answer.ts#orgBrief`), so the top bar shows it
  before `/auth/me` answers; `/auth/orgs` carries it per row.
- **A copy's `_id` is a pure function of its source's** (`ids.ts`: the last 8 bytes XORed with a mask from the target
  org; the creation time stays), so a sync needs no table and a second run changes nothing. References are rewritten
  BY VALUE (the restore's remap rule): an ObjectId or 24-hex string that is a source document's id becomes its copy's,
  anything else (identities) is left. The test asserts not one id of the real org survives in the copy.
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
- **People are access, not data.** Matched by identity (an existing membership is reused, so the documents its person
  made name it), a role by name, an enabled app by app (the app creates those rows itself the
  first time anyone opens the hub, so a copy made after a reset finds them there); a membership the copy adds is switched off (an admin's stays on for the
  first copy, `--activate-admins`). A reset keeps people, roles, invites, desktops and fiscal devices.
- **Source wins** on a document both orgs hold; a tester's edit of a copied document is overwritten at the next run,
  documents only the test org holds are never touched, a deletion in the real org is not propagated, numbering is
  `max(copy, real)`, and a unique-index clash is a counted `clash`, not a failure.
