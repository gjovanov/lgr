import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { initServiceContext } from 'services/context'
import { createSQLiteRepositories } from 'dal-sqlite'
import { logger } from 'services/logger'

// Desktop-specific
import { desktopAuthController } from './controllers/auth.controller.js'
import { desktopSettingsController } from './controllers/settings.controller.js'
import { setupFirstRun } from './setup/first-run.js'
import { initSettingsPath } from './settings.js'

// Accounting controllers (DAL-refactored)
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

// --- Initialize SQLite-backed repositories ---
const dbPath = process.env.LGR_DB_PATH || './lgr.db'
const repos = await createSQLiteRepositories({ backend: 'sqlite', sqlitePath: dbPath })
initServiceContext(repos)
initSettingsPath(dbPath)

// First-run: create default org + admin if empty
await setupFirstRun(repos)

const PORT = Number(process.env.LGR_DESKTOP_PORT) || 4080

const app = new Elysia()
  .use(cors({ origin: true, credentials: true }))
  .onError(({ code, error: err, set, request }) => {
    if (code === 'VALIDATION') {
      set.status = 422
      return { message: err.message }
    }
    if (code === 'NOT_FOUND') {
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/api/') && !url.pathname.match(/\.\w{2,}$/)) {
        set.status = 200
        return Bun.file('../desktop-ui/dist/index.html')
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
        info: { title: 'LGR Desktop API', version: '0.1.0', description: 'Unified offline-first ERP API' },
        tags: [
          { name: 'Auth', description: 'Desktop authentication' },
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
      // Desktop auth (login, logout, me) + settings
      .use(desktopAuthController)
      .use(desktopSettingsController)

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

// Static files (Desktop UI build) — only in dev mode.
// In production (Tauri), the webview loads the UI directly from the bundled frontend.
const uiDistPath = new URL('../desktop-ui/dist', import.meta.url).pathname
const uiDistExists = await Bun.file(`${uiDistPath}/index.html`).exists()

if (uiDistExists) {
  app.use(
    staticPlugin({
      assets: uiDistPath,
      prefix: '',
    }),
  )

  const spaPaths = [
    '/',
    '/dashboard',
    '/accounting/*',
    '/invoicing/*',
    '/warehouse/*',
    '/payroll/*',
    '/hr/*',
    '/crm/*',
    '/erp/*',
    '/settings/*',
    '/auth/*',
  ]
  for (const path of spaPaths) {
    app.get(path, () => Bun.file(`${uiDistPath}/index.html`))
  }
} else {
  logger.info('Desktop UI dist not found, serving API only')
}

app.listen({ hostname: '127.0.0.1', port: PORT })

logger.info(`LGR Desktop API running at http://127.0.0.1:${PORT}`)
logger.info(`SQLite database: ${dbPath}`)
logger.info(`Swagger docs at http://127.0.0.1:${PORT}/swagger`)

export type App = typeof app
