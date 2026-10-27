import { Elysia } from 'elysia'
import { enterRequest, leaveRequest } from 'db/home/request-context'
import { isReadOnlyRoute, isListedReadWriter, routeKey } from 'services/biz/route-class'

// Portal controllers
import { authController } from './controllers/auth.controller.js'
import { localAuthController } from './controllers/local-auth.controller.js'
import { onpremCredentialsController } from './controllers/onprem-credentials.controller.js'
import { oauthController } from './controllers/oauth.controller.js'
import { inviteController } from './controllers/invite.controller.js'
import { stripeController } from './controllers/stripe.controller.js'
import { orgController } from './controllers/org.controller.js'
import { orgLogoController } from './controllers/org-logo.controller.js'
import { digestController } from './controllers/digest.controller.js'
import { backupController } from './controllers/backup.controller.js'
import { integrationsController } from './controllers/integrations.controller.js'
import { userController } from './controllers/user.controller.js'
import { fileController } from './controllers/file.controller.js'
import { notificationController } from './controllers/notification.controller.js'
import { appHubController } from './controllers/app-hub.controller.js'
import { tagController } from './controllers/tag.controller.js'
import { auditLogController } from './controllers/audit-log.controller.js'
import { permissionSetController } from './controllers/permission-set.controller.js'
import { dashboardController } from './controllers/dashboard.controller.js'
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
import { orderController } from 'invoicing-api/src/controllers/order.controller.js'
import { internalOrderController } from 'invoicing-api/src/controllers/internal-order.controller.js'
import { reservationController } from 'invoicing-api/src/controllers/reservation.controller.js'
import { productSupplyController } from 'invoicing-api/src/controllers/product-supply.controller.js'
import { billImportController } from 'invoicing-api/src/controllers/bill-import.controller.js'
import { receiptBillController } from 'invoicing-api/src/controllers/receipt-bill.controller.js'
import { docImportController } from 'invoicing-api/src/controllers/doc-import.controller.js'
import { paymentOrderController } from 'invoicing-api/src/controllers/payment-order.controller.js'
import { cashOrderController } from 'invoicing-api/src/controllers/cash-order.controller.js'
import { contactLedgerController } from 'invoicing-api/src/controllers/contact-ledger.controller.js'
import { stockAvailabilityController } from 'invoicing-api/src/controllers/stock-availability.controller.js'
import { statsController } from 'invoicing-api/src/controllers/stats.controller.js'
import { agingReportController } from 'invoicing-api/src/controllers/aging-report.controller.js'
import { invoiceExportController } from 'invoicing-api/src/controllers/invoice-export.controller.js'
import { sequenceConfigController } from 'invoicing-api/src/controllers/sequence-config.controller.js'
import { posController } from 'invoicing-api/src/controllers/pos.controller.js'
import { cashRegisterController } from 'invoicing-api/src/controllers/cash-register.controller.js'

// Warehouse controllers
import { productController } from 'warehouse-api/src/controllers/product.controller.js'
import { warehouseController } from 'warehouse-api/src/controllers/warehouse.controller.js'
import { movementController } from 'warehouse-api/src/controllers/movement.controller.js'
import { openingStockController } from 'warehouse-api/src/controllers/opening-stock.controller.js'
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

// Reports controllers (FR-06 #14)
import { reportsController } from 'reports-api/src/controllers/report.controller.js'
import { filesController } from 'files-api/src/controllers/file.controller.js'

// Fiscal / SUPTO controllers
import { fiscalDeviceController, workstationController } from './controllers/fiscal-device.controller.js'
import { suptoExportController } from './controllers/supto-export.controller.js'
import { desktopController } from './controllers/desktop.controller.js'
import { desktopV1Controller } from './controllers/desktop-v1.controller.js'
import { desktopDownloadController } from './controllers/desktop-download.controller.js'
import { nodeController } from './controllers/node.controller.js'
import { nodeV1Controller } from './controllers/node-v1.controller.js'
import { moveController } from './controllers/move.controller.js'
import { numberingController } from './controllers/numbering.controller.js'
import { serverStatusController } from './controllers/server-status.controller.js'
import { homeController } from './controllers/home.controller.js'
import { adminNodesController } from './controllers/admin-nodes.controller.js'
import { addressController, adminAddressesController } from './controllers/address.controller.js'
import { adminLicencesController } from './controllers/admin-licences.controller.js'
import { licenceController } from './controllers/licence.controller.js'
import { idpController, idpSignInController } from './controllers/idp.controller.js'

/**
 * The API route table — every controller the server mounts under `/api`, and nothing else.
 *
 * ⚠ Extracted out of `unified.ts` for gjovanov/lgr#31. `unified.ts` connects to Mongo and
 * calls `.listen()` at import time, so a test can never mount it — which is why the route
 * table had no test that could see ALL of it, and why 66 of 67 `/org/:orgId/…` controllers
 * shipped with no cross-tenant guard and nothing noticed.
 *
 * `tenant-isolation.flow.test.ts` mounts THIS and walks `.routes`. That is the point of the
 * split: a controller added to the list below is automatically subject to the isolation
 * property, including ones written next year. Never inline a `.use()` back into `unified.ts`
 * — a route mounted there would be invisible to that test.
 */
export function createApiApp() {
  return new Elysia({ name: 'api-routes' })
    /**
     * FR-20.6 — the request context the write guard reads: is this route read-only, for which org,
     * and is it a listed read that writes (`services/biz/route-class.ts`).
     *
     * ⚠ `onTransform` because it is SYNCHRONOUS. Under Bun an `AsyncLocalStorage` store entered
     * after an `await` in a hook is not seen by the handler, and one entered synchronously outlives
     * the request in its execution context, hence the reset after the response (#169).
     */
    .onTransform({ as: 'global' }, ({ request, route, params }) => {
      enterRequest({
        readOnly: isReadOnlyRoute(request.method, route),
        route: routeKey(request.method, route),
        orgId: (params as Record<string, string | undefined> | undefined)?.orgId,
        listedWriter: isListedReadWriter(request.method, route),
      })
    })
    .onAfterResponse({ as: 'global' }, () => { leaveRequest() })
    /**
     * A JSON answer keeps its content type when the response also sets two or more cookies.
     *
     * ⚠ Elysia 1.4.30 on Bun 1.3.10 (the production runtime; Bun 1.4 does not show it): with
     * more than one cookie, `handleSet` replaces `set.headers` with a `Headers` instance, and the
     * JSON branch then writes `set.headers["content-type"] = "application/json"` as a JS PROPERTY
     * on it, which is no header at all. The body went out as text/plain: on 2026-10-23,
     * `POST /auth/login` once P0a-8 began writing both session cookies, and every other sign-in
     * and the sign-out with it. Named here, before the mapping, the type survives the copy into
     * `Headers`. Only plain objects and arrays, which are exactly what Elysia labels JSON.
     */
    .onAfterHandle({ as: 'global' }, ({ response, set }) => {
      if (response === null || typeof response !== 'object') return
      const kind = (response as object).constructor?.name
      if (kind !== 'Object' && kind !== 'Array') return
      const headers = set.headers as Record<string, unknown>
      if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json'
    })
    .group('/api', (app) =>
      app
        /**
         * Liveness. **Public, cheap, and says nothing.**
         *
         * ⚠ It exists because things already call it. FR-14.17's reachability probe asks for
         * `/api/health` before deciding a till is offline, and with no such route every probe
         * paid a failed request and fell back to fetching the origin — which works, but makes
         * "the server is down" slower to notice and noisier in the logs than it should be.
         *
         * ⚠ It deliberately does NOT touch Mongo. A liveness check that fails when the database
         * is slow turns a degraded hub into an unreachable one, and the desktop's answer to
         * "unreachable" is to stop showing the app. Readiness is a different question and would
         * need a different route.
         *
         * ⚠ And it reports nothing a stranger can use: no version, no hostname, no counts. It
         * is reachable without a token by definition, so its body is the smallest true thing.
         */
        .get('/health', () => ({ ok: true }))
        // Portal
        .use(authController)
        .use(localAuthController)
        .use(onpremCredentialsController)
        .use(oauthController)
        .use(inviteController)
        .use(stripeController)
        .use(orgController)
        .use(orgLogoController)
        .use(digestController)
        .use(backupController)
        .use(integrationsController)
        .use(userController)
        .use(fileController)
        // FR-6.21 (#14): the `/org/:orgId/export/:module/{excel,pdf}` stub is gone. It had
        // zero consumers and answered "not yet implemented" — the generic report runner
        // (`/org/:orgId/reports/:id/export`) is what it was a placeholder for.
        .use(notificationController)
        .use(appHubController)
        .use(tagController)
        .use(auditLogController)
        .use(permissionSetController)
        .use(dashboardController)

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
        .use(orderController)
        .use(internalOrderController)
        .use(reservationController)
        .use(productSupplyController)
        .use(billImportController)
        // FR-22.31/32 (#168): the supplier's bill for goods a receipt already booked.
        .use(receiptBillController)
        .use(docImportController)
        .use(paymentOrderController)
        .use(cashOrderController)
        .use(contactLedgerController)
        .use(stockAvailabilityController)
        .use(statsController)
        .use(agingReportController)
        .use(invoiceExportController)
        .use(sequenceConfigController)

        // Warehouse
        .use(productController)
        .use(warehouseController)
        .use(movementController)
        .use(openingStockController)
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
        // FR-21.12: the cash-register journal, shared by the POS and invoicing apps
        .use(cashRegisterController)

        // Reports
        .use(reportsController)
        .use(filesController)

        // Fiscal / SUPTO
        .use(fiscalDeviceController)
        .use(workstationController)
        .use(suptoExportController)
    // LGR Desktop (FR-14): the admin side under /org/:orgId/desktops, and the desktop's own
    // routes under /desktop/v1 behind their own deny-by-default DesktopAuth plugin.
    .use(desktopController)
    .use(desktopV1Controller)
    // The installers, streamed from the private repo's releases (public: see public-routes.ts).
    .use(desktopDownloadController)
    // Masters registered with global (FR-20.2): the Servers page under /org/:orgId/nodes, and the
    // master's own routes under /node/v1 behind their deny-by-default NodeAuth. 404 on a master.
    .use(nodeController)
    .use(nodeV1Controller)
    // FR-20.79 (P3-6a): moving an org to its master, under /org/:orgId/moves. 404 on a master.
    .use(moveController)
    .use(numberingController)
    // FR-20.98 (P3-8b): a master's own status page, under /org/:orgId/server. 404 on lgrai.app.
    .use(serverStatusController)
    .use(homeController)
    // The sys-admin Nodes page (P2-3a): every master, across orgs. BACKUP_SYS_ADMINS only.
    .use(adminNodesController)
    // FR-20.72 (P3-4a): an org's address on lgrai.app, and its approval.
    .use(addressController)
    .use(adminAddressesController)
    // FR-20.55 (P2-3b): this server's licence for an org (the banner; `{applies: false}` on global),
    // and the sys-admins' pilots and air-gapped licence files (global only).
    .use(licenceController)
    .use(adminLicencesController)
    // FR-20.39 (P2-4): "Sign in with LGR": lgrai.app's authorize side, and a master's sign-in side.
    .use(idpController)
    .use(idpSignInController),
    )
}
