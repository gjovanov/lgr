import type { CapabilityId, FeatureId } from './catalogue'

/**
 * FR-27.2 — what each org route needs, in capabilities (#529).
 *
 * The same three kinds as `services/biz/route-permission.ts`, which this replaces in Phase 0's last step:
 *   - `anyOf`: the caller must hold one of these capabilities;
 *   - `self`: the controller decides, and the reason says how (and, as the slices land, which capability);
 *   - `member`: any member of the org may.
 * A route resolves by its exact key first, then by the longest prefix. One with no rule is refused, and
 * `access-differential.flow.test.ts` fails on it, as `route-permission.flow` does today.
 *
 * Keys are the route after `/api/org/:orgId/`. Exact read keys are that path; exact write keys carry the method.
 *
 * ⚠ FR-26's areas are not here: an area is a set of capabilities the compiled grant lacks (`legacy.ts#AREA_OF`).
 * So a rule on an area route names only that area's capabilities, or the carve-out would leak.
 *
 * Import-pure.
 */

export type AccessRule =
  | { readonly anyOf: readonly CapabilityId[] }
  | { readonly self: string }
  | { readonly member: string }

type Cap = CapabilityId
const any = (...caps: Cap[]): AccessRule => ({ anyOf: caps })
const self = (why: string): AccessRule => ({ self: why })
const member = (why: string): AccessRule => ({ member: why })
/** A feature's reads: its page's capability and its page-less one. */
const reads = (f: FeatureId, ...also: Cap[]): AccessRule => any(`${f}.view` as Cap, `${f}.lookup` as Cap, ...also)
/** A feature's writes: any of its work actions. */
const writes = (f: FeatureId, ...also: Cap[]): AccessRule => any(`${f}.create` as Cap, `${f}.edit` as Cap, `${f}.delete` as Cap, ...also)

const ADMIN = 'the admin role'
const ADMIN_OR_SETTINGS = 'the admin role, or admin.settings'

export const READ_PREFIXES: ReadonlyArray<readonly [string, AccessRule]> = [
  ['', member('the org itself, as the app shell shows it (integration tokens are never serialised)')],

  // The invoicing app picks an account and a bank account for cash and payment orders.
  ['accounting/account', reads('accounts', 'sales-docs.view')],
  ['accounting/bank-account', reads('bank-accounts', 'sales-docs.view')],
  ['accounting/books', reads('ledgers')],
  ['accounting/report', reads('ledgers')],
  ['accounting/reports', reads('ledgers')],
  ['accounting/exchange-rate', reads('exchange-rates')],
  ['accounting/fiscal-year', reads('accounting-setup')],
  ['accounting/fiscal-period', reads('accounting-setup')],
  ['accounting/fiscal-positions', reads('accounting-setup')],
  ['accounting/payment-terms', reads('accounting-setup')],
  ['accounting/fixed-asset', reads('fixed-assets')],
  ['accounting/journal', reads('journal')],
  ['accounting/journals', reads('journal')],
  ['accounting/reconciliation', reads('reconciliation')],
  ['accounting/tax-return', reads('vat')],
  ['accounting/vat', reads('vat')],
  ['accounting', reads('ledgers')],

  // FR-25 §3.11: about one person each.
  ['payroll/employee', any('payroll-people.view')],
  ['payroll/payslip', any('payroll-people.view')],
  ['payroll/timesheet', any('payroll-people.view')],
  ['payroll/contract', any('payroll-people.view')],
  ['payroll/absence', any('payroll-people.view')],
  ['payroll/leave-balance', any('payroll-people.view')],
  ['payroll', reads('payroll-runs')],

  // The supplier picker in inventory, the contact pickers of the reports, a POS customer.
  ['invoicing/contact', any('contacts.view', 'contacts.browse', 'contacts.lookup')],
  // The import dialog (also opened from inventory's movements) offers an ORDO to book against.
  ['invoicing/orders', any('orders.view', 'orders.browse', 'orders.lookup')],
  ['invoicing/internal-orders', any('orders.view')],
  ['invoicing/reservations', any('orders.view')],
  ['invoicing/bills', any('bills.view')],
  ['invoicing/payment-order', any('payments.view')],
  ['invoicing/cash-order', any('payments.view')],
  // #203: a product's stock, holds and incoming goods, on the inventory app's product page.
  ['invoicing/product-supply', reads('products', 'sales-docs.view')],
  ['invoicing/export', self('canExport')],
  ['invoicing/sequences', self('admin or manager: the sequence configuration')],
  ['invoicing', any('sales-docs.view')],
  // FR-27.6: one collection, three kinds (`partition.ts`); the controller holds each document to its own.
  ['invoices', any('sales-docs.view', 'proforma.view', 'bills.view')],

  // The invoice form, the cash-sale terminal, the POS terminal and the report pickers.
  ['warehouse/product-category', reads('categories', 'sales-docs.view', 'till.view')],
  ['warehouse/product-ledger', reads('products', 'sales-docs.view')],
  ['warehouse/product', reads('products', 'sales-docs.view', 'till.view')],
  ['warehouse/warehouse', reads('warehouses', 'sales-docs.view', 'till.view')],
  ['warehouse/locations', reads('warehouses')],
  ['warehouse/lots', reads('warehouses')],
  ['warehouse/operation-types', reads('warehouses')],
  // A contact's stock movements, opened from the invoicing app.
  ['warehouse/movement', reads('movements', 'sales-docs.view')],
  // The product page and the transfer form read the levels too: only the page is stock control's.
  ['warehouse/stock-level', any('stock-levels.lookup')],
  ['warehouse/cost-layer/valuation', reads('valuation')],
  ['warehouse/cost-layer', reads('products')],
  ['warehouse/inventory-count', reads('inventory-counts')],
  ['warehouse/opening-stock', reads('opening-stock')],
  ['warehouse/price-list', reads('price-lists')],
  ['warehouse/bulk-pricing', reads('bulk-pricing')],
  ['warehouse', reads('products')],

  // The cash-sale terminal in the invoicing app sells from the POS catalog.
  ['trade/pos/catalog', any('till.view', 'sales-docs.view')],
  // FR-21.12: the cash-register journal, invoicing's /cash-sales, is the till's own journal too.
  ['cash-register', any('cash-sales.view')],
  ['trade/pos', any('till.view')],
  ['pos', any('till.view')],
  ['pricing', any('pricing.read')],

  ['stats/product', reads('products', 'sales-docs.view')],
  ['stats', any('sales-docs.view')],
  ['dashboard', any('dashboard.view', 'dashboard.lookup')],
  ['doc-import', any('doc-import.read')],

  ['audit-logs', self('auditReadScope: the whole trail needs admin.audit; anyone else reads the history of one record, of a module they read')],
  ['reports', self('canAccessReport: the catalog lists only what the caller may run')],
  ['supto', self('admin or nra_auditor')],
  ['fiscal', member('device names and states, for the tills; connection details only for FISCAL_ADMIN_ROLES (sanitizeDevice)')],
  ['file', any('files.view')],
  ['files', self('files-api: admin, or admin.settings; the archives also for nra_auditor; the diff of a snapshot also takes what reading stock takes (compareRefusal)')],
  ['digest', self('admin role (FR-11): admin.settings deliberately does not suffice')],
  ['backup', self('requireSysAdmin')],
  ['desktops', self(ADMIN_OR_SETTINGS)],
  ['nodes', self(`${ADMIN_OR_SETTINGS} (FR-20.2; global only, 404 on a master)`)],
  ['moves', self(`${ADMIN_OR_SETTINGS} (FR-20.79; global only, 404 on a master)`)],
  ['address', self(`${ADMIN_OR_SETTINGS} (FR-20.72; global only, 404 on a master)`)],
  ['numbering', self(`${ADMIN_OR_SETTINGS} (FR-20.51)`)],
  ['server', self(`${ADMIN_OR_SETTINGS} (FR-20.98); \`here\` tells any member only whether to show it`)],
  ['integration', self(ADMIN)],
  ['invite', self(ADMIN)],
  ['permission-sets', self(ADMIN_OR_SETTINGS)],
  ['roles', self('roles.view (FR-27.4, role.controller)')],

  ['apps', member('the app hub, filtered by what the caller may open')],
  ['licence', member("this server's licence for the org, for the banner and the till (FR-20.55)")],
  ['home', member('where the org lives and whether it is written here, for the read-only banner (FR-20.75)')],
  ['notification', member("the caller's own notifications only (filtered on userId)")],
  ['tags', member('the tag vocabulary products and contacts share')],
  ['logo', member("the org's logo in the app shell")],
  ['user', member("colleagues' names and roles, for pickers and assignments; credentials are projected out (FR-11.3)")],
]

export const EXACT_READS: ReadonlyMap<string, AccessRule> = new Map([
  // A contact's amounts due and paid: the invoicing app's, not the pickers'.
  ['invoicing/contact/:id/summary', any('contacts.view')],
  ['trade/pos/session/:id/device-report', self('FISCAL_ADMIN_ROLES: admin, manager, warehouse_manager')],
  // A filing's files name a person: they go to who files them and who audits them (FR-25 D10).
  ['accounting/vat/:period/file/:name', any('vat.file', 'audit-log.lookup')],
])

export const WRITE_PREFIXES: ReadonlyArray<readonly [string, AccessRule]> = [
  // A new account is the admin's or the accountant's: the controller asks for `accounts.create` on top.
  ['accounting/account', any('accounts.edit', 'accounts.delete')],
  ['accounting/bank-account', writes('bank-accounts')],
  ['accounting/exchange-rate', writes('exchange-rates')],
  ['accounting/fiscal-year', writes('accounting-setup')],
  ['accounting/fiscal-period', writes('accounting-setup')],
  ['accounting/fiscal-positions', writes('accounting-setup')],
  ['accounting/payment-terms', writes('accounting-setup')],
  ['accounting/fixed-asset', writes('fixed-assets')],
  ['accounting/journal', writes('journal')],
  ['accounting/journals', writes('journal')],
  ['accounting/reconciliation', writes('reconciliation')],
  ['accounting/tax-return', writes('vat')],
  ['accounting', writes('accounting-setup')],

  ['invoices', writes('sales-docs', 'proforma.create', 'proforma.edit', 'proforma.delete', 'bills.create', 'bills.edit', 'bills.delete')],
  ['invoicing/orders', writes('orders')],
  ['invoicing/internal-orders', writes('orders')],
  ['invoicing/reservations', writes('orders')],
  ['invoicing/bills', writes('bills')],
  ['bills/import', writes('bills')],
  ['invoicing/payment-order', writes('payments')],
  ['invoicing/cash-order', writes('payments')],
  ['invoicing/contact', writes('contacts')],
  // The invoice form moves stock between warehouses before it sells.
  ['invoicing/stock-availability', any('stock-availability.transfer')],
  // The controller holds it to admin and manager (`sequences.edit`).
  ['invoicing/sequences', any('sales-docs.edit')],
  ['invoicing', writes('sales-docs')],

  // FR-26.7: a transfer-only session writes movements too. The controller holds it to transfers.
  ['warehouse/movement', writes('movements', 'movements.create:transfer')],
  ['warehouse/product-category', writes('categories')],
  ['warehouse/product', writes('products')],
  ['warehouse/cost-layer', writes('products')],
  ['warehouse/warehouse', writes('warehouses')],
  ['warehouse/locations', writes('warehouses')],
  ['warehouse/lots', writes('warehouses')],
  ['warehouse/operation-types', writes('warehouses')],
  ['warehouse/inventory-count', writes('inventory-counts')],
  ['warehouse/opening-stock', writes('opening-stock')],
  ['warehouse/price-list', writes('price-lists')],
  ['warehouse/bulk-pricing', writes('bulk-pricing')],
  ['warehouse', writes('products')],

  ['payroll/employee', any('payroll-people.edit')],
  ['payroll/payslip', any('payroll-people.edit')],
  ['payroll/timesheet', any('payroll-people.edit')],
  ['payroll/contract', any('payroll-people.edit')],
  ['payroll/absence', any('payroll-people.edit')],
  ['payroll/leave-balance', any('payroll-people.edit')],
  ['payroll', writes('payroll-runs')],

  ['trade/pos', any('till.sell')],
  ['pos', any('till.sell')],

  ['files', self('files-api: admin, or admin.settings; booking, undoing, reconciling or analysing a document also takes the write permission of what it books (booksRefusal)')],
  ['fiscal', self('FISCAL_ADMIN_ROLES: admin, manager, warehouse_manager')],
  ['user', self('admin role (S-21)')],
  ['invite', self(ADMIN)],
  ['permission-sets', self(ADMIN)],
  ['roles', self('roles.edit, and FR-27.8 in role.service')],
  ['apps', self(ADMIN)],
  ['digest', self(ADMIN)],
  ['backup', self('requireSysAdmin')],
  ['desktops', self(ADMIN_OR_SETTINGS)],
  ['nodes', self(`${ADMIN_OR_SETTINGS} (FR-20.2; global only, 404 on a master)`)],
  ['moves', self(`${ADMIN_OR_SETTINGS} (FR-20.79; global only, 404 on a master)`)],
  ['address', self(`${ADMIN_OR_SETTINGS} (FR-20.72; global only, 404 on a master)`)],
  ['server', self(`${ADMIN_OR_SETTINGS} (FR-20.47; on the server only, 404 on lgrai.app)`)],
  ['numbering', self(`${ADMIN_OR_SETTINGS} (FR-20.51; every node)`)],
  ['integration', self(ADMIN)],
  ['logo', self(ADMIN)],
]

export const EXACT_WRITES: ReadonlyMap<string, AccessRule> = new Map([
  ['POST accounting/journal/:id/post', any('journal.post')],
  ['POST accounting/journal/:id/void', any('journal.post')],
  // FR-25 R2: LGR produces the files and records who filed them.
  ['POST accounting/vat/:period/generate', any('vat.file')],
  ['POST accounting/vat/:period/mark-filed', any('vat.file')],
  ['POST accounting/import/chart', any('books-import.run')],
  ['POST accounting/import/analytics', any('books-import.run')],
  ['POST accounting/import/opening', any('books-import.run')],
  ['POST accounting/import/journal', any('books-import.run')],
  ['POST accounting/import/finish', any('books-import.run')],
  ['POST payroll/run/:id/approve', any('payroll-runs.approve')],
  // FR-25 §3.12: reading a value out of the sealed record, audit-logged by the route.
  ['POST payroll/employee/:id/reveal', any('payroll-people.reveal')],
  ['POST payroll/run/:id/reveal', any('payroll-people.reveal')],
  ['POST payroll/run/:id/declaration', any('payroll-people.reveal')],
  ['POST payroll/contract/:id/reveal', any('payroll-people.reveal')],
  ['POST payroll/absence/:id/reveal', any('payroll-people.reveal')],
  ['POST payroll/payslip/:id/reveal', any('payroll-people.reveal')],
  // FR-25 §5.1: the controller also asks for the people.
  ['POST payroll/import/employees', any('payroll-import.run')],
  ['POST payroll/import/contracts', any('payroll-import.run')],
  ['POST payroll/import/months', any('payroll-import.run')],

  // Reads sent as POSTs, and writes that decide for themselves.
  ['POST reports/:id/run', self("canAccessReport: the report's own permission and roles; 404 for a report the caller may not see")],
  ['POST reports/:id/export', self('canExportReport, on top of canAccessReport')],
  ['POST invoicing/export/list', self('canExport')],
  ['POST invoicing/export/kind/:kind', self('canExport')],
  ['POST invoicing/export/:id/email', self('canWrite, and outgoing issued documents only')],
  ['POST invoicing/stock-availability/check', any('stock-availability.check')],
  // FR-21.18, FR-23: the journal's storno and its settle. The route also requires a storno role.
  ['POST cash-register/documents/:id/storno', any('till.sell', 'sales-docs.edit')],
  ['POST cash-register/documents/:id/settle', any('till.sell', 'sales-docs.edit')],
  ['POST trade/pos/session/:id/device-report', self('FISCAL_ADMIN_ROLES: admin, manager, warehouse_manager')],
  ['POST doc-import/extract', any('doc-import.extract')],
  ['POST doc-import/analyze', self('PERMISSION_BY_TARGET: the write permission of the surface imported into')],
  ['POST doc-import/commit', self('PERMISSION_BY_TARGET: the write permission of the surface imported into')],
  ['POST doc-import/convert', self('PERMISSION_BY_TARGET: the write permission of the surface imported into')],

  // FR-28.9: what a person records about an article's supplier is editing the article. `warehouse/product` would
  // let a role that may only create articles do it.
  ['PUT warehouse/product/:id/suppliers/:supplierId', any('products.edit')],
  ['DELETE warehouse/product/:id/suppliers/:supplierId', any('products.edit')],

  // Shared vocabulary on products and contacts.
  ['POST tags', any('tags.edit')],
  ['PUT tags/:id', any('tags.edit')],
  ['DELETE tags/:id', any('tags.edit')],

  // What every member does for themselves.
  ['POST audit-logs', member('a note on a record, attributed to its author; the controller accepts action `note` and nothing else')],
  ['PUT notification/:id/read', member("the caller's own notifications only (filtered on userId)")],
  ['PUT notification/read-all', member("the caller's own notifications only (filtered on userId)")],
  ['POST file', member("records the metadata of an upload; the row is the caller's own org's")],
  // No UI removes a File row; it is housekeeping, and the row is evidence of what was uploaded.
  ['DELETE file/:id', any('files.manage')],

  // The org itself.
  ['PUT ', self('admin role (org.controller)')],
])

const byLength = (rules: ReadonlyArray<readonly [string, AccessRule]>) => [...rules].sort((a, b) => b[0].length - a[0].length)
const READS_BY_LENGTH = byLength(READ_PREFIXES)
const WRITES_BY_LENGTH = byLength(WRITE_PREFIXES)

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function byPrefix(rest: string, rules: ReadonlyArray<readonly [string, AccessRule]>): AccessRule | undefined {
  for (const [prefix, rule] of rules) {
    if (prefix === '' ? rest === '' : rest === prefix || rest.startsWith(`${prefix}/`)) return rule
  }
  return undefined
}

/** The rule for a route, `rest` being the part after `/api/org/:orgId/`; undefined when there is none. */
export function accessRuleFor(method: string, rest: string): AccessRule | undefined {
  const m = method.toUpperCase()
  if (READ_METHODS.has(m)) return EXACT_READS.get(rest) ?? byPrefix(rest, READS_BY_LENGTH)
  return EXACT_WRITES.get(`${m} ${rest}`) ?? byPrefix(rest, WRITES_BY_LENGTH)
}
