import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { logger } from 'services/logger'

// Controllers
import { authController } from './controllers/auth.controller.js'
import { oauthController } from './controllers/oauth.controller.js'
import { inviteController } from './controllers/invite.controller.js'
import { stripeController } from './controllers/stripe.controller.js'
import { orgController } from './controllers/org.controller.js'
import { userController } from './controllers/user.controller.js'
import { fileController } from './controllers/file.controller.js'
import { exportController } from './controllers/export.controller.js'
import { notificationController } from './controllers/notification.controller.js'

// Accounting controllers
import { accountController } from './controllers/accounting/account.controller.js'
import { journalController } from './controllers/accounting/journal.controller.js'
import { fiscalYearController } from './controllers/accounting/fiscal-year.controller.js'
import { fiscalPeriodController } from './controllers/accounting/fiscal-period.controller.js'
import { fixedAssetController } from './controllers/accounting/fixed-asset.controller.js'
import { bankAccountController } from './controllers/accounting/bank-account.controller.js'
import { reconciliationController } from './controllers/accounting/reconciliation.controller.js'
import { taxReturnController } from './controllers/accounting/tax-return.controller.js'
import { exchangeRateController } from './controllers/accounting/exchange-rate.controller.js'

// Invoicing controllers
import { contactController } from './controllers/invoicing/contact.controller.js'
import { invoiceController } from './controllers/invoicing/invoice.controller.js'
import { paymentOrderController } from './controllers/invoicing/payment-order.controller.js'
import { cashOrderController } from './controllers/invoicing/cash-order.controller.js'

// Warehouse controllers
import { productController } from './controllers/warehouse/product.controller.js'
import { warehouseController } from './controllers/warehouse/warehouse.controller.js'
import { movementController } from './controllers/warehouse/movement.controller.js'
import { stockLevelController } from './controllers/warehouse/stock-level.controller.js'
import { inventoryCountController } from './controllers/warehouse/inventory-count.controller.js'
import { priceListController } from './controllers/warehouse/price-list.controller.js'

// Payroll controllers
import { employeeController } from './controllers/payroll/employee.controller.js'
import { payrollRunController } from './controllers/payroll/run.controller.js'
import { payslipController } from './controllers/payroll/payslip.controller.js'
import { timesheetController } from './controllers/payroll/timesheet.controller.js'

// HR controllers
import { departmentController } from './controllers/hr/department.controller.js'
import { leaveController } from './controllers/hr/leave.controller.js'
import { leaveTypeController } from './controllers/hr/leave-type.controller.js'
import { leaveBalanceController } from './controllers/hr/leave-balance.controller.js'
import { businessTripController } from './controllers/hr/business-trip.controller.js'
import { employeeDocumentController } from './controllers/hr/employee-document.controller.js'

// CRM controllers
import { leadController } from './controllers/crm/lead.controller.js'
import { dealController } from './controllers/crm/deal.controller.js'
import { pipelineController } from './controllers/crm/pipeline.controller.js'
import { activityController } from './controllers/crm/activity.controller.js'

// ERP controllers
import { bomController, productionOrderController } from './controllers/erp/production.controller.js'
import { constructionController } from './controllers/erp/construction.controller.js'
import { posController } from './controllers/erp/pos.controller.js'

// WebSocket
import { setupWebSocket } from './websocket/ws.server.js'

await connectDB()
logger.info('Connected to MongoDB')

const app = new Elysia()
  .use(cors({ origin: true, credentials: true }))
  .use(
    swagger({
      documentation: {
        info: { title: 'Ledger ERP API', version: '0.1.0', description: 'Full ERP REST API' },
        tags: [
          { name: 'Auth', description: 'Authentication' },
          { name: 'Accounting', description: 'Chart of Accounts, Journal Entries, Financial Reports' },
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

  // Auth (public)
  .group('/api', (app) =>
    app
      .use(authController)
      .use(oauthController)
      .use(inviteController)
      .use(stripeController)

      // Org-scoped routes
      .use(orgController)
      .use(userController)
      .use(fileController)
      .use(exportController)
      .use(notificationController)

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

// Static files (UI build)
try {
  app.use(
    staticPlugin({
      assets: '../ui/dist',
      prefix: '',
    }),
  )

  // SPA fallback
  const spaPaths = [
    '/',
    '/landing',
    '/dashboard',
    '/accounting/*',
    '/invoicing/*',
    '/warehouse/*',
    '/payroll/*',
    '/hr/*',
    '/crm/*',
    '/erp/*',
    '/settings/*',
    '/admin/*',
    '/auth/*',
    '/invite/*',
  ]
  for (const path of spaPaths) {
    app.get(path, () => Bun.file('../ui/dist/index.html'))
  }
} catch {
  logger.info('UI dist not found, serving API only')
}

app.listen({ hostname: config.host, port: config.port })

logger.info(`Ledger ERP running at http://${config.host}:${config.port}`)
logger.info(`Swagger docs at http://${config.host}:${config.port}/swagger`)

export type App = typeof app
