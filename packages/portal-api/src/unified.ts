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
import { analyticsController } from './controllers/analytics.controller.js'
import { integrationsController } from './controllers/integrations.controller.js'

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
import { contactLedgerController } from 'invoicing-api/src/controllers/contact-ledger.controller.js'
import { stockAvailabilityController } from 'invoicing-api/src/controllers/stock-availability.controller.js'

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
import { jobPositionController } from 'hr-api/src/controllers/job-position.controller.js'
import { applicantController } from 'hr-api/src/controllers/applicant.controller.js'
import { appraisalController } from 'hr-api/src/controllers/appraisal.controller.js'

// CRM controllers
import { leadController } from 'crm-api/src/controllers/lead.controller.js'
import { dealController } from 'crm-api/src/controllers/deal.controller.js'
import { pipelineController } from 'crm-api/src/controllers/pipeline.controller.js'
import { activityController } from 'crm-api/src/controllers/activity.controller.js'

// ERP controllers
import { bomController, productionOrderController } from 'erp-api/src/controllers/production.controller.js'
import { constructionController } from 'erp-api/src/controllers/construction.controller.js'
import { posController } from 'erp-api/src/controllers/pos.controller.js'
import { equipmentController } from 'erp-api/src/controllers/equipment.controller.js'
import { maintenanceController } from 'erp-api/src/controllers/maintenance.controller.js'

// Advanced MRP + PLM controllers
import { workCenterController } from 'erp-api/src/controllers/work-center.controller.js'
import { routingController } from 'erp-api/src/controllers/routing.controller.js'
import { ecoController } from 'erp-api/src/controllers/eco.controller.js'

// POS Restaurant controllers
import { restaurantFloorController } from 'erp-api/src/controllers/restaurant-floor.controller.js'
import { kitchenOrderController } from 'erp-api/src/controllers/kitchen-order.controller.js'

// Fleet controllers
import { vehicleController } from 'fleet-api/src/controllers/vehicle.controller.js'
import { vehicleCostController } from 'fleet-api/src/controllers/vehicle-cost.controller.js'

// Sales controllers
import { salesOrderController } from 'sales-api/src/controllers/sales-order.controller.js'
import { quotationTemplateController } from 'sales-api/src/controllers/quotation-template.controller.js'

// Purchase controllers
import { purchaseOrderController } from 'purchase-api/src/controllers/purchase-order.controller.js'
import { blanketOrderController } from 'purchase-api/src/controllers/blanket-order.controller.js'
import { reorderRuleController } from 'purchase-api/src/controllers/reorder-rule.controller.js'

// Project controllers
import { projectController } from 'project-api/src/controllers/project.controller.js'
import { taskController } from 'project-api/src/controllers/task.controller.js'
import { milestoneController } from 'project-api/src/controllers/milestone.controller.js'
import { timesheetController as projectTimesheetController } from 'project-api/src/controllers/timesheet.controller.js'
import { fieldServiceController } from 'project-api/src/controllers/field-service.controller.js'

// Helpdesk controllers
import { ticketController } from 'helpdesk-api/src/controllers/ticket.controller.js'
import { teamController } from 'helpdesk-api/src/controllers/team.controller.js'
import { slaPolicyController } from 'helpdesk-api/src/controllers/sla-policy.controller.js'
import { knowledgeController } from 'helpdesk-api/src/controllers/knowledge.controller.js'

// Documents controllers
import { workspaceController as docWorkspaceController } from 'documents-api/src/controllers/workspace.controller.js'
import { documentController } from 'documents-api/src/controllers/document.controller.js'
import { signatureController } from 'documents-api/src/controllers/signature.controller.js'

// Subscriptions controllers
import { subscriptionController } from 'subscriptions-api/src/controllers/subscription.controller.js'

// Approvals controllers
import { approvalTypeController } from 'approvals-api/src/controllers/approval-type.controller.js'
import { approvalRequestController } from 'approvals-api/src/controllers/approval-request.controller.js'

// Planning controllers
import { shiftController } from 'planning-api/src/controllers/shift.controller.js'
import { shiftTemplateController } from 'planning-api/src/controllers/template.controller.js'
import { appointmentController, appointmentTypeController } from 'planning-api/src/controllers/appointment.controller.js'

// Fiscal / SUPTO controllers
import { fiscalDeviceController, workstationController } from './controllers/fiscal-device.controller.js'
import { suptoExportController } from './controllers/supto-export.controller.js'

// WebSocket
import { setupWebSocket } from './websocket/ws.server.js'

// --- Connect to MongoDB once ---
await connectDB()
logger.info('Connected to MongoDB')

const repos = await createMongoRepositories({ backend: 'mongo' })
initServiceContext(repos)

// Register cross-module event handlers (Sales→Warehouse, Purchase→Warehouse, etc.)
import { registerEventHandlers } from 'services/events/handlers'
registerEventHandlers()

// Pre-read index.html files for SPA fallback
const uiModules = ['portal', 'accounting', 'trade', 'sales', 'purchase', 'project', 'helpdesk', 'documents', 'subscriptions', 'approvals', 'planning', 'fleet', 'payroll', 'hr', 'crm', 'erp'] as const
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
          const injectedHtml = html.replace(
            '</head>',
            `<script>window.__LGR_PURESTAT_URL__='${config.externalIntegrations?.purestat?.url || ''}';window.__LGR_PURESTAT_TRACKER_URL__='${config.externalIntegrations?.purestat?.trackerUrl || ''}';window.__LGR_PURESTAT_SITE_ID__='${config.externalIntegrations?.purestat?.siteId || ''}';window.__LGR_ROOMLER_URL__='${config.externalIntegrations?.roomler?.url || ''}';window.__LGR_TICKYTACK_URL__='${config.externalIntegrations?.tickytack?.url || ''}';</script></head>`,
          )
          set.status = 200
          set.headers['content-type'] = 'text/html; charset=utf-8'
          return injectedHtml
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
          { name: 'Sales', description: 'Quotations, Sales Orders, Templates' },
          { name: 'Purchase', description: 'RFQs, Purchase Orders, Agreements, Reorder Rules' },
          { name: 'Project', description: 'Projects, Tasks, Milestones, Timesheets' },
          { name: 'Helpdesk', description: 'Tickets, SLA Policies, Teams' },
          { name: 'Knowledge', description: 'Knowledge base articles' },
          { name: 'Documents', description: 'Workspaces, Files, E-Signatures' },
          { name: 'Subscriptions', description: 'Recurring Subscriptions' },
          { name: 'Approvals', description: 'Approval Types & Requests' },
          { name: 'Planning', description: 'Shifts, Templates, Appointments' },
          { name: 'Fleet', description: 'Vehicles, Costs' },
          { name: 'Fiscal', description: 'Fiscal Devices, Workstations, SUPTO' },
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
      .use(analyticsController)
      .use(integrationsController)

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
      .use(contactLedgerController)
      .use(stockAvailabilityController)

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
      .use(jobPositionController)
      .use(applicantController)
      .use(appraisalController)

      // CRM
      .use(leadController)
      .use(dealController)
      .use(pipelineController)
      .use(activityController)

      // ERP
      .use(bomController)
      .use(productionOrderController)
      .use(constructionController)
      .use(posController)
      .use(equipmentController)
      .use(maintenanceController)
      .use(workCenterController)
      .use(routingController)
      .use(ecoController)
      .use(restaurantFloorController)
      .use(kitchenOrderController)

      // Fleet
      .use(vehicleController)
      .use(vehicleCostController)

      // Sales
      .use(salesOrderController)
      .use(quotationTemplateController)

      // Purchase
      .use(purchaseOrderController)
      .use(blanketOrderController)
      .use(reorderRuleController)

      // Project
      .use(projectController)
      .use(taskController)
      .use(milestoneController)
      .use(projectTimesheetController)
      .use(fieldServiceController)

      // Helpdesk
      .use(ticketController)
      .use(teamController)
      .use(slaPolicyController)
      .use(knowledgeController)

      // Documents
      .use(docWorkspaceController)
      .use(documentController)
      .use(signatureController)

      // Subscriptions
      .use(subscriptionController)

      // Approvals
      .use(approvalTypeController)
      .use(approvalRequestController)

      // Planning
      .use(shiftController)
      .use(shiftTemplateController)
      .use(appointmentController)
      .use(appointmentTypeController)

      // Fiscal / SUPTO
      .use(fiscalDeviceController)
      .use(workstationController)
      .use(suptoExportController),
  )

// WebSocket
setupWebSocket(app as any)

// Static files for all module UIs
const moduleUiConfig = [
  { name: 'portal', assets: '../portal-ui/dist', prefix: '' },
  { name: 'accounting', assets: '../accounting-ui/dist', prefix: '/accounting' },
  { name: 'trade', assets: '../trade-ui/dist', prefix: '/trade' },
  { name: 'payroll', assets: '../payroll-ui/dist', prefix: '/payroll' },
  { name: 'hr', assets: '../hr-ui/dist', prefix: '/hr' },
  { name: 'crm', assets: '../crm-ui/dist', prefix: '/crm' },
  { name: 'erp', assets: '../erp-ui/dist', prefix: '/erp' },
  { name: 'sales', assets: '../sales-ui/dist', prefix: '/sales' },
  { name: 'purchase', assets: '../purchase-ui/dist', prefix: '/purchase' },
  { name: 'project', assets: '../project-ui/dist', prefix: '/project' },
  { name: 'helpdesk', assets: '../helpdesk-ui/dist', prefix: '/helpdesk' },
  { name: 'documents', assets: '../documents-ui/dist', prefix: '/documents' },
  { name: 'subscriptions', assets: '../subscriptions-ui/dist', prefix: '/subscriptions' },
  { name: 'approvals', assets: '../approvals-ui/dist', prefix: '/approvals' },
  { name: 'planning', assets: '../planning-ui/dist', prefix: '/planning' },
  { name: 'fleet', assets: '../fleet-ui/dist', prefix: '/fleet' },
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
