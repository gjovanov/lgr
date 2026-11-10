/**
 * FR-27.1 — the catalogue: every feature a role can be given, and the actions it has (#529).
 *
 * A capability is `feature.action` (`movements.create:transfer`). Everything that decides who may do what is
 * generated from here: the server's route rules (`./routes.ts`), the pages (`./pages.ts`), the legacy compiler
 * (`./legacy.ts`) and, from Phase 1, the role editor and the built-in roles. `docs/fr/FR-27-one-access-model.md`
 * Appendix A is this file as a table, for the owner's review.
 *
 * Three actions every feature may have:
 *   - `view`: opens the feature's own page, and reads its records;
 *   - `browse`: opens that page for a role of another app (a warehouse role opens Orders to book a delivery);
 *   - `lookup`: reads the records without the page (a form searching products).
 * The rest are the feature's own verbs.
 *
 * ⚠ Phase 0 changes nobody's access: `access-differential.flow.test.ts` holds every route and page to today's
 * answer for every permission, role and area. Where an action exists only to say exactly what a legacy
 * permission opened, the comment says so; Phase 2 may merge it.
 *
 * Import-pure: the SPA bundles it.
 */

export const FEATURE_GROUPS = ['invoicing', 'inventory', 'accounting', 'payroll', 'reports', 'files', 'settings', 'helpers'] as const
export type FeatureGroup = (typeof FEATURE_GROUPS)[number]

const WORK = ['create', 'edit', 'delete'] as const

export const CATALOGUE = [
  // ── Invoicing ──
  // `totals`: the list's strip and `GET invoices/summary`; `import`: the list's Import button (#493 items 2, 5).
  { id: 'sales-docs', group: 'invoicing', actions: ['view', ...WORK, 'export', 'totals', 'import'] },
  { id: 'proforma', group: 'invoicing', actions: ['view', ...WORK] },
  { id: 'bills', group: 'invoicing', actions: ['view', ...WORK, 'totals'] },
  // `browse`: the inventory roles open Orders (READ_WITH_INVENTORY). `lookup`: a transfer-only session reads them.
  { id: 'orders', group: 'invoicing', actions: ['view', 'browse', 'lookup', ...WORK] },
  { id: 'payments', group: 'invoicing', actions: ['view', ...WORK] },
  // `browse`: the inventory roles open Contacts (suppliers). `lookup`: the till and a transfer-only session pick one.
  { id: 'contacts', group: 'invoicing', actions: ['view', 'browse', 'lookup', ...WORK] },
  // The journal of cash sales (`/invoicing/cash-sales`), read by the back office and the till alike.
  { id: 'cash-sales', group: 'invoicing', actions: ['view', 'storno', 'settle'] },
  // The terminal and its sessions.
  { id: 'till', group: 'invoicing', actions: ['view', 'sell', 'manage-sessions'] },
  { id: 'devices', group: 'invoicing', actions: ['view', 'edit', 'report', 'z-report', 'sync-time', 'name-payments'] },
  { id: 'sequences', group: 'invoicing', actions: ['view', 'edit'] },

  // ── Inventory ── `view` opens the page (`inventory.read`); `lookup` is what the other inventory permissions read.
  // `costs`: the cost figures, a field group (FR-27.6, D-5): `purchasePrice`, the buying-price slot, margins (`fields.ts`).
  { id: 'products', group: 'inventory', actions: ['view', 'lookup', ...WORK, 'export', 'costs'] },
  { id: 'categories', group: 'inventory', actions: ['view', 'lookup', ...WORK] },
  { id: 'warehouses', group: 'inventory', actions: ['view', 'lookup', ...WORK] },
  { id: 'movements', group: 'inventory', actions: ['view', 'lookup', ...WORK, 'create:transfer'] },
  { id: 'stock-levels', group: 'inventory', actions: ['view', 'lookup'] },
  { id: 'inventory-counts', group: 'inventory', actions: ['view', 'lookup', ...WORK] },
  { id: 'valuation', group: 'inventory', actions: ['view', 'lookup'] },
  { id: 'opening-stock', group: 'inventory', actions: ['view', 'lookup', ...WORK] },
  { id: 'price-lists', group: 'inventory', actions: ['view', 'lookup', ...WORK] },
  { id: 'bulk-pricing', group: 'inventory', actions: ['view', 'lookup', ...WORK] },

  // ── Accounting ── `view` opens the page (`accounting.read`); `lookup` is what write, post and file read.
  // `accounts.create` is the admin's and the accountant's (`account.controller`); the route takes `edit`.
  { id: 'accounts', group: 'accounting', actions: ['view', 'lookup', ...WORK] },
  { id: 'bank-accounts', group: 'accounting', actions: ['view', 'lookup', ...WORK] },
  { id: 'journal', group: 'accounting', actions: ['view', 'lookup', ...WORK, 'post'] },
  { id: 'ledgers', group: 'accounting', actions: ['view', 'lookup'] },
  { id: 'vat', group: 'accounting', actions: ['view', 'lookup', ...WORK, 'file'] },
  { id: 'accounting-setup', group: 'accounting', actions: ['view', 'lookup', ...WORK] },
  { id: 'exchange-rates', group: 'accounting', actions: ['view', 'lookup', ...WORK] },
  { id: 'reconciliation', group: 'accounting', actions: ['view', 'lookup', ...WORK] },
  { id: 'fixed-assets', group: 'accounting', actions: ['view', 'lookup', ...WORK] },
  { id: 'books-import', group: 'accounting', actions: ['run'] },

  // ── Payroll ──
  { id: 'payroll-runs', group: 'payroll', actions: ['view', 'lookup', ...WORK, 'approve'] },
  { id: 'payroll-people', group: 'payroll', actions: ['view', 'edit', 'reveal'] },
  { id: 'payroll-import', group: 'payroll', actions: ['run'] },

  // ── Reports, Files ──
  { id: 'reports', group: 'reports', actions: ['view', 'export'] },
  { id: 'supto', group: 'reports', actions: ['view', 'export'] },
  { id: 'files', group: 'files', actions: ['view', 'manage', 'archives'] },

  // ── Settings and people ──
  { id: 'dashboard', group: 'settings', actions: ['view', 'lookup'] },
  { id: 'org-settings', group: 'settings', actions: ['view', 'edit'] },
  { id: 'users', group: 'settings', actions: ['view', 'edit'] },
  { id: 'invites', group: 'settings', actions: ['manage'] },
  { id: 'roles', group: 'settings', actions: ['view', 'edit'] },
  { id: 'apps', group: 'settings', actions: ['manage'] },
  { id: 'digest', group: 'settings', actions: ['manage'] },
  { id: 'integrations', group: 'settings', actions: ['manage'] },
  { id: 'billing', group: 'settings', actions: ['manage'] },
  { id: 'desktops', group: 'settings', actions: ['view', 'manage'] },
  { id: 'servers', group: 'settings', actions: ['view', 'manage'] },
  { id: 'numbering', group: 'settings', actions: ['view', 'manage'] },
  // `view` opens the page (a portal page); `lookup` reads a filing's files, which no area holds.
  { id: 'audit-log', group: 'settings', actions: ['view', 'lookup'] },
  // The org menu's other orgs, invitations and New organization, and `/orgs` inside an org (#493 item 4).
  { id: 'org', group: 'settings', actions: ['switch'] },

  // ── Helpers: no row in the editor; what several forms share ──
  { id: 'pricing', group: 'helpers', actions: ['read'] },
  { id: 'stock-availability', group: 'helpers', actions: ['check', 'transfer'] },
  { id: 'doc-import', group: 'helpers', actions: ['read', 'extract'] },
  { id: 'tags', group: 'helpers', actions: ['edit'] },
] as const satisfies ReadonlyArray<{ id: string; group: FeatureGroup; actions: readonly string[] }>

type Entry = (typeof CATALOGUE)[number]
export type FeatureId = Entry['id']
type CapOf<E> = E extends { id: infer I extends string; actions: readonly (infer A extends string)[] } ? `${I}.${A}` : never
/** `feature.action`, for every action of every feature: a typo is a type error. */
export type CapabilityId = CapOf<Entry>

export const CAPABILITIES: ReadonlySet<string> = new Set(CATALOGUE.flatMap(f => f.actions.map(a => `${f.id}.${a}`)))

export function isCapability(id: string): id is CapabilityId {
  return CAPABILITIES.has(id)
}

/** Every capability of one feature. */
export function capsOf(feature: FeatureId): CapabilityId[] {
  const f = CATALOGUE.find(e => e.id === feature)
  return f ? (f.actions as readonly string[]).map(a => `${feature}.${a}` as CapabilityId) : []
}
