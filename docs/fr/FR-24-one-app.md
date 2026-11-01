# FR-24 — One app: one web UI, one API package, ready for several pods

| | |
|---|---|
| **Status** | Specified 2026-10-31. The plan runs on the defaults in §12 until the owner says otherwise. |
| **Tracking** | [gjovanov/lgr#402](https://github.com/gjovanov/lgr/issues/402) |
| **Builds on** | FR-19 (a session per tab), FR-20 (pod address, signed hop, presence rows, task owners, graceful stop), FR-14 (the desktop's native bridge), and the POS move the owner decided on 2026-10-31 |
| **Code anchors** | origin/master `1971a7bc` (2026-10-31). Anchors, not gospel. |

## 0. The short version

1. **The API is already one process.** `portal-api/src/unified.ts` mounts every controller, and the six domain `*-api` packages have no `listen` of their own. They are folders of controllers plus six copies of one auth plugin.
2. **What is split is the web UI: eight SPAs, each its own document.** Crossing from one to another is a full page load, and a page load closes the Web Serial port. That is the printer that disconnects. `useFiscalBridge` was written to survive navigation (module-level state, nothing on unmount), and it does, inside one SPA.
3. **Merging the eight is cheap.** A throwaway spike composed all eight route tables into one Vite build on the first try: 22 s against 134 s, 9 MB against 52 MB, and 12 KB more gzipped JS on first load (§1.2).
4. **The merge does not make LGR scale by itself.** The API was one process before it and will be one process after it, so the merge removes nothing that stops a second pod. What stops one is in-process state, above all the fiscal bridge. ⚠ **`replicas: 2` today breaks every till** (§6.1). FR-20 already built most of what is needed, so §6 is smaller than it looks.

The two halves are independent. Phases 0–4 give one app. Phases 5–7 give several pods, and neither waits for the other.

## 1. Evaluation

### 1.1 What is split today

| | Today | Note |
|---|---|---|
| API processes | **1** | `unified.ts`, port 4001. `moduleUiConfig` serves the SPAs from the same process |
| Domain API packages | 6 + `portal-api` | No server of their own. `dev:legacy` is gone |
| Auth plugins | 7 `app-auth.service.ts` + `AuthService` | The seven are **byte-identical**, 126 lines each. `isForeignOrg` is registered in all of them, so the tenant guard exists in eight places |
| SPAs | **8** | portal, accounting, inventory, invoicing, pos, payroll, reports, files. `desktop-ui` is the shell's own pages and stays out of this FR |
| `useAppStore` | 8 copies, all with Pinia id `app` | accounting, inventory, payroll, pos and reports are identical; files is smaller, invoicing adds 26 lines, portal adds 213 |
| `DefaultLayout.vue` | 8 copies, 70–156 lines | Each holds its menu, and each repeats the switcher and sign-out logic |
| Pods | 1 | `replicas: 1`, pinned to one worker by the uploads volume |
| Separate workload | `lgr-ocr` | Its own Deployment already. Unaffected |

### 1.2 Measured

Baseline: the eight `bun run build`s, one after another, on a dev laptop. Spike: all eight route tables mounted under their prefixes in one Vite build (thrown away; nothing from it is in the tree).

| | Eight SPAs | One SPA (spike) |
|---|---|---|
| Build | 134 s | **22 s** |
| `dist`, total | 52.1 MB | **9.1 MB** |
| JS, total | 16.4 MB | **4.4 MB** |
| First load, JS | 1,087 KB, 335 KB gzipped (invoicing) | 1,153 KB, **347 KB** gzipped |
| First load, CSS | 589 KB, 86 KB gzipped | 589 KB, 86 KB gzipped |
| Moving between modules | Full page load: everything above again, from cache at best, plus the session bootstrap | A route change |

The spike still carried all eight stores and layouts, so the real build comes out a little smaller.

**What the spike proved:** it builds, with no change to any view; `useFiscalBridge` ends up in exactly one chunk, so one bridge serves every module (`ui-shared/plugins` warns that Vite can duplicate workspace modules; here it did not, and FR-24.15 keeps it that way); the eight stores with id `app` are all in the bundle and would collide (FR-24.1).

**What it did not prove:** that the merged app runs. It was built, never opened.

Found by inspection, each one a risk that turned out not to exist: no `@/` import anywhere in any UI, so the per-package alias is no obstacle; route names are already namespaced (`invoicing.*`, `pos.*`, …), so none collide, and `useGridColumns` keeps every saved column layout; every domain route is a relative child, so it mounts under a prefix unchanged; all UI `<style>` blocks are scoped, apart from two in `ui-shared` that every SPA already loads; there is no `@media print`, no `<keep-alive>` and no per-app i18n catalog.

### 1.3 What the split costs

- **The printer.** Moving between apps closes the tab's Web Serial port and its socket. The cashier has to reconnect through the browser's port picker. Tills on LGR Desktop are not affected: their port is held in Rust.
- **Every move between apps is a page load**, on the paths staff walk all day.
- **Copies that drift.** Eight stores, eight layouts, seven auth plugins. A security fix to the guard has to land eight times.
- **A security surface that exists only for it.** `?token=` handoff (`ui-shared/nav/navigate.ts`) carries a session between per-app Vite ports. It was a login-fixation hole until FR-14.24 limited it to localhost.
- **Nine dev processes,** and a long touch-point list for each new app (CLAUDE.md, under FR-06).

### 1.4 What the split buys

Each candidate benefit, checked:

| Benefit | Reality |
|---|---|
| Deploy one app alone | Never used. One image, one tag, one rollout |
| Scale one app alone | Impossible: one process |
| Smaller bundles per app | First load differs by 12 KB gzipped |
| A failure stays in one app | One failing build already fails the whole image |
| Team boundaries | One team, and all eight sit on `ui-shared` |

The owner's reading stands: the benefit is zero.

## 2. Target

```
one browser tab = one document = one Vue app, one router, one Pinia, one bridge
   /               → App Hub, dashboard, settings, admin, auth   (as today)
   /invoicing/*    → the same routes, the same names             (as today)
   /inventory/* /accounting/* /payroll/* /reports/* /files/*     (as today)
   /pos/*          → 302 to their new home (POS move)

packages/web       the one Vite build, served at /
packages/api       the one API (portal-api today)
N pods             one image, same process, Mongo for what they share
```

**URLs, route names, API paths, permissions, `OrgApp` activation and the App Hub do not change.** This FR moves code. Apart from the page load going away, a user sees nothing new, and no e2e URL needs editing.

## 3. Plan

| # | Phase | Size | What it ships | Rollback |
|---|---|---|---|---|
| 0 | **POS move**, already decided and designed (10-31) | M | POS ↔ Invoicing keeps the printer. 8 SPAs become 7 | Previous image |
| 1 | **Same pieces everywhere**: one store, one layout, module manifests, one navigation seam | M | Nothing visible. Small PRs on master | Revert the PR |
| 2 | **One SPA beside the others**, behind a cookie | M | The owner and testers run it on production | Clear the cookie |
| 3 | **Flip, then delete** the seven builds | S | Every move keeps the printer | Env flag for a week; afterwards the previous image |
| 4 | **One auth plugin**, then rename-only package moves | S | Eight guards become one | Revert the commit |
| 5 | **Ready for pods, on one pod**: bridge reconnects, readiness, drain, presence rows | M | A deploy stops stranding browser tills | Revert; the rows are harmless |
| 6 | **Two pods** on one node, the request goes to the printer | L | Deploys with no downtime, a second core | `replicas: 1` |
| 7 | **A second node** (optional, Q-3) | M | Survives losing the non-Mongo node | Back to one node |

S ≤ 1 day, M 2–3 days, L about a week. Phases 0–4 run in order. Phase 5 can run beside them and is worth doing first if deploys hurt. Phase 6 needs 5. Phase 7 needs 6.

**Phase 0 stays as designed.** `git mv` pos-ui into invoicing-ui is a strict prefix of this FR. Nothing here changes it, and it should not wait: it is ready and it fixes the most common hop.

## 4. One web UI

### Phase 1 — same pieces everywhere

- **FR-24.1** `useAppStore` MUST exist once, in `ui-shared`, as the superset of the eight. Each package's `store/app.store.ts` becomes a re-export, so no view's import changes. With one Pinia the id `app` would otherwise resolve to whichever module loaded first, and the views of the others would get a store without their actions.
- **FR-24.2** One layout in `ui-shell` MUST replace the `DefaultLayout.vue` copies. A module's menu becomes data.
- **FR-24.3** Each UI package MUST export a manifest, `{ id, base, routes, menu }`. Until Phase 3 its own router is built from that manifest.
- **FR-24.4** App-relative paths MUST stop depending on the router's base. There are about 110 literal sites: 41 menu entries, 35 breadcrumbs, 27 `back-to`/`backTo` values and 5 direct `router.push('/…')` or `:to`. The first three kinds are data and get fixed in one place: menus and breadcrumbs take the module's base from the manifest, and `EntityFormShell` takes it from the route. The five direct ones become named routes, which work under either router, so this ships before the flip. A test MUST resolve every such path against the merged route table.
- **FR-24.5** One seam MUST decide how a person moves: `ui-shared/nav/navigate.ts`. A unit test MUST fail on any UI source that assigns `window.location` for an in-app path, the way `unit/session-keys.test.ts` guards the session keys. Links rendered as `<a :href="appHref(…)">` (favourites, `+ Нов`, entity links) MUST become router links, or they keep reloading the page. They keep a real `href`, so open-in-new-tab still works.
  - ⚠ **One page load is all it takes.** Anything left behind here drops the printer, and in a way no test notices.
  - The list that stays a page load: sign-out, org switch (already guarded, `session/switch-guards.ts`), a token changed underneath the tab (`useHttpClient`), and the IdP/OAuth redirects, which leave the origin.
  - A 401's move to the sign-in page (`useHttpClient`, the router guards) SHOULD become a router push, so a till whose session lapsed keeps its printer through the new sign-in.
- **FR-24.6** `openPage` MUST stop loading the page when the target renders the same view as the current route (`nav/open-page.ts`). Inside one SPA that case is common (one invoice to a new one). The shell's `<router-view>` gets a key that forces the remount instead.
- **FR-24.7** Pending-changes entries MUST stay restorable. They live in `localStorage` with `routePath` relative to the old app, and `DefaultLayout` rebuilds the URL from `appId`. After the flip `route.fullPath` is the full path, so a reader MUST accept both forms.

### Phase 2 — one SPA beside the others

- **FR-24.10** `packages/web` MUST hold the one `index.html`, `main.ts`, `App.vue` and the router composition, with Vite `base: '/'` and its own asset directory (`/ui/`), because the portal's `/assets/` is still being served.
- **FR-24.11** The route tree MUST have one shell record with every module under it, so moving between modules does not remount the layout.
- **FR-24.12** One `beforeEach` MUST merge the portal's rules (`meta.public`, `guest`, `person`) with the domain routers' org-session check. The till's PIN page stays outside the shell, and its guard applies to till routes only (FR-20.40).
- **FR-24.13** The serving MUST be selectable. `spaErrorHandler` picks the shell from a cookie (`lgr_ui=one`, set by `/__ui/one`, cleared by `/__ui/split`), and `LGR_UI_DEFAULT=one|split` sets the default. Both builds are in the image until Phase 3. A server package stays on the split build until the delete.
- **FR-24.14** Stale code MUST be handled, because the accidental refresh that crossing apps gave is gone and a till tab can live for days:
  - The build id goes in `index.html` and in a response header. On a mismatch the shell offers a reload, and reloads by itself on the next navigation when no form is dirty and this tab holds no bridge.
  - A failed lazy chunk (`vite:preloadError`) reloads to the target URL, at most once per build id. A tab holding a bridge asks first.
  - A failed entry script reloads itself, a bounded number of times (a small inline script). During a rollout `index.html` and its entry can come from pods on different versions, and without this the page stays blank.
- **FR-24.15** CI MUST fail when the first-load JS grows past 360 KB gzipped, when any module's views land in the entry chunk, or when `useFiscalBridge`'s code appears in more than one chunk.
- **FR-24.16** The e2e suite MUST pass on both shells, with no spec changed for the new one. It is the regression suite this FR gets for free, because URLs and route names stay. CI runs no e2e yet: the nightly run (#365, PR #400) is a prerequisite of the flip.
- **FR-24.17** The shell MUST show that this tab holds a printer, and `useFiscalBridgeAlerts` moves up to it. Today the alerts mount in the POS views only, so after the merge a printer lost while the cashier is in Inventory would go unnoticed. ⚠ The shell only READS status. It never opens a port: Web Serial gives a port to one tab, and that rule from the POS design stands.
- **FR-24.18** Analytics MUST NOT spread. The tag sits in the portal's shell today, so domain pages are not reported (`portalShellFor`, global only). A single shell would report every module URL, ids included. Module routes stay unreported (Q-2). A master keeps its node tag and no analytics, unchanged.
- **FR-24.19** The tab title moves from each `index.html` (`LGR Invoicing`, …) to the module's manifest.

### Phase 3 — flip, then delete

- **FR-24.20** The default flips by env. After a week in the field, or sooner on the owner's word, the delete follows.
- **FR-24.21** MUST be deleted: seven `index.html` / `vite.config.ts` / `main.ts` / `App.vue` and router shells; the Dockerfile's per-SPA `RUN` and `COPY` lines; `UI_MODULES`, `moduleUiConfig` and `uiDir`; the `dev:*-ui` / `build:*-ui` scripts; `devPort`; the `?token=` handoff (`handoffQuery`, `classifyTokenHandoff`, `consumeTokenHandoff`, `isDevTokenHandoffOrigin`) and the `localhost:4001` `portalBase` lines; `MovedToReportsView`, replaced by router redirects that keep the query; `routerAppId`. After this nothing reads a session token from a query string.
- **FR-24.22** MUST stay: the `/pos/*` 302s, because desktops hold `startPath: /pos/` (302, never 301: a rollback must still work); `LEGACY_PAGE_IDS`; every route name.
- **FR-24.23** `bun run dev` MUST start the API and one Vite dev server that proxies `/api` and `/ws`.
- **FR-24.24** A server package's `ui/` MUST hold the one SPA (`scripts/build-server.ts`, `check-package`). A master's update is atomic per version, so nothing migrates, and a rollback brings its own UI.
- **FR-24.25** `docs/architecture/overview.md`, `CLAUDE.md` and "touch points for the next app" MUST be rewritten. Adding a module becomes one manifest and one registry row.

## 5. One API

The API needs no merging at runtime. This phase removes the copies.

- **FR-24.30** The seven `app-auth.service.ts` MUST become one import. They are byte-identical, so this is a dedupe, proved by `tenant-isolation.flow.test.ts` and the permission suites passing unmodified.
- **FR-24.31** Rename-only, one commit each, no content change: `packages/*-ui` into `packages/web/src/modules/<id>`, and `packages/*-api` plus `portal-api` into `packages/api` (Q-1). At a quiet moment with no open PR on those paths, so `git log --follow` keeps working. ⚠ `portal-api` is named 158 times in 112 files, and in `workingDir` in lgr-deploy's Deployment, so the image and the manifest must change together.

## 6. Several pods

### 6.1 What stops a second pod

| State | Where | With two pods |
|---|---|---|
| **Bridge sockets and printer drivers** | `websocket/fiscal-bridge.ts:108,157`, `fiscal/fiscal-device.service.ts:20` | **Blocker.** See below. Server-opened TCP devices sit in the same in-process registry, so they have the same problem |
| **Device status reset at boot** | `unified.ts:298`, `biz/fiscal-status-reset.ts:12` | **Blocker.** A starting pod marks every `online` device `offline`, including the ones its sibling holds |
| **Browser bridge has no reconnect** | `useFiscalBridge.ts:298` | **Blocker for rolling deploys**, and it already hurts with one pod: every deploy strands browser tills at the port picker |
| **Probes and drain** | `deployment-lgr.yaml` | **Needed for a clean roll.** TCP probes know nothing of Mongo; there is no `preStop`, so a pod can still be sent traffic after it stops listening; 30 s grace against a 25 s stop wait, and a Z-report can run for minutes |
| **Uploads volume** | hostPath PV with node affinity | Blocks a second **node**. Two pods on one node are fine |
| **Front proxy** | names one worker's NodePort | Blocks a second **node** only |
| `/ws/tasks` | `websocket/ws.server.ts:35` | **Not a blocker.** No UI calls `useWebSocket`, and `sendNotification` has no callers. Every task screen polls, and `GET …/task/:id` falls back to the `BackgroundTask` row, which every progress update writes |
| Login throttle | `login_throttles` | Already holds across pods |
| Migrations | lock in `_migrations` | Already held across pods; `MIGRATIONS_AUTO` is off on global anyway |
| Background tasks | `background/task-owner.ts` | Designed for it: owner plus heartbeat |
| Digest, backup, archive | unique claims | Designed for it |
| Moves, fenced import | conditional updates, leases | Designed for it |
| Uplink and tunnels | `node_presence`, `tunnel/forward.ts`, `tunnel/hop.ts` | Built for it and exercised by `tests/two-node/move-e2e.script.ts`. Never yet run on production with two pods |
| Desktop sockets | `websocket/desktop.ts:64` | Designed for it: other pods' sockets learn on the next heartbeat |
| Session revocation | `identity/session.service.ts:158` | Accepted: another pod sees a password change within a minute |
| Home, release and logo caches | various | Harmless: short TTL, or keyed by content |
| Tunnel edge limits | `tunnel/edge.ts:36` | Documented as per pod |
| Schedulers | `unified.ts:319` | Audited one by one: each is claimed, idempotent or local (`fiscal-time-sync` touches only devices this pod holds). No change needed |

**Why `replicas: 2` breaks tills.** A bridge lives on one pod and a sale lands on either. `getFiscalContext` (`cash-register-till.ts:48`) reads "not connected in this process" as "offline", logs "proceeding without fiscal receipt" and returns `null`. So half the sales are refused by the printer gate (#390), or, where the gate is off, go through with no receipt. ⚠ Until Phase 6 ships, a comment on `replicas` in `deployment-lgr.yaml` MUST say so (FR-24.47).

### 6.2 The design: the request goes to the printer

The pod holding the bridge runs the whole request. Any other pod forwards it there, with the hop FR-20.73 already built.

```
till ──wss──► pod A   holds the socket and the driver, keeps a row in fiscal_presence
cashier ──POST sale──► pod B   reads the row, forwards the request to A as a hop
                       pod A   authenticates it, runs it, prints, answers through B
```

**Why this and not a remote printer.** `IFiscalPrinter` looks like the obvious seam, and it is the wrong one:

- `fiscalOperation()` keeps a pod from stopping between two commands of a receipt (`in-flight.ts`). A remote caller's receipt would be many separate requests, so the holder could drain between lines and leave the device with a receipt open. That is the exact failure the counter exists to stop.
- The Eltrade driver's queue and its "a receipt this driver is printing" state must be one instance per device, and all of a device's work has to reach it in order.
- It would add 25 methods with `Date` arguments, optional-method semantics and typed errors as a new internal API that can print.

A forwarded request adds none of that. Everything the fiscal code assumes about being in one process stays true, the holder's graceful stop counts the request as in flight, and the holder authenticates with the user's own token, so no new trust relationship exists. On one pod, and on a master, the row always names the pod itself and nothing is forwarded, so no flag is needed.

### Phase 5 — ready for pods, on one pod

- **FR-24.40** The browser bridge MUST reconnect by itself when its socket drops and the port is still open: backoff from 1 s to 30 s, no picker. `bridge_in_use` is retried, as the desktop does; an eviction is not.
- **FR-24.41** After a full page load the bridge SHOULD come back with no picker: `navigator.serial.getPorts()` needs no gesture for a port already granted. It reopens only when exactly one granted port matches the remembered `usbVendorId`/`usbProductId` (a native COM port reports neither, so there it must be the only granted port), and a `port_in_use` stays a message, never status `error`. The spec does not state outright that `open()` needs no gesture; the bridge's USB-reconnect path already relies on it. Confirm it on the first till.
- **FR-24.42** `GET /api/ready` MUST answer 503 while stopping or when Mongo does not answer, and the readiness probe uses it. Liveness stays TCP. `/api/health` stays as it is: desktops read it.
- **FR-24.43** The roll MUST be clean: `preStop` sleep 5 s so endpoints update; `maxSurge: 1`, `maxUnavailable: 0`; `LGR_STOP_WAIT_MS` long enough for a Z-report, with `terminationGracePeriodSeconds` above it plus the sleep. Those limits only cost time when something is really in flight.
- **FR-24.44** On stop, once the fiscal count reaches zero, the pod MUST close its bridges with code 1012, and clients reconnect at once with no backoff. Waiting for the exit would leave tills on a pod that no longer takes new connections, and which a sibling's forward can no longer reach.
- **FR-24.45** New collection `fiscal_presence`, modeled on `node_presence`, one row per `(orgId, deviceNumber)` a pod holds: `deviceId`, `kind` (`user`, `desktop`, or `server` for a device the pod opened over TCP), `label`, `userId` or `desktopId`, `instanceId`, `podId`, `podAddr`, `connId`, `connectedAt`, `heartbeatAt`, and an optional `evict`. Replication class `N`, and it joins `NODE_STATE_MODELS`.
  - It is kept where the registry is, `fiscal-device.service.ts` (`registerPrinter`, `connectDevice` and their inverses), so no way of holding a device can miss it.
  - Heartbeat 5 s, dead after 20 s. The uplink's 75 s is too long for a till.
  - ⚠ The unique index decides `bridge_in_use`. It replaces the in-memory check, which cannot see a sibling.
  - The same principal reconnecting takes its own row over at once (same `instanceId` for a tab, same `desktopId` for a desktop), including a row a crashed pod left behind.
  - A close deletes the row only if `connId` still matches: a client that already reconnected elsewhere must not be marked offline by its old socket's late close.
- **FR-24.46** `resetStaleFiscalStatuses` MUST go. A scheduler on every pod marks `online` devices with no live row `offline`. It is idempotent and scoped by `homeScope()`.
- **FR-24.47** `connected` and `bridgedBy` (`GET /fiscal/device`, the close preview, the terminal) MUST come from the row. The warning on `replicas` goes into `deployment-lgr.yaml` in this phase.
- **FR-24.48** A takeover and a revocation MUST work across pods. The row gets `evict`, and the holder's tick acts on it within 5 s. ⚠ Revocation still does not depend on the till cooperating: the server drops the socket. On one pod it stays immediate, as today.
- **FR-24.49** `fiscal:bridge:register` gains an optional `instanceId`. A desktop is identified by its `desktopId`, so field versions 0.1.5–0.1.7 work unchanged. A browser tab on old code cannot take its own row over, and waits out the 20 s.

### Phase 6 — two pods

- **FR-24.50** A route that reaches a printer MUST declare it, with a macro whose resolver names the device from `{ user, params, body }`. The check runs after authentication and before the handler, so nothing has been written when the request moves. A forward carries the raw body, never a re-encoded one.
  - ⚠ `/close` claims the session and then resolves the device. The macro runs before that claim and only reads, so the handler keeps its order, but no declared route may write before the macro runs.
  - The set known today:
    - `pos.controller.ts`: `POST /session` (its device check), and under `/session/:id`: `close-preview`, `close`, `transaction` (POST), `storno`, `report/print`, `device-report`.
    - `cash-register.controller.ts`: the journal's storno.
    - `invoice.controller.ts`: `POST /invoices`, for a back-office cash sale that joins its author's open session (FR-21.31). This route is why the resolver needs `user` and `body`: the device follows from the author's session, not from the path.
    - `fiscal-device.controller.ts`: `PUT /:id` (it rebinds the driver) and everything under `/:id/` that reaches the device: `connect`, `disconnect`, `status`, `z-report`, `x-report`, `sync-time`, `operator-report`, `fm-report`, `ej-report`, `program-operator`, `read-operator`, `payment-names`.
    - `invoice.controller.ts`, FR-23: `/:id/send`, `/:id/payments` and `/:id/receipt`, on the device of the open session of whoever issues or pays (`deviceFromCounter`). `PUT /:id` and `/:id/void` reach a device only to finish a receipt whose request died, on that receipt's own device (`deviceFromDeadReceipt`).
  - **Exempt: `numbering.controller.ts`.** Its witness reads every device of an org in one request, and `not_connected` is its documented answer for a device on another pod (`device-witness.service.ts`). It is evidence for a person, never a lock, so it stays local.
- **FR-24.51** The hop MUST reuse `forwardHttp` with its own key label. A hop is never forwarded again. The holder unreachable answers 503 `fiscal_holder_unreachable` with nothing written, and the client retries under the same `Idempotency-Key`: the sale, the close and the storno already carry one (`ui-shared/composables/idempotency`, `hot-path-key`, #155).
- **FR-24.52** ⚠ "Held elsewhere" MUST never read as "offline". `getFiscalContext`'s proceed-without-a-receipt path stays reachable only when no live row exists anywhere. A route that missed FR-24.50 reaching a device held by another pod answers 503. It never skips the receipt. A hop arriving where the device has just left answers 409 `fiscal_holder_moved`, and the client retries once.
- **FR-24.53** A test MUST walk the real route table and fail when a route reaching `getPrinter` or `getFiscalContext` has no declaration and is not on the exempt list, as `tenant-isolation.flow.test.ts` does for the guard.
- **FR-24.54** `tests/two-node` gains a two-pod till lane: a simulated Eltrade (`helpers/eltrade-simulator.ts`) bridged to pod A, with every flow requested on pod B: sale, storno, close with Z-report, device report, takeover, revocation, an invoice issued and paid at the counter (FR-23), pod A killed mid-day.
- **FR-24.55** `replicas: 2`, same node, `POD_IP` from the downward API. No storage change: a `ReadWriteOnce` hostPath serves two pods on one node.
- **FR-24.56** An HPA MAY follow once a CPU signal justifies it. Two fixed replicas is the target.

### Phase 7 — a second node (optional, Q-3)

- **FR-24.60** Uploads MUST move to storage both nodes can mount. An NFS `ReadWriteMany` volume is the default: no code changes, and reversible by copying back. A `BlobStore` over S3 means reworking every path below `config.upload.dir` and keeping a local driver for masters, for a benefit nothing needs yet.
- **FR-24.61** The front proxy MUST list both workers. `topologySpreadConstraints` spread the pods by zone, and a `PodDisruptionBudget` of `minAvailable: 1` joins them here, not earlier: with both pods pinned to one node it would only block `kubectl drain`.
- ⚠ **Be honest about what this buys.** Mongo is one replica on one node and the front proxy is one host. Losing either stops LGR however many pods run. Phase 7 buys CPU and survival of the node with no Mongo on it, not high availability.

## 7. Edge cases and risks

| Risk | Handling |
|---|---|
| **Pinia state now outlives a module.** A reload used to clear it | Views fetch on mount, and none use `<keep-alive>`. Org switch stays a full reload, so nothing crosses orgs. Field test: a till tab over a working day, memory flat |
| **An unhandled route or link** reloads the page and drops the printer silently | FR-24.5's test, and the bridge coming back by itself (FR-24.41), so the cost of a miss is seconds |
| **A guard the portal lacked**: the merged `beforeEach` could let a public route skip the org check, or block one | E2e on both shells; `meta.public` routes listed in a test |
| **Rollout version skew**: `index.html` from a new pod, chunks from an old one | FR-24.14. The API stays compatible across one deploy, as it must already for open tabs |
| **A stale till tab** keeps running old code | FR-24.14 offers the reload and never forces one with a bridge up |
| **An old pending-changes entry** with an app-relative path | FR-24.7 |
| **A forward during a roll** finds the holder draining | 503 with nothing written, or 409, then a retry under the idempotency key. The window is the drain plus a reconnect: seconds |
| **Two pods race for one device** | The unique index picks one, the other gets `bridge_in_use`, as two tabs do today |
| **Double booking across a retry** | The `Idempotency-Key` on a sale, a close and a storno already covers it, and it is Mongo-backed, so it holds across pods |
| **Bun blocks on one thread** | Unchanged per pod. A second pod means a heavy report no longer stalls every till |

## 8. Integration constraints

- **FR-20.** A master stays one process, and all of §6 must be a no-op there. `fiscal_presence` is class `N`. New code that sweeps across orgs is scoped by `homeScope()`. A master serves no third-party script.
- **FR-14.** The native bridge's protocol stays compatible with field versions. `/connect` keeps refusing `browser` and `desktop` with 422. "Registration routes on the signature" and "a desktop can never evict" stay as they are.
- **FR-19.** A tab keeps its own org. Nothing here touches `session.ts`, except that the `?token=` reader goes.
- **FR-21 / FR-23.** The till's and the journal's fiscal routes are FR-24.50 routes. FR-23's new print paths declare themselves when they land. A device's turn (`fiscal/device-turn.ts`) is a queue in the process holding it, so what hops there waits there, and a sale and a payment asked of two pods still print one at a time.
- **FR-05.** Route names stay, because Playwright and `useGridColumns` key on them.
- **The global constraints in `docs/fr/README.md`** hold: `/bills/import/*` and the invoice payload stay byte-compatible.
- **Deploys.** No phase changes data. Phases 3, 5 and 6 still follow the protocol on #171: nothing while `deploy-prod.sh` runs, and a line on the issue when a deploy matters to others.

## 9. Migration and rollback

No data migration in Phases 0–4. `fiscal_presence` is a new, disposable collection: dropping it loses nothing, since bridges re-register.

| Phase | Back out by |
|---|---|
| 2 | Clear the cookie, or set `LGR_UI_DEFAULT=split` |
| 3, before the delete | `LGR_UI_DEFAULT=split` and a restart |
| 3, after the delete | `deploy-prod.sh --tag <previous>` |
| 5 | Revert; the old code ignores the rows |
| 6 | `replicas: 1` in lgr-deploy. On one pod the routing forwards nothing |
| 7 | Point the volume back after copying the delta |

## 10. Acceptance criteria

1. With a printer bridged in the browser, moving through every module and the App Hub, for a whole session, leaves the bridge `connected`, with no picker and no reconnect, and the next sale prints.
2. No in-app move loads the document: Playwright asserts one `load` event across a walk of all seven modules.
3. Every existing e2e spec passes unmodified on both shells, except what the POS move itself changes.
4. Saved grid columns, favourites, pending changes and deep links from before the flip all still work.
5. One Vite build of the web app in the Dockerfile, in `bun run build` and in `bun run dev`. `desktop-ui` stays its own.
6. First-load JS at or under 360 KB gzipped, and no module's views in the entry chunk.
7. Nothing reads a session token from a query string.
8. One auth plugin, with `tenant-isolation.flow.test.ts` passing unmodified.
9. A master package built from the new tree passes the SHOP lane, on one process, with no analytics and no forwarded request.
10. A deploy with a browser till connected: the bridge returns by itself, with no picker, and a sale prints within 30 s of the old pod going.
11. With two pods, a bridge on one and every till flow requested on the other: every flow prints exactly once.
12. Killing the holder pod mid-day: the till reconnects, the next sale prints, and no sale is booked twice or left without a receipt it should have.
13. Two pods restarting one after the other never mark a held device `offline`.
14. No sale is ever completed without a receipt because of which pod served it (FR-24.52).

## 11. Field test

On production, in a test org, with a non-fiscalized device. Write results as "equal", "unchanged" or counts: never amounts.

**After Phase 2** (cookie on one browser):
1. Open `/__ui/one`, sign in, open the till, connect the printer.
2. Go Invoicing → Inventory → Accounting → Reports → App Hub → back to the till. The chip stays connected, and no picker appears.
3. Sell, storno and print a device report.
4. Pull the USB cable while in Inventory: the shell alerts. Plug it back: it reconnects.
5. Open an invoice with unsaved edits, move to Inventory, come back: the edits are under Pending changes.
6. Leave the tab open through a working day. Memory stays flat and the printer connected.

**After Phase 5:** with the till connected, run a deploy. The bridge returns unaided, and the next sale prints.

**After Phase 6:** repeat with two pods, watching which pod holds the row. Delete the holder pod during a quiet moment. The till reconnects, and a sale prints on the first try or after one automatic retry.

Remove what the test created, and say how that was checked.

## 12. Questions for the owner

Each has a default, and the plan proceeds on it.

- **Q-1. The rename-only moves (FR-24.31).** Do them, or leave the folders? **Default: do them last, at a quiet moment.** They have no runtime effect, but they are what make it one app in the tree as well as in the browser. The `portal-api` rename is the one with a cost.
- **Q-2. Analytics on module pages.** **Default: no,** as today. They would report every document URL, ids included.
- **Q-3. A second node.** **Default: stop at two pods on one node.** Without a Mongo replica it buys little (§6, Phase 7). If wanted, NFS first.
- **Q-4. Who tries the cookie first.** **Default: the owner and `acme-corp` for two days, then one regal till for a week.**

## 13. Rejected

| Alternative | Why not |
|---|---|
| Micro-frontends / module federation | Keeps the split and adds a runtime to it |
| Keep eight SPAs and have every till use LGR Desktop | It does fix the printer, since the port is held in Rust. It fixes nothing else, and browser tills exist |
| Hold the port in a worker across page loads | Web Serial is exposed to windows and dedicated workers only, and a dedicated worker dies with its page |
| A big-bang `git mv` first | No user value until the end, and it collides with every open branch |
| Redis or NATS for routing | A new stateful service for one job, and a master would need it too or a second code path. FR-20's row plus hop is already built and tested |
| A remote printer proxy | §6.2 |
| Sticky sessions | The bridge's socket and the sale's HTTP request are different connections, and on a desktop till different clients |
| A dedicated fiscal pod | One point of failure, two roles for one image, and it needs the forwarding anyway |
| Object storage now | §6, FR-24.60 |
