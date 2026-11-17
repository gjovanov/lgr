import { describe, it, expect, afterAll } from 'bun:test'
import { setSession } from 'ui-shared/session/session'
import { setLiveAccess } from 'ui-shared/access/live-grant'
import { compileLegacy, type CapabilityId, type Grant } from 'config/access'
import { DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, ROLES, type Role } from 'config/constants'
import { internalOrderEmailAccess, mayEmailInternalOrders, mayEmailOrders, orderEmailAccess } from 'invoicing-api/src/lib/email-guards'
import { useDocEmailAccess } from '../../../invoicing-ui/src/composables/doc-email-access'

/**
 * The two order lists offer „Изпрати по имейл" by the server's own rule (2026-11-16).
 *
 * A list cannot import the invoicing API, so `invoicing-ui/composables/doc-email-access` names the capabilities
 * again. This file is what holds the two together: the same answer for a session of every role, and for a role's
 * grant in an org on roles, so the button is never offered to someone the two routes answer 403, nor withheld from
 * someone they serve.
 *
 * The customer orders are why it exists: their rule is the supplier orders' but for the read, and one copied from
 * the other would offer the button to a role the request refuses.
 */

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
}
const g = globalThis as any
const real = { window: g.window, document: g.document }
if (typeof g.window === 'undefined') {
  g.window = { sessionStorage: new MemoryStorage(), localStorage: new MemoryStorage(), addEventListener() {}, location: { pathname: '/' } }
  g.document ??= { addEventListener() {}, visibilityState: 'visible' }
}
afterAll(() => {
  setLiveAccess(null)
  setSession('', null)
  g.window = real.window
  g.document = real.document
})

const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`
const org = { id: 'o1', slug: 'o1', name: 'O1' } as any
/** A session of a role as its token is issued today: the role's default permissions, and its areas where it has them. */
const claimsOf = (role: Role) => ({
  id: `u-${role}`, orgId: 'o1', role, permissions: [...DEFAULT_ROLE_PERMISSIONS[role]],
  ...(DEFAULT_ROLE_AREAS[role] ? { areas: DEFAULT_ROLE_AREAS[role] } : {}),
  exp: 4102444800,
})
/** FR-27 P3-5: a session's grant is its role's, as the sign-in answers it (here: what those claims compile to). */
const liveOf = (claims: Parameters<typeof compileLegacy>[0]) => {
  const grant = compileLegacy(claims)
  return { all: !!grant.all, caps: grant.all ? [] : [...grant.caps], role: { id: 'r', name: 'R', version: 'r:1' } }
}
const list = useDocEmailAccess()
/** What the two routes answer a session of exactly this grant, for each kind of order. */
const served = (access: Grant) => {
  const user = { id: 'u1', role: 'member', permissions: [], access }
  return { supplier: mayEmailOrders(orderEmailAccess(user)), customer: mayEmailInternalOrders(internalOrderEmailAccess(user)) }
}
const offered = () => ({ supplier: list.orders(), customer: list.internalOrders() })

describe('an order list offers the mail by what the two routes are reached by', () => {
  it('a session of every role is offered it exactly when the server would not answer 403', () => {
    const customer: string[] = []
    for (const role of ROLES) {
      const claims = claimsOf(role)
      setSession(token(claims), org)
      setLiveAccess(liveOf(claims))
      expect({ role, ...offered() }).toEqual({
        role,
        supplier: mayEmailOrders(orderEmailAccess(claims)),
        customer: mayEmailInternalOrders(internalOrderEmailAccess(claims)),
      })
      if (list.internalOrders()) customer.push(role)
    }
    // Who mails a customer order today: the roles that work on orders and print.
    expect(customer.sort()).toEqual(['accountant', 'admin', 'manager', 'sales', 'sales_consultant'])
  })

  it('in an org on roles the role\'s grant decides, for each kind of order by its own read', () => {
    // The token alone would mail both (a manager); the role it was given decides.
    setSession(token({ ...claimsOf('manager'), rid: 'r1' }), org)
    const grants: Array<{ caps: CapabilityId[]; supplier: boolean; customer: boolean }> = [
      // Reads and prints, works on no order.
      { caps: ['orders.view', 'sales-docs.export'], supplier: false, customer: false },
      // Works on orders, may not print.
      { caps: ['orders.view', 'orders.create', 'orders.edit'], supplier: false, customer: false },
      // ⚠ The page-less reads reach a supplier order's sheet and no customer order's: the two lists differ here.
      { caps: ['orders.browse', 'orders.lookup', 'orders.edit', 'sales-docs.export'], supplier: true, customer: false },
      // Deleting is not the work that mails.
      { caps: ['orders.view', 'orders.delete', 'sales-docs.export'], supplier: false, customer: false },
      // The read, the export and either half of the work.
      { caps: ['orders.view', 'orders.create', 'sales-docs.export'], supplier: true, customer: true },
      { caps: ['orders.view', 'orders.edit', 'sales-docs.export'], supplier: true, customer: true },
    ]
    for (const [i, grant] of grants.entries()) {
      // An edit of the role is followed, with no sign-out: each grant is the same role, saved again.
      setLiveAccess({ all: false, caps: grant.caps, role: { id: 'r1', name: 'Orders', version: `r1:${i}` } })
      const want = { caps: grant.caps, supplier: grant.supplier, customer: grant.customer }
      expect({ caps: grant.caps, ...offered() }).toEqual(want)
      expect({ caps: grant.caps, ...served({ caps: new Set(grant.caps) }) }).toEqual(want)
    }
    setLiveAccess({ all: true, caps: [], role: { id: 'r1', name: 'Everything', version: 'r1:all' } })
    expect(offered()).toEqual({ supplier: true, customer: true })
    expect(served({ all: true })).toEqual({ supplier: true, customer: true })
    setLiveAccess(null)
  })

  it('nobody signed in is offered nothing', () => {
    setSession('', null)
    setLiveAccess(null)
    expect(offered()).toEqual({ supplier: false, customer: false })
    expect(mayEmailInternalOrders(internalOrderEmailAccess(null))).toBe(false)
  })
})
