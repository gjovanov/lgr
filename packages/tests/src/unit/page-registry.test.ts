import { describe, it, expect } from 'bun:test'
import {
  APP_NAV_META,
  NEW_DOCUMENT_MENU,
  PAGE_REGISTRY,
  LEGACY_PAGE_IDS,
  canOpenPage,
  currentPageId,
  isTillOnly,
  matchPage,
  newDocumentMenu,
  pageById,
  portalPagesFor,
  type PageViewer,
} from 'ui-shared/nav/page-registry'
import { routerPathFor } from 'ui-shared/nav/open-page'
import { APP_REGISTRY, PERMISSIONS, ROLES, type Role } from 'config/constants'
import { ALL, PAGE_ACCESS, accessRuleFor, templateGrant, type CapabilityId } from 'config/access'
import { capsOfPermissions } from '../helpers/permission-caps'

/** Whether a role holding only this capability passes the route's rule (FR-27 P3-6: the capability rules). */
const routeTakes = (cap: CapabilityId, method: string, route: string) => {
  const rule = accessRuleFor(method, route.replace('/api/org/:orgId/', ''))
  return !!rule && (!('anyOf' in rule) || rule.anyOf.includes(cap))
}

describe('what the portal\'s menu offers: what `canOpenPage` lets them open (D10)', () => {
  const asRole = (role: Role): PageViewer => ({ grant: templateGrant(role) })
  const EVERY = ['/dashboard', '/settings/organization', '/settings/users', '/settings/roles', '/settings/invites', '/settings/desktops', '/settings/servers', '/settings/server', '/settings/billing', '/admin/audit-log']

  it('a till-only person is offered none of it', () => {
    expect(portalPagesFor({ grant: capsOfPermissions('pos.read', 'pos.write') })).toEqual([])
    expect(portalPagesFor({ grant: capsOfPermissions('pos.read') })).toEqual([])
  })

  it('a PIN session neither, whatever its role says', () => {
    expect(portalPagesFor({ grant: ALL, amr: ['pin'] })).toEqual([])
  })

  it('nobody signed in, nothing', () => {
    expect(portalPagesFor(null)).toEqual([])
  })

  it('an admin, all of it, whatever its set says', () => {
    expect(portalPagesFor({ grant: ALL })).toEqual(EVERY)
  })

  it('someone in on the back office keeps what they read, and is not offered what the server refuses them', () => {
    const read = ['/dashboard', '/settings/organization', '/settings/users']
    expect(portalPagesFor(asRole('manager'))).toEqual(read)
    expect(portalPagesFor(asRole('accountant'))).toEqual(read)
    expect(portalPagesFor(asRole('sales'))).toEqual(read)
    expect(portalPagesFor(asRole('member'))).toEqual(read)
  })

  it('who reads no dashboard is not offered it, and the people pages still', () => {
    expect(portalPagesFor(asRole('hr_manager'))).toEqual(['/settings/organization', '/settings/users'])
  })

  it('a tax inspector reads the audit trail, and nothing else of the settings', () => {
    expect(portalPagesFor(asRole('nra_auditor'))).toEqual(['/dashboard', '/settings/organization', '/settings/users', '/admin/audit-log'])
  })

  it('a permission that opens a page opens it for whoever holds it', () => {
    // Not the permission sets: writing one is assigning access, which only an admin does.
    expect(portalPagesFor({ grant: capsOfPermissions('pos.read', 'admin.settings') })).toEqual(['/settings/organization', '/settings/users', '/settings/desktops', '/settings/servers', '/settings/server'])
  })

  it('every page it answers for is a route of the portal', async () => {
    const { portalRoutes } = await import('../../../web/src/modules/portal/routes')
    const paths = (portalRoutes as any[]).flatMap(r => (r.children ?? []).map((c: any) => `/${c.path}`))
    for (const path of EVERY) expect(paths).toContain(path)
  })
})

describe('page-registry matchPage', () => {
  it('matches an exact registry path', () => {
    expect(matchPage('/invoicing/invoices')?.id).toBe('/invoicing/invoices')
    expect(matchPage('/inventory/products')?.labelKey).toBe('nav.products')
  })

  it('resolves detail / sub routes to their list page', () => {
    expect(matchPage('/invoicing/invoices/123/edit')?.id).toBe('/invoicing/invoices')
    expect(matchPage('/inventory/products/abc/stock')?.id).toBe('/inventory/products')
  })

  // The registry used to carry a nested /invoicing/bills/import page, which made this the
  // longest-prefix case. Importing moved onto the Bills list itself, so that path is now a
  // redirect and — like any other sub-route — folds back into its list page.
  it('folds bill sub-routes into the Bills page', () => {
    expect(matchPage('/invoicing/bills')?.id).toBe('/invoicing/bills')
    expect(matchPage('/invoicing/bills/import')?.id).toBe('/invoicing/bills')
    expect(matchPage('/invoicing/bills/9/edit')?.id).toBe('/invoicing/bills')
  })

  it('does not match across a partial segment boundary', () => {
    expect(matchPage('/invoicing/invoices-archive')).toBeNull()
    expect(matchPage('/invoicing/invoicesX')).toBeNull()
  })

  it('returns null for unknown / empty paths', () => {
    expect(matchPage('/portal/dashboard')).toBeNull()
    expect(matchPage('')).toBeNull()
  })

  it('keeps page ids globally unique across apps', () => {
    const ids = PAGE_REGISTRY.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('pageById round-trips', () => {
    expect(pageById('/invoicing/cash-sales/new')?.appId).toBe('invoicing')
    expect(pageById('/nope')).toBeNull()
  })
})

// FR-22.51: ★ pins a blank form. matchPage used to fold /new into its list, so the only thing
// a person standing on a new invoice could pin was the invoice list.
describe('page-registry matchPage — new-document forms', () => {
  it('a /new form is a page of its own, not its list', () => {
    expect(matchPage('/invoicing/invoices/new')?.id).toBe('/invoicing/invoices/new')
    expect(matchPage('/invoicing/bills/new')?.id).toBe('/invoicing/bills/new')
    // FR-26.8.6 (D-1): the form makes every type, so its row is the stock movement's.
    expect(matchPage('/inventory/movements/new')?.labelKey).toBe('nav.newDocPage.stockMovement')
    expect(matchPage('/invoicing/internal-orders/new')?.id).toBe('/invoicing/internal-orders/new')
  })

  it('a document that exists still resolves to its list', () => {
    expect(matchPage('/inventory/movements/6a1b2c')?.id).toBe('/inventory/movements')
    expect(matchPage('/invoicing/orders/6a1b2c/edit')?.id).toBe('/invoicing/orders')
    expect(matchPage('/invoicing/reservations/6a1b2c')?.id).toBe('/invoicing/reservations')
  })

  it('the invoice form opened as a credit or debit note is that note’s page', () => {
    expect(matchPage('/invoicing/invoices/new', '?type=credit_note')?.id).toBe('/invoicing/invoices/new?type=credit_note')
    expect(matchPage('/invoicing/invoices/new', '?restore=1&type=debit_note')?.id).toBe('/invoicing/invoices/new?type=debit_note')
    expect(matchPage('/invoicing/invoices/new', '?type=invoice')?.id).toBe('/invoicing/invoices/new')
    expect(matchPage('/invoicing/invoices/new', '')?.id).toBe('/invoicing/invoices/new')
  })

  it('a row with a query matches only its exact path', () => {
    expect(matchPage('/invoicing/invoices/123/edit', '?type=credit_note')?.id).toBe('/invoicing/invoices')
  })
})

const role = (r: Role): PageViewer => ({ grant: templateGrant(r) })
const page = (id: string) => {
  const p = pageById(id)
  if (!p) throw new Error(`no page ${id}`)
  return p
}

describe('canOpenPage — the permissions ★ and „+ Нов" read (FR-22 §5.8)', () => {
  it('an admin opens everything, whatever its set says', () => {
    const admin: PageViewer = { grant: ALL }
    expect(PAGE_REGISTRY.every((p) => canOpenPage(p, admin))).toBe(true)
  })

  it('a list page needs its app, as the App Hub tile does', () => {
    expect(canOpenPage(page('/invoicing/invoices'), role('member'))).toBe(true)
    expect(canOpenPage(page('/payroll/employees'), role('warehouse_manager'))).toBe(false)
    expect(canOpenPage(page('/inventory/products'), role('warehouse_manager'))).toBe(true)
  })

  it('a new-document form needs the write its Save needs', () => {
    expect(canOpenPage(page('/invoicing/invoices/new'), role('member'))).toBe(false)
    expect(canOpenPage(page('/invoicing/invoices/new'), role('sales'))).toBe(true)
    expect(canOpenPage(page('/inventory/movements/new'), role('sales'))).toBe(false)
    expect(canOpenPage(page('/inventory/movements/new'), role('warehouse_manager'))).toBe(true)
    expect(canOpenPage(page('/invoicing/bills/new'), role('nra_auditor'))).toBe(false)
  })

  it('a PIN session reaches the till and nothing else, even an admin’s', () => {
    const pin: PageViewer = { grant: ALL, amr: ['pin'] }
    for (const id of TILL_PAGES) expect(canOpenPage(page(id), pin), id).toBe(true)
    expect(canOpenPage(page('/invoicing/invoices/new'), pin)).toBe(false)
    expect(canOpenPage(page('/invoicing/invoices'), pin)).toBe(false)
    expect(canOpenPage(page('/inventory/products'), pin)).toBe(false)
  })

  it('nobody signed in opens nothing', () => {
    expect(canOpenPage(page('/invoicing/cash-sales/new'), null)).toBe(false)
  })
})

const TILL_PAGES = ['/invoicing/cash-sales/new', '/invoicing/cash-sales', '/invoicing/cash-register/sessions', '/invoicing/configuration/devices']

describe('the till, inside the invoicing app', () => {
  it('its pages say so, and nothing else in the app does', () => {
    expect(PAGE_REGISTRY.filter(p => p.till).map(p => p.id).sort()).toEqual([...TILL_PAGES].sort())
  })

  it('the terminal needs the write a sale needs: a reader is not offered it', () => {
    expect(canOpenPage(page('/invoicing/cash-sales/new'), role('sales'))).toBe(true)
    expect(canOpenPage(page('/invoicing/cash-sales/new'), role('nra_auditor'))).toBe(false)
    expect(canOpenPage(page('/invoicing/cash-sales/new'), role('accountant'))).toBe(false)
  })

  it('the journal is read by either side, the sessions and the devices by the till', () => {
    expect(canOpenPage(page('/invoicing/cash-sales'), role('accountant'))).toBe(true)
    expect(canOpenPage(page('/invoicing/cash-sales'), { grant: capsOfPermissions('pos.read') })).toBe(true)
    expect(canOpenPage(page('/invoicing/cash-register/sessions'), role('accountant'))).toBe(false)
    expect(canOpenPage(page('/invoicing/configuration/devices'), role('accountant'))).toBe(false)
    expect(canOpenPage(page('/invoicing/cash-register/sessions'), role('nra_auditor'))).toBe(true)
  })

  // A page's capabilities are the server's, not a guess: whoever is offered it can read it.
  it('every capability a till page names reads what that page reads', () => {
    const reads: Record<string, string> = {
      '/invoicing/cash-sales': '/api/org/:orgId/cash-register/documents',
      '/invoicing/cash-register/sessions': '/api/org/:orgId/trade/pos/session',
    }
    for (const [id, route] of Object.entries(reads)) {
      for (const c of PAGE_ACCESS[id].anyOf) expect({ id, c, reads: routeTakes(c, 'GET', route) }).toEqual({ id, c, reads: true })
    }
  })

  it('a favourite pinned in the POS app keeps its star', () => {
    expect(currentPageId('/pos/terminal')).toBe('/invoicing/cash-sales/new')
    expect(currentPageId('/pos/orders')).toBe('/invoicing/cash-sales')
    expect(currentPageId('/pos/sessions')).toBe('/invoicing/cash-register/sessions')
    expect(currentPageId('/pos/devices')).toBe('/invoicing/configuration/devices')
  })

  // FR-24 Phase 0 rewrote stored ids to `/invoicing/pos/*`, and may have reached production first.
  it('so does one that FR-24 Phase 0 rewrote to /invoicing/pos/*', () => {
    expect(currentPageId('/invoicing/pos/terminal')).toBe('/invoicing/cash-sales/new')
    expect(currentPageId('/invoicing/pos/orders')).toBe('/invoicing/cash-sales')
    expect(currentPageId('/invoicing/pos/sessions')).toBe('/invoicing/cash-register/sessions')
    expect(currentPageId('/invoicing/pos/devices')).toBe('/invoicing/configuration/devices')
  })

  // `currentPageId` is one hop: an id that led to another old id would keep a dead star.
  it('every remapped id lands on a page in one hop', () => {
    for (const to of Object.values(LEGACY_PAGE_IDS)) expect(pageById(to), to).not.toBeNull()
  })

  it('an old /pos path is no page any more', () => {
    expect(matchPage('/pos/terminal')).toBeNull()
    expect(matchPage('/invoicing/cash-sales/new')?.labelKey).toBe('nav.csTerminal')
    expect(matchPage('/invoicing/configuration/devices/6a1b')?.id).toBe('/invoicing/configuration/devices')
    expect(matchPage('/invoicing/cash-sales/6a1b/view')?.id).toBe('/invoicing/cash-sales')
  })
})

describe('canOpenPage reads an app as the server does', () => {
  // A module's reads name every permission of the module (`route-permission.ts`).
  it('every invoicing.* opens the invoicing pages, and the app\'s write forms still ask for write', () => {
    for (const held of ['invoicing.read', 'invoicing.write', 'invoicing.send']) {
      for (const id of ['/invoicing/invoices', '/invoicing/contacts', '/invoicing/cash-sales']) {
        expect({ held, id, opens: canOpenPage(page(id), { grant: capsOfPermissions(held) }) }).toEqual({ held, id, opens: true })
      }
    }
    expect(canOpenPage(page('/invoicing/invoices/new'), { grant: capsOfPermissions('invoicing.send') })).toBe(false)
    expect(canOpenPage(page('/invoicing/invoices/new'), { grant: capsOfPermissions('invoicing.read') })).toBe(false)
    expect(canOpenPage(page('/invoicing/invoices/new'), { grant: capsOfPermissions('invoicing.write') })).toBe(true)
  })

  it('the journal for whoever the server serves it to, and nobody else', () => {
    for (const p of PERMISSIONS) {
      const held = { grant: capsOfPermissions(p) }
      expect({ p, opens: canOpenPage(page('/invoicing/cash-sales'), held) }).toEqual({ p, opens: /^(pos|invoicing)\./.test(p) })
    }
  })
})

describe('isTillOnly', () => {
  // The server reads the module for any of them, so such a person keeps the back office.
  it('never someone holding any invoicing.*, whichever the server honoured', () => {
    expect(isTillOnly({ grant: capsOfPermissions('pos.read', 'pos.write', 'invoicing.write', 'invoicing.send') })).toBe(false)
    expect(isTillOnly({ grant: capsOfPermissions('pos.write', 'invoicing.send') })).toBe(false)
    expect(isTillOnly({ grant: capsOfPermissions('pos.read', 'invoicing.write') })).toBe(false)
  })

  it('pos.* and nothing that opens another page of the app', () => {
    expect(isTillOnly({ grant: capsOfPermissions('pos.read', 'pos.write') })).toBe(true)
    expect(isTillOnly({ grant: capsOfPermissions('pos.write') })).toBe(true)
    expect(isTillOnly({ grant: capsOfPermissions('pos.read', 'reports.read') })).toBe(true)
  })

  // The server reads the orders and the contacts for the inventory app too.
  it('never someone holding any inventory.*', () => {
    for (const p of ['inventory.read', 'inventory.write', 'inventory.adjust']) {
      expect(isTillOnly({ grant: capsOfPermissions('pos.read', p) })).toBe(false)
    }
  })

  it('not with invoicing.read, and not without the till', () => {
    expect(isTillOnly({ grant: capsOfPermissions('pos.read', 'invoicing.read') })).toBe(false)
    expect(isTillOnly({ grant: capsOfPermissions('inventory.read') })).toBe(false)
    expect(isTillOnly({ grant: capsOfPermissions() })).toBe(false)
  })

  it('no default role is, so nobody in the field changes today', () => {
    for (const r of ROLES) expect(isTillOnly(role(r)), r).toBe(false)
  })

  it('a PIN session is, whatever it holds: the server holds it to the till', () => {
    expect(isTillOnly({ grant: ALL, amr: ['pin'] })).toBe(true)
    expect(isTillOnly({ grant: templateGrant('sales'), amr: ['pin'] })).toBe(true)
  })

  it('an admin is refused nothing, whatever its set says', () => {
    expect(isTillOnly({ grant: ALL })).toBe(false)
  })

  it('nobody signed in is not', () => {
    expect(isTillOnly(null)).toBe(false)
  })
})

describe('newDocumentMenu — „+ Нов" (FR-22.49)', () => {
  const ids = (who: PageViewer | null) => newDocumentMenu(who).map((g) => g.map((i) => i.page.id))

  it('every entry names a registry form', () => {
    for (const { pageId } of NEW_DOCUMENT_MENU.flat()) {
      const p = pageById(pageId)
      expect(p, pageId).not.toBeNull()
      expect(p!.path.split('?')[0]).toEndWith('/new')
      expect(PAGE_ACCESS[pageId]?.anyOf.length, pageId).toBeGreaterThan(0)
    }
  })

  it('an admin gets every daily document, grouped', () => {
    expect(ids({ grant: ALL })).toEqual([
      ['/invoicing/invoices/new', '/invoicing/invoices/new?type=credit_note', '/invoicing/proforma/new', '/invoicing/offer/new'],
      ['/invoicing/cash-sales/new'],
      ['/invoicing/bills/new', '/inventory/movements/new'],
      ['/invoicing/internal-orders/new', '/invoicing/orders/new', '/invoicing/reservations/new'],
    ])
  })

  it('a cashier is not offered the goods receipt it may not save', () => {
    expect(ids(role('sales')).flat()).not.toContain('/inventory/movements/new')
    expect(ids(role('sales')).flat()).toContain('/invoicing/cash-sales/new')
  })

  it('a cash sale is the till: who has no till is not offered one', () => {
    expect(ids(role('accountant')).flat()).not.toContain('/invoicing/cash-sales/new')
    expect(ids(role('accountant')).flat()).toContain('/invoicing/invoices/new')
  })

  it('a PIN session is offered the till alone', () => {
    expect(ids({ ...role('sales'), amr: ['pin'] })).toEqual([['/invoicing/cash-sales/new']])
  })

  it('a warehouse manager gets the receipt alone, and no empty groups', () => {
    expect(ids(role('warehouse_manager'))).toEqual([['/inventory/movements/new']])
  })

  it('a read-only role gets nothing, so the button is not shown at all', () => {
    expect(ids(role('member'))).toEqual([])
    expect(ids(role('nra_auditor'))).toEqual([])
    expect(ids(null)).toEqual([])
  })

  // The menu's permission is the server's, not a guess: the route each form saves to.
  it('each form needs exactly what the server asks to save it', () => {
    const saves: Record<string, string> = {
      '/invoicing/invoices/new': '/api/org/:orgId/invoices',
      '/invoicing/invoices/new?type=credit_note': '/api/org/:orgId/invoices',
      '/invoicing/proforma/new': '/api/org/:orgId/invoices',
      '/invoicing/offer/new': '/api/org/:orgId/invoices',
      '/invoicing/cash-sales/new': '/api/org/:orgId/trade/pos/session/:id/transaction',
      '/invoicing/bills/new': '/api/org/:orgId/invoices',
      '/inventory/movements/new': '/api/org/:orgId/warehouse/movement',
      '/invoicing/internal-orders/new': '/api/org/:orgId/invoicing/internal-orders',
      '/invoicing/orders/new': '/api/org/:orgId/invoicing/orders',
      '/invoicing/reservations/new': '/api/org/:orgId/invoicing/reservations',
    }
    for (const { pageId } of NEW_DOCUMENT_MENU.flat()) {
      for (const c of PAGE_ACCESS[pageId].anyOf) expect({ pageId, c, saves: routeTakes(c, 'POST', saves[pageId]) }).toEqual({ pageId, c, saves: true })
    }
  })
})

describe('APP_NAV_META mirrors APP_REGISTRY', () => {
  it('in base path, permission and colour', () => {
    for (const [id, meta] of Object.entries(APP_NAV_META)) {
      const reg = APP_REGISTRY[id as keyof typeof APP_REGISTRY]
      expect(reg, id).toBeDefined()
      expect(`${meta.base}/`).toBe(reg.path)
      expect(meta.permission).toBe(reg.requiredPermission)
      expect(meta.color).toBe(reg.color)
    }
    expect(Object.keys(APP_NAV_META).sort()).toEqual(Object.keys(APP_REGISTRY).sort())
  })

  // The App Hub reads `APP_REGISTRY`, the pages read `canOpenPage`. One permission at a time, so
  // neither can come to hold one the other does not. The journal, which the whole app reads, and not
  // any page: one opened by another right earns no tile, because the app's home would refuse them.
  it('the Invoicing tile opens for exactly the permissions that read its journal', () => {
    const { requiredPermission, alsoOpenedBy } = APP_REGISTRY.invoicing
    const opens = PERMISSIONS.filter(p => canOpenPage(pageById('/invoicing/cash-sales')!, { grant: capsOfPermissions(p) }))
    expect([requiredPermission, ...(alsoOpenedBy ?? [])].sort()).toEqual([...opens].sort())
  })
})

describe('open-page helpers', () => {
  it('POS is no app of its own', () => {
    expect(Object.keys(APP_NAV_META)).not.toContain('pos')
  })

  it('routerPathFor keeps a path the SPA serves, and hands any other back', () => {
    const root = { resolve: (p: string) => ({ matched: ['/apps', '/invoicing/cash-sales/new'].includes(p) ? [{}] : [] }) } as any
    expect(routerPathFor('/invoicing/cash-sales/new', root)).toBe('/invoicing/cash-sales/new')
    expect(routerPathFor('/apps', root)).toBe('/apps')
    expect(routerPathFor('/nowhere', root)).toBeNull()
    expect(routerPathFor('//elsewhere.test/apps', root)).toBeNull()
  })
})
