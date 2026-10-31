import { Elysia } from 'elysia'
import { corsPlugin } from './cors.js'
import { isolationHeaders } from './isolation-headers.js'
import swagger from '@elysiajs/swagger'
import { config, nodeRole } from 'config'
import { connectDB } from 'db/connection'
import { initServiceContext } from 'services/context'
import { createMongoRepositories } from 'dal-mongo'
import { logger } from 'services/logger'

// The whole API route table lives in `api.ts` so tests can mount it — see the header there.
import { createApiApp } from './api.js'
// Same reason for the SPA serving: `spa-fallback.flow.test.ts` drives it with the real plugins.
import { UI_MODULES, portalShellFor, spaErrorHandler, uiStaticPlugin, type UiModule } from './spa-fallback.js'

// WebSocket
import { setupWebSocket } from './websocket/ws.server.js'
import { closeAllBridges, setupFiscalBridgeWS } from './websocket/fiscal-bridge.js'
import { setFiscalForwarding } from 'fiscal/fiscal-route'
import { forwardHttp } from './tunnel/forward.js'
import { FISCAL_HOP, verifyHop } from './tunnel/hop.js'
import { clientIp } from './auth/client-ip.js'
import { setupDesktopWS } from './websocket/desktop.js'
import { setupUplinkWS } from './websocket/uplink.js'

// The master's front, control socket and stop (FR-20.16, FR-20.23)
import { frontRefusal } from './front/front-guard.js'
import { tunnelRouter } from './tunnel/router.js'
import { startControlSocket } from './front/control-socket.js'
import { gracefulStop, isStopping } from './front/graceful-stop.js'

// --- Connect to MongoDB once ---
await connectDB()
logger.info('Connected to MongoDB')

// --- Versioned migrations (FR-20.19), before anything reads the data ---
// A failure stops the start: serving a half-migrated database is worse than not serving.
if (config.migrations.auto) {
  const { mongoose } = await import('db/connection')
  const { runMigrations } = await import('migrations/runner')
  const { homeScope } = await import('db/home/home')
  // FR-20.5: a migration runs for the orgs whose home is here; a master's orgs migrate on the master.
  const result = await runMigrations({ db: mongoose.connection.db!, orgFilter: await homeScope(), log: (m, extra) => logger.info(extra ?? {}, m) })
  logger.info({ applied: result.applied, alreadyApplied: result.alreadyApplied.length }, 'Migrations up to date')
}

const repos = await createMongoRepositories({ backend: 'mongo' })
initServiceContext(repos)

// Register cross-module event handlers
import { registerEventHandlers } from 'services/events/handlers'
registerEventHandlers()

// FR-20.51 (P3-7): a master whose database went back in time locks its legal series BEFORE it serves.
if (config.node.role === 'master') {
  const { journalHwmTick, lanCloneTick } = await import('services/biz/home/series-lock.service')
  await journalHwmTick().catch(e => logger.error({ err: e?.message ?? String(e) }, 'Series lock: the journal\'s high-water mark could not be checked'))
  // A clone the supervisor saw on the shop's network before this start (AC 50).
  await lanCloneTick().catch(e => logger.error({ err: e?.message ?? String(e) }, 'Series lock: the clone record could not be read'))
}

/**
 * Where a module's built SPA is. From the repository: `packages/<module>-ui/dist`, beside this
 * package (the server runs in `packages/portal-api`). A server package sets `LGR_UI_ROOT` to its
 * `ui/` directory, which holds one built SPA per module, named after it (FR-20 plan step P0b-9).
 */
const uiRoot = process.env.LGR_UI_ROOT?.replace(/[\\/]+$/, '')
const uiDir = (mod: string) => (uiRoot ? `${uiRoot}/${mod}` : `../${mod}-ui/dist`)

// Pre-read index.html files for SPA fallback
const indexHtmlMap: Partial<Record<UiModule, string>> = {}

for (const mod of UI_MODULES) {
  try {
    indexHtmlMap[mod] = await Bun.file(`${uiDir(mod)}/index.html`).text()
  } catch {
    logger.info(`${mod}-ui dist not found, skipping static serving`)
  }
}
// The analytics tag goes on lgrai.app's portal only (FR-20 AC 66).
if (indexHtmlMap.portal) indexHtmlMap.portal = portalShellFor(indexHtmlMap.portal, nodeRole())

const app = new Elysia()
  // FR-20.72–20.74 (P3-4b): an org's address, `<label>.lgrai.app`, is its server's: tunnelled before
  // anything of lgrai.app's own app, headers or cookies runs. Global only; nothing for other hosts.
  .onRequest(tunnelRouter())
  // FR-20.16: behind the master's supervisor, before routing and for WebSocket upgrades too. Off
  // where no front secret is set; its master-only refusals hold on every master.
  .onRequest(async ({ request }) => {
    const refusal = await frontRefusal(request)
    if (refusal) return refusal
  })
  .use(isolationHeaders()) // FR-20.72: CORP same-origin + Origin-Agent-Cluster on every response
  .use(corsPlugin()) // S-07: an allow-list, not every origin a caller names
  // 422 / SPA shell / 404 / 500. The shell's status needs care: see spa-fallback.ts.
  .onError(spaErrorHandler(indexHtmlMap))
  // API docs on lgrai.app only: the page loads its viewer from a CDN, and a master serves no
  // third-party script (FR-20 AC 66).
  .use(
    nodeRole() !== 'global' ? new Elysia() : swagger({
      documentation: {
        info: { title: 'LGR Unified API', version: '0.1.0', description: 'LGR ERP — All modules unified' },
        tags: [
          { name: 'Auth', description: 'Authentication & OAuth' },
          { name: 'Org', description: 'Organization management' },
          { name: 'Users', description: 'User management' },
          { name: 'Invites', description: 'Invitation management' },
          { name: 'Apps', description: 'App Hub' },
          { name: 'Billing', description: 'Stripe billing' },
          { name: 'Files', description: 'File management' },
          { name: 'Notifications', description: 'Notifications' },
          { name: 'Accounting', description: 'Chart of Accounts, Journal Entries, Reports' },
          { name: 'Invoicing', description: 'Invoices, Contacts, Payments' },
          { name: 'Warehouse', description: 'Products, Stock, Movements' },
          { name: 'Payroll', description: 'Employees, Payroll Runs, Payslips' },
          { name: 'Fiscal', description: 'Fiscal Devices, Workstations, SUPTO' },
          { name: 'POS', description: 'Point of Sale' },
        ],
      },
    }),
  )

  // All routes under /api — the table itself is in `api.ts`
  .use(createApiApp())

// FR-24.50/24.51: a till request for a printer another pod holds is forwarded there, as a fiscal hop.
setFiscalForwarding({
  forward: (to, request, client) => forwardHttp(to, request, client, { hopLabel: FISCAL_HOP }),
  isHop: request => !!verifyHop(request, Date.now(), FISCAL_HOP),
  clientIp: request =>
    verifyHop(request, Date.now(), FISCAL_HOP)?.clientIp ?? clientIp(Object.fromEntries(request.headers as any)) ?? null,
})

// WebSocket
setupWebSocket(app as any)
setupFiscalBridgeWS(app as any)
setupDesktopWS(app as any)
// FR-20.52 (P2-2a): a registered master's uplink. Global only: a master registers nowhere.
if (nodeRole() === 'global') setupUplinkWS(app as any)

// Static files for all module UIs
const moduleUiConfig = [
  { name: 'portal', prefix: '' },
  { name: 'accounting', prefix: '/accounting' },
  { name: 'inventory', prefix: '/inventory' },
  { name: 'invoicing', prefix: '/invoicing' },
  { name: 'pos', prefix: '/pos' },
  { name: 'payroll', prefix: '/payroll' },
  { name: 'reports', prefix: '/reports' },
  { name: 'files', prefix: '/files' },
].map(ui => ({ ...ui, assets: uiDir(ui.name) }))

for (const ui of moduleUiConfig) {
  if (indexHtmlMap[ui.name as UiModule]) {
    try {
      // ⚠ Awaited. The plugin is async, and unawaited it registers its routes after `listen`:
      // for the first ~180 ms every asset answered 404 while `/api/health` already said ready, so
      // a page loaded during a rollout came up blank (measured on the server package, P0b-9).
      app.use(await uiStaticPlugin(ui))
    } catch {
      logger.info(`Static plugin failed for ${ui.name}-ui`)
    }
  }
}

// SPA fallback is handled entirely by the onError NOT_FOUND handler above.
// It checks pathname against module prefixes and serves the correct index.html,
// while skipping paths that look like static assets (contain a file extension).

// SUPTO mode banner
if (config.supto.mode === 'production') {
  logger.info('SUPTO mode: PRODUCTION — data immutability enforced, fiscal receipts required')
}

app.listen({ hostname: config.host, port: config.port })

logger.info(`LGR Unified running at http://${config.host}:${config.port}`)
if (nodeRole() === 'global') logger.info(`Swagger docs at http://${config.host}:${config.port}/swagger`)
if (nodeRole() === 'master' && !config.front.secret) {
  logger.warn('A master with no front secret: nothing stands between this listener and the network (FR-20.16)')
}

// ── The graceful stop and the control socket (FR-20.23, FR-20.16) ─────────────────────────
const stopDeps = {
  server: app.server,
  waitMs: config.stop.waitMs,
  closeControl: undefined as undefined | (() => void),
  // FR-24.44: once nothing fiscal is in flight, tills reconnect elsewhere at once.
  closeBridges: () => closeAllBridges(1012),
  disconnect: async () => (await import('db/connection')).mongoose.disconnect(),
}
const stopNow = (reason: string) => { void gracefulStop(reason, stopDeps) }

if (config.front.controlSocket && config.front.secret) {
  const startedAt = Date.now()
  const control = startControlSocket(config.front.controlSocket, config.front.secret, {
    status: async () => {
      const { schedulerHealth } = await import('services/scheduler/registry')
      const { fiscalInFlight } = await import('fiscal/in-flight')
      const { clockTrusted, lastClockVerification } = await import('fiscal/clock')
      const { POSSession } = await import('db/models')
      const { homeScope } = await import('db/home/home')
      // What the updater defers on (FR-20.20): a till mid-session, a receipt mid-print.
      const posOpen = await POSSession.countDocuments({ status: { $in: ['open', 'closing_control'] }, ...(await homeScope()) })
        .exec().catch(() => null)
      return {
        ok: !isStopping(),
        stopping: isStopping(),
        pid: process.pid,
        role: nodeRole(),
        uptimeSecs: Math.round((Date.now() - startedAt) / 1000),
        fiscalInFlight: fiscalInFlight(),
        posOpen,
        pendingRequests: app.server?.pendingRequests ?? 0,
        pendingWebSockets: app.server?.pendingWebSockets ?? 0,
        schedulers: schedulerHealth(),
        // FR-20.22: what the status page shows. Unknown is never drift 0.
        clock: (() => {
          const trust = clockTrusted()
          return { trusted: trust.ok, reason: trust.ok ? undefined : trust.reason, last: lastClockVerification() ?? null }
        })(),
        // FR-20.98–20.101 (P3-8): the last backup, the orgs fenced here, what waits for the internet.
        ...((await (await import('services/biz/node/master-health')).masterHealth().catch(() => null)) ?? {}),
      }
    },
    stop: stopNow,
    // FR-20.64: the mirror's pages, for the supervisor to send on the bulk socket (P3-2b).
    replication: {
      status: async () => (await import('services/biz/replication/control')).replicationStatus(),
      page: async body => {
        const c = await import('services/biz/replication/control')
        return c.pageFor(c.readPageAsk(body))
      },
      resend: async text => {
        const c = await import('services/biz/replication/control')
        return c.resendFor(c.readResendAsk(text))
      },
      // FR-20.69 (P3-3): a chunk of a file global's mirror asked for.
      blob: async body => {
        const b = await import('services/biz/replication/blob-source')
        return b.blobFor(b.readBlobAsk(body))
      },
    },
    // FR-20.18 (#350): the setup console's view of this server: the orgs homed here, the desktops paired.
    setup: async () => (await import('services/biz/node/setup-facts')).setupFacts(),
    // FR-20.20: what the update helper asks for before it switches versions.
    backup: async () => {
      const { backupBeforeUpdate } = await import('services/biz/backup/pre-update-backup.service')
      const result = await backupBeforeUpdate()
      logger.info({ ok: result.ok, runs: result.runs.map(r => `${r.slug ?? r.orgId}:${r.status}`) }, 'Backup before an update')
      return { ...result }
    },
  })
  stopDeps.closeControl = control.close
  logger.info({ socket: config.front.controlSocket }, 'Control socket listening')
}

// ── Cold-start mitigation ──────────────────────────────────────────────────────
// Schema compilation for ALL models now runs in db/connection.ts (warmupSchemas) on every
// connect AND reconnect. Here we additionally PRIME the heaviest real-data aggregations
// against the FIRST REAL org, so mongod caches their working set + query plans. The previous
// warmup queried a dummy org that matched zero docs, so the product-ledger / dashboard
// $lookup stages never executed and the cache stayed cold — the first real request still
// paid the multi-second tax. Best-effort; runs on boot and on reconnect.
async function runDataPriming() {
  const start = Date.now()
  try {
    const { Org, Product } = await import('db/models')
    const org = await Org.findOne().select({ _id: 1 }).lean()
    if (!org) return // fresh DB — nothing real to prime
    const orgId = String((org as any)._id)
    const product = await Product.findOne({ orgId }).select({ _id: 1 }).lean()
    const { getProductLedger } = await import('services/biz/product-ledger.service')
    const { getInvoiceSummary } = await import('services/biz/invoice-summary.service')
    await Promise.all([
      product
        ? getProductLedger(orgId, String((product as any)._id), { page: 0, size: 1 }).catch(() => null)
        : Promise.resolve(null),
      getInvoiceSummary(orgId, { direction: 'outgoing' }).catch(() => null),
    ])
    logger.info({ duration: Date.now() - start, orgId }, 'Mongo data priming complete')
  } catch (e) {
    logger.warn({ error: (e as any)?.message }, 'Mongo data priming failed')
  }
}

// Re-prime hot aggregations when Mongoose reconnects (db/connection.ts re-warms schemas
// on the same event). Otherwise the first post-reconnect product-ledger/dashboard hit
// pays the cold-cache tax again.
import { mongoose } from 'db/connection'
mongoose.connection.on('reconnected', () => {
  logger.info('Mongoose reconnected — re-priming hot aggregations')
  runDataPriming().catch(e => logger.warn({ error: (e as any)?.message }, 'Reconnect priming failed'))
})

// ── Start-up tasks and schedulers (FR-20.23, plan step P0a-6) ─────────────────────────────
// Each runs on its own. They used to share one `try { … } catch { }`: a throw in the data priming,
// the fiscal reset or the first NTP check silently left every scheduler after it unstarted — no
// backups, no digest, no retention until the next restart, and nothing in the logs.
setTimeout(async () => {
  // A stop asked for in the first 100 ms: nothing starts that the stop has already halted.
  if (isStopping()) return
  const once = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (e: any) {
      logger.warn({ task: name, error: e?.message }, 'Start-up task failed — the others run regardless')
    }
  }

  // FR-24.46: no reset of every device at boot. With two pods it marked offline the devices the
  // sibling held; the `fiscal-presence` scheduler below marks offline only what no live row holds.
  // FR-21.28: say at startup when the cash register will answer 503 until `bun run migrate` (0009).
  await once('cash-register-readiness', async () => {
    const { logRegisterReadiness } = await import('services/biz/cash-register/freeze-check')
    await logRegisterReadiness()
  })
  // Warms caches; nothing waits for it.
  void once('data-priming', runDataPriming)

  /** A scheduler whose module is imported when it starts, so a broken import fails only it. */
  const lazy = <M>(load: () => Promise<M>, run: (m: M) => Promise<unknown>) => {
    let mod: M
    return { load: async () => { mod = await load() }, tick: () => run(mod) }
  }

  const { startSchedulers } = await import('services/scheduler/registry')
  const owner = await import('services/background/task-owner')
  await startSchedulers([
    // FR-24.46: a device marked `online` that no live presence row holds (on any pod) is `offline`.
    {
      name: 'fiscal-presence', intervalMs: 10_000, immediate: true,
      ...lazy(() => import('services/biz/fiscal-presence.service'), m => m.markUnheldDevicesOffline()),
    },
    // NTP time verification at start (the immediate tick), then every 6 hours by default.
    {
      name: 'fiscal-time-sync', intervalMs: config.supto.timeSyncIntervalMs, immediate: true,
      ...lazy(() => import('fiscal/time-sync.service'), m => m.runTimeSyncCycle()),
    },
    // FR-11.5 (#21) — daily digest. `checkIntervalMs: 0` disables it; .env.test sets that so no
    // test ever mails. The tick is cheap and decides per org, in the org's own timezone, whether
    // its hour has come. The immediate pass catches up today after a restart past the hour.
    {
      name: 'daily-digest', intervalMs: config.digest.checkIntervalMs, immediate: true,
      ...lazy(() => import('services/biz/digest/digest-runner.service'), m => m.digestTick()),
    },
    // FR-20.61 (P3-1b, P3-2b) — a master's capture of its own writes: one tailer under a lease, kept
    // running by this tick, and every org homed here captured. It ticks on every master because it
    // follows the link (Full: on), which can change while the API runs; LGR_REPLICATION=off stops it
    // for good, and global never runs it.
    {
      name: 'replication-capture', intervalMs: config.node.role === 'master' && config.replication.capture !== false ? 5_000 : 0, immediate: true,
      ...lazy(() => import('services/biz/replication/engine'), m => m.captureTick()),
    },
    // FR-13.10 (#24) — per-org backups. The claim is the unique {orgId, kind, date} on BackupRun.
    {
      name: 'backup', intervalMs: config.backup.checkIntervalMs, immediate: true,
      ...lazy(() => import('services/biz/backup/backup-runner.service'), m => m.backupTick()),
    },
    // FR-13.43–13.46 (#24) — retention. Global and bounded by `batchSize`: a row 366 days old is
    // 366 days old in every timezone.
    // ⚠ Registered AFTER the backup scheduler on purpose. It is the only scheduled job that
    // destroys data, and its immediate pass must not run ahead of the backup's.
    {
      name: 'retention', intervalMs: config.retention.checkIntervalMs, immediate: true,
      ...lazy(() => import('services/biz/retention/retention.service'), m => m.retentionTick()),
    },
    // FR-14.19 (#57) — reap ephemeral desktops that stopped reporting. ⚠ Only `ephemeral: true`
    // rows: the field lanes' throwaway VMs, never a till whose shop lost its connection.
    {
      name: 'desktop-reaper', intervalMs: config.desktop.reaperIntervalMs, immediate: true,
      ...lazy(() => import('services/biz/desktop/desktop.service'), m => m.reapEphemeralDesktops()),
    },
    // FR-20.2 (P2-1) — on global, reap ephemeral masters silent for 24 h. ⚠ Only `ephemeral: true`
    // rows: the field lanes' throwaway masters, never a shop's whose internet is down.
    {
      name: 'node-reaper', intervalMs: config.node.role === 'global' ? config.node.reaperIntervalMs : 0, immediate: true,
      ...lazy(() => import('services/biz/node/node.service'), m => m.reapEphemeralNodes()),
    },
    // FR-20.43 (P2-5) — on a master, its people's changes on lgrai.app, which end their sessions here.
    {
      name: 'identity-feed', intervalMs: config.node.role === 'master' ? config.identityFeed.intervalMs : 0, immediate: true,
      ...lazy(() => import('services/biz/identity/identity-feed.service'), m => m.identityFeedTick()),
    },
    // FR-20.40 (P2-4c) — on a master, its seal key's public half where the supervisor signs it into
    // its token assertions: before registration too, so the first token already carries it.
    {
      name: 'seal-key', intervalMs: config.node.role === 'master' && config.node.sealPubFile ? 10 * 60_000 : 0, immediate: true,
      ...lazy(() => import('services/biz/node/node-seal-key'), m => m.publishSealKey()),
    },
    // FR-20.79 (P3-6a) — moving an org to its master: on global, a frozen move's copy once the home
    // cache has run out; on a master, its moves on global (take the copy, then the home).
    {
      name: 'move-tick', intervalMs: config.node.role === 'global' ? config.move.tickMs : 0, immediate: true,
      ...lazy(() => import('services/biz/move/move.service'), m => m.moveTick()),
    },
    // FR-20.80 (P3-6c) — a move back: on global, a verified one's files put back in place and its
    // flip, after which the master's bulk socket is welcomed again (it pages the org no more).
    {
      name: 'move-back-tick', intervalMs: config.node.role === 'global' ? config.move.tickMs : 0, immediate: true,
      ...lazy(
        async () => ({ back: await import('services/biz/move/move-back.service'), uplink: await import('./websocket/uplink.js') }),
        m => m.back.moveBackTick(new Date(), { flippedBack: nodeId => m.uplink.rewelcomeNode(nodeId) }),
      ),
    },
    // FR-20.51 (P3-7) — on a master: the journal against its mark, and what lgrai.app says of this
    // server (a clone alarm, pages refused as a history that went back, how far it holds the journal).
    // Any of them locks legal numbering. From the start: a reverted disk is caught by the last one.
    {
      name: 'series-lock-tick', intervalMs: config.node.role === 'master' ? 60_000 : 0, immediate: true,
      // Then what it says of each org goes to lgrai.app, for the Servers page there.
      ...lazy(() => import('services/biz/home/series-lock.service'), async m => {
        const locked = (await m.journalHwmTick()) + (await m.lanCloneTick()) + (await m.linkAlarmsTick())
        await m.reportOrgState()
        return locked
      }),
    },
    // FR-20.70 (P3-7f) — after this master lost the record of its changes, lgrai.app's copy of each
    // org written here is made equal to it again: the copy's ids asked for and journaled again.
    {
      name: 'mirror-reconcile-tick', intervalMs: config.node.role === 'master' ? 60_000 : 0, immediate: true,
      ...lazy(() => import('services/biz/replication/reconcile'), m => m.mirrorReconcileTick()),
    },
    // FR-20.84 (P3-6e) — the audited import of a fenced export a person asked for: one batch a tick,
    // under a lease, so a crash or another pod repeats nothing.
    {
      name: 'fenced-import-tick', intervalMs: config.node.role === 'global' ? config.move.tickMs : 0, immediate: true,
      ...lazy(() => import('services/biz/move/fenced-import.service'), m => m.fencedImportTick()),
    },
    // FR-20.71 (P3-7g) — on a master: what a re-seed kept, brought into the books once a person asks.
    {
      name: 'kept-import-tick', intervalMs: config.node.role === 'master' ? config.move.tickMs : 0, immediate: true,
      ...lazy(() => import('services/biz/move/kept-import.service'), m => m.keptImportTick()),
    },
    {
      name: 'move-worker', intervalMs: config.node.role === 'master' ? config.move.workerMs : 0, immediate: true,
      ...lazy(
        async () => ({ worker: await import('services/biz/move/move-worker.service'), fiscal: await import('fiscal/in-flight') }),
        // A move back is refused while a fiscal device of this process prints.
        m => m.worker.moveWorkerTick(new Date(), fetch, m.fiscal.fiscalInFlight),
      ),
    },
    // FR-20.86 (P2-6) — on a master, the outbox: mail global sends on its behalf. 0 disables it.
    {
      name: 'outbox', intervalMs: config.node.role === 'master' ? config.outbox.intervalMs : 0, immediate: true,
      ...lazy(() => import('services/biz/relay/outbox-worker'), m => m.outboxTick()),
    },
    // FR-20.23 — background tasks: this process's heartbeat on the tasks it runs, and failing the
    // tasks whose process stopped (a deploy, a crash), so no screen polls a dead task for a week.
    { name: 'task-heartbeat', intervalMs: owner.HEARTBEAT_MS, tick: owner.heartbeatOwnedTasks },
    { name: 'orphaned-task-reaper', intervalMs: 60_000, immediate: true, tick: () => owner.failOrphanedTasks() },
  ])
}, 100)

// Graceful shutdown (FR-20.23): the same stop as the control socket's — the listener closes, an
// in-flight receipt finishes, the fiscal devices disconnect. `front/graceful-stop.ts`.
process.on('SIGTERM', () => stopNow('SIGTERM'))
process.on('SIGINT', () => stopNow('SIGINT'))

export type App = typeof app
