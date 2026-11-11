import { describe, it, expect } from 'bun:test'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { ROLE_TEMPLATES, can, isCapability, projectGrant, seesCosts, templateGrant, type CapabilityId, type Grant } from 'config/access'
import { REPORT_REGISTRY, reportById } from 'services/biz/report-registry'
import { canAccessReport, canExportReport } from 'services/biz/report-registry.types'

/**
 * FR-27 (#529): a report is the role's to read when it holds the capability of what the report shows. In an org on
 * `roles` that decides, not the projection's permissions, which may say less than the role; the legacy model keeps
 * the report's permission and role list, unchanged.
 *
 * NOTE: no `.rejects` / `.resolves` (Known Issues).
 */

const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })
const onRoles = (grant: Grant) => ({ ...(grant.all ? { role: 'admin', permissions: [] } : projectGrant(grant).legacy), access: grant })
const report = (id: string) => reportById(id)!

describe('every report names what it shows', () => {
  it('a capability the catalogue knows, on every entry', () => {
    expect(REPORT_REGISTRY.length).toBeGreaterThan(20)
    expect(REPORT_REGISTRY.filter(e => !isCapability(e.cap)).map(e => e.id)).toEqual([])
  })

  it('the documents by their kind, the books by theirs, SUPTO by its own', () => {
    expect(report('sales-documents').cap).toBe('sales-docs.view')
    expect(report('purchase-documents').cap).toBe('bills.view')
    expect(report('cash-register').cap).toBe('cash-sales.view')
    expect(report('accounting-trial-balance').cap).toBe('ledgers.view')
    expect(REPORT_REGISTRY.filter(e => e.category === 'fiscal').every(e => e.cap === 'supto.view')).toBe(true)
  })
})

describe('an org on roles: the role decides', () => {
  it('every built-in role reads exactly the reports whose capability it holds (and the costs, for a costs report)', () => {
    for (const t of ROLE_TEMPLATES) {
      const grant = templateGrant(t.key)
      const user = onRoles(grant)
      for (const e of REPORT_REGISTRY) {
        const want = can(grant, e.cap) && (e.fieldGroup !== 'costs' || seesCosts(grant))
        expect({ role: t.key, report: e.id, reads: canAccessReport(e, user) }).toEqual({ role: t.key, report: e.id, reads: want })
      }
    }
  })

  it('a role holding a capability its projection carries no permission for still reads the report', () => {
    const bookkeeper = { role: 'member', permissions: [] as string[], access: caps('ledgers.view') }
    expect(canAccessReport(report('accounting-trial-balance'), bookkeeper)).toBe(true)
    expect(canAccessReport(report('accounting-chronology'), bookkeeper)).toBe(false)
    // The same token without a role: its claims decide, and they carry no `accounting.read`.
    expect(canAccessReport(report('accounting-trial-balance'), { role: 'member', permissions: [] })).toBe(false)
  })

  it('a role without bills reads no purchase register, whatever its invoicing reads (FR-27.6)', () => {
    const counter = { role: 'member', permissions: ['invoicing.read'], access: caps('sales-docs.view', 'cash-sales.view') }
    expect(canAccessReport(report('sales-documents'), counter)).toBe(true)
    expect(canAccessReport(report('cash-register'), counter)).toBe(true)
    expect(canAccessReport(report('purchase-documents'), counter)).toBe(false)
  })

  it('SUPTO is `supto.view`, not a role name; the export is `reports.export` on top', () => {
    const fiscal = REPORT_REGISTRY.find(e => e.category === 'fiscal')!
    expect(canAccessReport(fiscal, { role: 'member', permissions: [], access: caps('supto.view') })).toBe(true)
    expect(canAccessReport(fiscal, { role: 'nra_auditor', permissions: [], access: caps('sales-docs.view') })).toBe(false)
    const reader = { role: 'member', permissions: [] as string[], access: caps('sales-docs.view') }
    expect(canExportReport(report('sales-documents'), reader)).toBe(false)
    expect(canExportReport(report('sales-documents'), { ...reader, access: caps('sales-docs.view', 'reports.export') })).toBe(true)
  })
})

describe('the legacy model: as before', () => {
  const legacy = (role: string) => ({ role, permissions: [...(DEFAULT_ROLE_PERMISSIONS as any)[role]] })

  it('the report permission and its role list decide', () => {
    expect(canAccessReport(report('accounting-trial-balance'), legacy('accountant'))).toBe(true)
    expect(canAccessReport(report('accounting-trial-balance'), legacy('warehouse_manager'))).toBe(false)
    const fiscal = REPORT_REGISTRY.find(e => e.category === 'fiscal')!
    expect(canAccessReport(fiscal, legacy('nra_auditor'))).toBe(true)
    expect(canAccessReport(fiscal, legacy('accountant'))).toBe(false)
    expect(canAccessReport(fiscal, { role: 'admin', permissions: [] })).toBe(true)
    // `invoicing.write` alone never read the invoicing reports: the exact permission, as ever.
    expect(canAccessReport(report('sales-documents'), { role: 'member', permissions: ['invoicing.write'] })).toBe(false)
  })
})
