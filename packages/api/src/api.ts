import { Elysia } from 'elysia'
import { enterRequest, leaveRequest } from 'db/home/request-context'
import { isReadOnlyRoute, isListedReadWriter, routeKey } from 'services/biz/route-class'
import { requestVia } from './front/front-guard.js'
import { isStopping } from './front/graceful-stop.js'
import { mongoose } from 'db/connection'

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
import { documentLookupController } from './controllers/document-lookup.controller.js'
import { auditLogController } from './controllers/audit-log.controller.js'
import { roleController } from './controllers/role.controller.js'
import { dashboardController } from './controllers/dashboard.controller.js'
import { posPaymentMethodController } from './controllers/pos-payment-method.controller.js'

// Accounting controllers
import { accountController } from './accounting/controllers/account.controller.js'
import { journalController } from './accounting/controllers/journal.controller.js'
import { fiscalYearController } from './accounting/controllers/fiscal-year.controller.js'
import { fiscalPeriodController } from './accounting/controllers/fiscal-period.controller.js'
import { fixedAssetController } from './accounting/controllers/fixed-asset.controller.js'
import { bankAccountController } from './accounting/controllers/bank-account.controller.js'
import { analyticController } from './accounting/controllers/analytic.controller.js'
import { productGroupController } from './accounting/controllers/product-group.controller.js'
import { groupCostController } from './accounting/controllers/group-cost.controller.js'
import { reconciliationController } from './accounting/controllers/reconciliation.controller.js'
import { taxReturnController } from './accounting/controllers/tax-return.controller.js'
import { vatController } from './accounting/controllers/vat.controller.js'
import { exchangeRateController } from './accounting/controllers/exchange-rate.controller.js'
import { reportController } from './accounting/controllers/report.controller.js'
import { journalConfigController } from './accounting/controllers/journal-config.controller.js'
import { paymentTermController } from './accounting/controllers/payment-term.controller.js'
import { fiscalPositionController } from './accounting/controllers/fiscal-position.controller.js'
import { journalAnalysisController } from './accounting/controllers/journal-analysis.controller.js'
import { booksImportController, booksLedgerController } from './accounting/controllers/books-import.controller.js'

// Invoicing controllers
import { contactController } from './invoicing/controllers/contact.controller.js'
import { invoiceController } from './invoicing/controllers/invoice.controller.js'
import { numberClashController } from './invoicing/controllers/number-clash.controller.js'
import { orderController } from './invoicing/controllers/order.controller.js'
import { internalOrderController } from './invoicing/controllers/internal-order.controller.js'
import { reservationController } from './invoicing/controllers/reservation.controller.js'
import { productSupplyController } from './invoicing/controllers/product-supply.controller.js'
import { billImportController } from './invoicing/controllers/bill-import.controller.js'
import { receiptBillController } from './invoicing/controllers/receipt-bill.controller.js'
import { dispatchInvoiceController } from './invoicing/controllers/dispatch-invoice.controller.js'
import { docImportController } from './invoicing/controllers/doc-import.controller.js'
import { paymentOrderController } from './invoicing/controllers/payment-order.controller.js'
import { cashOrderController } from './invoicing/controllers/cash-order.controller.js'
import { contactLedgerController } from './invoicing/controllers/contact-ledger.controller.js'
import { stockAvailabilityController } from './invoicing/controllers/stock-availability.controller.js'
import { statsController } from './invoicing/controllers/stats.controller.js'
import { agingReportController } from './invoicing/controllers/aging-report.controller.js'
import { invoiceExportController } from './invoicing/controllers/invoice-export.controller.js'
import { docEmailController } from './invoicing/controllers/doc-email.controller.js'
import { sequenceConfigController } from './invoicing/controllers/sequence-config.controller.js'
import { posController } from './invoicing/controllers/pos.controller.js'
import { cashRegisterController } from './invoicing/controllers/cash-register.controller.js'

// Warehouse controllers
import { productController } from './warehouse/controllers/product.controller.js'
import { productSupplierController, productSupplierRecordController } from './warehouse/controllers/product-supplier.controller.js'
import { warehouseController } from './warehouse/controllers/warehouse.controller.js'
import { movementController } from './warehouse/controllers/movement.controller.js'
import { movementEmailController } from './warehouse/controllers/movement-email.controller.js'
import { openingStockController } from './warehouse/controllers/opening-stock.controller.js'
import { stockLevelController } from './warehouse/controllers/stock-level.controller.js'
import { inventoryCountController } from './warehouse/controllers/inventory-count.controller.js'
import { priceListController } from './warehouse/controllers/price-list.controller.js'
import { productLedgerController } from './warehouse/controllers/product-ledger.controller.js'
import { pricingController } from './warehouse/controllers/pricing.controller.js'
import { bulkPricingController } from './warehouse/controllers/bulk-pricing.controller.js'
import { costLayerController } from './warehouse/controllers/cost-layer.controller.js'
import { productCategoryController } from './warehouse/controllers/product-category.controller.js'
import { stockLocationController } from './warehouse/controllers/stock-location.controller.js'
import { operationTypeController } from './warehouse/controllers/operation-type.controller.js'
import { stockLotController } from './warehouse/controllers/stock-lot.controller.js'

// Payroll controllers
import { employeeController } from './payroll/controllers/employee.controller.js'
import { payrollRunController } from './payroll/controllers/run.controller.js'
import { payslipController } from './payroll/controllers/payslip.controller.js'
import { timesheetController } from './payroll/controllers/timesheet.controller.js'
import { payrollImportController } from './payroll/controllers/import.controller.js'
import { absenceController, contractController, leaveBalanceController } from './payroll/controllers/contract.controller.js'

// Reports controllers (FR-06 #14)
import { reportsController } from './reports/controllers/report.controller.js'
import { filesController } from './files/controllers/file.controller.js'

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
        via: requestVia(request),
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
        /**
         * FR-24.42: readiness, for the Kubernetes readiness probe. 503 while this pod stops (it must
         * get no new traffic) and while Mongo does not answer. Liveness stays a TCP check, and
         * `/health` stays as it is: desktops read it, and it must not fail on a slow database.
         */
        .get('/ready', async ({ set }) => {
          if (isStopping()) {
            set.status = 503
            return { ready: false, reason: 'stopping' }
          }
          if (!(await mongoAnswers())) {
            set.status = 503
            return { ready: false, reason: 'database' }
          }
          return { ready: true }
        })
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
        // FR-31.22: the top bar's jump to a document by its number, mounted with the tags as ONE plugin. Every `.use`
        // added to this chain is one more TS2589 (the chain is that deep); grouped, the two count as the one before.
        .use(new Elysia().use(tagController).use(documentLookupController))
        .use(auditLogController)
        .use(roleController)
        .use(dashboardController)

        // Accounting
        .use(accountController)
        .use(journalController)
        .use(fiscalYearController)
        .use(fiscalPeriodController)
        .use(fixedAssetController)
        .use(bankAccountController)
        // FR-25a §3.2: the books' analytic tree; FR-25 R3 slice 2: the review queue of the products' groups in it, and
        // the accountant's overrides of a group's average cost. One `.use` for the three: the chain is as long as the
        // type checker follows.
        .use(new Elysia().use(analyticController).use(productGroupController).use(groupCostController))
        .use(reconciliationController)
        .use(taxReturnController)
        .use(vatController)
        .use(exchangeRateController)
        .use(reportController)
        .use(journalConfigController)
        .use(paymentTermController)
        .use(fiscalPositionController)
        .use(journalAnalysisController)
        .use(booksImportController)
        .use(booksLedgerController)

        // Invoicing
        .use(contactController)
        .use(invoiceController)
        .use(numberClashController)
        .use(orderController)
        .use(internalOrderController)
        .use(reservationController)
        .use(productSupplyController)
        .use(billImportController)
        // FR-22.31/32 (#168): the supplier's bill for goods a receipt already booked.
        .use(receiptBillController)
        // FR-22.61/62 (#725): the customer's invoice for goods a stock note already delivered.
        .use(dispatchInvoiceController)
        .use(docImportController)
        .use(paymentOrderController)
        .use(cashOrderController)
        .use(contactLedgerController)
        .use(stockAvailabilityController)
        .use(statsController)
        .use(agingReportController)
        .use(invoiceExportController)
        .use(docEmailController)
        .use(sequenceConfigController)

        // Warehouse
        .use(productController)
        // FR-28: which suppliers an article was bought from, read from the documents.
        .use(productSupplierController)
        // FR-28.9: what a person records about an article's supplier (preferred, the supplier's code, lead time).
        .use(productSupplierRecordController)
        .use(warehouseController)
        .use(movementController)
        // The list's ticked movements by e-mail, each as its printed sheet.
        .use(movementEmailController)
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
        .use(contractController)
        .use(absenceController)
        .use(leaveBalanceController)
        .use(payrollImportController)

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

/** FR-24.42: Mongo answers a ping within 2 s. */
async function mongoAnswers(): Promise<boolean> {
  const db = mongoose.connection.db
  if (!db || mongoose.connection.readyState !== 1) return false
  try {
    await Promise.race([
      db.admin().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ])
    return true
  } catch {
    return false
  }
}
