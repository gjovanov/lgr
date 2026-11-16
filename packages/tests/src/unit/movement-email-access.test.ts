import { describe, it, expect, afterAll } from 'bun:test'
import { setSession } from 'ui-shared/session/session'
import { setLiveAccess } from 'ui-shared/access/live-grant'
import { compileLegacy } from 'config/access'
import { DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, ROLES, type Role } from 'config/constants'
import { MOVEMENT_EMAIL_WORK, mayEmailMovements } from 'warehouse-api/src/lib/movement-email-guards'
import { MOVEMENT_EMAIL_CAPS, mailsMovements } from '../../../inventory-ui/src/composables/movement-email-access'

/**
 * The movements list offers „Изпрати по имейл" by the server's own rule (2026-11-16).
 *
 * The list cannot import the warehouse API, so it names the capabilities again
 * (`inventory-ui/composables/movement-email-access`). This file is what holds the two together: the same list, and
 * the same answer for a session of every role, so the button is never offered to someone the two routes answer 403,
 * nor withheld from someone they serve.
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

describe('the list asks what the two mail routes are reached by', () => {
  it('the same capabilities as the server\'s guard', () => {
    expect([...MOVEMENT_EMAIL_CAPS].sort()).toEqual([...MOVEMENT_EMAIL_WORK].sort())
  })

  it('a session of every role is offered the mail exactly when the server would not answer it 403', () => {
    const offered: string[] = []
    for (const role of ROLES) {
      const claims = claimsOf(role)
      setSession(token(claims), org)
      setLiveAccess(null)
      expect(mailsMovements(), role).toBe(mayEmailMovements(compileLegacy(claims)))
      if (mailsMovements()) offered.push(role)
    }
    // Who that is today: the roles that work on movements, and the two that write a Seller's transfers.
    expect(offered.sort()).toEqual(['admin', 'manager', 'sales_consultant', 'seller', 'warehouse_manager'])
  })

  it('in an org on roles the role\'s grant decides, and an edit of the role is followed', () => {
    // The token alone would mail (a warehouse manager); the role it was given only reads.
    setSession(token({ ...claimsOf('warehouse_manager'), rid: 'r1' }), org)
    setLiveAccess({ all: false, caps: ['movements.view', 'movements.lookup'], role: { id: 'r1', name: 'Reader', version: 'r1:1' } })
    expect(mailsMovements()).toBe(false)
    // The role is given a Seller's transfers: the button is offered, with no sign-out.
    setLiveAccess({ all: false, caps: ['movements.lookup', 'movements.create:transfer'], role: { id: 'r1', name: 'Seller', version: 'r1:2' } })
    expect(mailsMovements()).toBe(true)
    setLiveAccess({ all: true, caps: [], role: { id: 'r1', name: 'Everything', version: 'r1:3' } })
    expect(mailsMovements()).toBe(true)
    setLiveAccess(null)
  })

  it('nobody signed in is offered nothing', () => {
    setSession('', null)
    setLiveAccess(null)
    expect(mailsMovements()).toBe(false)
  })
})
