import { describe, it, expect } from 'bun:test'
// Import-pure module (no db/models) — this file must never boot Mongoose,
// same reasoning as amount-in-words.test.ts.
import { canExport, canWrite } from 'invoicing-api/src/lib/export-access'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

const asUser = (role: string) => ({ role, permissions: DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] })

describe('invoicing export access gate', () => {
  // Regression: the gate used to accept only the legacy `trade.*` grants, so every non-admin
  // role — including nra_auditor, whose entire job is reading and exporting — got a 403.
  it('lets every role that can read invoices export them', () => {
    for (const role of ['admin', 'manager', 'accountant', 'member', 'nra_auditor']) {
      expect(canExport(asUser(role))).toBe(true)
    }
  })

  it('still accepts an unexpanded legacy trade.* token', () => {
    expect(canExport({ role: 'manager', permissions: ['trade.read'] })).toBe(true)
    expect(canWrite({ role: 'manager', permissions: ['trade.write'] })).toBe(true)
  })

  it('refuses a caller with no invoicing grant at all', () => {
    expect(canExport({ role: 'warehouse_manager', permissions: DEFAULT_ROLE_PERMISSIONS.warehouse_manager })).toBe(false)
    expect(canExport({ role: 'member', permissions: [] })).toBe(false)
    expect(canExport(null)).toBe(false)
  })

  it('keeps number-allocating prints behind a write grant', () => {
    expect(canWrite(asUser('nra_auditor'))).toBe(false)   // read-only inspector: reprint only
    expect(canWrite(asUser('member'))).toBe(false)
    expect(canWrite(asUser('manager'))).toBe(true)
    expect(canWrite(asUser('admin'))).toBe(true)
  })
})
