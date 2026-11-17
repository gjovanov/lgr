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
