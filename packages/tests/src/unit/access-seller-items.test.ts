import { describe, it, expect } from 'bun:test'
import { ROLES, type Role } from 'config/constants'
import { can, templateGrant, type CapabilityId } from 'config/access'

/**
 * #493 items 2, 4, 5 on the evaluator (FR-27 D-8): the totals strip and `GET invoices/summary`, the Import button on
 * the invoices list, and changing organization. The built-in Seller and Sales Consultant hold none of them; every
 * other built-in role keeps what it had. (FR-27 P3-6: asked of the roles' grants; what an `areas` list took away is
 * `unit/access-legacy-frozen.test.ts`'s.)
 */

const ITEMS: CapabilityId[] = ['sales-docs.totals', 'sales-docs.import', 'org.switch']
const RESTRICTED: Role[] = ['seller', 'sales_consultant']

describe('#493 items 2, 4, 5', () => {
  it('a Seller and a Sales Consultant have none of them', () => {
    for (const role of RESTRICTED) expect({ role, held: ITEMS.filter(c => can(templateGrant(role), c)) }).toEqual({ role, held: [] })
  })

  it('every other role keeps them: the strip and Import where it writes sales documents, changing organization always', () => {
    const WRITES_SALES_DOCS = ['admin', 'manager', 'accountant', 'sales']
    const READS_SALES_DOCS = [...WRITES_SALES_DOCS, 'member', 'nra_auditor']
    for (const role of ROLES.filter(r => !RESTRICTED.includes(r))) {
      const grant = templateGrant(role)
      expect({ role, totals: can(grant, 'sales-docs.totals') }).toEqual({ role, totals: READS_SALES_DOCS.includes(role) })
      expect({ role, import: can(grant, 'sales-docs.import') }).toEqual({ role, import: WRITES_SALES_DOCS.includes(role) })
      expect({ role, switch: can(grant, 'org.switch') }).toEqual({ role, switch: true })
    }
  })
})
