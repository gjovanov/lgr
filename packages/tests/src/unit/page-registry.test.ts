import { describe, it, expect } from 'bun:test'
import {
  APP_NAV_META,
  NEW_DOCUMENT_MENU,
  PAGE_REGISTRY,
  canOpenPage,
  currentPageId,
  matchPage,
  newDocumentMenu,
  pageById,
  type PageViewer,
} from 'ui-shared/nav/page-registry'
import { appRelativePath, routerAppId, routerPathFor, spaOf } from 'ui-shared/nav/open-page'
import { APP_REGISTRY, DEFAULT_ROLE_PERMISSIONS, type Role } from 'config/constants'
import { writeRuleFor } from 'services/biz/route-permission'

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
    expect(pageById('/invoicing/pos/terminal')?.appId).toBe('pos')
    expect(pageById('/nope')).toBeNull()
  })
})

// FR-22.51: ★ pins a blank form. matchPage used to fold /new into its list, so the only thing
// a person standing on a new invoice could pin was the invoice list.
describe('page-registry matchPage — new-document forms', () => {
  it('a /new form is a page of its own, not its list', () => {
    expect(matchPage('/invoicing/invoices/new')?.id).toBe('/invoicing/invoices/new')
    expect(matchPage('/invoicing/bills/new')?.id).toBe('/invoicing/bills/new')
    expect(matchPage('/inventory/movements/new')?.labelKey).toBe('nav.newDocPage.goodsReceipt')
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

const role = (r: Role): PageViewer => ({ role: r, permissions: DEFAULT_ROLE_PERMISSIONS[r] })
const page = (id: string) => {
  const p = pageById(id)
  if (!p) throw new Error(`no page ${id}`)
  return p
}

describe('canOpenPage — the permissions ★ and „+ Нов" read (FR-22 §5.8)', () => {
  it('an admin opens everything, whatever its set says', () => {
    const admin: PageViewer = { role: 'admin', permissions: [] }
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
    const pin: PageViewer = { role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, amr: ['pin'] }
    expect(canOpenPage(page('/invoicing/pos/terminal'), pin)).toBe(true)
    expect(canOpenPage(page('/invoicing/invoices/new'), pin)).toBe(false)
    expect(canOpenPage(page('/inventory/products'), pin)).toBe(false)
  })

  it('nobody signed in opens nothing', () => {
    expect(canOpenPage(page('/invoicing/pos/terminal'), null)).toBe(false)
  })
})

describe('newDocumentMenu — „+ Нов" (FR-22.49)', () => {
  const ids = (who: PageViewer | null) => newDocumentMenu(who).map((g) => g.map((i) => i.page.id))

  it('every entry names a registry form', () => {
    for (const { pageId } of NEW_DOCUMENT_MENU.flat()) {
      const p = pageById(pageId)
      expect(p, pageId).not.toBeNull()
      expect(p!.path.split('?')[0]).toEndWith('/new')
      expect(p!.need?.length, pageId).toBeGreaterThan(0)
    }
  })

  it('an admin gets every daily document, grouped', () => {
    expect(ids({ role: 'admin', permissions: [] })).toEqual([
      ['/invoicing/invoices/new', '/invoicing/invoices/new?type=credit_note', '/invoicing/proforma/new'],
      ['/invoicing/cash-sales/new'],
      ['/invoicing/bills/new', '/inventory/movements/new'],
      ['/invoicing/internal-orders/new', '/invoicing/orders/new', '/invoicing/reservations/new'],
    ])
  })

  it('a cashier is not offered the goods receipt it may not save', () => {
    expect(ids(role('sales')).flat()).not.toContain('/inventory/movements/new')
    expect(ids(role('sales')).flat()).toContain('/invoicing/cash-sales/new')
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
      '/invoicing/cash-sales/new': '/api/org/:orgId/invoices',
      '/invoicing/bills/new': '/api/org/:orgId/invoices',
      '/inventory/movements/new': '/api/org/:orgId/warehouse/movement',
      '/invoicing/internal-orders/new': '/api/org/:orgId/invoicing/internal-orders',
      '/invoicing/orders/new': '/api/org/:orgId/invoicing/orders',
      '/invoicing/reservations/new': '/api/org/:orgId/invoicing/reservations',
    }
    for (const { pageId } of NEW_DOCUMENT_MENU.flat()) {
      const rule = writeRuleFor('POST', saves[pageId])
      expect(rule && 'need' in rule ? [...rule.need] : null, pageId).toEqual([...page(pageId).need!])
    }
  })
})

describe('APP_NAV_META mirrors APP_REGISTRY', () => {
  it('in base path, dev port, permission and colour', () => {
    for (const [id, meta] of Object.entries(APP_NAV_META)) {
      const reg = APP_REGISTRY[id as keyof typeof APP_REGISTRY]
      expect(reg, id).toBeDefined()
      expect(`${meta.base}/`).toBe(reg.path)
      expect(meta.devPort).toBe(reg.devPort)
      expect(meta.permission).toBe(reg.requiredPermission)
      expect(meta.color).toBe(reg.color)
    }
    expect(Object.keys(APP_NAV_META).sort()).toEqual(Object.keys(APP_REGISTRY).sort())
  })
})

describe('open-page helpers', () => {
  it('routerAppId names the app a router serves, from its history base', () => {
    expect(routerAppId('/invoicing')).toBe('invoicing')
    expect(routerAppId('/inventory/')).toBe('inventory')
    expect(routerAppId('')).toBeNull() // the portal
    expect(routerAppId('/invoicingX')).toBeNull()
  })

  it('appRelativePath is the path inside the page’s own app', () => {
    expect(appRelativePath(page('/invoicing/invoices/new?type=credit_note'))).toBe('/invoices/new?type=credit_note')
    expect(appRelativePath(page('/inventory/movements/new'))).toBe('/movements/new')
    // FR-24 Phase 0: a POS page is a route of the invoicing SPA, named as that router names it.
    expect(appRelativePath({ appId: 'pos', path: '/invoicing/pos' })).toBe('/pos')
    expect(appRelativePath(page('/invoicing/pos/terminal'))).toBe('/pos/terminal')
  })

  // FR-24 Phase 0: one document serves POS and invoicing, so the till's printer survives the hop.
  it('POS is served by the invoicing SPA; every other app by its own', () => {
    expect(spaOf('pos')).toBe('invoicing')
    for (const id of Object.keys(APP_NAV_META).filter(id => id !== 'pos')) expect(spaOf(id)).toBe(id)
  })

  it('routerPathFor keeps a path of this SPA inside the router, and hands any other back', () => {
    // The two things routerPathFor reads: the history base, and whether the path resolves here.
    const known = new Set(['/pos/', '/pos/terminal', '/', '/invoices'])
    const router = {
      options: { history: { base: '/invoicing/' } },
      resolve: (p: string) => ({ matched: known.has(p) ? [{}] : [] }),
    } as any
    expect(routerPathFor('/invoicing/pos/', router)).toBe('/pos/')
    expect(routerPathFor('/invoicing/pos/terminal', router)).toBe('/pos/terminal')
    expect(routerPathFor('/invoicing/', router)).toBe('/')
    expect(routerPathFor('/invoicing/invoices', router)).toBe('/invoices')
    expect(routerPathFor('/inventory/', router)).toBeNull()
    expect(routerPathFor('/invoicingX/', router)).toBeNull()
  })

  it('remaps favourites pinned on the old /pos/* pages', () => {
    for (const old of ['/pos/terminal', '/pos/orders', '/pos/sessions', '/pos/devices']) {
      expect(pageById(currentPageId(old))?.appId).toBe('pos')
    }
  })
})
