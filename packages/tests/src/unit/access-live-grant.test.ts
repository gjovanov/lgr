import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { setSession } from 'ui-shared/session/session'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { grantOfViewer } from 'ui-shared/nav/page-registry'
import { accessGrant } from 'ui-shared/access/useAccess'
import { followAccessVersion, liveAccessVersion, liveGrant, setAccessRefetch, setLiveAccess, type LiveAccess } from 'ui-shared/access/live-grant'
import { can } from 'config/access'

/**
 * FR-27.5 (#529) — the SPA follows the session's role live: `/auth/me`'s `access` decides over the token's claims in
 * an org on `roles`, and a new `x-access-version` asks `/auth/me` again, once.
 */

// A tab: the session module keeps its token in the window's sessionStorage, read lazily on first use.
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

// Every unit file shares one process: leave no session, grant or window behind.
afterAll(() => {
  setLiveAccess(null)
  setSession('', null)
  g.window = real.window
  g.document = real.document
})

const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`
const seller = { id: 'u1', orgId: 'o1', role: 'seller', permissions: ['invoicing.read', 'invoicing.write'], exp: 4102444800 }
const role = (version: string, caps: string[]): LiveAccess => ({ all: false, caps, role: { id: 'r1', name: 'Counter', version } })
const tick = () => new Promise(r => setTimeout(r, 0))

let asked = 0
let answer: LiveAccess | null = null

beforeEach(() => {
  setSession(token(seller), { id: 'o1', slug: 'o1', name: 'O1' } as any)
  setLiveAccess(null)
  asked = 0
  setAccessRefetch(async () => { asked++; return answer })
})

describe('the live grant', () => {
  it('none: the claims decide, as before', () => {
    expect(liveGrant()).toBeNull()
    expect(sessionViewer()?.grant).toBeUndefined()
    expect(can(accessGrant(), 'sales-docs.view')).toBe(true)
  })

  it("held: it decides over the claims, for this tab's session and the views", () => {
    setLiveAccess(role('r1:1', ['products.view']))
    expect(can(accessGrant(), 'sales-docs.view')).toBe(false)
    expect(can(accessGrant(), 'products.view')).toBe(true)
    expect(can(grantOfViewer(sessionViewer()), 'products.view')).toBe(true)
    // Another viewer's claims are theirs.
    expect(can(grantOfViewer({ role: 'seller', permissions: ['invoicing.read'] }), 'sales-docs.view')).toBe(true)
  })

  it('an unknown capability is no grant; the Administrator is all', () => {
    setLiveAccess({ all: false, caps: ['products.view', 'products.teleport'], role: null })
    expect([...(liveGrant() as any).caps]).toEqual(['products.view'])
    setLiveAccess({ all: true, caps: [], role: null })
    expect(can(accessGrant(), 'roles.edit')).toBe(true)
  })

  it('belongs to one membership: a tab signed in elsewhere never reads it', () => {
    setLiveAccess(role('r1:1', ['products.view']))
    setSession(token({ ...seller, orgId: 'o2' }), { id: 'o2', slug: 'o2', name: 'O2' } as any)
    expect(liveGrant()).toBeNull()
    expect(can(accessGrant(), 'sales-docs.view')).toBe(true)
  })
})

describe('x-access-version', () => {
  it('the version held asks nothing; a new one asks /auth/me once, however many responses arrive', async () => {
    setLiveAccess(role('r1:1', ['products.view']))
    followAccessVersion('r1:1', true)
    expect(asked).toBe(0)
    answer = role('r1:2', ['products.view', 'sales-docs.view'])
    followAccessVersion('r1:2', true)
    followAccessVersion('r1:2', true)
    await tick()
    expect(asked).toBe(1)
    expect(liveAccessVersion()).toBe('r1:2')
    expect(can(accessGrant(), 'sales-docs.view')).toBe(true)
  })

  it('an org moving to roles mid-session: the first version seen is followed', async () => {
    answer = role('r1:1', ['products.view'])
    followAccessVersion('r1:1', true)
    await tick()
    expect(asked).toBe(1)
    expect(liveAccessVersion()).toBe('r1:1')
  })

  it('an org response with no version while a grant is held: the org left roles, and the claims decide again', async () => {
    setLiveAccess(role('r1:1', ['products.view']))
    answer = null
    followAccessVersion(undefined, false)
    expect(asked).toBe(0)
    followAccessVersion(undefined, true)
    await tick()
    expect(asked).toBe(1)
    expect(liveGrant()).toBeNull()
  })
})
