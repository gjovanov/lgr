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
- `scripts/access-model.ts --all --set roles`: org by org, only where the 7-day report is 0 and every person has a
  role; prints what it skipped and why. Audited (#676).
- Run on production after the stores (G1). **Rollback:** `--set legacy` per org, at once, no deploy.

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
- Migration 0016: the legacy fields move to an archive and are unset:
  - `User.permissions`, `permissionSetIds` and the legacy `role` go to `User.legacyArchive`;
  - `Invite.assignRole` goes to `Invite.legacyArchive`;
  - the `PermissionSet` collection is copied to `permissionsets_archive`.
  It is idempotent and scoped by `orgFilter`, like every migration.
- The archive is kept for **one release**, then 0017 drops it (§5).

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
