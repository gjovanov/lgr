import { describe, it, expect } from 'bun:test'
import { visibleMenu, type ModuleMenuItem } from '../../../ui-shell/src/module'
import {
  PAGE_REGISTRY, canOpenPage, isPortalAreaPath, isTransferOnly, landingWithoutPortal, newDocumentMenu, pageById,
  portalPagesFor, runsDevices, writesInventory, type PageViewer,
} from 'ui-shared/nav/page-registry'
import { AREAS, DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, FISCAL_ADMIN_ROLES, holdsArea, mergeAreas, type Role } from 'config/constants'
import { AREA_PREFIXES, areaForRoute, areaRefusal, permissionRefusal, writeRuleFor } from 'services/biz/route-permission'
import { manifest as inventory } from '../../../inventory-ui/src/manifest'
import { manifest as invoicing } from '../../../invoicing-ui/src/manifest'

/**
 * FR-26: what the Seller and the Sales Consultant see (§2.1), as the menus, „+ Нов", the portal
 * and the route rules decide it. The server side over HTTP is `integration/seller-roles.flow`.
 */

const as = (r: Role): PageViewer => ({ role: r, permissions: DEFAULT_ROLE_PERMISSIONS[r], ...(DEFAULT_ROLE_AREAS[r] ? { areas: DEFAULT_ROLE_AREAS[r] } : {}) })
const seller = as('seller')
const consultant = as('sales_consultant')
const entries = (menu: ModuleMenuItem[], who: PageViewer) => visibleMenu(menu, who).flatMap(g => (g.children ?? [g]).filter(c => c.to).map(c => c.to))

describe('the claim: absent and [] are opposites', () => {
  it('holdsArea: absent opens every area, [] none, a list its own; admin always', () => {
    for (const area of AREAS) {
      expect(holdsArea({ role: 'member' }, area)).toBe(true)
      expect(holdsArea({ role: 'member', areas: [] }, area)).toBe(false)
      expect(holdsArea({ role: 'admin', areas: [] }, area)).toBe(true)
    }
    expect(holdsArea({ role: 'member', areas: ['orders'] }, 'orders')).toBe(true)
    expect(holdsArea({ role: 'member', areas: ['orders'] }, 'purchases')).toBe(false)
    expect(holdsArea(null, 'orders')).toBe(false)
  })

  it('mergeAreas: an admin set or one without areas wins; otherwise the union', () => {
    expect(mergeAreas([{ areas: [] }])).toEqual([])
    expect(mergeAreas([{ areas: [] }, { areas: ['orders'] }])).toEqual(['orders'])
    expect(mergeAreas([{ areas: ['pricing'] }, { areas: ['orders'] }])).toEqual(['orders', 'pricing'])
    expect(mergeAreas([{ areas: [] }, {}])).toBeUndefined()
    expect(mergeAreas([{ areas: [] }, { isAdmin: true, areas: [] }])).toBeUndefined()
    expect(mergeAreas([])).toBeUndefined()
  })

  it('only the two new roles are held to areas', () => {
    expect(Object.keys(DEFAULT_ROLE_AREAS).sort()).toEqual(['sales_consultant', 'seller'])
    for (const role of Object.keys(DEFAULT_ROLE_PERMISSIONS) as Role[]) {
      if (role === 'seller' || role === 'sales_consultant') continue
      expect(as(role).areas).toBeUndefined()
    }
  })

  it('neither role holds accounting, payroll, reports or admin', () => {
    for (const role of ['seller', 'sales_consultant'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role].filter(p => /^(accounting|payroll|reports|admin)\./.test(p))).toEqual([])
      expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain('inventory.transfer')
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain('inventory.write')
    }
  })
})

describe('the invoicing menu (§2.1)', () => {
  it('the Seller: sales documents, the till, contacts and devices', () => {
    // The offers ride on the proforma's capabilities: whoever quotes with a proforma quotes with an offer too.
    expect(entries(invoicing.menu!, seller)).toEqual(['/invoices', '/proforma', '/offer', '/cash-sales/new', '/cash-sales', '/cash-register/sessions', '/contacts', '/configuration/devices'])
  })

  it('the Sales Consultant: the same, and the Orders group', () => {
    const shown = entries(invoicing.menu!, consultant)
    expect(shown).toEqual(expect.arrayContaining(['/orders', '/internal-orders', '/reservations', '/invoices', '/contacts']))
    expect(shown).not.toContain('/bills')
    expect(shown).not.toContain('/payment-orders')
    expect(shown).not.toContain('/cash-orders')
    expect(shown).not.toContain('/configuration/sequences')
  })
})

describe('what both roles view in Invoicing (§2.1)', () => {
  // Outgoing documents and their forms, the till, Contacts and Devices.
  const PAGES = [
    '/invoicing/invoices', '/invoicing/invoices/new', '/invoicing/invoices/new?type=credit_note', '/invoicing/invoices/new?type=debit_note',
    '/invoicing/proforma', '/invoicing/proforma/new', '/invoicing/offer', '/invoicing/offer/new',
    '/invoicing/cash-sales/new', '/invoicing/cash-sales', '/invoicing/cash-register/sessions',
    '/invoicing/contacts', '/invoicing/configuration/devices',
  ]

  it('each opens every one of them', () => {
    for (const who of [seller, consultant]) expect({ role: who.role, closed: PAGES.filter(id => !canOpenPage(pageById(id)!, who)) }).toEqual({ role: who.role, closed: [] })
  })

  it('Devices are read-only to both: the server runs them for FISCAL_ADMIN_ROLES alone (D-8)', () => {
    expect(runsDevices(seller)).toBe(false)
    expect(runsDevices(consultant)).toBe(false)
    expect(runsDevices(as('sales'))).toBe(false)
    for (const role of FISCAL_ADMIN_ROLES) expect(runsDevices({ role, permissions: [] })).toBe(true)
    expect(runsDevices(null)).toBe(false)
  })

  it("a document's journal entry is no link of theirs: Accounting is not theirs to see", () => {
    for (const who of [seller, consultant]) expect(canOpenPage(pageById('/accounting/journal-entries')!, who)).toBe(false)
    expect(canOpenPage(pageById('/accounting/journal-entries')!, as('accountant'))).toBe(true)
  })
})

describe('the inventory menu (FR-26.8.2)', () => {
  it('the Seller: products, categories, warehouses and movements; no prices or stock control', () => {
    expect(entries(inventory.menu!, seller)).toEqual(['/products', '/categories', '/warehouses', '/movements'])
  })

  it('whoever holds inventory and no areas keeps all of it', () => {
    const all = inventory.menu!.flatMap(g => g.children!.map(c => c.to))
    expect(entries(inventory.menu!, as('warehouse_manager'))).toEqual(all)
    expect(entries(inventory.menu!, { role: 'admin', permissions: [] })).toEqual(all)
  })
})

describe('„+ Нов" (FR-26.8.6)', () => {
  const menu = (who: PageViewer) => newDocumentMenu(who).flat().map(i => `${i.page.id} ${i.labelKey}`)

  it('a transfer-only session sees a stock movement; whoever makes a receipt keeps the receipt', () => {
    expect(menu(seller)).toContain('/inventory/movements/new nav.newDoc.stockMovement')
    expect(menu(as('warehouse_manager'))).toContain('/inventory/movements/new nav.newDoc.goodsReceipt')
    expect(pageById('/inventory/movements/new')!.labelKey).toBe('nav.newDocPage.stockMovement')
  })

  it('the Seller makes no bill and no order; the Sales Consultant makes orders', () => {
    expect(menu(seller).map(l => l.split(' ')[0])).toEqual([
      '/invoicing/invoices/new', '/invoicing/invoices/new?type=credit_note', '/invoicing/proforma/new', '/invoicing/offer/new', '/invoicing/cash-sales/new', '/inventory/movements/new',
    ])
    expect(menu(consultant).map(l => l.split(' ')[0])).toEqual(expect.arrayContaining(['/invoicing/internal-orders/new', '/invoicing/orders/new', '/invoicing/reservations/new']))
    expect(menu(consultant).map(l => l.split(' ')[0])).not.toContain('/invoicing/bills/new')
  })
})

describe('★ and the page search', () => {
  it('a Seller opens no page of Accounting, Payroll, Reports or Files, and none of an area it lacks', () => {
    const opened = PAGE_REGISTRY.filter(p => canOpenPage(p, seller))
    expect(opened.filter(p => ['accounting', 'payroll', 'reports', 'files'].includes(p.appId))).toEqual([])
    expect(opened.filter(p => p.area)).toEqual([])
  })

  it('Sequences is admin and manager only, as the server decides', () => {
    const sequences = pageById('/invoicing/configuration/sequences')!
    expect(canOpenPage(sequences, as('manager'))).toBe(true)
    expect(canOpenPage(sequences, { role: 'admin', permissions: [] })).toBe(true)
    for (const role of ['sales', 'accountant', 'seller', 'sales_consultant', 'member'] as const) expect(canOpenPage(sequences, as(role))).toBe(false)
  })
})

describe('the portal (FR-26.8.4)', () => {
  it('a Seller has none of its pages, and lands on Products (#493 item 3)', () => {
    expect(portalPagesFor(seller)).toEqual([])
    expect(portalPagesFor(consultant)).toEqual([])
    expect(landingWithoutPortal(seller)).toBe('/inventory/products')
    expect(landingWithoutPortal(consultant)).toBe('/inventory/products')
    expect(portalPagesFor(as('sales'))).toContain('/dashboard')
  })

  it('a session without the portal that cannot open Products lands in its first app, as before', () => {
    expect(landingWithoutPortal({ role: 'member', permissions: ['invoicing.read'], areas: [] })).toBe('/invoicing/')
    expect(landingWithoutPortal({ role: 'member', permissions: [], areas: [] })).toBe('/account')
  })

  it('the paths a session without the portal does not reach', () => {
    for (const p of ['/', '/apps', '/dashboard', '/settings/users', '/admin/audit-log']) expect({ p, v: isPortalAreaPath(p) }).toEqual({ p, v: true })
    for (const p of ['/account', '/orgs', '/invite/abc', '/auth/login', '/invoicing/invoices']) expect({ p, v: isPortalAreaPath(p) }).toEqual({ p, v: false })
  })
})

describe('transfers only', () => {
  it('who writes transfers only, and who writes the inventory', () => {
    expect(isTransferOnly(seller)).toBe(true)
    expect(isTransferOnly(as('warehouse_manager'))).toBe(false)
    expect(isTransferOnly({ role: 'admin', permissions: ['inventory.transfer'] })).toBe(false)
    expect(writesInventory(seller)).toBe(false)
    expect(writesInventory(as('warehouse_manager'))).toBe(true)
  })

  it('a movement write needs inventory.write or inventory.transfer; the rest of the warehouse inventory.write', () => {
    const movement = writeRuleFor('POST', '/api/org/:orgId/warehouse/movement')
    expect(movement && 'need' in movement ? [...movement.need] : null).toEqual(['inventory.write', 'inventory.transfer'])
    expect(permissionRefusal(seller, 'POST', '/api/org/:orgId/warehouse/movement')).toBeNull()
    expect(permissionRefusal(seller, 'POST', '/api/org/:orgId/warehouse/product')?.code).toBe('permission_required')
  })
})

describe('the route rules (FR-26.6)', () => {
  it('each area prefix refuses a session without it, reads and writes alike, and nobody else', () => {
    for (const [prefix, area] of AREA_PREFIXES) {
      const route = `/api/org/:orgId/${prefix}`
      expect(areaForRoute(route)).toBe(area)
      expect(areaRefusal({ role: 'member', areas: [] }, route)?.area).toBe(area)
      expect(areaRefusal({ role: 'member' }, route)).toBeNull()
      expect(areaRefusal({ role: 'admin', areas: [] }, route)).toBeNull()
    }
  })

  it('what a kept page needs is under no area', () => {
    for (const rest of ['invoicing/stock-availability/check', 'invoicing/contact', 'pricing/resolve', 'warehouse/stock-level', 'warehouse/movement', 'invoices', 'apps', 'user', '']) {
      expect({ rest, area: areaForRoute(`/api/org/:orgId/${rest}`) }).toEqual({ rest, area: undefined })
    }
  })

  it('the Sales Consultant reaches the orders and nothing else carved out', () => {
    expect(permissionRefusal(consultant, 'GET', '/api/org/:orgId/invoicing/orders')).toBeNull()
    expect(permissionRefusal(consultant, 'POST', '/api/org/:orgId/invoicing/reservations')).toBeNull()
    expect(permissionRefusal(consultant, 'GET', '/api/org/:orgId/invoicing/payment-order')?.code).toBe('area_required')
    expect(permissionRefusal(seller, 'GET', '/api/org/:orgId/invoicing/orders')?.code).toBe('area_required')
  })
})
