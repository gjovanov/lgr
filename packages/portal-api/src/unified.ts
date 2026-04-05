import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { initServiceContext } from 'services/context'
import { createMongoRepositories } from 'dal-mongo'
import { logger } from 'services/logger'

// Portal controllers
import { authController } from './controllers/auth.controller.js'
import { oauthController } from './controllers/oauth.controller.js'
import { inviteController } from './controllers/invite.controller.js'
import { stripeController } from './controllers/stripe.controller.js'
import { orgController } from './controllers/org.controller.js'
import { userController } from './controllers/user.controller.js'
import { fileController } from './controllers/file.controller.js'
import { exportController } from './controllers/export.controller.js'
import { notificationController } from './controllers/notification.controller.js'
import { appHubController } from './controllers/app-hub.controller.js'
import { tagController } from './controllers/tag.controller.js'
import { auditLogController } from './controllers/audit-log.controller.js'
import { permissionSetController } from './controllers/permission-set.controller.js'
import { posPaymentMethodController } from './controllers/pos-payment-method.controller.js'

// Accounting controllers
import { accountController } from 'accounting-api/src/controllers/account.controller.js'
import { journalController } from 'accounting-api/src/controllers/journal.controller.js'
import { fiscalYearController } from 'accounting-api/src/controllers/fiscal-year.controller.js'
import { fiscalPeriodController } from 'accounting-api/src/controllers/fiscal-period.controller.js'
import { fixedAssetController } from 'accounting-api/src/controllers/fixed-asset.controller.js'
import { bankAccountController } from 'accounting-api/src/controllers/bank-account.controller.js'
import { reconciliationController } from 'accounting-api/src/controllers/reconciliation.controller.js'
import { taxReturnController } from 'accounting-api/src/controllers/tax-return.controller.js'
import { exchangeRateController } from 'accounting-api/src/controllers/exchange-rate.controller.js'
import { reportController } from 'accounting-api/src/controllers/report.controller.js'
import { journalConfigController } from 'accounting-api/src/controllers/journal-config.controller.js'
import { paymentTermController } from 'accounting-api/src/controllers/payment-term.controller.js'
import { fiscalPositionController } from 'accounting-api/src/controllers/fiscal-position.controller.js'
import { journalAnalysisController } from 'accounting-api/src/controllers/journal-analysis.controller.js'

// Invoicing controllers
import { contactController } from 'invoicing-api/src/controllers/contact.controller.js'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller.js'
import { paymentOrderController } from 'invoicing-api/src/controllers/payment-order.controller.js'
import { cashOrderController } from 'invoicing-api/src/controllers/cash-order.controller.js'
import { contactLedgerController } from 'invoicing-api/src/controllers/contact-ledger.controller.js'
import { stockAvailabilityController } from 'invoicing-api/src/controllers/stock-availability.controller.js'
import { statsController } from 'invoicing-api/src/controllers/stats.controller.js'
import { agingReportController } from 'invoicing-api/src/controllers/aging-report.controller.js'
import { posController } from 'invoicing-api/src/controllers/pos.controller.js'

// Warehouse controllers
import { productController } from 'warehouse-api/src/controllers/product.controller.js'
import { warehouseController } from 'warehouse-api/src/controllers/warehouse.controller.js'
import { movementController } from 'warehouse-api/src/controllers/movement.controller.js'
import { stockLevelController } from 'warehouse-api/src/controllers/stock-level.controller.js'
import { inventoryCountController } from 'warehouse-api/src/controllers/inventory-count.controller.js'
import { priceListController } from 'warehouse-api/src/controllers/price-list.controller.js'
import { productLedgerController } from 'warehouse-api/src/controllers/product-ledger.controller.js'
import { pricingController } from 'warehouse-api/src/controllers/pricing.controller.js'
import { bulkPricingController } from 'warehouse-api/src/controllers/bulk-pricing.controller.js'
import { costLayerController } from 'warehouse-api/src/controllers/cost-layer.controller.js'
import { productCategoryController } from 'warehouse-api/src/controllers/product-category.controller.js'
import { stockLocationController } from 'warehouse-api/src/controllers/stock-location.controller.js'
import { operationTypeController } from 'warehouse-api/src/controllers/operation-type.controller.js'
import { stockLotController } from 'warehouse-api/src/controllers/stock-lot.controller.js'

// Payroll controllers
import { employeeController } from 'payroll-api/src/controllers/employee.controller.js'
import { payrollRunController } from 'payroll-api/src/controllers/run.controller.js'
import { payslipController } from 'payroll-api/src/controllers/payslip.controller.js'
import { timesheetController } from 'payroll-api/src/controllers/timesheet.controller.js'

// Fiscal / SUPTO controllers
import { fiscalDeviceController, workstationController } from './controllers/fiscal-device.controller.js'
import { suptoExportController } from './controllers/supto-export.controller.js'

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
const uiModules = ['portal', 'accounting', 'inventory', 'invoicing', 'pos', 'trade', 'payroll'] as const
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

  // All routes under /api
  .group('/api', (app) =>
    app
      // Portal
      .use(authController)
      .use(oauthController)
      .use(inviteController)
      .use(stripeController)
      .use(orgController)
      .use(userController)
      .use(fileController)
      .use(exportController)
      .use(notificationController)
      .use(appHubController)
      .use(tagController)
      .use(auditLogController)
      .use(permissionSetController)

      // Accounting
      .use(accountController)
      .use(journalController)
      .use(fiscalYearController)
      .use(fiscalPeriodController)
      .use(fixedAssetController)
      .use(bankAccountController)
      .use(reconciliationController)
      .use(taxReturnController)
      .use(exchangeRateController)
      .use(reportController)
      .use(journalConfigController)
      .use(paymentTermController)
      .use(fiscalPositionController)
      .use(journalAnalysisController)

      // Invoicing
      .use(contactController)
      .use(invoiceController)
      .use(paymentOrderController)
      .use(cashOrderController)
      .use(contactLedgerController)
      .use(stockAvailabilityController)
      .use(statsController)
      .use(agingReportController)

      // Warehouse
      .use(productController)
      .use(warehouseController)
      .use(movementController)
      .use(stockLevelController)
      .use(inventoryCountController)
      .use(priceListController)
      .use(productLedgerController)
      .use(pricingController)
      .use(bulkPricingController)
      .use(costLayerController)
      .use(productCategoryController)
      .use(stockLocationController)
      .use(operationTypeController)
      .use(stockLotController)

      // Payroll
      .use(employeeController)
      .use(payrollRunController)
      .use(payslipController)
      .use(timesheetController)

      // POS
      .use(posController)
      .use(posPaymentMethodController)

      // Fiscal / SUPTO
      .use(fiscalDeviceController)
      .use(workstationController)
      .use(suptoExportController),
  )

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
  { name: 'trade', assets: '../trade-ui/dist', prefix: '/trade' },
  { name: 'payroll', assets: '../payroll-ui/dist', prefix: '/payroll' },
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

// Warmup + SUPTO startup tasks
setTimeout(async () => {
  try {
    const warmupStart = Date.now()
    await Promise.all([
      repos.products.findAll({ orgId: '000000000000000000000000' }, { page: 0, size: 1 }),
      repos.invoices.findAll({ orgId: '000000000000000000000000' }, { page: 0, size: 1 }),
      repos.contacts.findAll({ orgId: '000000000000000000000000' }, { page: 0, size: 1 }),
      repos.stockLevels.findAll({ orgId: '000000000000000000000000' }, { page: 0, size: 1 }),
      repos.stockMovements.findAll({ orgId: '000000000000000000000000' }, { page: 0, size: 1 }),
      repos.accounts.findAll({ orgId: '000000000000000000000000' }, { page: 0, size: 1 }),
    ])
    logger.info({ duration: Date.now() - warmupStart }, 'Mongoose model warmup complete')

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
