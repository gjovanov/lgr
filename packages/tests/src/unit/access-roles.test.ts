import { describe, it, expect } from 'bun:test'
import { ROLES } from 'config/constants'
import { ROLE_TEMPLATES, can, grantOfRole, isLockedRole, legacyKeyOf, roleDisplay, sameGrant, templateGrant, unknownCaps } from 'config/access'

/**
 * FR-27.3 (#529) — the built-in roles grant today's access of their legacy role, and a stored role grants what it
 * says and nothing it does not.
 */

describe('the built-in templates', () => {
  it('one per legacy role, under the names people know', () => {
    expect(ROLE_TEMPLATES.map(t => t.key)).toEqual([...ROLES])
    expect(new Set(ROLE_TEMPLATES.map(t => t.name)).size).toBe(ROLES.length)
    // The system permission sets' names, which people knew (`ROLE_PERMISSION_SET_NAMES` until FR-27 P3-6).
    expect(Object.fromEntries(ROLE_TEMPLATES.map(t => [t.key, t.name]))).toMatchObject({
      admin: 'Administrator', manager: 'Manager', accountant: 'Accountant', warehouse_manager: 'Warehouse Manager',
      seller: 'Seller', sales_consultant: 'Sales Consultant', member: 'Member (Read Only)', nra_auditor: 'NRA Auditor (Read Only)',
    })
  })
  // What each grants against its legacy role's defaults: `unit/access-legacy-frozen.test.ts` (FR-27 P3-6).

  it('the NRA auditor reads, exports and reads the audit log, and works on nothing', () => {
    const g = templateGrant('nra_auditor') as { caps: Set<string> }
    expect(can(g, ['audit-log.view', 'reports.export', 'supto.view'])).toBe(true)
    expect([...g.caps].filter(c => /\.(create|edit|delete|post|sell|approve)$/.test(c))).toEqual([])
  })

  it('FR-25 §3.11: a member reads no payroll; the roles whose job it is do', () => {
    expect(can(templateGrant('member'), ['payroll-runs.view', 'payroll-people.view'])).toBe(false)
    expect(can(templateGrant('hr_manager'), 'payroll-people.view')).toBe(true)
  })

  it('the Administrator holds everything', () => {
    expect(templateGrant('admin').all).toBe(true)
    expect(grantOfRole({ all: true }).all).toBe(true)
  })

  it('#529: the Administrator and the NRA Auditor are locked, edited or not; every other role is not', () => {
    expect(isLockedRole({ all: true, isBuiltin: true, templateKey: 'admin' })).toBe(true)
    expect(isLockedRole({ isBuiltin: true, templateKey: 'nra_auditor' })).toBe(true)
    expect(isLockedRole({ isBuiltin: true, edited: true, templateKey: 'nra_auditor', caps: ['sales-docs.edit'] })).toBe(true)
    for (const t of ROLE_TEMPLATES.filter(t => !['admin', 'nra_auditor'].includes(t.key))) {
      expect(isLockedRole({ isBuiltin: true, templateKey: t.key })).toBe(false)
    }
    // A role an org made from the auditor's template is its own: not built-in, so not locked.
    expect(isLockedRole({ isBuiltin: false, caps: [...(templateGrant('nra_auditor') as { caps: Set<string> }).caps] })).toBe(false)
    expect(isLockedRole(null)).toBe(false)
  })
})

describe('a stored role', () => {
  it('built-in and never edited: its template, whatever caps it stored', () => {
    expect(sameGrant(grantOfRole({ isBuiltin: true, edited: false, templateKey: 'seller', caps: [] }), templateGrant('seller'))).toBe(true)
  })

  it('edited, or custom: what it was saved with', () => {
    const g = grantOfRole({ isBuiltin: true, edited: true, templateKey: 'seller', caps: ['products.view'] })
    expect(can(g, 'products.view')).toBe(true)
    expect(can(g, 'sales-docs.view')).toBe(false)
  })

  it('an id the catalogue does not know is no grant, and is listed (FR-27.8)', () => {
    const role = { caps: ['products.view', 'products.teleport'] }
    expect(can(grantOfRole(role), 'products.view')).toBe(true)
    expect(unknownCaps(role)).toEqual(['products.teleport'])
  })
})

describe("0015's key for an imported role", () => {
  it('legacyKeyOf: the same access, the same key, whatever the order', () => {
    expect(legacyKeyOf({ role: 'member', permissions: ['b', 'a'] })).toBe(legacyKeyOf({ role: 'member', permissions: ['a', 'b'] }))
    expect(legacyKeyOf({ role: 'member', permissions: [], areas: [] })).not.toBe(legacyKeyOf({ role: 'member', permissions: [] }))
  })
})

describe('how a role is named outside the roles screens (roleDisplay, #529 answer 4)', () => {
  it('a built-in role still carrying its template name: its key, which the SPA translates', () => {
    for (const t of ROLE_TEMPLATES) expect(roleDisplay({ isBuiltin: true, templateKey: t.key, name: t.name })).toBe(t.key)
    expect(roleDisplay({ isBuiltin: true, templateKey: 'seller' })).toBe('seller')
  })

  it('a built-in role the org renamed: its own name, as the Roles screen shows it', () => {
    expect(roleDisplay({ isBuiltin: true, templateKey: 'seller', name: 'Counter staff' })).toBe('Counter staff')
    expect(roleDisplay({ isBuiltin: true, templateKey: 'member', name: 'Member' })).toBe('Member')
  })

  it('a custom role: its name; none: empty', () => {
    expect(roleDisplay({ isBuiltin: false, name: 'Seller' })).toBe('Seller')
    expect(roleDisplay({ isBuiltin: false, templateKey: 'seller', name: 'Seller copy' })).toBe('Seller copy')
    expect(roleDisplay(null)).toBe('')
  })
})
