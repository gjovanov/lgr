import { describe, it, expect } from 'bun:test'
import { AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES } from 'config/constants'
import { can, compileLegacy, type CapabilityId } from 'config/access'

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
  { cap: 'files.archives', was: "role === 'nra_auditor' (admin through gate)", old: c => ['admin', 'nra_auditor'].includes(c.role) },
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
