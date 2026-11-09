import { describe, it, expect } from 'bun:test'
import { DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, ROLES, type Role } from 'config/constants'
import { can, compileLegacy, type CapabilityId } from 'config/access'

/**
 * #493 items 2, 4, 5 on the Phase 0 evaluator (FR-27 D-8): the totals strip and `GET invoices/summary`, the Import
 * button on the invoices list, and changing organization. Not for a session whose claim carries an `areas` list (the
 * Seller and the Sales Consultant, as a role or as a set); every other session keeps what it had.
 */

const ITEMS: CapabilityId[] = ['sales-docs.totals', 'sales-docs.import', 'org.switch']
const claims = (role: Role, areas?: string[]) => ({ role, permissions: [...DEFAULT_ROLE_PERMISSIONS[role]], ...(areas ? { areas } : {}) })

describe('#493 items 2, 4, 5', () => {
  it('a Seller and a Sales Consultant, by role or by their system set, have none of them', () => {
    for (const role of ['seller', 'sales_consultant'] as Role[]) {
      const grant = compileLegacy(claims(role, DEFAULT_ROLE_AREAS[role]))
      expect(ITEMS.filter(c => can(grant, c))).toEqual([])
      // A set carries the same list whatever the role it is given to.
      expect(ITEMS.filter(c => can(compileLegacy({ ...claims('member'), areas: DEFAULT_ROLE_AREAS[role] }), c))).toEqual([])
    }
  })

  it('every other role keeps them: the strip and Import where it writes sales documents, changing organization always', () => {
    for (const role of ROLES.filter(r => !DEFAULT_ROLE_AREAS[r])) {
      const grant = compileLegacy(claims(role))
      const perms = DEFAULT_ROLE_PERMISSIONS[role]
      const invoicing = role === 'admin' || perms.some(p => p.startsWith('invoicing.'))
      expect({ role, totals: can(grant, 'sales-docs.totals') }).toEqual({ role, totals: invoicing })
      expect({ role, import: can(grant, 'sales-docs.import') }).toEqual({ role, import: role === 'admin' || perms.includes('invoicing.write') })
      expect({ role, switch: can(grant, 'org.switch') }).toEqual({ role, switch: true })
    }
  })

  it('a session without an areas list keeps them, whatever else it holds', () => {
    expect(can(compileLegacy({ role: 'member', permissions: [] }), 'org.switch')).toBe(true)
    expect(can(compileLegacy({ role: 'member', permissions: [], areas: ['portal'] }), 'org.switch')).toBe(false)
  })
})
