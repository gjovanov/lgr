import { describe, it, expect } from 'bun:test'
import { AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, holdsArea } from 'config/constants'
import { DOC_KINDS, can, compileLegacy, partitionFilter, readsKind, writesKind, type CapabilityId } from 'config/access'
import { seesBills, seesOrders } from 'services/biz/access/partition'

/**
 * FR-27.2 (#529) — the controllers' own checks, moved onto `can()`, answer as the role and permission checks they
 * replace. One row per replaced check: the capability, and the old predicate written out as it was.
 *
 * Every role × no, each single and its default permissions × areas absent and `[]`. The old checks read the role
 * name or the permission list only; areas must not move them.
 */

interface Claims { role: string; permissions: string[]; areas?: string[] }

const has = (c: Claims, p: string) => c.role === 'admin' || c.permissions.includes(p)

const GATES: Array<{ cap: CapabilityId; was: string; old: (c: Claims) => boolean }> = [
  // fiscal-device.controller, pos.controller's device report: FISCAL_ADMIN_ROLES.
  { cap: 'devices.edit', was: "FISCAL_ADMIN_ROLES.includes(role)", old: c => ['admin', 'manager', 'warehouse_manager'].includes(c.role) },
  { cap: 'devices.report', was: "FISCAL_ADMIN_ROLES.includes(role)", old: c => ['admin', 'manager', 'warehouse_manager'].includes(c.role) },
  { cap: 'devices.z-report', was: "['admin', 'manager'].includes(role)", old: c => ['admin', 'manager'].includes(c.role) },
  { cap: 'devices.sync-time', was: "['admin', 'manager'].includes(role)", old: c => ['admin', 'manager'].includes(c.role) },
  { cap: 'devices.name-payments', was: "role === 'admin'", old: c => c.role === 'admin' },
  // cash-register.controller, pos.controller, counter-refund: STORNO_ROLES.
  { cap: 'cash-sales.storno', was: 'STORNO_ROLES.includes(role)', old: c => ['admin', 'manager'].includes(c.role) },
  { cap: 'cash-sales.settle', was: 'STORNO_ROLES.includes(role)', old: c => ['admin', 'manager'].includes(c.role) },
  // pos.controller: a session another cashier opened.
  { cap: 'till.manage-sessions', was: "role === 'admin' || role === 'manager'", old: c => ['admin', 'manager'].includes(c.role) },
  // sequence-config.controller.
  { cap: 'sequences.edit', was: "['admin', 'manager'].includes(role)", old: c => ['admin', 'manager'].includes(c.role) },
  // export-access.ts.
  { cap: 'sales-docs.export', was: 'canExport', old: c => has(c, 'invoicing.read') || has(c, 'invoicing.write') },
  { cap: 'sales-docs.edit', was: 'canWrite', old: c => has(c, 'invoicing.write') },
  // aging-report.controller, report.controller's reportsRefusal.
  { cap: 'reports.view', was: "role === 'admin' || reports.read", old: c => has(c, 'reports.read') },
  // movement.controller: a transfer-only session (FR-26.7) is one without this.
  { cap: 'movements.create', was: "role === 'admin' || inventory.write", old: c => has(c, 'inventory.write') },
  // account.controller.
  { cap: 'accounts.create', was: "['admin', 'accountant'].includes(role)", old: c => ['admin', 'accountant'].includes(c.role) },
  // the payroll controllers' holdsPersonal (FR-25 §3.11).
  { cap: 'payroll-people.view', was: 'holdsPersonal', old: c => has(c, 'payroll.personal') },
  // supto-export.controller.
  { cap: 'supto.export', was: "['admin', 'nra_auditor'].includes(role)", old: c => ['admin', 'nra_auditor'].includes(c.role) },
  // file.controller: gate, and readGate's auditor.
  { cap: 'files.view', was: "role === 'admin' || admin.settings", old: c => has(c, 'admin.settings') },
  // FR-27.7: the files gate's writes (`writeGate`).
  { cap: 'files.manage', was: "role === 'admin' || admin.settings", old: c => has(c, 'admin.settings') },
  { cap: 'files.archives', was: "role === 'nra_auditor' (admin through gate)", old: c => ['admin', 'nra_auditor'].includes(c.role) },
  // P0-5, the portal: the settings pages' controllers (admin, or admin.settings), the admin's own, and tag writes by type.
  { cap: 'desktops.manage', was: "role === 'admin' || admin.settings", old: c => has(c, 'admin.settings') },
  { cap: 'servers.manage', was: "role === 'admin' || admin.settings", old: c => has(c, 'admin.settings') },
  { cap: 'numbering.manage', was: "role === 'admin' || admin.settings", old: c => has(c, 'admin.settings') },
  { cap: 'roles.view', was: "role === 'admin' || admin.settings", old: c => has(c, 'admin.settings') },
  { cap: 'apps.manage', was: "role === 'admin'", old: c => c.role === 'admin' },
  { cap: 'digest.manage', was: "role === 'admin'", old: c => c.role === 'admin' },
  { cap: 'integrations.manage', was: "role === 'admin'", old: c => c.role === 'admin' },
  { cap: 'invites.manage', was: "role === 'admin'", old: c => c.role === 'admin' },
  { cap: 'org-settings.edit', was: "role === 'admin'", old: c => c.role === 'admin' },
  { cap: 'billing.manage', was: "role === 'admin'", old: c => c.role === 'admin' },
  { cap: 'users.edit', was: "role === 'admin'", old: c => c.role === 'admin' },
  { cap: 'roles.edit', was: "role === 'admin'", old: c => c.role === 'admin' },
  { cap: 'products.edit', was: "tag.controller: role === 'admin' || inventory.write", old: c => has(c, 'inventory.write') },
  { cap: 'warehouses.edit', was: "tag.controller: role === 'admin' || inventory.write", old: c => has(c, 'inventory.write') },
  { cap: 'contacts.edit', was: "tag.controller: role === 'admin' || invoicing.write", old: c => has(c, 'invoicing.write') },
  { cap: 'payroll-people.edit', was: "tag.controller: role === 'admin' || payroll.write", old: c => has(c, 'payroll.write') },
]

function shapes(): Claims[] {
  const out: Claims[] = []
  for (const role of ROLES) {
    for (const permissions of [[], ...PERMISSIONS.map(p => [p]), [...DEFAULT_ROLE_PERMISSIONS[role]]]) {
      out.push({ role, permissions: [...permissions] })
      out.push({ role, permissions: [...permissions], areas: [] })
    }
    out.push({ role, permissions: [...DEFAULT_ROLE_PERMISSIONS[role]], areas: [...AREAS] })
  }
  return out
}

describe('FR-27.2: a controller check on can() answers as the check it replaced', () => {
  for (const gate of GATES) {
    it(`${gate.cap} ≡ ${gate.was}`, () => {
      const differences = shapes()
        .filter(c => can(compileLegacy(c), gate.cap) !== gate.old(c))
        .map(c => `${c.role} [${c.permissions.join(',')}] areas=${c.areas ? `[${c.areas.join(',')}]` : 'absent'}`)
      expect(differences).toEqual([])
    })
  }
})

/** Every role × no, each single and its default permissions × areas absent, `[]`, each area alone, and all of them. */
function areaShapes(): Claims[] {
  const out: Claims[] = []
  for (const role of ROLES) {
    for (const permissions of [[], ...PERMISSIONS.map(p => [p]), [...DEFAULT_ROLE_PERMISSIONS[role]]]) {
      for (const areas of [undefined, [], ...AREAS.map(a => [a]), [...AREAS]]) out.push({ role, permissions: [...permissions], ...(areas ? { areas: [...areas] } : {}) })
    }
  }
  return out
}
const label = (c: Claims) => `${c.role} [${c.permissions.join(',')}] areas=${c.areas ? `[${c.areas.join(',')}]` : 'absent'}`

describe("FR-27.6: partitions answer as FR-26's areas did", () => {
  // The `invoices` route rules (config/access/routes.ts): only a session they let in reaches the controller.
  const READS_INVOICES: CapabilityId[] = ['sales-docs.view', 'proforma.view', 'bills.view']
  const WRITES_INVOICES: CapabilityId[] = ['sales-docs.create', 'sales-docs.edit', 'sales-docs.delete', 'proforma.create', 'proforma.edit', 'proforma.delete', 'bills.create', 'bills.edit', 'bills.delete']

  it("invoice.controller's reads: the kinds a session reads ≡ `holdsArea(user, 'purchases')`", () => {
    const differences = areaShapes()
      .filter(c => can(compileLegacy(c), READS_INVOICES))
      .filter(c => {
        const g = compileLegacy(c)
        const old = holdsArea(c, 'purchases') ? null : { direction: 'outgoing' }
        return readsKind(g, 'bills') !== holdsArea(c, 'purchases') || JSON.stringify(partitionFilter(g)) !== JSON.stringify(old)
      })
      .map(label)
    expect(differences).toEqual([])
  })

  it("invoice.controller's create: refused for a bill without purchases, and for nothing else", () => {
    const differences = areaShapes()
      .filter(c => can(compileLegacy(c), WRITES_INVOICES))
      .filter(c => {
        const g = compileLegacy(c)
        return DOC_KINDS.some(k => {
          const now = !(k === 'bills' && !readsKind(g, 'bills')) && writesKind(g, k, 'create')
          const was = !(k === 'bills' && !holdsArea(c, 'purchases'))
          return now !== was
        })
      })
      .map(label)
    expect(differences).toEqual([])
  })

  it("seesBills and seesOrders are the areas on the legacy model, for any session (a warehouse manager sees a receipt's bill)", () => {
    const differences = areaShapes()
      .filter(c => seesBills(c as any) !== holdsArea(c, 'purchases') || seesOrders(c as any) !== holdsArea(c, 'orders'))
      .map(label)
    expect(differences).toEqual([])
    expect(seesBills({ role: 'warehouse_manager', permissions: [...DEFAULT_ROLE_PERMISSIONS.warehouse_manager] } as any)).toBe(true)
    expect(can(compileLegacy({ role: 'warehouse_manager', permissions: [...DEFAULT_ROLE_PERMISSIONS.warehouse_manager] }), 'bills.view')).toBe(false)
  })

  it("and a role's capabilities on a role", () => {
    const access = { caps: new Set(['products.view']) }
    expect(seesBills({ role: 'member', permissions: [], access } as any)).toBe(false)
    expect(seesOrders({ role: 'member', permissions: [], access } as any)).toBe(false)
    const buyer = { caps: new Set(['bills.view', 'orders.lookup']) }
    expect(seesBills({ role: 'member', permissions: [], areas: [], access: buyer } as any)).toBe(true)
    expect(seesOrders({ role: 'member', permissions: [], areas: [], access: buyer } as any)).toBe(true)
  })
})
