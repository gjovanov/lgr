import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { initServiceContext } from 'services/context'
import { createMongoRepositories } from 'dal-mongo'
import { logger } from 'services/logger'

// The whole API route table lives in `api.ts` so tests can mount it — see the header there.
import { createApiApp } from './api.js'

// WebSocket
import { setupWebSocket } from './websocket/ws.server.js'
import { setupFiscalBridgeWS } from './websocket/fiscal-bridge.js'

// --- Connect to MongoDB once ---
await connectDB()
logger.info('Connected to MongoDB')

const repos = await createMongoRepositories({ backend: 'mongo' })
initServiceContext(repos)

// Register cross-module event handlers
import { registerEventHandlers } from 'services/events/handlers'
registerEventHandlers()

// Pre-read index.html files for SPA fallback
const uiModules = ['portal', 'accounting', 'inventory', 'invoicing', 'pos', 'payroll', 'reports', 'files'] as const
const indexHtmlMap: Record<string, string> = {}

for (const mod of uiModules) {
  try {
    indexHtmlMap[mod] = await Bun.file(`../${mod}-ui/dist/index.html`).text()
  } catch {
    logger.info(`${mod}-ui dist not found, skipping static serving`)
  }
}

const app = new Elysia()
  .use(cors({ origin: true, credentials: true }))
  .onError(({ code, error: err, set, request }) => {
    if (code === 'VALIDATION') {
      set.status = 422
      return { message: err.message }
    }
    if (code === 'NOT_FOUND') {
      const url = new URL(request.url)
      const pathname = url.pathname
      if (!pathname.startsWith('/api/') && !pathname.match(/\.\w{2,}$/)) {
        // Determine which module's index.html to serve
        const moduleName = uiModules.find((m) => m !== 'portal' && pathname.startsWith(`/${m}`))
        // Serve module's own SPA, or fall back to portal (app hub) for modules without a UI yet
        const html = indexHtmlMap[moduleName || 'portal'] || indexHtmlMap['portal']
        if (html) {
          set.status = 200
          set.headers['content-type'] = 'text/html; charset=utf-8'
          // index.html must NOT be cached — it references the per-build hashed asset
          // bundles, so a stale copy pins users to old JS after a deploy (the cause of
          // the "hard refresh needed to see changes" issue). The hashed assets under
          // /assets/* are content-addressed and stay cacheable.
          set.headers['cache-control'] = 'no-cache, no-store, must-revalidate'
          return html
        }
      }
      set.status = 404
      return { message: 'Not found' }
    }
    logger.error(err)
    set.status = 500
    return { message: err.message || 'Internal server error' }
  })
  .use(
    swagger({
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

// Static files for all module UIs
const moduleUiConfig = [
  { name: 'portal', assets: '../portal-ui/dist', prefix: '' },
  { name: 'accounting', assets: '../accounting-ui/dist', prefix: '/accounting' },
  { name: 'inventory', assets: '../inventory-ui/dist', prefix: '/inventory' },
  { name: 'invoicing', assets: '../invoicing-ui/dist', prefix: '/invoicing' },
  { name: 'pos', assets: '../pos-ui/dist', prefix: '/pos' },
  { name: 'payroll', assets: '../payroll-ui/dist', prefix: '/payroll' },
  { name: 'reports', assets: '../reports-ui/dist', prefix: '/reports' },
  { name: 'files', assets: '../files-ui/dist', prefix: '/files' },
]

for (const ui of moduleUiConfig) {
  if (indexHtmlMap[ui.name]) {
    try {
      app.use(
        staticPlugin({
          assets: ui.assets,
          prefix: ui.prefix || '',
          indexHTML: false,
        }),
      )
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
logger.info(`Swagger docs at http://${config.host}:${config.port}/swagger`)

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

// Data priming + SUPTO startup tasks
setTimeout(async () => {
  try {
    await runDataPriming()

    // Reset stale fiscal device statuses on startup (connections lost on restart)
    const { FiscalDevice } = await import('db/models')
    const resetCount = await FiscalDevice.updateMany({ status: 'online' }, { status: 'offline' }).exec()
    if (resetCount.modifiedCount > 0) {
      logger.info({ count: resetCount.modifiedCount }, 'Reset stale fiscal device statuses to offline')
    }

    // NTP time verification on startup
    const { runTimeSyncCycle } = await import('fiscal/time-sync.service')
    await runTimeSyncCycle()

    // Schedule periodic time sync (default: every 6 hours)
    setInterval(() => {
      runTimeSyncCycle().catch(e => logger.warn({ error: e.message }, 'Periodic time sync failed'))
    }, config.supto.timeSyncIntervalMs)

    // FR-11.5 (#21) — daily digest scheduler, same shape as the time sync above.
    // `checkIntervalMs: 0` disables it entirely; .env.test sets that so no test ever mails.
    // The tick is cheap (one indexed query for enabled orgs) and decides per org, in that
    // org's own timezone, whether its hour has come and whether today was already sent.
    if (config.digest.checkIntervalMs > 0) {
      const { digestTick } = await import('services/biz/digest/digest-runner.service')
      const tick = () => digestTick().catch(e => logger.warn({ error: e.message }, 'Daily digest tick failed'))
      // One immediate pass so a restart after the configured hour still catches up today.
      tick()
      setInterval(tick, config.digest.checkIntervalMs)
      logger.info({ intervalMs: config.digest.checkIntervalMs }, 'Daily digest scheduler started')
    }

    // FR-13.10 (#24) — per-org backup scheduler, the same shape again.
    // `checkIntervalMs: 0` disables it entirely; .env.test sets that so no test ever writes a
    // bundle or mails one. The claim is the unique {orgId, kind, date} index on BackupRun.
    if (config.backup.checkIntervalMs > 0) {
      const { backupTick } = await import('services/biz/backup/backup-runner.service')
      const btick = () => backupTick().catch(e => logger.warn({ error: e.message }, 'Backup tick failed'))
      btick()
      setInterval(btick, config.backup.checkIntervalMs)
      logger.info({ intervalMs: config.backup.checkIntervalMs, hour: config.backup.hour }, 'Backup scheduler started')
    }

    // FR-13.43–13.46 (#24) — retention, the same shape a third time.
    // `checkIntervalMs: 0` disables it entirely; `.env.test` sets that so no test can delete
    // anything. Unlike the two above this sweep has no per-org hour: a row 366 days old is
    // 366 days old in every timezone, so it runs globally and bounded by `batchSize`.
    //
    // ⚠ Registered LAST on purpose. It is the only scheduled job that destroys data, and the
    // one immediate pass below runs at startup — after the backup scheduler has been given
    // its chance to start, so a process that crashes during boot has not deleted anything on
    // its way past a backup that never ran.
    if (config.retention.checkIntervalMs > 0) {
      const { retentionTick } = await import('services/biz/retention/retention.service')
      const rtick = () => retentionTick().catch(e => logger.warn({ error: e.message }, 'Retention tick failed'))
      rtick()
      setInterval(rtick, config.retention.checkIntervalMs)
      logger.info({ intervalMs: config.retention.checkIntervalMs }, 'Retention scheduler started')
    }
  } catch { /* startup tasks are best-effort */ }
}, 100)

// Graceful shutdown: disconnect all fiscal devices
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...')
  try {
    const { disconnectAll } = await import('fiscal/fiscal-device.service')
    await disconnectAll()
  } catch { /* best-effort */ }
  process.exit(0)
})

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...')
  try {
    const { disconnectAll } = await import('fiscal/fiscal-device.service')
    await disconnectAll()
  } catch { /* best-effort */ }
  process.exit(0)
})

export type App = typeof app
