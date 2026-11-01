import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { createMemoryHistory, createRouter } from 'vue-router'
import { visibleMenu, type ModuleManifest, type ModuleMenuItem } from '../../../ui-shell/src/module'
import { inModule, pendingRestoreUrl } from 'ui-shared/nav/open-page'
import { APP_NAV_META, canOpenPage, isTillOnly, matchPage, PAGE_REGISTRY, readsDocuments, type PageViewer } from 'ui-shared/nav/page-registry'
import { APP_REGISTRY, DEFAULT_ROLE_PERMISSIONS, FISCAL_ADMIN_ROLES, type Role } from 'config/constants'
import { manifest as accounting } from '../../../accounting-ui/src/manifest'
import { manifest as inventory } from '../../../inventory-ui/src/manifest'
import { manifest as invoicing } from '../../../invoicing-ui/src/manifest'
import { journalRoute, pinAtTill, tillLanding, tillRedirect, type TillSession } from '../../../invoicing-ui/src/pos/till-rules'
import { pinOffered } from '../../../invoicing-ui/src/pos/composables/useTillPin'
import { manifest as payroll } from '../../../payroll-ui/src/manifest'
import { manifest as reports } from '../../../reports-ui/src/manifest'
import { manifest as files } from '../../../files-ui/src/manifest'
import { posRedirect } from '../../../portal-api/src/lib/pos-redirect'
import { MODULES } from '../../../web/src/modules'
import { routes as oneSpaRoutes } from '../../../web/src/routes'

/**
 * FR-24.3/24.4: each module is a manifest, and every app-relative path it names (menu entries,
 * breadcrumbs, back-to values) resolves against its OWN route table. Those paths no longer depend
 * on a router's base, so the same table mounts unchanged under one SPA (Phase 2).
 */

const MANIFESTS: ModuleManifest[] = [accounting, inventory, invoicing, payroll, reports, files]
const PACKAGES = join(import.meta.dirname, '..', '..', '..')

/** Every route of the module as a regex over module-relative paths ("/orders/:id"). */
function routePatterns(m: ModuleManifest): RegExp[] {
  const out: RegExp[] = []
  const walk = (records: any[], parent: string) => {
    for (const r of records) {
      const path = r.path.startsWith('/') ? r.path : `${parent}/${r.path}`.replace(/\/+$/, '') || '/'
      const source = path.replace(/:[A-Za-z_]+\([^)]*\)[*+?]?|:[A-Za-z_]+\??/g, '[^/]+')
      out.push(new RegExp(`^${source === '/' ? '/?' : source}/?$`))
      if (r.children) walk(r.children, path === '/' ? '' : path)
    }
  }
  walk(m.routes, '')
  return out
}

function resolves(m: ModuleManifest, to: string): boolean {
  const pathname = to.split(/[?#]/)[0]
  return routePatterns(m).some(re => re.test(pathname))
}

function menuPaths(items: ModuleMenuItem[] | null): string[] {
  return (items ?? []).flatMap(i => [...(i.to ? [i.to] : []), ...menuPaths(i.children ?? null)])
}

function breadcrumbPaths(records: any[]): string[] {
  return records.flatMap(r => [
    ...((r.meta?.breadcrumb ?? []) as { to?: string }[]).flatMap(c => (c.to ? [c.to] : [])),
    ...breadcrumbPaths(r.children ?? []),
  ])
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

/** Which module a source file's back-to values belong to. */
function moduleOf(rel: string): ModuleManifest | undefined {
  const id = rel.split('/')[0].replace(/-ui$/, '')
  return MANIFESTS.find(m => m.id === id)
}

describe('FR-24.3: one manifest per module', () => {
  it('this list is the one SPA\'s, so what is held here holds there', () => {
    expect(MODULES.map(m => m.id).sort()).toEqual(MANIFESTS.map(m => m.id).sort())
  })

  it('names an app the registry knows, at the base the registry gives it', () => {
    for (const m of MANIFESTS) expect({ id: m.id, base: m.base }).toEqual({ id: m.id, base: APP_NAV_META[m.id].base })
  })

  it('redirects by name, never to a path, which would name a router base', () => {
    const misses: string[] = []
    const walk = (id: string, records: any[]) => {
      for (const r of records) {
        const target = typeof r.redirect === 'function' ? r.redirect({ params: { id: 'x' }, query: {} }) : r.redirect
        if (typeof target === 'string' || (target && typeof target === 'object' && 'path' in target)) misses.push(` `)
        if (r.children) walk(id, r.children)
      }
    }
    for (const m of MANIFESTS) walk(m.id, m.routes)
    expect(misses).toEqual([])
  })

  it('names routes relative to the module: no route path names a base', () => {
    for (const m of MANIFESTS) {
      for (const r of [...m.routes, ...(m.outside ?? [])]) {
        expect({ id: m.id, path: r.path, absolute: r.path.startsWith('/') }).toEqual({ id: m.id, path: r.path, absolute: false })
      }
    }
  })
})

describe('FR-24.4: every app-relative path resolves in its own module', () => {
  it('menus', () => {
    const misses = MANIFESTS.flatMap(m => menuPaths(m.menu).filter(p => !resolves(m, p) && !(m.outside ?? []).some(o => `/${o.path}` === p)).map(p => `${m.id} ${p}`))
    expect(misses).toEqual([])
  })

  it('breadcrumbs', () => {
    const misses = MANIFESTS.flatMap(m => breadcrumbPaths(m.routes).filter(p => !resolves(m, p)).map(p => `${m.id} ${p}`))
    expect(misses).toEqual([])
  })

  it('back-to values in the views and form configs', () => {
    const misses: string[] = []
    const pattern = /back-to="(\/[^"]*)"|backTo:\s*'(\/[^']*)'/g
    for (const root of ['accounting-ui', 'inventory-ui', 'invoicing-ui', 'payroll-ui', 'reports-ui', 'files-ui']) {
      for (const file of sources(join(PACKAGES, root, 'src'))) {
        const rel = relative(PACKAGES, file).replace(/\\/g, '/')
        const m = moduleOf(rel)
        for (const hit of readFileSync(file, 'utf8').matchAll(pattern)) {
          const to = hit[1] ?? hit[2]
          if (!m || !resolves(m, to)) misses.push(`${rel}: ${to}`)
        }
      }
    }
    expect(misses).toEqual([])
  })
})

describe('inModule and the pending-changes restore', () => {
  const at = (path: string) => ({ matched: [{ path, meta: { module: 'x' } }] })

  it('prefixes a module-relative path with the path of its shell record', () => {
    expect(inModule(at('/'), '/orders')).toBe('/orders')
    expect(inModule(at('/invoicing'), '/orders/1?x=1')).toBe('/invoicing/orders/1?x=1')
    expect(inModule({ matched: [] }, '/orders')).toBe('/orders')
    expect(inModule(at('/invoicing'), 'relative')).toBe('relative')
  })

  it('reopens an entry recorded relative to its app, or inside a bigger SPA, on the same page', () => {
    expect(pendingRestoreUrl({ appId: 'inventory', routePath: '/movements/1', id: 'e1' })).toBe('/inventory/movements/1?restore=e1')
    expect(pendingRestoreUrl({ appId: 'invoicing', routePath: '/configuration/devices/1', id: 'e3' })).toBe('/invoicing/configuration/devices/1?restore=e3')
    expect(pendingRestoreUrl({ appId: 'invoicing', routePath: '/invoicing/invoices/1/edit', id: 'e4' })).toBe('/invoicing/invoices/1/edit?restore=e4')
    expect(pendingRestoreUrl({ appId: 'inventory', id: 'e5' })).toBeNull()
  })
})

/** The one router: it composes every module, so its paths carry the module's base. */
const oneRouter = () => createRouter({ history: createMemoryHistory('/'), routes: oneSpaRoutes })

/**
 * A real router taken as far as its guards: that is past every redirect, so vue-router's own rules
 * decide what a redirect keeps, and short of loading a lazy view.
 */
async function landing(path: string): Promise<string> {
  const router = oneRouter()
  let landed = ''
  router.beforeEach((to) => {
    landed = to.fullPath
    return false
  })
  await router.push(path)
  return landed
}

/** The same, with the till's rules asked as `web/src/router.ts` asks them. */
async function guarded(path: string, tab: TillSession): Promise<string> {
  const router = oneRouter()
  let landed = ''
  router.beforeEach(async (to) => {
    const till = to.name === 'pos.pin' ? null : await tillRedirect(to, tab)
    if (till) return till
    landed = to.fullPath
    return false
  })
  await router.push(path)
  return landed
}

function leaves(records: any[]): any[] {
  return records.flatMap(r => (r.children ? leaves(r.children) : [r]))
}

describe('the till, part of the invoicing module', () => {
  const routes = [...leaves(invoicing.routes), ...(invoicing.outside ?? [])]
  const byName = (name: string) => routes.find(r => r.name === name)
  const NAMES = ['pos.terminal', 'pos.orders', 'pos.orders.detail', 'pos.sessions', 'pos.devices', 'pos.devices.new', 'pos.devices.detail', 'pos.pin']

  it('keeps every route name POS ever had: pending changes, grid columns and pushes name them', () => {
    expect(NAMES.filter(n => !byName(n))).toEqual([])
    const router = oneRouter()
    expect(NAMES.filter(n => !router.hasRoute(n))).toEqual([])
  })

  it('sits at its final addresses', () => {
    expect(byName('invoicing.cash-sales.new').path).toBe('cash-sales/new')
    expect(String(byName('invoicing.cash-sales.new').component)).toContain('PosTerminalView')
    expect(String(byName('invoicing.cash-sales.edit').component)).toContain('CashSaleFormView')
    expect(byName('pos.sessions').path).toBe('cash-register/sessions')
    expect(byName('pos.devices').path).toBe('configuration/devices')
    expect(byName('pos.devices.new').path).toBe('configuration/devices/new')
    expect(byName('pos.devices.detail').path).toBe('configuration/devices/:id')
    expect((invoicing.outside ?? []).map(r => [r.name, r.path])).toEqual([['pos.pin', 'pin']])
  })

  // The menu reads the registry and the router reads `meta.till`. Drifted apart, a till-only session
  // would be offered a page the router then takes it away from.
  it('every till page of the registry is a `meta.till` route, and the reverse', () => {
    const tillRoutes = routes.filter(r => r.meta?.till).map(r => r.path)
    for (const page of PAGE_REGISTRY.filter(p => p.till)) {
      expect(tillRoutes, page.id).toContain(page.path.replace('/invoicing/', ''))
    }
    expect(tillRoutes.sort()).toEqual([
      'cash-register/sessions', 'cash-sales', 'cash-sales/:id/view', 'cash-sales/new',
      'configuration/devices', 'configuration/devices/:id', 'configuration/devices/new', 'pin',
    ])
  })

  it('is no module of its own', () => {
    expect(MODULES.map(m => m.id)).not.toContain('pos')
    expect(MODULES.map(m => m.base).filter(b => b.startsWith('/invoicing'))).toEqual(['/invoicing'])
  })

  it('keeps its PIN pad outside the shell', () => {
    const pin = oneRouter().getRoutes().find(r => r.name === 'pos.pin')!
    expect({ path: pin.path, shellRecord: pin.meta.module ?? null, till: pin.meta.till }).toEqual({ path: '/invoicing/pin', shellRecord: null, till: true })
  })
})

describe('the till\'s guard', () => {
  const NO_PIN = async () => false
  const PIN = async () => true
  const session = (who: PageViewer, pinOffered = NO_PIN): TillSession => ({ hasOrg: true, who, pinOffered })
  const noSession = (pinOffered = NO_PIN): TillSession => ({ hasOrg: false, who: null, pinOffered })
  const cashier: PageViewer = { role: 'cashier', permissions: ['pos.read', 'pos.write'] }
  const pinAdmin: PageViewer = { role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, amr: ['pin'] }
  const sales: PageViewer = { role: 'sales', permissions: DEFAULT_ROLE_PERMISSIONS.sales }

  it('takes a till-only session from any other page of the module to the terminal', async () => {
    for (const who of [cashier, pinAdmin]) {
      for (const page of ['/invoices', '/invoices/new', '/bills', '/cash-sales/6a1b/edit', '/configuration/sequences', '/']) {
        expect({ page, to: await guarded(`/invoicing${page}`, session(who)) }).toEqual({ page, to: '/invoicing/cash-sales/new' })
      }
    }
  })

  it('leaves it on the till\'s pages', async () => {
    for (const page of ['/cash-sales/new', '/cash-sales', '/cash-sales/6a1b/view', '/cash-register/sessions', '/configuration/devices', '/configuration/devices/new', '/configuration/devices/6a1b']) {
      expect({ page, to: await guarded(`/invoicing${page}`, session(cashier)) }).toEqual({ page, to: `/invoicing${page}` })
    }
  })

  it('leaves everyone else where they asked to go', async () => {
    expect(await guarded('/invoicing/invoices', session(sales))).toBe('/invoicing/invoices')
    expect(await guarded('/invoicing/cash-sales/new', session(sales))).toBe('/invoicing/cash-sales/new')
  })

  it('offers a PIN on the till\'s pages only, where the server offers one', async () => {
    const pad = (page: string) => `/invoicing/pin?to=${page}`
    expect(await guarded('/invoicing/cash-sales/new', noSession(PIN))).toBe(pad('/invoicing/cash-sales/new'))
    expect(await guarded('/invoicing/cash-register/sessions', noSession(PIN))).toBe(pad('/invoicing/cash-register/sessions'))
    // The router's own sign-in rule takes these: the till's rules have nothing to say.
    expect(await guarded('/invoicing/invoices', noSession(PIN))).toBe('/invoicing/invoices')
    expect(await guarded('/invoicing/cash-sales/new', noSession(NO_PIN))).toBe('/invoicing/cash-sales/new')
  })

  it('reads the old addresses as what they lead to', async () => {
    expect(await guarded('/invoicing/pos/orders', session(cashier))).toBe('/invoicing/cash-sales')
    expect(await guarded('/invoicing/pos/terminal', noSession(PIN))).toContain('/invoicing/pin')
  })

  it('has nothing to say about another module: the server refuses there', async () => {
    expect(await guarded('/inventory/products', session(cashier))).toBe('/inventory/products')
  })
})

/**
 * The one rule for who may open what, as a table over every kind of person the review named. `canOpenPage`
 * decides: the guard, the menu, the landing and the App Hub tile are all held to it here, on real
 * routes, so none of them can come to a different answer.
 */
describe('who may open what', () => {
  const role = (r: Role): PageViewer => ({ role: r, permissions: DEFAULT_ROLE_PERMISSIONS[r] })
  const set = (...permissions: string[]): PageViewer => ({ role: 'member', permissions })
  const pin = (r: Role): PageViewer => ({ ...role(r), amr: ['pin'] })

  const TERMINAL = '/invoicing/cash-sales/new'
  const JOURNAL = '/invoicing/cash-sales'
  const SESSIONS = '/invoicing/cash-register/sessions'
  const DEVICES = '/invoicing/configuration/devices'
  const INVOICES = '/invoicing/invoices'
  const ORDER = '/invoicing/orders/6a1b/edit'
  const CONTACTS = '/invoicing/contacts'

  /** [who, tile, the Invoicing tile's landing, then where each page ends up]. */
  const TABLE: Array<[string, PageViewer, boolean, string, Record<string, string>]> = [
    ['pos.read alone reads, and sells nothing', set('pos.read'), true, JOURNAL, { [TERMINAL]: JOURNAL, [SESSIONS]: SESSIONS, [DEVICES]: DEVICES, [INVOICES]: JOURNAL }],
    ['pos.write alone', set('pos.write'), true, TERMINAL, { [TERMINAL]: TERMINAL, [JOURNAL]: JOURNAL, [SESSIONS]: SESSIONS, [INVOICES]: TERMINAL }],
    ['both of pos.*', set('pos.read', 'pos.write'), true, TERMINAL, { [TERMINAL]: TERMINAL, [JOURNAL]: JOURNAL, [INVOICES]: TERMINAL }],
    ['pos.* with invoicing.write and .send, no .read', set('pos.read', 'pos.write', 'invoicing.write', 'invoicing.send'), true, INVOICES, { [TERMINAL]: TERMINAL, [INVOICES]: INVOICES, '/invoicing/invoices/new': '/invoicing/invoices/new', '/invoicing/contacts': '/invoicing/contacts', '/invoicing/cash-sales/6a1b/edit': '/invoicing/cash-sales/6a1b/edit' }],
    ['an accountant, whose bookmark was the old form', role('accountant'), true, INVOICES, { [TERMINAL]: JOURNAL, [JOURNAL]: JOURNAL, [SESSIONS]: JOURNAL, [DEVICES]: JOURNAL, [INVOICES]: INVOICES, '/invoicing/cash-sales/6a1b/view': '/invoicing/cash-sales/6a1b/view' }],
    ['a member, read-only', role('member'), true, INVOICES, { [TERMINAL]: JOURNAL, [JOURNAL]: JOURNAL, [SESSIONS]: JOURNAL, [INVOICES]: INVOICES }],
    ['an NRA auditor reads the till and sells nothing', role('nra_auditor'), true, INVOICES, { [TERMINAL]: JOURNAL, [JOURNAL]: JOURNAL, [SESSIONS]: SESSIONS, [INVOICES]: INVOICES }],
    ['sales has all of it', role('sales'), true, INVOICES, { [TERMINAL]: TERMINAL, [JOURNAL]: JOURNAL, [SESSIONS]: SESSIONS, [INVOICES]: INVOICES }],
    ['a manager has all of it', role('manager'), true, INVOICES, { [TERMINAL]: TERMINAL, [INVOICES]: INVOICES }],
    ['a PIN of someone who sells', pin('sales'), true, TERMINAL, { [TERMINAL]: TERMINAL, [JOURNAL]: JOURNAL, [INVOICES]: TERMINAL }],
    ['a PIN of an admin', pin('admin'), true, TERMINAL, { [TERMINAL]: TERMINAL, [INVOICES]: TERMINAL, '/invoicing/cash-sales/6a1b/edit': TERMINAL }],
    ['a PIN of someone who only reads the till', pin('nra_auditor'), true, JOURNAL, { [TERMINAL]: JOURNAL, [JOURNAL]: JOURNAL, [SESSIONS]: SESSIONS, [INVOICES]: JOURNAL }],
    // Nothing of invoicing or the till: no landing to give, so the server's refusals stand, as on
    // any app they hold nothing of. A warehouse manager still runs the devices by address.
    ['neither, by address', role('warehouse_manager'), false, INVOICES, { [TERMINAL]: TERMINAL, [DEVICES]: DEVICES, [INVOICES]: INVOICES }],
    // Who runs a device is the server's roles, not `pos.*`: these used to land on the journal.
    ['a warehouse manager who reads invoicing too', { role: 'warehouse_manager', permissions: ['invoicing.read', 'inventory.read'] }, true, INVOICES, { [DEVICES]: DEVICES, [`${DEVICES}/6a1b`]: `${DEVICES}/6a1b`, [TERMINAL]: JOURNAL, [SESSIONS]: JOURNAL }],
    ['a manager on a set of their own', { role: 'manager', permissions: ['invoicing.read'] }, true, INVOICES, { [DEVICES]: DEVICES, [TERMINAL]: JOURNAL }],
    // The server reads the orders and the contacts for the inventory app, so these pages are theirs.
    ['the till and inventory', set('pos.read', 'pos.write', 'inventory.read'), true, TERMINAL, { [ORDER]: ORDER, [CONTACTS]: CONTACTS, [TERMINAL]: TERMINAL, [INVOICES]: TERMINAL }],
    ['a warehouse manager, following a link from a product', role('warehouse_manager'), false, INVOICES, { [ORDER]: ORDER, [CONTACTS]: CONTACTS }],
  ]

  const session = (who: PageViewer): TillSession => ({ hasOrg: true, who, pinOffered: async () => false })

  for (const [name, who, tile, home, pages] of TABLE) {
    describe(name, () => {
      it('ends up where the table says', async () => {
        for (const [from, to] of Object.entries(pages)) {
          expect({ from, to: await guarded(from, session(who)) }).toEqual({ from, to })
        }
      })

      it('the Invoicing tile leads to a page they can use', async () => {
        expect(await guarded('/invoicing/', session(who))).toBe(home)
      })

      // The tile is for who has somewhere to start. A page opened by another right (the devices by
      // a role) earns none: the app's home would refuse them.
      it('has the tile exactly if the journal, which the whole app reads, opens for them', () => {
        const { requiredPermission, alsoOpenedBy } = APP_REGISTRY.invoicing
        const held = who.permissions ?? []
        expect([requiredPermission, ...(alsoOpenedBy ?? [])].some(p => held.includes(p))).toBe(tile)
        expect(canOpenPage(matchPage(JOURNAL)!, who)).toBe(tile)
      })

      it('is offered exactly the pages `canOpenPage` opens', () => {
        const shown = menuPaths(visibleMenu(invoicing.menu!, who)).filter(p => p !== '/pin')
        const open = menuPaths(invoicing.menu).filter(p => p !== '/pin').filter(p => canOpenPage(matchPage(`/invoicing${p}`)!, who))
        expect(shown).toEqual(open)
      })

      it('is sent only to a page it may open', async () => {
        const landing = tillLanding(who)
        if (landing) {
          const page = matchPage(oneRouter().resolve(landing).path)!
          expect({ page: page.id, opens: canOpenPage(page, who) }).toEqual({ page: page.id, opens: true })
        }
      })
    })
  }

  // The server's rule is roles, and `fiscal` reads are any member's. The menu hid the page from the
  // people who run the devices, and a guard took some of them off it.
  it('the devices open for the roles the server lets run them, and the menu offers them', () => {
    const devices = matchPage(DEVICES)!
    for (const r of FISCAL_ADMIN_ROLES) {
      expect({ r, opens: canOpenPage(devices, { role: r, permissions: [] }) }).toEqual({ r, opens: true })
      expect(menuPaths(visibleMenu(invoicing.menu!, { role: r, permissions: [] }))).toContain('/configuration/devices')
    }
    expect(canOpenPage(devices, set('pos.read'))).toBe(true)
    expect(canOpenPage(devices, set('invoicing.read'))).toBe(false)
    expect(canOpenPage(devices, role('accountant'))).toBe(false)
  })

  // `route-permission.ts` reads `invoicing/orders` and `invoicing/contact` for `inventory.*` too.
  // Asked of `invoicing.*` alone, a warehouse manager in on a link had an empty menu.
  it('someone in on what inventory reads is offered it', () => {
    expect(menuPaths(visibleMenu(invoicing.menu!, role('warehouse_manager')))).toEqual(['/orders', '/contacts', '/configuration/devices'])
    expect(menuPaths(visibleMenu(invoicing.menu!, set('pos.read', 'pos.write', 'inventory.read')))).toEqual(['/cash-sales/new', '/cash-sales', '/cash-register/sessions', '/orders', '/contacts', '/configuration/devices'])
  })

  // Not the same question: the back-office form and the print of a sale read `/invoices`.
  it('reading the orders is not reading the documents', () => {
    expect(readsDocuments(set('pos.write', 'inventory.read'))).toBe(false)
    expect(readsDocuments(role('accountant'))).toBe(true)
    expect(readsDocuments(pin('admin'))).toBe(false)
  })

  // The router matches without regard to case, and the registry's paths are lower case.
  it('a capitalised address is the page the router opens for it', async () => {
    expect(await guarded('/invoicing/Cash-Sales/New', session(role('accountant')))).toBe(JOURNAL)
    expect(await guarded('/INVOICING/CONFIGURATION/DEVICES', session(role('accountant')))).toBe(JOURNAL)
    expect(await guarded('/invoicing/Cash-Register/Sessions', session(role('sales')))).toBe('/invoicing/Cash-Register/Sessions')
  })

  it('the till starts on the terminal, on the journal for someone who cannot sell, and nowhere for someone who cannot read it', () => {
    expect(tillLanding(set('pos.write'))).toEqual({ name: 'invoicing.cash-sales.new' })
    expect(tillLanding(set('pos.read'))).toEqual({ name: 'invoicing.cash-sales' })
    expect(tillLanding(role('accountant'))).toEqual({ name: 'invoicing.cash-sales' })
    expect(tillLanding(role('warehouse_manager'))).toBeNull()
    expect(tillLanding(null)).toBeNull()
  })

  it('a PIN session is till-only whatever it holds, and an admin never is, whatever its set says', () => {
    expect(isTillOnly(pin('admin'))).toBe(true)
    expect(isTillOnly({ role: 'admin', permissions: ['pos.read'] })).toBe(false)
  })

  // The page registry prefix-matches this one to the journal, which the till reads. It is the back
  // office's form: it reads `/invoices`.
  it('a sale\'s back-office form is no till page', async () => {
    expect(await guarded('/invoicing/cash-sales/6a1b/edit', session(set('pos.read', 'pos.write')))).toBe(TERMINAL)
    expect(await guarded('/invoicing/cash-sales/6a1b/edit', session(set('pos.read')))).toBe(JOURNAL)
  })
})

describe('a draft of a new cash sale, made on the form that stood at this address', () => {
  const session = (who: PageViewer): TillSession => ({ hasOrg: true, who, pinOffered: async () => false })
  const accountant: PageViewer = { role: 'accountant', permissions: DEFAULT_ROLE_PERMISSIONS.accountant }
  const sales: PageViewer = { role: 'sales', permissions: DEFAULT_ROLE_PERMISSIONS.sales }

  // The entries in the field name `invoicing.cash-sales.new`, and an accountant holds no `pos.*`:
  // the terminal is no page of theirs, and the draft still is.
  it('opens the form, for whoever may save it', async () => {
    for (const who of [sales, accountant]) {
      expect(await guarded('/invoicing/cash-sales/new?restore=e1', session(who))).toBe('/invoicing/cash-sales/draft?restore=e1')
    }
  })

  it('by the entry\'s route name, as the Pending changes panel opens it', async () => {
    const router = oneRouter()
    expect(router.resolve({ name: 'invoicing.cash-sales.new', query: { restore: 'e1' } }).fullPath).toBe('/invoicing/cash-sales/new?restore=e1')
    expect(await guarded(router.resolve({ name: 'invoicing.cash-sales.new', query: { restore: 'e1' } }).fullPath, session(accountant))).toBe('/invoicing/cash-sales/draft?restore=e1')
  })

  it('the terminal itself is untouched', async () => {
    expect(await guarded('/invoicing/cash-sales/new', session(sales))).toBe('/invoicing/cash-sales/new')
  })

  it('the form is the back office\'s, so a till-only session is not sent there', async () => {
    expect(await guarded('/invoicing/cash-sales/draft', session({ role: 'member', permissions: ['pos.read', 'pos.write'] }))).toBe('/invoicing/cash-sales/new')
  })

  it('the form sits at its own address, with no `meta.till`', () => {
    const route = oneRouter().getRoutes().find(r => r.name === 'invoicing.cash-sales.draft')!
    expect({ path: route.path, till: route.meta.till ?? false }).toEqual({ path: '/invoicing/cash-sales/draft', till: false })
    expect(String(route.components?.default)).toContain('CashSaleFormView')
  })
})

describe('what a person reads about the till', () => {
  const LOCALES = ['en', 'bg', 'de', 'mk']
  const strings = (node: unknown, path = ''): Array<[string, string]> => typeof node === 'string'
    ? [[path, node]]
    : Object.entries((node ?? {}) as Record<string, unknown>).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k))

  // The app is gone, and the page a message sends someone to is gone with it.
  it('sends nobody to the POS app, which is gone', () => {
    const gone = /POS\s*→|POS Sessions|POS-Sitzungen|POS сесии/
    for (const l of LOCALES) {
      const messages = JSON.parse(readFileSync(join(PACKAGES, 'ui-shared', 'src', 'locales', `${l}.json`), 'utf8'))
      expect({ l, found: strings(messages).filter(([, s]) => gone.test(s)).map(([k]) => k) }).toEqual({ l, found: [] })
    }
    // The server's refusals, in its own words.
    for (const file of ['portal-api/src/controllers/fiscal-device.controller.ts', 'fiscal/src/device-command.ts', 'fiscal/src/fiscal-device.service.ts']) {
      expect({ file, found: readFileSync(join(PACKAGES, file), 'utf8').match(/(opened|connect it|connect) from the POS/) }).toEqual({ file, found: null })
    }
  })
})

describe('where a row of the journal opens', () => {
  const row = (origin: string, kind = 'sale') => ({ id: '6a1b', store: 'invoice', kind, origin })
  const view = { name: 'invoicing.cash-sales.view', params: { id: '6a1b' } }
  const edit = { name: 'invoicing.cash-sales.edit', params: { id: '6a1b' } }

  it('a till sale opens on the journal\'s page, for every role: the form shows no tender, no stock and no storno', () => {
    for (const tillOnly of [false, true]) expect(journalRoute(row('pos'), tillOnly)).toEqual(view)
  })

  it('a storno opens there too, wherever it came from', () => {
    for (const origin of ['pos', 'backoffice', 'import']) expect(journalRoute(row(origin, 'storno'), false)).toEqual(view)
  })

  it('a back-office sale and an import keep their document page', () => {
    for (const origin of ['backoffice', 'import']) expect(journalRoute(row(origin), false)).toEqual(edit)
  })

  it('a till-only session reads no documents', () => {
    for (const origin of ['backoffice', 'import']) expect(journalRoute(row(origin), true)).toEqual(view)
  })
})

describe('the till\'s old addresses', () => {
  // ⚠ `/invoicing/pos/*` can reach production ahead of the move, and the server hands it to this
  // router. `/pos/*` never gets here: the server answers it. The two must agree.
  const SAME_PAGE: Array<[string, string]> = [
    ['', '/cash-sales/new'],
    ['/', '/cash-sales/new'],
    ['/terminal', '/cash-sales/new'],
    ['/orders', '/cash-sales'],
    ['/orders/6a1b', '/cash-sales/6a1b/view'],
    ['/sessions', '/cash-register/sessions'],
    ['/devices', '/configuration/devices'],
    ['/devices/new', '/configuration/devices/new'],
    ['/devices/6a1b', '/configuration/devices/6a1b'],
    ['/nope', '/cash-sales/new'],
    ['/orders/1/extra', '/cash-sales/new'],
    ['/sessions/1', '/cash-sales/new'],
    ['/devices/1/edit', '/cash-sales/new'],
  ]

  it('the server sends /pos/* to the same pages', () => {
    for (const [rest, to] of SAME_PAGE) expect({ rest, server: posRedirect(`/pos${rest}`) }).toEqual({ rest, server: `/invoicing${to}` })
  })

  it('/invoicing/pos/* lands on those pages', async () => {
    for (const [rest, to] of SAME_PAGE) expect({ rest, router: await landing(`/invoicing/pos${rest}`) }).toEqual({ rest, router: `/invoicing${to}` })
  })

  it('keeps the query and the hash', async () => {
    expect(await landing('/invoicing/pos/orders?session=abc&q=CS-1')).toBe('/invoicing/cash-sales?session=abc&q=CS-1')
    expect(await landing('/invoicing/pos/orders/6a1b?a=1#line')).toBe('/invoicing/cash-sales/6a1b/view?a=1#line')
    expect(await landing('/invoicing/pos/devices/6a1b?restore=e3')).toBe('/invoicing/configuration/devices/6a1b?restore=e3')
    expect(await landing('/invoicing/pos/nope?a=1')).toBe('/invoicing/cash-sales/new?a=1')
  })

  it('the PIN pad, keeping `to`: under /invoicing it was already this router\'s', async () => {
    expect(await landing('/invoicing/pos/pin?to=%2Fpos%2Forders')).toBe('/invoicing/pin?to=/pos/orders')
  })

  it('the old route names lead where their paths do', () => {
    const router = oneRouter()
    expect(router.resolve({ name: 'pos.terminal' }).path).toBe('/invoicing/pos/terminal')
    expect(router.resolve({ name: 'pos.orders' }).path).toBe('/invoicing/pos/orders')
    expect(router.resolve({ name: 'pos.orders.detail', params: { id: '1' } }).path).toBe('/invoicing/pos/orders/1')
  })

  it('a stored path that is not one of them keeps its own page', async () => {
    expect(await landing('/invoicing/invoices')).toBe('/invoicing/invoices')
    expect(await landing('/invoicing/cash-sales/6a1b/edit')).toBe('/invoicing/cash-sales/6a1b/edit')
  })

  // FR-24.7. `routeName` survived, and `ModuleLayout#handleRestore` asks this router for it, whatever
  // `appId` the entry carries.
  it('a pending change from before the move reopens by name', () => {
    expect(oneRouter().hasRoute('pos.devices.detail')).toBe(true)
  })

  it('a pending change whose route name is gone reopens by URL, through the server', () => {
    const url = pendingRestoreUrl({ appId: 'pos', routePath: '/devices/1', id: 'e2' })!
    expect(url).toBe('/pos/devices/1?restore=e2')
    const [pathname, query] = url.split('?')
    expect(posRedirect(pathname, `?${query}`)).toBe('/invoicing/configuration/devices/1?restore=e2')
  })

  it('a pending change from under FR-24 Phase 0 reopens through the router', async () => {
    const url = pendingRestoreUrl({ appId: 'invoicing', routePath: '/pos/devices/1', id: 'e3' })!
    expect(url).toBe('/invoicing/pos/devices/1?restore=e3')
    expect(await landing(url)).toBe('/invoicing/configuration/devices/1?restore=e3')
  })
})

describe('the invoicing menu, as each person sees it', () => {
  const role = (r: Role): PageViewer => ({ role: r, permissions: DEFAULT_ROLE_PERMISSIONS[r] })
  const entries = (who: PageViewer | null) => visibleMenu(invoicing.menu!, who).flatMap(g => g.children!.filter(c => c.to).map(c => c.to))
  const dividers = (who: PageViewer | null) => visibleMenu(invoicing.menu!, who).flatMap(g => g.children!.filter(c => c.divider))
  const TILL = ['/cash-sales/new', '/cash-sales', '/cash-register/sessions', '/configuration/devices']
  const everything = menuPaths(invoicing.menu).filter(p => p !== '/pin')

  it('the groups are where goran put them', () => {
    const outgoing = invoicing.menu!.find(g => g.labelKey === 'nav.outgoingDocs')!
    expect(outgoing.children!.map(c => (c.divider ? '|' : c.to))).toEqual(['/invoices', '/proforma', '|', '/cash-sales/new', '/cash-sales', '/cash-register/sessions', '/pin'])
    expect(invoicing.menu!.find(g => g.labelKey === 'nav.configuration')!.children!.map(c => c.to)).toEqual(['/contacts', '/configuration/sequences', '/configuration/devices'])
  })

  it('whoever sells and invoices gets all of it, the divider in its place', () => {
    expect(entries(role('sales'))).toEqual(everything)
    expect(dividers(role('sales'))).toHaveLength(1)
  })

  it('an admin too, whatever its set says', () => {
    expect(entries({ role: 'admin', permissions: [] })).toEqual(everything)
  })

  it('a till-only role sees the till alone, with no group left empty and no divider above it', () => {
    const till: PageViewer = { role: 'cashier', permissions: ['pos.read', 'pos.write'] }
    expect(entries(till)).toEqual(TILL)
    expect(visibleMenu(invoicing.menu!, till).map(g => g.labelKey)).toEqual(['nav.outgoingDocs', 'nav.configuration'])
    expect(dividers(till)).toEqual([])
  })

  it("a PIN session sees the till alone, even an admin's", () => {
    expect(entries({ role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, amr: ['pin'] })).toEqual(TILL)
  })

  // An accountant has no `pos.*`: every call of these pages would be refused.
  it('an invoicing role without pos.* is not offered the till, and keeps the journal it reads', () => {
    const shown = entries(role('accountant'))
    expect(shown).toContain('/cash-sales')
    for (const p of ['/cash-sales/new', '/cash-register/sessions', '/configuration/devices']) expect(shown).not.toContain(p)
    expect(entries(role('member'))).not.toContain('/cash-sales/new')
    expect(dividers(role('accountant'))).toHaveLength(1)
  })

  it('a reader is not offered a terminal it cannot sell on', () => {
    expect(entries(role('nra_auditor'))).not.toContain('/cash-sales/new')
    expect(entries(role('nra_auditor'))).toContain('/cash-register/sessions')
  })

  // FR-20.40. The rule is the entry's own, under the till's rules: it holds for whoever is at the till.
  it('„Switch operator" shows only where the server offers a PIN', async () => {
    const till: PageViewer = { role: 'cashier', permissions: ['pos.read', 'pos.write'] }
    entries(till) // asks once, and lets the answer (no server here: "no") settle first
    await pinOffered()
    await Promise.resolve()
    pinAtTill.value = false
    expect(entries(till)).not.toContain('/pin')
    pinAtTill.value = true
    expect(entries(till)).toEqual(['/cash-sales/new', '/cash-sales', '/cash-register/sessions', '/pin', '/configuration/devices'])
    expect(entries(role('accountant'))).toContain('/pin')
    pinAtTill.value = false
  })

  it('leaves the manifest as it found it', () => {
    const copy = JSON.stringify(invoicing.menu)
    visibleMenu(invoicing.menu!, { role: 'cashier', permissions: ['pos.read'] })
    expect(JSON.stringify(invoicing.menu)).toBe(copy)
  })
})

describe('visibleMenu', () => {
  const entry = (to: string, when?: ModuleMenuItem['when']): ModuleMenuItem => ({ labelKey: to, to, ...(when ? { when } : {}) })
  const line: ModuleMenuItem = { labelKey: '', divider: true }
  const nobody = null
  const hidden = () => false

  it('a divider never ends a group, opens one, or doubles', () => {
    const menu = [{ labelKey: 'g', children: [line, entry('/a'), line, line, entry('/b'), line] }]
    expect(visibleMenu(menu, nobody)[0].children!.map(c => c.to ?? '|')).toEqual(['/a', '|', '/b'])
  })

  it('a divider goes with the entries around it', () => {
    const below = [{ labelKey: 'g', children: [entry('/a'), line, entry('/b', hidden)] }]
    expect(visibleMenu(below, nobody)[0].children!.map(c => c.to ?? '|')).toEqual(['/a'])
    const above = [{ labelKey: 'g', children: [entry('/a', hidden), line, entry('/b')] }]
    expect(visibleMenu(above, nobody)[0].children!.map(c => c.to ?? '|')).toEqual(['/b'])
  })

  it('a group with nothing left goes, and one with no children was never a group', () => {
    const menu = [{ labelKey: 'g', children: [entry('/a', hidden), line] }, entry('/top')]
    expect(visibleMenu(menu, nobody).map(i => i.labelKey)).toEqual(['/top'])
  })

  it('every other module is untouched: no entry of theirs asks anything', () => {
    for (const m of MANIFESTS.filter(x => x !== invoicing && x.menu)) {
      expect({ id: m.id, menu: menuPaths(visibleMenu(m.menu!, nobody)) }).toEqual({ id: m.id, menu: menuPaths(m.menu) })
    }
  })

  it('hands `when` the person', () => {
    const seen: unknown[] = []
    const who: PageViewer = { role: 'sales' }
    visibleMenu([entry('/a', (w) => { seen.push(w); return true })], who)
    expect(seen).toEqual([who])
  })
})
