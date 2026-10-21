# Nodes — the server model after FR-20's P0

**Status:** what exists on `master` after FR-20's P0 (October 2026). Production runs one node,
`global`, and every org's home is global, so nothing below changes how lgrai.app behaves today.

The target (on-prem masters, the mirror, the tunnel, moving an org) is in
[FR-20's plan, Part A](https://github.com/gjovanov/lgr/blob/feat/fr-20-offline/docs/fr/FR-20-IMPLEMENTATION-PLAN.md#part-a--architecture),
and is not built.

Specification: [FR-20](https://github.com/gjovanov/lgr/blob/feat/fr-20-offline/docs/fr/FR-20-offline-lan-master.md)
· Tracking: [gjovanov/lgr#159](https://github.com/gjovanov/lgr/issues/159)

## The node role

`LGR_NODE_ROLE` is `global` (the default) or `master`; anything else refuses to start
(`config/src/index.ts`). Code asks `nodeRole()` from `config`, never a host name or another
variable.

## Org homes

Every org has one **home**: the node that holds the authoritative copy of its data and is the only
one that writes it.

- **The record.** It is a row in `org_homes` (`OrgHome`): `{ orgId, home: 'global' | <nodeId>,
  epoch, state, since, changedBy }`. **No row means `global`, epoch 0**, which is every org today.
  `OrgHome` is node state, not tenant data: it has no `tenantPlugin`.
- **States.** `state` is `active`, `freezing`, `frozen`, `fenced` or `hold`. Only `active` writes.
- **It fails closed.** A row that disagrees with `Org.homeEpochHighWater`, or a missing row once
  that is set, reads as `hold`.
- **`db/home/home.ts`** reads it:
  - `homeOf(orgId)` answers from a 5-second cache, which `forgetHome` clears and `{ fresh: true }`
    skips;
  - `isHomeHere(orgId)`;
  - `assertHomeIsHere(orgId)` throws `HomeElsewhereError`.

## Where a write is refused

Three layers, from the outside in.

1. **The route gate.** The auth plugins run `services/biz/home-gate.ts#homeGate` right after
   `isForeignOrg`, on every route, with no exception list.
   - Off an org's home, a route that writes answers **409** `{ code: 'org_home_elsewhere' }`.
   - What writes is decided by `services/biz/route-class.ts`. A GET reads; anything else writes,
     except the POSTs in `READ_ONLY_WRITES` (reports, list exports). A route listed there must
     write nothing.
2. **The request context.** Every API request runs in a context (`db/home/request-context.ts`)
   that names its route and org. A write inside a read-only route is recorded.
   - Off the org's home, that write is refused, unless the route is in `GET_WRITERS`. Each route
     there checks the home itself.
   - At home, an unlisted one is logged, and `reads-that-write.flow.test.ts` walks every GET route
     and fails on it.
3. **The write guard.** `tenantPlugin` installs it on every org-scoped model
   (`db/home/write-guard.ts`).
   - **What it refuses**, with `HomeElsewhereError`, when the org's home is elsewhere:
     - `save` and `insertMany`;
     - every update, delete and `findOneAnd*`;
     - `bulkWrite`;
     - an update that moves documents into an org.

     That covers services, sweeps and scripts, not only routes.
   - **Legal numbers.** `Sequence` writes, which allocate every legal number, read the home fresh,
     never from the cache.
   - ⚠ **Raw driver writes (`Model.collection.*`) bypass the guard.** Each one is listed in
     `home-write-guard.flow.test.ts#RAW_WRITE_SITES`, and is either guarded by `assertHomeIsHere`
     or exempt with a reason. A new one fails that test.

## Writes that cross orgs

`homeScope()` (`db/home/home.ts`) returns the filter that keeps a multi-org write to the orgs homed
on this node:
- `{}` on global today;
- `{ orgId: { $nin: away } }` once an org lives elsewhere;
- `{ orgId: { $in: mine } }` on a master.

`homeScope('_id')` scopes a loop over `Org` itself.

**Where it's used:**
- the identity fan-outs: a password change reaches every membership of the person;
- the boot-time fiscal device reset;
- retention;
- the migrations runner;
- the schedulers: the daily digest, backups, the desktop reaper and the orphaned-task sweep.

An unscoped multi-org write is refused whole by the write guard as soon as one org lives
elsewhere.

**Joining an org refuses one homed elsewhere** rather than filtering it. That covers an invite,
registration, OAuth sign-up and desktop enrollment.

## Scripts

A script that opens the database checks the home **before** it writes, through
`scripts/lib/home-guard.ts`:
- **`assertScriptHome(orgId)`**, for a `--org` script. Off the org's home it exits with code 2,
  having written nothing.
- **`keepHomeOrgs`**, for a script that walks every org. It skips the orgs homed elsewhere, and
  stops if a NAMED org is one of them.
- **`tenantHomeScope()`**, for a collection sweep.

`unit/scripts-home-guard.test.ts` fails a script in `scripts/` that opens the database without
one.

## Data migrations

A data change a release needs is a versioned migration in `packages/migrations`, never a script
run by hand.
- **The registry.** `src/registry.ts` lists them in order. Today there are three:
  `0000-baseline`, `0001-unp-per-device` and `0002-file-sha256`.
- **The runner** runs the pending ones under a lock, records each in `_migrations`, and takes only
  the orgs homed on this node.
- **Running them:**
  - `bun run migrate` runs them by hand, and `--status` lists them;
  - with `MIGRATIONS_AUTO=true`, the server runs them before it listens. That is off by default,
    so global runs them by hand after a deploy.
- **Never edit a released migration.** The runner refuses to start when an applied one has
  changed. A fix is a new migration.
- **Every migration is idempotent.** `migrations.flow.test.ts` re-runs each on a seeded database
  and expects no change.

## Node state stays out of backups

`db/home/node-state.ts#NODE_STATE_MODELS` names the models that describe this node rather than an
org's data: `OrgHome`, and `BackgroundTask`, whose owner is a process.
- They are left out of every backup bundle.
- A restore skips such a section, even from an older bundle that carries one.

A bundle restored on another node therefore never says who is home.

## Stored file paths

`File.storagePath` and `DocFile.currentPath` are moving to paths relative to `UPLOAD_DIR`
(`<orgId>/…`), so that a node with a different upload root can read them
(`services/biz/files/stored-path.ts`).

- **Every reader goes through `resolveStored(stored, orgId)`.** It takes either form, and maps a
  legacy absolute path from a known root onto this node's root. The known roots are this
  server's, `/app/uploads`, and `UPLOAD_LEGACY_ROOTS`. It refuses `..`, drive letters and another
  org's tree.
- **Writers still store absolute paths.** They switch one release later, together with the
  migration that rewrites the rows: expand, then contract.
- **`File.sha256`** is recorded at upload. Migration `0002-file-sha256` backfills it from the bytes
  on disk.

## Not built yet

FR-20's P1 to P3:
- the master's supervisor and installer;
- the desktop's LAN proxy;
- the uplink to global;
- the mirror and the tunnel;
- moving an org between homes.

[desktop.md](desktop.md) describes the desktop as it is today: a client of the cloud.
