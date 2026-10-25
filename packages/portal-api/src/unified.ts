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
import { setupFiscalBridgeWS } from './websocket/fiscal-bridge.js'
import { setupDesktopWS } from './websocket/desktop.js'
import { setupUplinkWS } from './websocket/uplink.js'

// The master's front, control socket and stop (FR-20.16, FR-20.23)
import { frontRefusal } from './front/front-guard.js'
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
      }
    },
    stop: stopNow,
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
      getInvoiceSummary(orgId).catch(() => null),
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

  // Reset stale fiscal device statuses on startup (connections lost on restart)
  await once('fiscal-status-reset', async () => {
    const { resetStaleFiscalStatuses } = await import('services/biz/fiscal-status-reset')
    const count = await resetStaleFiscalStatuses()
    if (count > 0) logger.info({ count }, 'Reset stale fiscal device statuses to offline')
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
