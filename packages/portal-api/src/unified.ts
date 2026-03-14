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

// Invoicing controllers
import { contactController } from 'invoicing-api/src/controllers/contact.controller.js'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller.js'
import { paymentOrderController } from 'invoicing-api/src/controllers/payment-order.controller.js'
import { cashOrderController } from 'invoicing-api/src/controllers/cash-order.controller.js'

// Warehouse controllers
import { productController } from 'warehouse-api/src/controllers/product.controller.js'
import { warehouseController } from 'warehouse-api/src/controllers/warehouse.controller.js'
import { movementController } from 'warehouse-api/src/controllers/movement.controller.js'
import { stockLevelController } from 'warehouse-api/src/controllers/stock-level.controller.js'
import { inventoryCountController } from 'warehouse-api/src/controllers/inventory-count.controller.js'
import { priceListController } from 'warehouse-api/src/controllers/price-list.controller.js'
import { productLedgerController } from 'warehouse-api/src/controllers/product-ledger.controller.js'
import { pricingController } from 'warehouse-api/src/controllers/pricing.controller.js'

// Payroll controllers
import { employeeController } from 'payroll-api/src/controllers/employee.controller.js'
import { payrollRunController } from 'payroll-api/src/controllers/run.controller.js'
import { payslipController } from 'payroll-api/src/controllers/payslip.controller.js'
import { timesheetController } from 'payroll-api/src/controllers/timesheet.controller.js'

// HR controllers
import { departmentController } from 'hr-api/src/controllers/department.controller.js'
import { leaveController } from 'hr-api/src/controllers/leave.controller.js'
import { leaveTypeController } from 'hr-api/src/controllers/leave-type.controller.js'
import { leaveBalanceController } from 'hr-api/src/controllers/leave-balance.controller.js'
import { businessTripController } from 'hr-api/src/controllers/business-trip.controller.js'
import { employeeDocumentController } from 'hr-api/src/controllers/employee-document.controller.js'

// CRM controllers
import { leadController } from 'crm-api/src/controllers/lead.controller.js'
import { dealController } from 'crm-api/src/controllers/deal.controller.js'
import { pipelineController } from 'crm-api/src/controllers/pipeline.controller.js'
import { activityController } from 'crm-api/src/controllers/activity.controller.js'

// ERP controllers
import { bomController, productionOrderController } from 'erp-api/src/controllers/production.controller.js'
import { constructionController } from 'erp-api/src/controllers/construction.controller.js'
import { posController } from 'erp-api/src/controllers/pos.controller.js'

// WebSocket
import { setupWebSocket } from './websocket/ws.server.js'

// --- Connect to MongoDB once ---
await connectDB()
logger.info('Connected to MongoDB')

const repos = await createMongoRepositories({ backend: 'mongo' })
initServiceContext(repos)

// Pre-read index.html files for SPA fallback
const uiModules = ['portal', 'accounting', 'invoicing', 'warehouse', 'payroll', 'hr', 'crm', 'erp'] as const
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
        const html = indexHtmlMap[moduleName || 'portal']
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
          { name: 'HR', description: 'Departments, Leave, Business Trips' },
          { name: 'CRM', description: 'Leads, Deals, Pipeline' },
          { name: 'ERP', description: 'Production, Construction, POS' },
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

      // Invoicing
      .use(contactController)
      .use(invoiceController)
      .use(paymentOrderController)
      .use(cashOrderController)

      // Warehouse
      .use(productController)
      .use(warehouseController)
      .use(movementController)
      .use(stockLevelController)
      .use(inventoryCountController)
      .use(priceListController)
      .use(productLedgerController)
      .use(pricingController)

      // Payroll
      .use(employeeController)
      .use(payrollRunController)
      .use(payslipController)
      .use(timesheetController)

      // HR
      .use(departmentController)
      .use(leaveController)
      .use(leaveTypeController)
      .use(leaveBalanceController)
      .use(businessTripController)
      .use(employeeDocumentController)

      // CRM
      .use(leadController)
      .use(dealController)
      .use(pipelineController)
      .use(activityController)

      // ERP
      .use(bomController)
      .use(productionOrderController)
      .use(constructionController)
      .use(posController),
  )

// WebSocket
setupWebSocket(app as any)

// Static files for all module UIs
const moduleUiConfig = [
  { name: 'portal', assets: '../portal-ui/dist', prefix: '' },
  { name: 'accounting', assets: '../accounting-ui/dist', prefix: '/accounting' },
  { name: 'invoicing', assets: '../invoicing-ui/dist', prefix: '/invoicing' },
  { name: 'warehouse', assets: '../warehouse-ui/dist', prefix: '/warehouse' },
  { name: 'payroll', assets: '../payroll-ui/dist', prefix: '/payroll' },
  { name: 'hr', assets: '../hr-ui/dist', prefix: '/hr' },
  { name: 'crm', assets: '../crm-ui/dist', prefix: '/crm' },
  { name: 'erp', assets: '../erp-ui/dist', prefix: '/erp' },
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

app.listen({ hostname: config.host, port: config.port })

logger.info(`LGR Unified running at http://${config.host}:${config.port}`)
logger.info(`Swagger docs at http://${config.host}:${config.port}/swagger`)

export type App = typeof app
