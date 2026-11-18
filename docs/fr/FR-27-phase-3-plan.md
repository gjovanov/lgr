# FR-27 Phase 3: the contract (plan)

Part of #529. Phase 3 removes the legacy model now that roles decide. It is the one **one-way** phase (§5): it ships
only after Phase 2 has run in production at zero differences, and every step before the last two can be rolled back
by redeploying the previous release.

**What it removes (§3, FR-27.2, acceptance 2 and 8):**
- the legacy role as an authorization input;
- permission sets (model, screens, controller, seed, 0014's sets), `User.permissions` and `permissionSetIds`;
- FR-26's areas (`AREAS`, `holdsArea`, `mergeAreas`, `DEFAULT_ROLE_AREAS`);
- "own records only" (`ownRecordsOnly`, `scopedRepos`);
- the role-name checks (`FISCAL_ADMIN_ROLES`, …);
- the legacy route rules and shadow mode;
- `isDefault` on a set, and the Migrate button;
- the legacy claims in the token, once every master can do without them.

## 1. Gates: none of the code below merges before these hold

| Gate | How it is shown |
|---|---|
| **G1. Every org on `roles`** | `scripts/access-model.ts` reports `roles` for every org (today: `test-regal-pz`; the stores are with the owner). A new `--all --set roles` (P3-1) moves the rest, refusing any org whose report is not 0 or with a person without a role. |
| **G2. A release at zero differences** | Production runs one full release with every org on `roles` and `AccessShadowDiff` empty (`--report --days 7` for each org). Exception: differences from a `needsRelease` role, one the legacy model cannot express (e.g. a products-only reader), are expected and listed. G3 retires them. |
| **G3. Every master reads roles** | `NODE_MIN_MASTER_VERSION` is raised to the first server release with FR-27 Phase 1. #612–#615 merged before #624 bumped the server to 0.1.12, which is not tagged yet (the latest tag is `server-v0.1.11`). The uplink then refuses older masters (`masterVersionRefusal`), so no node still serves people from the legacy claims. |
| **G4. A backup** | The nightly backup of the release that P3-6 ships on, kept for the rollback window. |

## 2. The PRs, in order

Each PR keeps `bun run test`, `build`, `check:web` and the FR-27 walks green
(`e2e/field-walk-roles`, `field-walk-blank-roles`, `field-walk-fr27-11`).

### P3-1 · Every org to roles (ops, small code)
- `scripts/access-model.ts --all`, in **two steps**, because an org on `legacy` counts no differences (`shadow.ts`
  compares on `shadow` and `roles` only), so its "0" proves nothing (found 2026-11-16):
  - `--all --set shadow`: each org on `legacy` gets a role for anyone without one, with exactly their access
    (migration 0015's own `up`, scoped to the org), then moves to `shadow`. Nobody's access changes.
  - `--all --set roles [--min-days 1]`: each org on `shadow` moves once it has been there `--min-days`, with no
    difference since it moved (its audit entry says when) and nobody without a role.
  - A dry run unless `--execute`; it prints what it moves and what it skips, with why (`scripts/lib/access-advance.ts`).
    Every move is audited (#676). `--org <slug> --give-roles` does the role step for one org.
- Run on production after the stores (G1): 2026-11-16 the stores and `test-regal-pz` are on `roles`, 84 orgs on
  `legacy`. **Rollback:** `--set legacy` per org, at once, no deploy.

### P3-2 · The evaluator decides everywhere
- `decideAccess` asks `accessRefusal` for every session. The legacy branch (`permissionRefusal`), `areaRefusal`
  and `shadowAccess` are no longer called.
- `Org.settings.access.model` is no longer read: an org is on `roles`. The field stays written for one release, so a
  rollback still finds it.
- A person with no role is refused at sign-in with a message naming the restore script, instead of falling back
  to the claims. G1 means there are none.
- Client: `grantOfViewer` takes the live grant only; `compileLegacy(claims)` is no longer the fallback.
- **Rollback:** redeploy the previous release. Nothing written changes shape.

### P3-3 · The screens (acceptance 8)
- Remove `PermissionSetsView` and its route. `/settings/permission-sets` redirects to `/settings/roles`, and its
  `PAGE_REGISTRY` / `PAGE_ACCESS` rows go.
- Remove from the Users dialog: the legacy role list, sets, areas and permissions, "own records only", Default,
  Migrate. One Role select stays.
- Invites take `assignRoleId` only. The legacy `assignRole` is no longer accepted (422).
- Remove the four locales' strings for them.
- Remove the client ratchets' allow-lists for these screens (`unit/access-client-grants`, `access-live-areas`).

### P3-4 · Templates as data, the factories on roles (test churn first, behaviour unchanged)
- `config/access/templates.ts`: each built-in template becomes a literal capability list, generated once from
  today's `templateGrant` and pinned by a test. Today they are compiled from `DEFAULT_ROLE_PERMISSIONS` at load.
- Test factories: `createTestUser(org, { role })` gives the built-in role of that key (`roleId`) instead of
  `permissions: DEFAULT_ROLE_PERMISSIONS[role]`. 114 test files use the factory, and most change nothing visible.
  Tests that sign hand-made legacy claims move to `roleId`.

### P3-5 · Stop writing the legacy model (needs G3)
- `role.service`: no projection, no system set ("Role · <name>"), no `legacy` on the role, no `needsRelease`.
- Users and invites: `permissions`, `permissionSetIds` and the legacy `role` are no longer written.
  `roleHistory` records the role's name and id (it already does).
- `tokenize()`: the token carries `rid`/`rv`, plus `operatorCode`, `iid`/`tv` and `amr` as today, but no
  `role` / `permissions` / `areas`. Everything that read them reads the grant instead: about 19 files reading `role`, and about 30 reading
  `permissions` in `src`. FR-27.10 is unchanged: operator codes, the PIN scope, fiscal immutability.
- **Rollback:** before P3-7 the old fields are still there, frozen at their last value. A rollback to the previous
  release serves people their access as of this deploy, and anything granted since is missing until roles are
  re-projected (`scripts/access-dry-run.ts` shows who).

**Done (draft PR, stacked on P3-3 / #803):**
- **Writers.** `role.service` writes the role alone: no `writeProjection` / `ensureProjection` / `projectOntoPeople`, no
  `legacy`, no `needsRelease`, no "Role · <name>" set (a deleted role still takes the set an older release made for it).
  `seedBuiltinRoles` writes no projection. A person's role is `roleId` plus a role history entry `{ roleId, roleName }`
  (`roleHistoryEntry`), from `assignRole` and `giveStartingRole` alike; no creator writes `role`, `permissions`,
  `permissionSetIds` or a history entry of its own any more: `register()` and `provisionNewOrg` (the founder is no longer
  put on the Administrator set), an invitation (no `assignRole`; `inviteDao` writes one only where a caller names it), its
  acceptance, the OAuth sign-up and invitee, `POST /user`, the demo seed (`helpers/seed.ts`: the built-in role of each
  seeded key, instead of 0015's run), `seed-user` (a service account is a role of its own, `--caps`, or `--permissions`
  read as the grant they gave), `import-regal-pz`, `restore-administrator`.
- **Schemas.** `User.role` is neither required nor defaulted, `permissions` / `permissionSetIds` default to `undefined`,
  `roleHistory.role` is optional and `roleHistory.roleId` new, `Invite.assignRole` has no default, `Role.legacy.role` is
  not required and `needsRelease` has no default. Without that a save of a loaded person or invitation writes them back
  after P3-7 has unset them (#820's finding); `legacy-not-written.flow` holds it.
- **The token.** `tokenize()` gives `id`, names, `orgId`, `operatorCode`, `rid`/`rv`; `sessionFor` adds `iid`/`tv`, the
  PIN sign-in `amr`. `attachAccess` attaches the grant and nothing else. Every answer that hands the SPA a session carries
  `access` (`live.ts#accessAnswerFor`: login, switch, join, new org, LGR sign-in, OAuth and desktop redeem, OAuth
  register, PIN), as `/auth/me` does.
- **Server readers moved to the grant:** the auth plugins (no `scopedRepos` from the token; the unused `access` macro
  deleted), `route-permission#holdsPersonal` and `#auditReadScope` (capabilities per audit module), the POS device-report's
  money (`accessRefusal`), the Files bookings (`booksRefusal`, `compareRefusal`), `targetRefusal` (no legacy branch),
  `canAccessReport` (the report's capability; `roles` no longer read), the App Hub, the backup routes (the Administrator,
  `grant.all`), the fiscal bridge (bridging `till.sell`; a takeover the Administrator's), the SUPTO operators table, the
  master setup's admins (`setup-facts`), the test-org copy's admins (`org-clone`), and the scripts that act as "the org's
  first admin" (`administratorFilter`). The org menu, the org picker and the invitations show the role
  (`roleDisplay`: a built-in by its key, translated as before, any other by its name). The legacy oracles
  (`permissionRefusal`, `legacyCanOpenPage`, `compileLegacy`, the `areas` helpers) stay for P3-6, with no caller left on
  a session but `grantOf`'s fallback.
- **Client.** `sessionViewer()` carries the live grant and `amr` only; `grantOfViewer` falls back to nothing (a viewer
  stated as legacy claims, which only tests build, is still compiled until P3-6). The sign-in answers set the grant
  (`applySession`, `useOrgSession#enter`), and the router waits for `/auth/me` once before its first decision on a page
  load or a new tab (`whenAccessSettled`). `jwtRole` is gone; the cash-sale journals ask the grant (they already did).
  The roles screens lose the "Not all of it on older servers" chip and its strings.
- **Changed from the plan.** (1) "About 19 / 30 files": most controllers had moved to `can()` in Phase 0–2; what was left
  is listed above, plus about 25 helper signatures typed as legacy claims (`{ role?, permissions? }`) that already asked
  the grant. (2) The plan did not say what the SPA decides on before `/auth/me`: P3-2 kept the claims as its fallback, so
  P3-5 has the sign-in answers carry the grant and the router wait for it. (3) `POST /permission-sets/migrate` (the
  Migrate button's route) wrote `permissionSetIds`: it answers 410 `legacy_model`. (4) `PUT /user` refuses `permissions`
  and `permissionSetIds` (422 `legacy_role_field`); a legacy `role` key on `POST`/`PUT /user` names the built-in role of
  that key and is not written.
- **After review (#529, the owner's answers 2 to 4, one PR).**
  - **`roleKey` on `POST`/`PUT /user`** (answer 3). A body names the role by `roleId` or by `roleKey`, a built-in role's
    template key (FR-27.3: scripts and API callers name a role by key; a role id differs per org), resolved to that
    org's built-in role of the template (`role.service#namedRoleId`). An unknown key is 422 `unknown_role_key` (with the
    keys); `roleId` with `roleKey` is 422 `role_id_and_key`; either with the legacy `role` is 422 `role_and_legacy`. The
    e2e files and tests that sent `role` (the FR-27 field walks among them) send `roleKey`; the four tests that state the
    conversion itself (`legacy-not-written`, `roles-onboarding`, `seller-roles`, `user-role-key`) keep `role`.
  - **The legacy `role` key still converts in this release, and each use is logged** (warn, `legacy role field on a
    user route`: the route, the org, the key; nothing about the person), so the release shows whether anything besides
    our tests still sends it. ⚠ **The next release refuses it: 422 `legacy_role_field`**, the code invitations already
    answer for `assignRole` (`invite.controller.ts`). Read the logs of the release first; those four tests then assert
    the 422.
  - **A renamed built-in role shows its own name** (answer 4). `roleDisplay` gives the template key only while the role
    still carries its template's name (`templateOf(key).name`); a built-in the org renamed (`updateRole` renames any but
    the Administrator) shows that name in the org menu, the org picker, an invitation and the SUPTO operators export,
    as on the Roles screen.
  - **Wording** (answer 2): the `backup` route rule (`config/access/routes.ts`) says "the Administrator of this org".

### P3-6 · Delete the legacy code
- Delete `AREAS`, `holdsArea`, `mergeAreas`, `DEFAULT_ROLE_AREAS` and `ROLE_PERMISSION_SET_NAMES`.
- Delete `ownRecordsOnly` / `scopedRepos` (13 files) and `FISCAL_ADMIN_ROLES` (7 files, now
  `devices.*` capabilities).
- Delete the legacy route lists in `route-permission.ts`, `permissionRefusal`, `legacyCanOpenPage`, `PageDef.need` /
  `roles` / `area` / `alsoNeed`, and `AREA_OF`.
- Delete shadow mode (`shadow.ts`, writing `AccessShadowDiff`) and the differential test, whose oracle is gone.
  The role-based suites (walks, `roles-*`, `access-*`) stay.
- ⚠ **Keep `config/access/legacy.ts` (`compileLegacy`, `LEGACY_BRIDGE`), frozen.** Migration 0015 imports it, and a
  released migration is never edited (its fingerprint is its file). A test pins that only `migrations/` and
  `legacy.ts`'s own test import it.
- `DEFAULT_ROLE_PERMISSIONS`: kept only if P3-4 left a reader. The goal is none.

**Done (draft PR #837, stacked on P3-5 / #824):**
- **Deleted.**
  - From `config/constants`: `AREAS` / `Area`, `holdsArea`, `mergeAreas`, `DEFAULT_ROLE_AREAS`, `ROLE_PERMISSION_SET_NAMES`
    and `FISCAL_ADMIN_ROLES`. The device pages and routes ask `devices.*`, which the built-in Administrator, Manager and
    Warehouse Manager hold, as the list said.
  - From `route-permission.ts`: the legacy rule lists (`EXACT_*` / `PREFIX_*_RULES`, `readRuleFor`, `writeRuleFor`),
    `AREA_PREFIXES` / `areaRefusal`, `writeRefusal` / `readRefusal` and `permissionRefusal`. It keeps `orgRouteRest`, the
    PIN scope, `holdsPersonal` and `auditReadScope`, which ask the session's grant and nothing else.
  - The evaluator: `grantOf` is the role's grant or nothing (no `compileLegacy` fallback, no memo). `AccessCaller` no
    longer extends the legacy claims. `seesBills` / `seesOrders` ask the partition's capabilities alone.
  - `page-registry`: `PageDef.need` / `roles` / `alsoNeed` / `area`, `legacyCanOpenPage`, `viewerHoldsArea` and the
    claims fallback of `grantOfViewer`. The two area-wide gates left are `holdsPortal` (`PORTAL_CAPS`: the capabilities
    FR-26's `portal` area was made of) and `exportsCatalog` (`products.export`).
  - `config/access/projection.ts` (`projectGrant`) and `roles.ts#grantOfClaims`: P3-5 stopped writing projections.
  - "Own records only": `scoped-repos.ts`, `scoped-repository.ts`, `record-scope.config.ts` (no caller since P3-5).
  - Shadow mode: `services/biz/access/shadow.ts`, the `AccessShadowDiff` model (its collection keeps its 30-day TTL
    and empties itself), `access-differential.flow` and `access-shadow.flow`.
  - Permission sets: the model, `permission-set.controller` (`/permission-sets/*` now 404; the SPA path still
    redirects to Roles & access), `permission-set.service` / `.seed` / `.migration`, the DAL entity and repository, the
    seeding of a new org's sets (`provisionNewOrg`), the org-clone's set matching, and the two set backfills
    (`scripts/backfill-member-payroll-read.ts`, `scripts/backfill-reports-permissions.ts`). `endSessionsOf` moved to
    `identity/session.service.ts`. A role's "Role · <name>" set from before P3-5 is no longer deleted with it.
  - The client: `STORNO_ROLES` and the role-key actor of `canStorno*` (a grant only); `compileLegacy` in
    `useAccess`, `storno.ts` and `report-registry.types`.
  - The dead read rule `warehouse/bulk-pricing` (no GET route), which the capability coverage test found.
  - The App Hub's legacy tiles (`app-hub.service`: `role === 'admin'`, the token's permissions against `APP_REGISTRY`):
    `getAvailableApps(orgId, grant)` gives the apps the role opens, nothing without a grant.
  - The legacy-key fallbacks for a person without a role: `administratorFilter`, `setup-facts` (a master's admins),
    the test-org copy's admins (`membershipAccess`) and `scripts/register-docs-in-pv.ts`. Such a person is no
    Administrator; since P3-2 they cannot sign in either.
- **Kept, and why.**
  - ⚠ **`config/access/legacy.ts`, frozen.** 0015 imports `compileLegacy`, `legacyClaimsOf`, `LEGACY_BRIDGE` through
    `config/access`. To delete FR-26's tables from `constants` without changing what 0015 does, the areas (`AREAS`,
    `LEGACY_ROLE_AREAS`, `mergeAreas`, `AREA_OF`) moved into legacy.ts as module-private copies, byte for byte the
    same rules; `compileLegacy` of every template's `legacy` claims still equals the template (pinned).
    `unit/access-legacy-frozen.test.ts` pins its SHA-256 and that nothing outside `packages/migrations/` names it but
    the barrel, `templates.ts` / `roles.ts` (what 0015 reads through), its own test, 0015's own test
    (`roles-migration.flow`) and the client ratchet that forbids it (`access-client-grants`).
  - `DEFAULT_ROLE_PERMISSIONS`: P3-4/P3-5 left readers, all frozen: legacy.ts, the templates' `legacy` claims (0015) and
    test fixtures. Nothing decides by it.
  - **The schema fields** `User.role` / `permissions` / `permissionSetIds` and `Invite.assignRole`, and `Role.legacy` /
    `needsRelease`: no default since P3-5, read by nothing that decides (display only: `roleDisplaysOf` falls back to
    a membership's legacy key). Removing a path changes nothing at runtime, so they go with 0018, which drops the
    archive, rather than split the one-way step between two PRs. 0017 (#820) reads and archives them through the
    driver, as it reads `permissionsets`: it needs neither the paths nor the model. The `ref: 'PermissionSet'` went.
  - `scripts/access-model.ts`: `--org` lists who has no role, `--give-roles` is 0015's own `up` for the people from
    before roles, `--all` lists the orgs with someone without one. `--set`, `--report`, `--days`, `--min-days` and
    `--execute` are refused, saying why; `scripts/lib/access-advance.ts` went. `Org.settings.access.model` is read by
    nothing.
  - `scripts/seed-user.ts --permissions` is refused, naming `--caps` (`accounting.import` was `--caps books-import.run`);
    the skills and the books guide say so.
- **Tests.** `route-permission.flow` and `read-permission.flow` hold every route to the capability rules
  (`config/access/routes.ts`): coverage both ways, a read-only built-in role refused every write it holds none of, every
  built-in role reaching what its apps read (`appsOpenedBy`), and the parts FR-26 carved out refused to the Seller and the
  Sales Consultant and nobody else. The suites that stated a person as legacy claims state a grant (`templateGrant(key)`,
  capabilities, or `tests/helpers/permission-caps.ts`, the old permissions' capabilities frozen as a fixture). The
  factory's `createTestPerson` writes its set through the driver, which 0015 reads.

### P3-7 · The data contract (one-way)
- Merges only after P3-5 is **released**: until then the app still writes the fields this moves.
- Migration **0017** (`0017-legacy-access-archive`; 0016 went to FR-30's text indexes): the legacy fields move to an
  archive and are unset:
  - `User.permissions`, `permissionSetIds` and the legacy `role` go to `User.legacyArchive` (with `archivedAt`);
  - `Invite.assignRole` goes to `Invite.legacyArchive` (with `archivedAt`);
  - the `permissionsets` collection is copied to `permissionsets_archive` (each set with `archivedAt`). The sets
    themselves stay: dropping the source is the follow-up's, not this migration's.
  It is idempotent and scoped by `orgFilter`, like every migration, and has a dry run (`bun run migrate --dry-run`).
  The archive holds exactly what was there (a missing field stays missing), and no answer carries it
  (`USER_PUBLIC_PROJECTION`, the invite list).
- ⚠ The schemas must stop defaulting the legacy fields first (P3-5/P3-6): Mongoose writes a default back on any
  `save()` of a loaded document, so with `role: { default: 'member' }` an archived person would get `role: 'member'`,
  `permissions: []` and `permissionSetIds: []` again on their next save, and an invite `assignRole: 'member'`.
- The archive is kept for **one release**, then **0018** drops it (§5): `legacyArchive` on users and invites,
  `permissionsets_archive`, and the `permissionsets` collection itself.

### P3-8 · The grep test (acceptance 2)
- `unit/access-no-legacy.test.ts` fails on any file outside `config/access/`, `services/biz/access/` and
  `migrations/` that:
  - names a legacy role key (`'admin'`, `'manager'`, …) as a check;
  - reads `permissions`, `areas` or `role` from a token or session;
  - imports `compileLegacy`.

**Done (draft PR #838, on master after P3-6 / #837):** `unit/access-no-legacy.test.ts` scans every `.ts` / `.vue` of `packages/*` and
`scripts/`, comments left out, outside the homes: `config/access/`, `services/biz/access/`, `packages/migrations/`, and the
tests (`packages/tests/`, `packages/e2e/`), which state fixtures. Four rules, one test each:
- **role-key check**: a built-in key (`ROLES`) compared with a `role` (`role === 'admin'`, `'x' !== session.role`), a key
  list asked of one (`['admin', 'manager'].includes(user.role)`), or a query for the people of a key
  (`User.find({ role: 'admin' })`). A books split's own `role` (`org.split.role`) is not one;
- **legacy claim read**: `permissions`, `areas` or `role` read off `user`, `session`, `claims`, `payload`, `token`,
  `viewer`, `who`, `caller`, `actor`, `me`, and any `permissions.includes(…)`;
- **legacy compiler**: `compileLegacy`, `legacyClaimsOf`, `LEGACY_BRIDGE` (P3-6's frozen-file test pins the importers,
  and lists this test among them: it names the compiler to forbid it);
- **stored legacy role**: a person's stored `role` (`u.role`, `person.role`, …), allowed only for display, listed with why:
  - `identity/session.service.ts#roleDisplaysOf`: a membership's label in the org picker and switcher;
  - `supto-export.service.ts`: the Н-18 operators table's role column (an audit page's names);
  - `auth/session-answer.ts#orgList` and `reporting/excel/supto.excel.ts`: they pass on the display the two above made;
  - `scripts/configure-daily-digest.ts`: the digest's recipients printed with their key (chosen by address);
  - `scripts/restore-administrator.ts`: the audit entry's old value, the role history's label;
  - `scripts/migrate-identities.ts`: the identity migration's report.

  Each goes when migration 0017 archives the field. The test fails on an allow-list entry nothing matches any more, and
  on rules that stop catching their own examples.
- Found on the way, and gone in P3-6 rather than listed: `app-hub.service`'s legacy tiles (`role === 'admin'`, the
  token's permissions), and the legacy-key fallbacks of `administratorFilter`, `setup-facts` (a master's admins), the
  test-org copy's admins and `scripts/register-docs-in-pv.ts`: a person without a role is no Administrator.
- Found after rebasing on master: `scripts/lib/daily-import.ts#gateGrantSession` judged a server that answers no
  `access` by the session's `role` claim (`claim === 'admin'`). It now stops such a session: no claim decides.

## 3. Rollback window

| After | Rollback |
|---|---|
| P3-1 | `--set legacy` per org (minutes, no deploy) |
| P3-2 to P3-4 | redeploy the previous release |
| P3-5 | redeploy, and access granted since this deploy is missing until re-projected |
| P3-7 | none in code. Restore from the archive by hand within the one-release window (G4 is the last resort) |

## 4. Risks

- **A master below the minimum version.** G3, and the uplink refuses it.
- **Test churn.** P3-4 goes before any behaviour change, so a red test means a factory, not access.
- **A role-name check that is behaviour, not access.** `roleHistory`'s labels, the digest's recipients and the audit
  page's names are read for display only. P3-8's allow-list names each, with why.
- **Released migrations import legacy code.** `legacy.ts` stays frozen (P3-6).

## 5. Estimate

| PR | Size |
|---|---|
| P3-1 | small |
| P3-2 | medium |
| P3-3 | medium (screens and locales) |
| P3-4 | large (tests) |
| P3-5 | large |
| P3-6 | large (deletion, mostly mechanical) |
| P3-7 | small |
| P3-8 | small |

Each is reviewable alone, and P3-1 to P3-4 change nobody's access.
