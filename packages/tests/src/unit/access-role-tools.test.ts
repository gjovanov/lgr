import { describe, it, expect } from 'bun:test'
import {
  ASKABLE_CAPABILITIES, CAPABILITIES, PAGE_ACCESS, compareGrants, pagesOpenedBy, templateGrant, whoCan, type CapabilityId, type Grant,
} from 'config/access'

/**
 * FR-27.9 (#529) — the role tools: "Who can…", "Compare" and the editor's preview, read off the same grants and page
 * rules the server and the menus decide by.
 */

const role = (name: string, grant: Grant) => ({ name, grant })
const ROLES = [
  role('Administrator', { all: true }),
  role('Seller', templateGrant('seller')),
  role('Sales consultant', templateGrant('sales_consultant')),
  role('Member', templateGrant('member')),
]

describe('Who can…', () => {
  it("asks about every capability the editor shows, and none of the helpers roles get through `withImplied`", () => {
    expect(ASKABLE_CAPABILITIES.length).toBeGreaterThan(50)
    expect(ASKABLE_CAPABILITIES.every(c => CAPABILITIES.has(c))).toBe(true)
    expect(ASKABLE_CAPABILITIES).toContain('sales-docs.create')
    expect(ASKABLE_CAPABILITIES).toContain('sales-docs.totals')
    expect(ASKABLE_CAPABILITIES).not.toContain('pricing.read' as CapabilityId)
    expect(new Set(ASKABLE_CAPABILITIES).size).toBe(ASKABLE_CAPABILITIES.length)
  })

  it('the roles holding it; the Administrator always', () => {
    const names = (cap: CapabilityId) => whoCan(ROLES, r => r.grant, cap).map(r => r.name)
    expect(names('sales-docs.create')).toEqual(['Administrator', 'Seller', 'Sales consultant'])
    expect(names('orders.view')).toEqual(['Administrator', 'Sales consultant', 'Member'])
    expect(names('roles.edit')).toEqual(['Administrator'])
  })
})

describe('Compare', () => {
  it('feature by feature, what one holds and the other does not', () => {
    const rows = compareGrants(templateGrant('seller'), templateGrant('sales_consultant'))
    const orders = rows.find(r => r.feature === 'orders')!
    expect(orders.differs).toBe(true)
    expect(orders.a).toBe('none')
    expect(orders.onlyA).toEqual([])
    expect(orders.onlyB.length).toBeGreaterThan(0)
    // What both hold is no difference.
    expect(rows.find(r => r.feature === 'sales-docs')!.differs).toBe(false)
  })

  it('a role against itself differs nowhere; against the Administrator, wherever it lacks something', () => {
    expect(compareGrants(templateGrant('member'), templateGrant('member')).filter(r => r.differs)).toEqual([])
    const vsAdmin = compareGrants(templateGrant('member'), { all: true })
    expect(vsAdmin.every(r => r.onlyA.length === 0)).toBe(true)
    expect(vsAdmin.find(r => r.feature === 'roles')!.b).toBe('full')
  })
})

describe('Preview as the role', () => {
  it('the pages its grant opens, by the page rules', () => {
    const member = pagesOpenedBy(templateGrant('member'))
    expect(member).toContain('/invoicing/invoices')
    expect(member).not.toContain('/invoicing/invoices/new')
    expect(member).not.toContain('/settings/roles')
    expect(pagesOpenedBy({ all: true })).toEqual(Object.keys(PAGE_ACCESS))
    expect(pagesOpenedBy({ caps: new Set() })).toEqual([])
  })
})
