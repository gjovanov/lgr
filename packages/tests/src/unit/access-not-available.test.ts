import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { setSession } from 'ui-shared/session/session'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { landingWithoutPortal, pageAt, startPage } from 'ui-shared/nav/page-registry'
import { accessSettled, liveLanding, setAccessRefetch, setLiveAccess, settleAccess, type LiveAccess } from 'ui-shared/access/live-grant'
import { pageAccessState, searchOf } from 'ui-shared/access/page-access'

/**
 * FR-27.7 (#529) — "Not available for your role": a layout shows it instead of a page the session's role does not
 * open (the same rule as the menus, `canOpenPage`), and waits rather than says no while an org on `roles` has not
 * told the tab its live grant. FR-27.4 — a role's landing page: where its people start, and where the page sends them.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
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

// Every unit file shares one process: leave no session, grant or window behind.
afterAll(() => {
  setLiveAccess(null)
  setSession('', null)
  g.window = real.window
  g.document = real.document
})

const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`
const org = { id: 'o1', slug: 'o1', name: 'O1' } as any
// An invoicing clerk on the legacy model: invoices, no Settings.
const clerk = { id: 'u1', orgId: 'o1', role: 'member', permissions: ['invoicing.read', 'invoicing.write'], exp: 4102444800 }
const tick = () => new Promise(r => setTimeout(r, 0))
let n = 0
/** A person in an org on `roles` (`rid`), new to this tab: `/auth/me` has not answered for them yet. */
function rolesSession(extra: Record<string, unknown> = {}) {
  setSession(token({ ...clerk, id: `r${++n}`, rid: 'role1', ...extra }), org)
}
const live = (caps: string[], landing: string | null = null): LiveAccess => ({ all: false, caps, role: { id: 'role1', name: 'Counter', version: 'role1:1' }, landing })

let answer: LiveAccess | null = null
let asked = 0
beforeEach(() => {
  answer = null
  asked = 0
  setAccessRefetch(async () => { asked++; return answer })
})

describe('pageAt: the page a route shows', () => {
  it("a module's page at its own path; a form's variant needs its query", () => {
    expect(pageAt('/invoicing/invoices')?.id).toBe('/invoicing/invoices')
    expect(pageAt('/invoicing/invoices/')?.id).toBe('/invoicing/invoices')
    expect(pageAt('/invoicing/invoices/new', '?type=credit_note')?.id).toBe('/invoicing/invoices/new?type=credit_note')
    expect(pageAt('/invoicing/invoices/new')?.id).toBe('/invoicing/invoices/new')
  })

  it("a module's record route is none: other apps link to records their people read by lookup", () => {
    expect(pageAt('/invoicing/invoices/0123/edit')).toBeNull()
    expect(pageAt('/inventory/products/0123/edit')).toBeNull()
    expect(pageAt('/inventory/movements/0123')).toBeNull()
  })

  it("the portal's Settings and Admin pages, at a / boundary; never the Dashboard, the account or the org list", () => {
    expect(pageAt('/settings/roles/abc')?.id).toBe('/settings/roles')
    expect(pageAt('/settings/servers')?.id).toBe('/settings/servers')
    expect(pageAt('/settings/server')?.id).toBe('/settings/server')
    expect(pageAt('/dashboard')).toBeNull()
    expect(pageAt('/account')).toBeNull()
    expect(pageAt('/orgs')).toBeNull()
  })

  it('a query, as the route has it', () => {
    expect(searchOf({})).toBe('')
    expect(searchOf({ type: 'credit_note' })).toBe('?type=credit_note')
    expect(searchOf({ a: ['1', '2'], b: null })).toBe('?a=1&a=2')
  })
})

describe('FR-27.7: the legacy model, the claims decide at once', () => {
  beforeEach(() => {
    setSession(token(clerk), org)
    setLiveAccess(null)
  })

  it('a page the menus offer opens; one they do not is not available, with no question asked', () => {
    expect(accessSettled()).toBe(true)
    expect(pageAccessState('/invoicing/invoices', '').state).toBe('open')
    expect(pageAccessState('/invoicing/invoices/new', '').state).toBe('open')
    const blocked = pageAccessState('/settings/roles', '')
    expect(blocked.state).toBe('blocked')
    expect(blocked.page?.id).toBe('/settings/roles')
    expect(pageAccessState('/payroll/employees', '').state).toBe('blocked')
    expect(asked).toBe(0)
  })

  it('a route no page rule covers shows, as before: the server decides', () => {
    expect(pageAccessState('/dashboard', '').state).toBe('open')
    expect(pageAccessState('/account', '').state).toBe('open')
    expect(pageAccessState('/inventory/products/0123/edit', '').state).toBe('open')
  })
})

describe('FR-27.7: an org on roles waits for the live grant', () => {
  it('a page the claims open shows at once; one they do not waits, asks once, and then decides', async () => {
    rolesSession()
    expect(accessSettled()).toBe(false)
    expect(pageAccessState('/invoicing/invoices', '').state).toBe('open')
    expect(pageAccessState('/payroll/employees', '').state).toBe('waiting')
    answer = live(['sales-docs.view', 'payroll-people.view'])
    settleAccess()
    settleAccess()
    await tick()
    expect(asked).toBe(1)
    expect(accessSettled()).toBe(true)
    expect(pageAccessState('/payroll/employees', '').state).toBe('open')
  })

  it('the role does not open it either: not available', async () => {
    rolesSession()
    answer = live(['sales-docs.view'])
    settleAccess()
    await tick()
    expect(pageAccessState('/payroll/employees', '').state).toBe('blocked')
    // The live grant decides over the claims: the clerk's claims open the invoice form, the role does not.
    expect(pageAccessState('/invoicing/invoices/new', '').state).toBe('blocked')
  })

  it('/auth/me failing ends the wait: the claims decide', async () => {
    rolesSession()
    setAccessRefetch(async () => { asked++; throw new Error('offline') })
    settleAccess()
    await tick()
    expect(accessSettled()).toBe(true)
    expect(pageAccessState('/payroll/employees', '').state).toBe('blocked')
  })
})

describe("FR-27.4: the role's landing page", () => {
  it('carried live, and where the session starts when its role opens it', () => {
    rolesSession()
    setLiveAccess(live(['sales-docs.view', 'products.view', 'dashboard.view'], '/inventory/products'))
    expect(liveLanding()).toBe('/inventory/products')
    expect(sessionViewer()?.landing).toBe('/inventory/products')
    expect(startPage(sessionViewer())).toBe('/inventory/products')
    expect(landingWithoutPortal(sessionViewer())).toBe('/inventory/products')
  })

  it('a landing the role does not open is ignored: the Dashboard, as without one', () => {
    rolesSession()
    setLiveAccess(live(['sales-docs.view', 'dashboard.view'], '/payroll/employees'))
    expect(startPage(sessionViewer())).toBe('/dashboard')
    setLiveAccess(live(['sales-docs.view', 'dashboard.view']))
    expect(sessionViewer()?.landing).toBeUndefined()
    expect(startPage(sessionViewer())).toBe('/dashboard')
  })

  it("a session sent out of the portal never lands on one of the portal's pages", () => {
    rolesSession({ areas: [] })
    setLiveAccess(live(['sales-docs.view', 'roles.edit'], '/settings/roles'))
    expect(startPage(sessionViewer())).toBe('/settings/roles')
    expect(landingWithoutPortal(sessionViewer())).toBe('/invoicing/')
  })

  it('belongs to its membership: another session in the tab reads none', () => {
    rolesSession()
    setLiveAccess(live(['products.view'], '/inventory/products'))
    rolesSession()
    expect(liveLanding()).toBeNull()
  })
})
