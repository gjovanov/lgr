import type { CapabilityId } from './catalogue'
import { can, type Grant } from './grant'

/**
 * FR-27.2 — who opens each page: any one of these capabilities (#529).
 *
 * One row per `ui-shared/nav/page-registry.ts` row (PAGE_REGISTRY and the portal's own pages), keyed by its id.
 * `till`: a page of the till, all a PIN session reaches. `access-differential.flow.test.ts` holds each row to
 * today's `canOpenPage` for every permission, role and area, and fails on a registry row with no entry here.
 *
 * Import-pure.
 */
export interface PageAccess {
  readonly anyOf: readonly CapabilityId[]
  /**
   * And one of these too: what the page's own data needs where the app's capability does not give it (FR-27
   * acceptance 4: no page loads with a 403). The two invoicing pages that moved into Reports read invoices.
   */
  readonly alsoAnyOf?: readonly CapabilityId[]
  readonly till?: true
}

type Cap = CapabilityId
const p = (...anyOf: Cap[]): PageAccess => ({ anyOf })
const till = (...anyOf: Cap[]): PageAccess => ({ anyOf, till: true })

const SUPTO_TABLES = ['18.1', '18.2', '18.3', '18.4', '18.5', '18.6', '18.7', '18.8', '18.9']
const REPORT_PAGES = [
  'export', 'aging', 'sales-documents', 'purchase-documents', 'cash-register', 'contact-ledger', 'inventory-valuation',
  'stock-levels', 'stock-movements', 'product-ledger', 'warehouse-operations', 'sales-history', 'order-sheet',
  'accounting-trial-balance', 'accounting-analytic-balance', 'accounting-main-book', 'accounting-chronology',
  'accounting-documents', ...SUPTO_TABLES.map(t => `supto/${t}`),
]

export const PAGE_ACCESS: Readonly<Record<string, PageAccess>> = {
  // ── Invoicing ──
  '/invoicing/invoices': p('sales-docs.view'),
  '/invoicing/orders': p('orders.view', 'orders.browse'),
  '/invoicing/internal-orders': p('orders.view'),
  '/invoicing/reservations': p('orders.view'),
  '/invoicing/proforma': p('proforma.view'),
  // An offer is a quote, of the proforma kind (`partition.ts`): the proforma capabilities open it.
  '/invoicing/offer': p('proforma.view'),
  '/invoicing/bills': p('bills.view'),
  '/invoicing/cash-sales': till('cash-sales.view'),
  '/invoicing/payment-orders': p('payments.view'),
  '/invoicing/cash-orders': p('payments.view'),
  '/invoicing/contacts': p('contacts.view', 'contacts.browse'),
  '/invoicing/configuration/sequences': p('sequences.view'),
  // ── Inventory ──
  '/inventory/products': p('products.view'),
  '/inventory/categories': p('categories.view'),
  '/inventory/warehouses': p('warehouses.view'),
  '/inventory/stock-levels': p('stock-levels.view'),
  '/inventory/movements': p('movements.view'),
  '/inventory/inventory-counts': p('inventory-counts.view'),
  '/inventory/inventory-valuation': p('valuation.view'),
  '/inventory/opening-stock': p('opening-stock.view'),
  '/inventory/price-lists': p('price-lists.view'),
  '/inventory/bulk-pricing': p('bulk-pricing.view'),
  // ── New documents ──
  '/invoicing/invoices/new': p('sales-docs.create'),
  '/invoicing/invoices/new?type=credit_note': p('sales-docs.create'),
  '/invoicing/invoices/new?type=debit_note': p('sales-docs.create'),
  '/invoicing/proforma/new': p('proforma.create'),
  '/invoicing/offer/new': p('proforma.create'),
  '/invoicing/cash-sales/new': till('till.sell'),
  '/invoicing/bills/new': p('bills.create'),
  '/inventory/movements/new': p('movements.create', 'movements.create:transfer'),
  '/invoicing/internal-orders/new': p('orders.create'),
  '/invoicing/orders/new': p('orders.create'),
  '/invoicing/reservations/new': p('orders.create'),
  // ── Accounting ──
  '/accounting/accounts': p('accounts.view'),
  // FR-25a §3.2: the analytic tree reads with the chart (`accounting/analytics` in routes.ts).
  '/accounting/analytics': p('accounts.view'),
  '/accounting/journal-entries': p('journal.view'),
  '/accounting/general-ledger': p('ledgers.view'),
  '/accounting/financial-statements': p('ledgers.view'),
  '/accounting/tax-returns': p('vat.view'),
  '/accounting/journal-analysis': p('ledgers.view'),
  '/accounting/bank-accounts': p('bank-accounts.view'),
  '/accounting/reconciliation': p('reconciliation.view'),
  '/accounting/exchange-rates': p('exchange-rates.view'),
  '/accounting/fixed-assets': p('fixed-assets.view'),
  // ── The till ──
  '/invoicing/cash-register/sessions': till('till.view'),
  '/invoicing/configuration/devices': till('devices.view'),
  // ── Payroll ──
  '/payroll/employees': p('payroll-people.view'),
  '/payroll/runs': p('payroll-runs.view'),
  '/payroll/payslips': p('payroll-people.view'),
  '/payroll/timesheets': p('payroll-people.view'),
  // ── Reports ──
  ...Object.fromEntries(REPORT_PAGES.map(r => [`/reports/${r}`, p('reports.view')])),
  // FR-06 moved these two out of Invoicing: the aging reads `invoicing/reports/aging` (sales documents), the export
  // lists the invoices and exports them (`canExport`). Reports alone opened them, and their data answered 403.
  '/reports/aging': { anyOf: ['reports.view'], alsoAnyOf: ['sales-docs.view'] },
  '/reports/export': { anyOf: ['reports.view'], alsoAnyOf: ['sales-docs.export'] },
  // ── The portal's own pages ──
  '/dashboard': p('dashboard.view'),
  '/settings/organization': p('org-settings.view'),
  '/settings/users': p('users.view'),
  '/settings/permission-sets': p('roles.edit'),
  '/settings/roles': p('roles.edit'),
  '/settings/invites': p('invites.manage'),
  '/settings/desktops': p('desktops.view'),
  '/settings/servers': p('servers.view'),
  '/settings/server': p('servers.view'),
  '/settings/billing': p('billing.manage'),
  '/admin/audit-log': p('audit-log.view'),
}

/**
 * May a session with this grant open the page? A PIN session opens the till's pages only, whatever it holds, as
 * `canOpenPage` and the server's PIN scope say. A page with no entry is opened by nobody.
 */
export function canOpen(pageId: string, grant: Grant | null | undefined, amr?: readonly string[] | null): boolean {
  if (!grant) return false
  const page = PAGE_ACCESS[pageId]
  if (!page) return false
  if (amr?.includes('pin') && !page.till) return false
  return can(grant, page.anyOf) && (!page.alsoAnyOf || can(grant, page.alsoAnyOf))
}
