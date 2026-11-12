# FR-27 — One access model: a role says what a person sees, what is read-only and what they can do

The spec as filed on gjovanov/lgr#529 (owner, 2026-11-05), verbatim. Appendix A is new: the catalogue for the owner's review before Phase 0 (FR-27.1).

| | |
|---|---|
| **Status** | Proposed 2026-11-05. The defaults in §9 stand unless the owner answers otherwise on this issue. D-5 and D-8 are decided (2026-11-05): the defaults. Nothing built. |
| **Builds on** | FR-26 (areas, `inventory.transfer`, role and sets agreeing), S-28/S-29 (`route-permission.ts`), FR-22 §5.8 (`canOpenPage`), FR-19 (memberships, `tokenVersion`), FR-24 (module manifests), FR-20 (replicated sets, masters on an older release), FR-25 (`payroll.personal`) |
| **Replaces, in Phase 3** | the legacy role as an authorization input, permission sets, areas, "own records only", the role-name checks, and the per-view helpers FR-26 added |
| **Code anchors** | origin/master `4cbe3222` (2026-11-05). Anchors, not gospel. |

## 0. The request (owner, 2026-11-05)

Permissions are confusing and cannot express what FR-26 asks for. *Settings → Permission sets → Create* and *Settings → Users → Create* (which offers a legacy role, permission sets and a "Permissions (Legacy)" list) do not tell an admin what a person will see, what is read-only, which operations they may perform or which documents they may create. Propose a simpler design.

**In short.** A person has one **role**. A role is a table: for every **feature** (Sales documents, Bills, Products, Devices…) a level, **None, View, Work or Full**, plus a few named extras (Export, Import, cost figures, one document type). The server, the menus and the buttons all read that one table, generated from one catalogue in code. FR-26's two roles and the five open items on #493 become rows in the table instead of code.

## 1. What is wrong today

### 1.1 Four answers to "what may this person do?"

A membership carries `role` (one of ten), `permissionSetIds` (any number) and its own `permissions` list (`db/models/user.model.ts`). `tokenize()` (`services/biz/auth.service.ts:579`) combines them:

1. If any set resolves in the org: the union of the sets' permissions and areas. The role's defaults and the user's own list are ignored.
2. Otherwise: the role's defaults plus the user's own list (`DEFAULT_ROLE_PERMISSIONS`, `DEFAULT_ROLE_AREAS`).
3. Either way the role **name** goes into the token, and about 80 checks in about 35 server files decide by it: `role === 'admin'` (the read and write refusals, `canOpenPage`, `holdsArea`), `FISCAL_ADMIN_ROLES`, `STORNO_ROLES`, `['admin', 'manager']`, `['admin', 'nra_auditor']`. 44 rules in `route-permission.ts` are marked `self:`, which means the controller decides, mostly by role name.
4. `hr_manager` and `sales` have no system set, so "Migrate from Roles" puts them on „Member (Read Only)".

One person is judged by permissions on one route and by role name on the next. That is why FR-26.9.3 had to add a warning for a role and sets that disagree.

### 1.2 The two screens

**Permission set → Create** (48 controls):

| Control | What it does | What an admin cannot tell from the screen |
|---|---|---|
| **Administrator** switch | every permission | that the role name `admin` is a second, separate bypass |
| **Default** switch | stored on the set | that no code reads it: no path assigns a set by it |
| **Permissions**: 24 checkboxes under six module names, labelled with the bare verb (`read`, `write`, `adjust`, `send`, `file`, `personal`, `import`, `users`…) | module-wide grants | what `adjust` or `personal` opens. Invoicing `write` covers sales documents, bills, payments and orders alike |
| **Areas**: "All areas" or "Only the areas ticked" + 7 checkboxes | FR-26's carve-outs, a second dimension on top of the first | that an absent list and an empty list mean opposite things |
| **Record scoping**: 12 "own records only" boxes | nothing. Eleven name modules this product no longer has (sales, purchase, project, helpdesk, crm, hr, documents, subscriptions, planning, fleet, erp). The twelfth, payroll, has a scope spec, but the filtered repositories it feeds (`scopedRepos`, built by the auth plugins) are read by no controller | that ticking any box changes nothing |
| **Migrate from Roles** | puts users with no set on the set of their role | that `sales` and `hr_manager` land on read-only |

**Users → Create** (identity fields aside, 27 controls):

| Control | What it does | What an admin cannot tell from the screen |
|---|---|---|
| **Role** (10 values, no description on any; „Sales" and „Seller" look alike, and so do bg „Продажби" and „Продавач") | still read by about 80 checks | what the role can do |
| **Permission Sets** (many) | decide at sign-in, overriding the role's permissions | which of the two wins, until a warning appears |
| **Permissions (Legacy)**: 24 checkboxes | used only while the user has no set | that they do nothing once a set is chosen |
| the API behind it | `POST /user` names only `role` in its schema; `PUT` names role, sets and the legacy list | |

### 1.3 What the vocabulary cannot say

- **Read-only against change below a module.** FR-26 needed 7 areas, one extra permission and a dozen controller checks to separate Orders, Bills and Payments from the rest of Invoicing.
- **Operations.** Import, Export, Print and email, Void and Delete have no permission of their own. A Seller's Import button on the movements list exists, and the server refuses it only because movements happen to need `inventory.write`.
- **Fields.** There is no way to hide cost figures (FR-26 D-5).
- **Delegation.** `admin.users` is handed to administrators and checked by nothing: users and invites change by role name `admin`. `admin.settings` opens a handful of settings pages and the Files app. "May run devices and numbering, may not touch people" cannot be said.
- **Landing page, changing organization, the invoices totals strip.** No switch at all.

Why not one more area per ask? Each costs the seven places below, and the next asks (hide costs, read-only Devices) are not areas.

### 1.4 The same fact is written down in seven places

1. `DEFAULT_ROLE_PERMISSIONS`, `DEFAULT_ROLE_AREAS`, `ROLE_PERMISSION_SET_NAMES` (`config/constants.ts`)
2. The seeded sets, and a migration for each change (`permission-set.seed.ts`, `0014-seller-permission-sets.ts`)
3. Six lists in `route-permission.ts`: reads, writes, exact reads, exact writes, `AREA_PREFIXES`, `PIN_SCOPE_ORG`
4. Controllers' own checks: the 44 `self:` rules and the role-name checks
5. `PAGE_REGISTRY` rows (`need`, `roles`, `area`, `till`) and each module's menu
6. Per-view helpers (`writesInventory`, `isTransferOnly`, `isTillOnly`, `readsDocuments`, `holdsArea`…): about 80 call sites in 27 files
7. The report registry's own `permission` and `roles` per report

"No Price lists for a Seller" touched all seven. They drift: the FR-26 production walk (2026-11-05) found write controls on the Devices page and Import buttons that the server refuses, and a totals strip and endpoint that nothing could switch off.

## 2. Design

### 2.1 Four terms

- **Feature**: what a person would name. Sales documents, Bills, Payment orders, Products, Price lists, Stock movements, Devices. About 60, listed in one catalogue in code (§2.5).
- **Action**: the same few verbs everywhere. `view`, `create`, `edit`, `delete`, `import`, `export`, plus the verbs a feature has of its own (`issue`, `void`, `post`, `approve`, `storno`, `file`). Some carry a document type: `create:transfer`, `create:credit_note`. Two are special: `see:costs` (a field group) and `lookup` (a form may search the feature's records, as the invoice form searches products, without the page).
- **Level**: a shortcut over a feature's actions, never stored.
  - **None**: not seen, not reachable.
  - **View**: opens, reads, prints. No New, Save, Delete, Import.
  - **Work**: View, plus create, edit and the feature's daily verbs.
  - **Full**: Work, plus delete, void, import, export, configure.

  Each catalogue entry says what its Work and Full contain, so a level is never a guess, and the editor shows it on hover. The editor shows the largest level the granted actions contain, and any granted action beyond it as a ticked extra.
- **Role**: a name, a description and a set of (feature, action) pairs. A person has exactly one role per organization.

Nothing in this model means "unrestricted" by being absent.

### 2.2 The role editor (Settings → Roles & access)

```
Role: Seller        3 people        Starts from: Seller template        Landing page: Products

                                        None  View  Work  Full    Extras beyond the level
INVOICING
  Sales documents                       ( )   ( )   (o)   ( )     [ ] Totals strip   [ ] Export
  Proforma                              ( )   ( )   (o)   ( )
  Till: terminal, journal, sessions     ( )   ( )   (o)   ( )     [ ] Storno
  Orders                                (o)   ( )   ( )   ( )
  Bills (incoming documents)            (o)   ( )   ( )   ( )
  Payment orders, cash orders           (o)   ( )   ( )   ( )
  Contacts                              ( )   ( )   (o)   ( )
  Devices                               ( )   (o)   ( )   ( )
INVENTORY
  Products                              ( )   (o)   ( )   ( )     [ ] Export   [x] Cost figures
  Stock movements                       ( )   (o)   ( )   ( )     Create and edit:  [x] Transfer  [ ] Receipt  [ ] Adjustment
  Price lists, Bulk pricing             (o)   ( )   ( )   ( )
  Stock levels, Counts, Valuation       (o)   ( )   ( )   ( )
ACCOUNTING, PAYROLL, REPORTS, FILES     all None (collapsed)
SETTINGS AND PEOPLE                     all None (collapsed)                   [ ] Change organization
```

Each row has a one-line description. Hovering a level lists what it grants: the pages, the buttons and the data. A row also says what it quietly lets other forms read ("the invoice form can search products, contacts and warehouses; their pages stay closed").

### 2.3 The Users dialog

```
First name    Middle name    Last name
Email         Username       Password
Role   [ Seller v ]
       Sells at the counter and on paper and moves stock between warehouses.
       Can create:   sales documents, proforma, cash sales, contacts, stock transfers
       Read-only:    products, categories, warehouses, devices
       Not visible:  orders, bills, payments, price lists, stock levels, accounting, payroll, reports, files, settings
Active [x]
```

The three lines under the description are generated from the role and the catalogue, on create as well as edit. They answer the owner's three questions: what is visible, what is read-only, what can be created.

### 2.4 FR-26 as data

The Seller and Sales Consultant of FR-26 §2.1, and the five open items on #493, as rows in the editor and no code:

| Feature | Seller | Sales Consultant |
|---|---|---|
| Sales documents (invoice, credit note, debit note), Proforma | Work | Work |
| Till: terminal, cash-sale journal, sessions | Work, Storno off | Work, Storno off |
| Orders: incoming, outgoing, reservations | None | Work |
| Bills, Payment orders, Cash orders, Sequences | None | None |
| Contacts | Work | Work |
| Devices | **View** (item 1) | **View** |
| Sales documents → Totals strip | off (item 2) | off |
| Products, Categories, Warehouses | View, Export off | View, Export off |
| Products → Cost figures | on, the owner's call (D-5) | on |
| Stock movements | View, create and edit `transfer` only | the same |
| Stock levels, Counts, Valuation, Opening stock, Price lists, Bulk pricing | None | None |
| Accounting, Payroll, Reports, Files | None | None |
| Home, Dashboard, Settings, Admin | None | None |
| Landing page | Products (item 3) | Products |
| Change organization | off (item 4) | off |
| Import on the movements and invoices lists | not granted, so no button (item 5) | not granted |

### 2.5 One catalogue, everything else generated

```ts
// packages/config/src/access/catalogue.ts: import-pure, like report-registry.types.ts
{ id: 'price-lists', app: 'inventory', label: 'access.priceLists', hint: 'access.priceLists.hint',
  actions: ['view', 'create', 'edit', 'delete'],
  levels:  { view: ['view'], work: ['view', 'create', 'edit'], full: 'all' },
  pages:   ['/inventory/price-lists', '/inventory/bulk-pricing'],
  routes:  ['warehouse/price-list', 'warehouse/bulk-pricing'] },

{ id: 'bills', app: 'invoicing', label: 'access.bills', hint: 'access.bills.hint',
  actions: ['view', 'create', 'edit', 'delete', 'issue', 'import', 'export'],
  levels:  { view: ['view'], work: ['view', 'create', 'edit', 'issue'], full: 'all' },
  implies: { create: ['products.lookup', 'contacts.lookup'] },
  pages:   ['/invoicing/bills', '/invoicing/bills/new'],
  routes:  ['bills/import', 'invoicing/bills'],
  partition: { model: 'Invoice', where: { direction: 'incoming' } } },  // the data layer adds this filter
```

From the catalogue come: the server's rule tables, the client's page rows and menu gates, the editor's rows and hints, the built-in roles, and the summaries under §2.3. Today's controls map in like this:

| Today | Becomes |
|---|---|
| `accounting.read/write/post/file/import` | accounting features: view; create and edit; `post`; `file`; `import` |
| `inventory.read/write/adjust/transfer` | inventory features: view; create, edit, delete; `adjust`; `create:transfer` |
| `invoicing.read/write/send` | invoicing features: view; create and edit; `issue` |
| `pos.read/write` | the Till feature: View; Work |
| `payroll.read/write/approve/personal/import` | payroll features: view; edit; `approve`; the people features; `import` |
| `reports.read/export` | Reports: View; `export` |
| `admin.users`, `admin.settings`, `admin.audit` | Users and Roles; organization settings, Devices (Full), numbering, desktops, servers; Audit log |
| the seven areas | `orders`, `bills`, `payments`, `price-lists`, stock control (four features), `products` → `export`, and each page's own feature in place of `portal` |
| `FISCAL_ADMIN_ROLES`, `STORNO_ROLES` | Devices (Full), Till → `storno` |
| `role === 'admin'` | the Administrator role: `*` |
| admin or `nra_auditor` (SUPTO tables) | SUPTO → `export` |

## 3. Requirements

**FR-27.1 — The catalogue (MUST).**
- One entry per feature in `packages/config/src/access/catalogue.ts`: id, app, label and hint keys, actions, document-type qualifiers, what View, Work and Full contain, `implies` (the lookups a form needs), pages, route prefixes, an optional data partition, optional field groups, a `till` flag. About 60 entries, derived from today's page registry, the six route lists and the report registry.
- `CapabilityId` is a union type, so a typo fails the build.
- Labels and hints exist in en, bg, de and mk. A test fails on a missing key (a missing key renders literally).
- The Work and Full definitions of every feature are a table the owner reviews in the Phase 0 PR.
- A group, `ALWAYS`, lists what every signed-in person keeps: account and password, sign-out, notifications, language, ★, and the shell's reads (the organization's name, colleagues' names, apps, logo, tags). The editor shows it greyed as "always included".

**FR-27.2 — One evaluator (MUST).**
- `accessRefusal(session, method, route)` replaces `readRefusal`, `writeRefusal` and `areaRefusal`. The six lists in `route-permission.ts` are generated from the catalogue. A route with no entry is refused and fails the route-table tests, as today.
- A `self:` rule survives only where the object decides (a partition or a field group), and it names the capability it checks.
- `canOpenPage`, `landingWithoutPortal`, `isTillOnly`, `isTransferOnly`, `writesInventory`, `readsDocuments`, `holdsArea`, `holdsPersonal`, `FISCAL_ADMIN_ROLES`, `STORNO_ROLES` and the role list in `canAccessReport` are deleted or become one-line calls to `can()`.
- After Phase 3 no file outside `access/` names a role or reads `permissions`, `areas` or `role` from a token. A test greps for it.
- A session's scope still narrows and never widens: a PIN session reaches the features marked `till`, an identity-only token the organization picker only.

**FR-27.3 — Roles (MUST).**
- `Role { orgId, name, description, caps[], landing?, templateKey?, isBuiltin, version }`, name unique per org, replicated like sets (class R). `User.roleId`, one per membership.
- The ten legacy roles ship as built-in templates whose access equals today's, under the same names. `sales` and `hr_manager`, which have no set today, get templates of their own.
- `Administrator` holds `*`, expanded when checked, so a capability added later is included. It cannot be edited, deleted or emptied.
- A built-in role that was never edited follows its template when a release adds capabilities. An edited one shows a "new options" badge and keeps what it had. A custom role never gains a capability by itself.
- An organization setting `defaultRoleId` replaces the set's `isDefault`. Invites and self-service joins use it.
- Scripts and API users name a role by `templateKey` (`seed-user.ts --role seller`, `create-api-user.ts`).

**FR-27.4 — The screens (MUST).**
- *Settings → Roles & access* replaces *Permission sets* (the old path redirects). A list with the number of people; a role is created blank, or copied from a template or another role. The editor is §2.2.
- A role page shows in words, generated from the catalogue, what the role can create, what is read-only and what is not visible (§2.3), and who has it.
- The Users dialog has one **Role** select with the role's description and the same summary under it. No sets, no legacy list, no areas, no record scoping, no Default switch, no Migrate button.
- Invites choose a role.
- A role's description is one sentence in four locales. That is what ends „Sales" against „Seller".

**FR-27.5 — Live effect (MUST).**
- The token carries `rid` and `rv` (role id and version). The grant is resolved on the server from a per-process cache of 60 s, as `liveSessionUser` does. A role edit or a change of a person's role reaches every pod within a minute, and nobody is signed out.
- Every response carries `x-access-version`. The SPA refetches `/auth/me` when it changes, and the menu follows.
- Until Phase 3 the token also carries the legacy claims, derived from the role, for tabs and masters on an older release.
- FR-26.9.4's `tokenVersion` bump on a role change stops: it signs the person out of every organization.

**FR-27.6 — Partitions and fields (MUST).**
- A capability that splits one collection (bills from sales documents, movement types, orders) is a filter in the data layer, not a check in each route. The `Invoice` and `StockMovement` DAO methods take the session's partition as a required argument, so a controller cannot forget it. For a role without `bills.view` an incoming document is 404 by id and absent from lists, exports, the contact ledger, summaries and the totals strip. This is FR-26.6's table, written once.
- A field group (`products.costs`: `purchasePrice`, `avgCost`, the cost tiers) is removed by one `redact()` in every serializer: list, id, picker, export, report, print. A test asserts the keys are absent from the JSON, not that a column is hidden.

**FR-27.7 — Read-only is generic (MUST).**
- `ListScaffold`, `DocumentForm` and the order, movement, product, category, warehouse and device forms open read-only when the feature's save action is missing: fields disabled, no New, Save, Delete, Import, Export or Void.
- A view that calls a write endpoint without consulting `useAccess()` fails a unit test. An allow-list names the exceptions and why.
- A hidden feature: its menu entry, ★ pin, „+ Нов" entry and search hit are gone, and its URL shows a standard "Not available for your role" page, never a blank page or a crash.
- Landing: the role's `landing` page, else the first page it may open. Sign-in, `/`, `/apps`, `/settings/*` and `/admin/*` all land there when the role cannot open them.
- Test builds put `data-cap` on every gated control, so a browser walk can assert it.

**FR-27.8 — Safety (MUST).**
- Nobody edits their own role. Nobody creates or edits a role, or assigns one, that holds a capability they do not hold. Only an Administrator assigns Administrator or `access.roles`.
- The last active Administrator cannot be demoted, deactivated or deleted. A sys-admin script restores the Administrator role of an organization that locked itself out, and is audited.
- An unknown id in a stored role is ignored and listed on the role's page. An unlisted capability is never a grant.
- Roles are tenant-scoped: a role id from another organization resolves to nothing, as sets do in `tokenize()`.
- Every role create, edit and delete, and every assignment, is audited with the before and after capabilities. `roleHistory` (Appendix 29) keeps working and records the role's key and name at the time.

**FR-27.9 — Preview and lookups (SHOULD, Phase 2).**
- "Preview as this role": the menu and pages as the role sees them, drawn from the catalogue, with no data and no impersonation.
- "Who can…": pick a capability, see the roles and people.
- "Compare roles": two columns.

**FR-27.10 — What does not change (MUST).** The tenant guard. Identity-only tokens. The PIN scope. Operator codes. Fiscal immutability. App enablement per organization: an app that is off hides its features whatever the role says. Desktop credentials.

## 4. Migration

| A membership today | Becomes |
|---|---|
| one set | a role named like the set, with what that set grants today (permissions and areas compiled). An `isAdmin` set on role `admin` becomes Administrator |
| several sets | one role "A + B", the union, created once per distinct combination and marked Imported. The admin renames it later |
| no set, role R, no extra permissions | the built-in role R |
| no set, role R, extra legacy permissions | a custom role "R + extras" |
| an `isAdmin` set on a role that is not `admin` | a custom role with every capability except those only role `admin` has today (people, invites, the organization, billing, digest, integrations, apps, logo). Administrator would hand that person admin-only routes. **Zero difference means nobody gains either** |
| a set id from another organization | ignored, as `tokenize()` ignores it today |
| API users | by their role key |

Procedure:
1. A **dry run per organization** prints people, their access before and after, and any difference. It writes nothing.
2. A per-organization flag `access.model`: `legacy` (today), `shadow` (the old rules decide, the evaluator runs beside them on every request and counts differences, with no business figures logged), `roles` (the evaluator decides). Move to `roles` only after a day with zero differences.
3. Both models are written until Phase 3. Every role also writes its legacy projection (role key, permissions, areas), so a master on an older release serves each person what they could do before.
4. A role that uses a restriction the legacy model cannot express (a field group, read-only Devices, an Import it must not show) is flagged "needs release N". Assigning it to a person homed on an older node is refused, with the minimum-version check that moves and re-seeds already use (#515).

The function that compiles a legacy grant into capabilities is also the Phase 0 oracle.

## 5. Phases and rollback

| Phase | Ships | Visible change | Exit |
|---|---|---|---|
| 0 | the catalogue, generated server tables, the evaluator, `useAccess`, the legacy compiler, the shadow flag. Sliced by app: Invoicing, Inventory, Accounting/Payroll/Reports/Files, Portal and admin | none | the differential test (§6) is green for every default role, every fixture shape, every route and every page |
| 1 | `Role`, the migration, Roles & access, the Users and Invite screens, live effect, the safety rules | the two screens | an organization on `roles` with zero shadow differences, the legacy projection written |
| 2 | partitions, field groups, generic read-only, Devices View/Full, the totals strip, Import and Export as actions, change organization, landing; #493 items 1 to 5 and D-5 | FR-26's open items | acceptance 3 and 4 |
| 3 | contract: remove the legacy inputs, screens, areas, record scoping, `isDefault`, the role-name checks and Migrate; drop the legacy claims once every master passes the minimum version | the old controls are gone | a release at zero differences, and the grep test |

**Rollback.** Phase 0 changes no answer. Phase 1: set `access.model` back to `legacy`, whose fields are still written. Phase 2: each restriction is catalogue data on a role, so remove the capability from the role, with no deploy. Phase 3 is the only one-way step: ship it a release after Phase 2 has run at zero differences, and keep the legacy fields in an archive field for one release.

**Risks.**
- *Access changes silently at migration.* The differential test, the dry run and the shadow flag.
- *An older master fails open.* The legacy projection, and the refusal in step 4.
- *The catalogue drifts from the code.* The tables are generated, and the coverage tests fail on a route or a gate with no entry.
- *An organization locks itself out.* Administrator cannot be edited, the last-Administrator rule, the restore script.
- *The editor overwhelms.* Levels, templates, one-sentence summaries, preview.

## 6. Tests

- **Differential (the safety net).** For each of the ten roles and each stored shape (one set, several sets, an `isAdmin` set on a non-admin role, no set with extra permissions, a set from another organization, `areas` absent against `[]`), over every route in the real route table (reads and writes) and every `PAGE_REGISTRY` row: the old verdict equals the evaluator's, on the server and in `canOpenPage`. Extends `route-permission.flow` and `read-permission.flow`.
- **Coverage.** Every route resolves to exactly one capability, and every capability has a route or a UI gate. Every gate names a catalogued id (type-checked). Every catalogue key exists in four locales.
- **Roles are data.** Build Seller and Sales Consultant from a blank role through the API, and once through the editor in e2e. Run `seller-roles.flow`'s assertions unchanged.
- **Partitions and fields.** Bills by id, list, export, ledger and summary; movement types; the `products.costs` keys absent from every serializer.
- **Live effect.** A role edit reaches a live session on the same pod at once and on a second pod within the TTL (the two-node harness), with no sign-out. A demoted Administrator loses admin-only routes within the TTL.
- **Safety.** Self-edit, escalation, last Administrator, another organization's role id, an unknown capability id.
- **Migration.** Idempotent; the dry run equals the applied result; the zero-difference gate refuses an organization with a difference.
- **Browser walk.** For each built-in role and every page: no 403 on load, no visible control without its capability, no `data-cap` control for a capability the role lacks.
- ⚠ Never `.rejects` or `.resolves` in this suite (CLAUDE.md, Known Issues).

## 7. Acceptance criteria

1. Shadow differences are zero over the whole corpus of §6 before any organization moves to `roles`.
2. After Phase 3 no file outside `access/` names a role or reads `permissions`, `areas` or `role` from a token.
3. From a blank role, in the editor, with no code, Seller and Sales Consultant pass the FR-26 §2.1 table and #493 items 1 to 5. Turning `see:costs` off removes the cost keys from the API (D-5).
4. For every built-in role and page, View without Work shows no New, Save, Delete, Import or Export, and no page loads with a 403.
5. A role edit reaches a live session within 60 s on every pod, with no sign-out.
6. FR-27.8 holds.
7. A master on the previous release serves each migrated person what they could do before.
8. The two screens carry none of: the legacy list, sets, areas, record scoping, Default, Migrate. The four locales are complete.
9. `bun run test`, `bun run build`, `bun run test:e2e` and CI are green. The existing suites pass unmodified except those that pin a removed control (the permission-set and users screens, and the areas assertions of `seller-roles.test.ts`).

## 8. Field test (production, after each phase; the demo org, never a customer's)

1. Phase 1: dry run, then move the demo org to `shadow`. Walk every default role. Read the difference count (0).
2. Phase 1: in Roles & access build Seller from a blank role. Create a throwaway user with it and compare it with a built-in Seller user: the same menus, the same refusals.
3. Phase 2: #493 items 1 to 5 on both roles. Turn `see:costs` off and read a product through the API: no cost keys.
4. Edit the role while that user is signed in. Their menu follows within a minute, and they are not signed out.
5. Drop the throwaway users and report the count left (0).

## 9. Decisions (defaults stand unless the owner answers otherwise)

| | Question | Default |
|---|---|---|
| D-1 | One role per person, or several that add up? | One. To deviate, copy the role. No per-user extras: those are today's "Permissions (Legacy)" |
| D-2 | Level names | None, View, Work, Full. bg: „Няма достъп", „Преглед", „Работа", „Пълен достъп" |
| D-3 | The ten legacy roles | They stay as built-in templates with unchanged access and names. A one-sentence description under each tells `sales` from `seller`. Renaming either is a separate call |
| D-4 | "Own records only" | Dropped, because it does nothing today. The model leaves room for a `scope` qualifier on a feature if a role ever needs "only my own documents" |
| D-5 | Cost figures for Seller and Sales Consultant (FR-26 D-5, still open) | **Decided 2026-11-05: the default.** The mechanism ships (`see:costs`). The templates keep showing them until the owner says otherwise |
| D-6 | A role change and sessions | Live within 60 s, nobody signed out. FR-26.9.4's `tokenVersion` bump goes |
| D-7 | Who edits roles | Administrator. `access.roles` can be delegated, but a delegate grants only what they hold, and never `access.roles` or `*` |
| D-8 | #493 items 1 to 5 meanwhile | **Decided 2026-11-05: the default.** Built as the first catalogue features in Phase 2, not as new areas. If they must ship sooner, they ship as catalogue entries on the Phase 0 evaluator, still not as areas |
| D-9 | Where today's `admin.settings` goes | It splits into features: organization settings, Devices (Full), numbering, desktops, servers, Files, Roles & access. What is Administrator-only today stays Administrator-only in every template |
| D-10 | Preview as role | Phase 2, SHOULD |

## 10. Not in this FR

- Own-records scoping, per-branch or per-warehouse restrictions, time-limited access, approval workflows, a two-factor policy per role, scopes for integration tokens beyond their role.
- A rewrite of any screen except to make it read-only or hide it.
- Renaming roles, or changing what any existing role can do. Phases 0 and 1 change nobody's access.
- Sign-in, identity and invite mechanics (FR-19).


---

## Appendix A. The catalogue, for review before Phase 0 (FR-27.1)

Mapped from origin/master `eb6414e6` (2026-11-09):
- the real route table, `createApiApp().routes`: 459 org routes, 229 distinct prefix-and-rule pairs;
- `PAGE_REGISTRY` and `PORTAL_PAGES`;
- the report registry;
- every role-name check on the server.

**Phase 0 changes nobody's access.** Each row below must give every stored shape the answer it gets today. The differential test (§6) proves it on every route and page. Where today's code and this table could disagree, A.4 says so.

### A.1 Conventions

- **A capability** is `feature.action`. An action may name a document type: `movements.create:transfer`.
- **The levels** are View ⊂ Work ⊂ Full. Each row lists only what a level adds; the extras sit outside the levels and are ticked one by one.
- **Reads.** Any capability of a feature opens that feature's read routes, so a `lookup` or a `create` reads it too. This is today's rule: "a role allowed to write it reads it". A **page** needs `view`.
- **Writes.** The work actions (`create`, `edit`, `delete`) open the feature's write routes. A route named under an action opens only for that action.
- **`lookup`** is what another feature's form reads: the invoice form searching products. It is granted only through another feature's `implies`, never shown as a level.
- **Helpers** are features with no row in the editor, granted only through `implies`. They cover routes several forms share.
- **`ALWAYS`** lists what every signed-in member keeps (FR-27.1). The editor shows it greyed.
- **`system`** marks what no organization role grants: backups (`requireSysAdmin`).

### A.2 Features

Labels: en / bg. Abbreviations in the routes column:
- `R`: read routes; `W`: write routes.
- ACC = `accounting.read|write|post|file`; INV = `inventory.read|write|adjust|transfer`; INVC = `invoicing.read|write|send`; POS = `pos.read|write`; PAY = `payroll.read|write|approve`.
- These are today's rules, quoted so the table can be checked against `route-permission.ts`.

#### Invoicing

| id | Label | View | Work adds | Full adds | Extras | Routes (today's rule) | Pages | Area today |
|---|---|---|---|---|---|---|---|---|
| `sales-docs` | Sales documents / Документи за продажба | view | create, edit, issue, pay, email | delete, void | `totals` (P0.5), `export`, `import` (P0.5) | R `invoices`, `invoices/peek-next`, `stats/invoice`, `invoicing/reports`, `invoicing/number-clashes` (INVC). W `invoices`, `invoicing/number-clashes` (`invoicing.write`). `invoicing/export` (self: `canExport`). `invoices/summary` → `totals` | `/invoicing/invoices`, `…/invoices/new` (+ credit and debit note) | |
| `proforma` | Proforma and offers / Проформи и оферти | view | create, edit, issue | delete | | the `invoices` routes, the quotes: type `proforma` or `offer` (one partition, Phase 2; offers since 2026-11-12) | `/invoicing/proforma`, `…/proforma/new`, `/invoicing/offer`, `…/offer/new` | |
| `bills` | Purchase documents / Документи за покупка | view | create, edit, issue, pay | delete, void | `totals`, `import` | R `invoicing/bills` (INVC). W `invoicing/bills`, `bills/import` (`invoicing.write`). The `invoices` routes, direction `incoming` (the controller's `holdsArea('purchases')` today) | `/invoicing/bills`, `…/bills/new` | `purchases` |
| `orders` | Orders and reservations / Поръчки и резервации | view | create, edit | delete | | R/W `invoicing/orders` (R also INV: a delivery books against an ORDO), `invoicing/internal-orders`, `invoicing/reservations`. Order links on an invoice (`orderLinkRefusal`) | orders, internal-orders, reservations (+ their `/new`) | `orders` |
| `payments` | Payment and cash orders / Платежни нареждания и касови ордери | view | create, edit | delete | | R/W `invoicing/payment-order`, `invoicing/cash-order` | payment-orders, cash-orders | `payments` |
| `contacts` | Contacts / Контакти | view | create, edit | delete | | R `invoicing/contact` (INVC\|INV\|POS → `lookup`), `invoicing/contact/:id/summary`, `invoicing/contact-ledger`, `stats/contact` (INVC). W `invoicing/contact` | `/invoicing/contacts`: today any INVC, or `inventory.read\|write\|adjust` (suppliers). See A.4 | |
| `cash-sales` | Cash sales / Касови продажби | view | | | `storno`, `settle` | R `cash-register/documents` (POS\|INVC). W `…/:id/storno`, `…/:id/settle` (`pos.write\|invoicing.write`, plus `STORNO_ROLES` in the controller) | `/invoicing/cash-sales` (till) | |
| `till` | Till: terminal and sessions / Каса: терминал и сесии | view | sell | | `manage-sessions` | R `trade/pos`, `pos/payment-methods` (POS); `trade/pos/catalog` (POS\|INVC → `lookup`). W `trade/pos`, `pos/payment-methods` (`pos.write`). Another cashier's close or report reprint: admin, manager | `/invoicing/cash-sales/new` (`pos.write`), `/invoicing/cash-register/sessions` (POS) | |
| `devices` | Fiscal devices / Устройства | view | edit, report | | `z-report`, `sync-time` (admin, manager), `name-payments` (admin) | R `fiscal` (`ALWAYS`: names and states; connection details only with `edit`, `sanitizeDevice`). W `fiscal/device`, `fiscal/workstation` (self: `FISCAL_ADMIN_ROLES`). Z-report and time sync: admin, manager. `trade/pos/session/:id/device-report` → `report` | `/invoicing/configuration/devices`: POS, or a `FISCAL_ADMIN_ROLES` role | |
| `sequences` | Document numbering / Номерация | view | edit | | | R `invoicing/sequences` (self: admin, manager). W the same route: `invoicing.write` by prefix, admin and manager in the controller | `/invoicing/configuration/sequences` | |

#### Inventory

| id | Label | View | Work adds | Full adds | Extras | Routes (today's rule) | Pages | Area today |
|---|---|---|---|---|---|---|---|---|
| `products` | Products / Продукти | view | create, edit | delete | `export`, `costs` | R `warehouse/product` (INV\|INVC\|POS → `lookup`), `warehouse/product-ledger`, `stats/product`, `invoicing/product-supply` (INV\|INVC). `warehouse/cost-layer` (not `/valuation`; INV) → `costs`. W `warehouse/product`, `warehouse/cost-layer` (`inventory.write`) | `/inventory/products` (`inventory.read`) | export: `catalogExport` |
| `categories` | Categories / Категории | view | create, edit | delete | | R `warehouse/product-category` (INV\|INVC\|POS). W the same | `/inventory/categories` | |
| `warehouses` | Warehouses / Складове | view | create, edit | delete | | R `warehouse/warehouse` (INV\|INVC\|POS), `warehouse/locations`, `warehouse/lots`, `warehouse/operation-types` (INV). W the same | `/inventory/warehouses` | |
| `movements` | Stock movements / Документи за движение на стоки | view | create, edit | delete | `create:transfer`, `import`, `export` | R `warehouse/movement` (INV\|INVC). W `warehouse/movement` (`inventory.write\|transfer`; a transfer-only session is held to transfers by the controller). Import: doc-import target `movement` (`inventory.write`) | `/inventory/movements`, `…/movements/new` (`inventory.write\|transfer`) | |
| `stock-levels` | Stock levels / Наличности | view | | | | R `warehouse/stock-level` (INV). The product page and the transfer form read it too, so it is not carved out today | `/inventory/stock-levels` | `stockControl` |
| `inventory-counts` | Inventory count / Инвентаризация | view | create, edit | delete | | R/W `warehouse/inventory-count` | `/inventory/inventory-counts` | `stockControl` |
| `valuation` | Inventory valuation / Оценка на запасите | view | | | | R `warehouse/cost-layer/valuation` | `/inventory/inventory-valuation` | `stockControl` |
| `opening-stock` | Opening stock import / Внос на начални наличности | view | create | | | R/W `warehouse/opening-stock` | `/inventory/opening-stock` | `stockControl` |
| `price-lists` | Price lists / Ценови листи | view | create, edit | delete | | R/W `warehouse/price-list` | `/inventory/price-lists` | `pricing` |
| `bulk-pricing` | Bulk pricing / Масово ценообразуване | view | apply | | | W `warehouse/bulk-pricing` | `/inventory/bulk-pricing` | `pricing` |

#### Accounting

| id | Label | View | Work adds | Full adds | Extras | Routes (today's rule) | Pages |
|---|---|---|---|---|---|---|---|
| `accounts` | Chart of accounts / Сметки | view | edit | create, delete | | R `accounting/account` (ACC\|INVC → `lookup`). W the same (`accounting.write`); POST also needs admin or accountant (`account.controller.ts:52`) | `/accounting/accounts` |
| `bank-accounts` | Bank accounts / Банкови сметки | view | create, edit | delete | | R `accounting/bank-account` (ACC\|INVC → `lookup`). W the same | `/accounting/bank-accounts` |
| `journal` | Journal entries / Счетоводни записи | view | create, edit | delete | `post` (post and void) | R/W `accounting/journal`, `accounting/journals`. `…/journal/:id/post\|void` → `post` | `/accounting/journal-entries` |
| `ledgers` | Ledgers and statements / Главна книга и отчети | view | | | | R `accounting/report`, `accounting/reports`, `accounting/books` | general-ledger, financial-statements, journal-analysis |
| `vat` | VAT and tax returns / ДДС и данъчни декларации | view | edit | | `file` | R `accounting/vat`, `accounting/tax-return`; a filing's files: `accounting.file\|admin.audit`. W `accounting/tax-return`; `…/vat/:period/generate\|mark-filed` → `file` | `/accounting/tax-returns` |
| `accounting-setup` | Fiscal years, periods and payment terms / Финансови години, периоди и условия за плащане | view | create, edit | delete | | R/W `accounting/fiscal-year`, `fiscal-period`, `fiscal-positions`, `payment-terms` | none in the registry |
| `exchange-rates` | Exchange rates / Валутни курсове | view | create, edit | delete | | R/W `accounting/exchange-rate` | `/accounting/exchange-rates` |
| `reconciliation` | Reconciliation / Съгласуване | view | create, edit | delete | | R/W `accounting/reconciliation` | `/accounting/reconciliation` |
| `fixed-assets` | Fixed assets / Дълготрайни активи | view | create, edit | delete | | R/W `accounting/fixed-asset` | `/accounting/fixed-assets` |
| `books-import` | Import of books / Внос на счетоводство | | | run | | W `accounting/import/*` (`accounting.import`) | |

#### Payroll

| id | Label | View | Work adds | Full adds | Extras | Routes (today's rule) | Pages |
|---|---|---|---|---|---|---|---|
| `payroll-runs` | Payroll runs / Ведомости | view | create, edit | delete | `approve` | R `payroll/run` (PAY). W `payroll/run` (`payroll.write`); `…/approve` → `approve`; `…/reveal`, `…/declaration` → `payroll-people.reveal` | `/payroll/runs` |
| `payroll-people` | Employees and their records / Служители, фишове, работно време | view | edit | | `reveal` | R `payroll/employee`, `contract`, `payslip`, `timesheet`, `absence`, `leave-balance` (`payroll.personal`). W the same (`payroll.write`, plus `holdsPersonal` in the controllers); `…/:id/reveal` → `reveal` | employees, payslips, timesheets |
| `payroll-import` | Import of payroll / Внос на заплати | | | run | | W `payroll/import/*` (`payroll.import`, plus `payroll.personal` in the controller) | |

#### Reports and Files

| id | Label | View | Full adds | Extras | Routes (today's rule) | Pages |
|---|---|---|---|---|---|---|
| `reports` | Reports / Справки | view | export | `invoicing`, `inventory`, `accounting` | R `reports/catalog`; W `reports/:id/run`, `…/export` (self: `canAccessReport` / `canExportReport`). Each report names one content extra, which replaces its `permission` (the 6 / 5 / 5 that read `invoicing.read`, `inventory.read`, `accounting.read`) | the `/reports/*` rows |
| `supto` | SUPTO tables / Таблици СУПТО | view | export | | R `supto/export`; the nine SUPTO reports (admin, nra_auditor) | `/reports/supto/*` |
| `files` | Files / Файлове | view | upload, book | `archives` | R/W `files/*`, `file` (self: admin or `admin.settings`; `archives` also nra_auditor; booking also takes the write of what it books) | `/files/*` |

#### Settings and people

| id | Label | View | Full adds | Routes (today's rule) | Pages |
|---|---|---|---|---|---|
| `dashboard` | Dashboard / Табло | view | | R `dashboard/summary` (INVC\|ACC\|INV; area `portal`) | `/dashboard` |
| `org-settings` | Organization / Организация | view | edit | W `PUT ''` (admin role), `logo` (admin role) | `/settings/organization` (anyone back office) |
| `users` | Users / Потребители | view | edit | W `user` (admin role). R `user` stays `ALWAYS` (colleagues' names) | `/settings/users` |
| `invites` | Invitations / Покани | | manage | R/W `invite` (admin role) | `/settings/invites` |
| `roles` | Roles and access / Роли и достъп | view | edit | R `permission-sets` (admin, or `admin.settings`); W the same (admin role) | `/settings/permission-sets` → `/settings/roles` |
| `apps` | Apps / Приложения | | manage | W `apps` (admin role). R `ALWAYS` | |
| `digest` | Daily digest / Дневен отчет | | manage | `digest/*` (admin role; FR-11: `admin.settings` deliberately does not suffice) | |
| `integrations` | Integrations / Интеграции | | manage | `integration/google-drive` (admin role) | |
| `billing` | Billing / Абонамент | | manage | Stripe (admin role) | `/settings/billing` |
| `desktops` | Desktops / Настолни приложения | view | manage | `desktops/*` (admin, or `admin.settings`) | `/settings/desktops` |
| `servers` | Servers and moves / Сървъри и преместване | view | manage | `nodes`, `moves`, `address`, `server` (admin, or `admin.settings`; global or master only) | `/settings/servers`, `/settings/server` |
| `numbering` | Last numbers / Последни номера | view | manage | `numbering/*` (admin, or `admin.settings`) | |
| `audit-log` | Audit log / Одит | view | | R `audit-logs/*` (self: all of it with `admin.audit`; one record's history to whoever reads its module) | `/admin/audit-log` |
| `org` | Your organizations / Вашите организации | | | extra `switch` (P0.5, #493 item 4) | the org menu, `/orgs` |

#### Helpers, `ALWAYS`, `system`

| id | Granted by | Routes |
|---|---|---|
| `pricing` (helper) | `implies` from the selling and stock forms | R `pricing/*` (INVC\|POS\|INV) |
| `stock-availability` (helper) | `check` from document views; `transfer` from document `create` | W `invoicing/stock-availability/check` (`invoicing.read\|inventory.read`), `…/create-transfers` (`invoicing.write`) |
| `doc-import` (helper) | the `import` extras | R `doc-import/task` (INVC\|INV); W `…/extract` (`invoicing.write\|inventory.write`); `analyze`, `commit`, `convert` decide by target |
| `tags` (helper) | `edit` from `contacts` and `products` Work | W `tags` (`invoicing.write\|inventory.write`); R `ALWAYS` |
| `ALWAYS` | every member | R `''` (the org), `apps`, `licence`, `home`, `notification`, `tags`, `logo`, `user`, `fiscal`; W `notification/*`, `POST audit-logs` (a note), `POST file` (an upload's metadata) |
| `system` | no org role | `backup/*` (`requireSysAdmin`) |

### A.3 The legacy bridge (what `compileLegacy` grants)

**Role `admin`** gets `{ all: true }`, as does an `isAdmin` set held by role `admin`.

**Permissions:**

| Permission | Capabilities |
|---|---|
| `invoicing.read` | `.view` of `sales-docs`, `proforma`, `bills`, `orders`, `payments`, `contacts`, `cash-sales`; `sales-docs.export`, `sales-docs.totals`, `reports.invoicing`; lookups: `products`, `categories`, `warehouses`, `movements`, `accounts`, `bank-accounts`, `till` (catalog); helpers `pricing`, `stock-availability.check`, `doc-import` |
| `invoicing.write` | the same reads, plus Work and Full of `sales-docs`, `proforma`, `bills`, `orders`, `payments`, `contacts` (`sales-docs.export` included, as `canExport`); `import` of `sales-docs` and `bills`; `stock-availability.transfer`; `tags.edit` |
| `invoicing.send` | the reads of `invoicing.read`, but not `export`. **It opens no write anywhere today** (A.4) |
| `inventory.read` | `.view` of every inventory feature; `products.costs`; `reports.inventory`; lookups `contacts`, `orders`; helpers `pricing`, `stock-availability.check`, `doc-import` |
| `inventory.write` | the inventory reads (as lookups, not `.view` pages), plus Work and Full of every inventory feature; `movements.import`; `tags.edit` |
| `inventory.adjust` | the inventory reads, as lookups only. **Nothing reads it beyond that today** (A.4) |
| `inventory.transfer` | the inventory reads, as lookups; `movements.create:transfer` |
| `pos.read` | `till.view`, `cash-sales.view`, `devices.view`; lookups `products`, `categories`, `warehouses`, `contacts`; `pricing` |
| `pos.write` | the `pos.read` set, plus `till.sell` |
| `accounting.read` | `.view` of every accounting feature but `books-import`; `reports.accounting` |
| `accounting.write` | Work and Full of the accounting features, except `accounts.create` (below) |
| `accounting.post` | `journal.post`, plus the accounting reads |
| `accounting.file` | `vat.file`, plus the accounting reads |
| `accounting.import` | `books-import.run` |
| `payroll.read` | `payroll-runs.view` |
| `payroll.write` | Work and Full of `payroll-runs`; `payroll-people.edit` |
| `payroll.approve` | `payroll-runs.approve` |
| `payroll.personal` | `payroll-people.view`, `payroll-people.reveal` |
| `payroll.import` | `payroll-import.run` |
| `reports.read` | `reports.view` |
| `reports.export` | `reports.export` |
| `admin.settings` | `files.*`, `desktops.*`, `servers.*`, `numbering.*`, `roles.view` |
| `admin.audit` | `audit-log.view`, plus a filing's files (`vat` download) |
| `admin.users` | nothing. **It is checked by nothing today** (§1.3) |

**By role name**, whatever the sets say:

| Role | Capabilities |
|---|---|
| `admin`, `manager`, `warehouse_manager` (`FISCAL_ADMIN_ROLES`) | `devices.view`, `devices.edit`, `devices.report` |
| `admin`, `manager` | `devices.z-report`, `devices.sync-time`, `cash-sales.storno`, `cash-sales.settle`, `till.manage-sessions`, `sequences.view`, `sequences.edit` (the last with `invoicing.write`, as the route needs it) |
| `admin`, `accountant` | `accounts.create` (with `accounting.write`) |
| `admin`, `nra_auditor` | `supto.view`, `supto.export` |
| `nra_auditor` | `files.archives` |
| `admin` | `org-settings.edit`, `users.edit`, `invites.manage`, `roles.edit`, `apps.manage`, `digest.manage`, `integrations.manage`, `billing.manage` |

**Areas.** When the claim is a list, each area that is missing removes:

| Missing area | Removed |
|---|---|
| `portal` | `dashboard.view`, and the portal pages' capabilities |
| `orders` | `orders.*`, except the `lookup` a delivery needs |
| `purchases` | `bills.*` |
| `payments` | `payments.*` |
| `pricing` | `price-lists.*`, `bulk-pricing.*` |
| `stockControl` | `inventory-counts.*`, `valuation.*`, `opening-stock.*`, `stock-levels.view` (its `lookup` stays) |
| `catalogExport` | `products.export` |

**#493 items 2–5 (P0.5).** Every session gets `sales-docs.totals`, `bills.totals`, `sales-docs.import` and `org.switch` unless its claim carries an `areas` list. That is item 2's own rule ("sessions without a list keep the strip"), and needs no new area. Such a session lands on `/inventory/products` when it can open it.

### A.4 What the mapping found

1. **`inventory.adjust` and `invoicing.send` gate nothing.** Both appear only in the read lists of `route-permission.ts` and in the page rules. No write route and no controller checks them. Holding `invoicing.send` alone, without `invoicing.write`, issues nothing, and `canExport` ignores it.
2. **Devices: Full is not one thing today.** A warehouse manager configures devices and prints their reports, but Z-reports and time sync are admin and manager only (`fiscal-device.controller.ts:323, 355`). The catalogue keeps `z-report` and `sync-time` as extras, so no template changes.
3. **The cash-sale journal is not the till.** `cash-register/documents` is read with any INVC or POS permission, but the sessions page needs POS. One "Till" row would hand an accountant the sessions page or take the journal from them, so `cash-sales` and `till` are two features. The editor can still show them under one heading.
4. **Proforma has no routes of its own.** It lives on `/invoices` with `type: 'proforma'`. Phase 0 gives `sales-docs`, `proforma` and `bills` the same `invoices` rule, as today. Telling them apart is Phase 2's partition (FR-27.6).
5. **Sequences disagree with themselves.** The write route's rule says `invoicing.write` (the `invoicing` prefix); the controller says admin or manager. The catalogue states the effective answer: `sequences.edit` = admin or manager, with `invoicing.write`.
6. **The Contacts page opens for whoever reads inventory**, to see suppliers (`READ_WITH_INVENTORY`), while a contact's summary and ledger need INVC. Phase 0 keeps that: the page opens on `contacts.view` or `contacts.lookup`. Phase 2 should choose: suppliers on the movement form, or `contacts.view` in the Warehouse Manager template.
7. **`stats/product` and `invoicing/product-supply` read across apps** (INV\|INVC). They go to `products` as `lookup`, so the invoicing app keeps them.
8. **`warehouse/cost-layer` is two things:** valuation (`stockControl`) and a product's cost layers. The latter maps to `products.costs`, the field group D-5 needs, so turning cost figures off in Phase 2 also closes the route.

### A.5 For the owner

- **The table.** Ids, labels, and what View, Work and Full hold (FR-27.1). The defaults stand unless you answer otherwise.
- **A.4.3:** `cash-sales` and `till` as two features.
- **A.3's #493 rule:** a session carrying an `areas` list loses the totals, the Import button and changing organization, and lands on Products. That is the Seller and the Sales Consultant, as a role or as a set.
