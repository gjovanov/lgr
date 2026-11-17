import { describe, it, expect } from 'bun:test'
import { visibleMenu, type ModuleMenuItem } from '../../../ui-shell/src/module'
import {
  PAGE_REGISTRY, canOpenPage, isPortalAreaPath, isTransferOnly, landingWithoutPortal, newDocumentMenu, pageById,
  exportsCatalog, holdsPortal, portalPagesFor, runsDevices, writesInventory, type PageViewer,
} from 'ui-shared/nav/page-registry'
import { ROLES, type Role } from 'config/constants'
import { ALL, accessRuleFor, templateGrant, type CapabilityId } from 'config/access'
import { accessRefusal } from 'services/biz/access/evaluate'
import { manifest as inventory } from '../../../inventory-ui/src/manifest'
import { manifest as invoicing } from '../../../invoicing-ui/src/manifest'

/**
 * FR-26: what the Seller and the Sales Consultant see (§2.1), as the menus, „+ Нов", the portal
 * and the route rules decide it. The server side over HTTP is `integration/seller-roles.flow`.
 *
 * FR-27 P3-6 (#529): each person is their built-in role's grant (`templateGrant`); FR-26's areas are the capabilities
 * the two roles' templates leave out, so the answers below are the ones the areas gave.
 */

const as = (r: Role): PageViewer => ({ grant: templateGrant(r) })
const admin: PageViewer = { grant: ALL }
const caps = (...c: CapabilityId[]): PageViewer => ({ grant: { caps: new Set(c) } })
const seller = as('seller')
const consultant = as('sales_consultant')
const entries = (menu: ModuleMenuItem[], who: PageViewer) => visibleMenu(menu, who).flatMap(g => (g.children ?? [g]).filter(c => c.to).map(c => c.to))

describe('the two roles', () => {
  it('neither role holds accounting, payroll, reports or admin; both transfer and write no other movement', () => {
    for (const role of ['seller', 'sales_consultant'] as const) {
      const held = [...templateGrant(role).caps]
      expect(held.filter(c => /^(accounts|journal|ledgers|vat|payroll-[a-z]+|reports|audit-log|roles|users)\./.test(c))).toEqual([])
      expect(held).toContain('movements.create:transfer')
      expect(held).not.toContain('movements.create')
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
    for (const [role, who] of [['seller', seller], ['sales_consultant', consultant]] as const) expect({ role, closed: PAGES.filter(id => !canOpenPage(pageById(id)!, who)) }).toEqual({ role, closed: [] })
  })

  it('Devices are read-only to both: the server runs them with devices.edit alone (D-8)', () => {
    expect(runsDevices(seller)).toBe(false)
    expect(runsDevices(consultant)).toBe(false)
    expect(runsDevices(as('sales'))).toBe(false)
    // The built-in roles that run them (FISCAL_ADMIN_ROLES until FR-27 P3-6), and nobody else.
    expect(ROLES.filter(r => runsDevices(as(r)))).toEqual(['admin', 'manager', 'warehouse_manager'])
    expect(runsDevices(caps('devices.edit'))).toBe(true)
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
    expect(entries(inventory.menu!, admin)).toEqual(all)
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
  it('a Seller opens no page of Accounting, Payroll, Reports or Files, and none of the parts FR-26 carved out', () => {
    const opened = PAGE_REGISTRY.filter(p => canOpenPage(p, seller))
    expect(opened.filter(p => ['accounting', 'payroll', 'reports', 'files'].includes(p.appId))).toEqual([])
    const carved = ['/invoicing/orders', '/invoicing/internal-orders', '/invoicing/reservations', '/invoicing/bills', '/invoicing/payment-orders', '/invoicing/cash-orders', '/inventory/stock-levels', '/inventory/inventory-counts', '/inventory/inventory-valuation', '/inventory/opening-stock', '/inventory/price-lists', '/inventory/bulk-pricing']
    expect(opened.map(p => p.id).filter(id => carved.some(c => id === c || id.startsWith(`${c}/`)))).toEqual([])
  })

  it('Sequences is admin and manager only, as the server decides', () => {
    const sequences = pageById('/invoicing/configuration/sequences')!
    expect(canOpenPage(sequences, as('manager'))).toBe(true)
    expect(canOpenPage(sequences, admin)).toBe(true)
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
    expect(landingWithoutPortal(caps('sales-docs.view'))).toBe('/invoicing/')
    expect(landingWithoutPortal(caps())).toBe('/account')
  })

  it('the portal is any capability of its pages, and the catalog export is products.export (FR-26 areas until P3-6)', () => {
    expect([seller, consultant].map(holdsPortal)).toEqual([false, false])
    expect(ROLES.filter(r => r !== 'seller' && r !== 'sales_consultant').every(r => holdsPortal(as(r)))).toBe(true)
    expect(holdsPortal(caps('audit-log.view'))).toBe(true)
    expect(holdsPortal(caps('sales-docs.view'))).toBe(false)
    expect([seller, consultant, as('member'), admin].map(exportsCatalog)).toEqual([false, false, true, true])
    expect(holdsPortal(null)).toBe(false)
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
    expect(isTransferOnly(admin)).toBe(false)
    expect(writesInventory(seller)).toBe(false)
    expect(writesInventory(as('warehouse_manager'))).toBe(true)
  })

  it('a movement write takes a movement capability, a transfer one included; a product write takes products', () => {
    const movement = accessRuleFor('POST', 'warehouse/movement')
    expect(movement && 'anyOf' in movement ? [...movement.anyOf] : movement).toEqual(expect.arrayContaining(['movements.create', 'movements.create:transfer']))
    const user = (who: PageViewer) => ({ id: 'u', orgId: 'o', access: who.grant })
    expect(accessRefusal(user(seller), 'POST', '/api/org/:orgId/warehouse/movement')).toBeNull()
    expect(accessRefusal(user(seller), 'POST', '/api/org/:orgId/warehouse/product')?.code).toBe('permission_required')
  })
})

describe('the route rules (FR-26.6): the parts carved out, as capabilities', () => {
  const user = (who: PageViewer) => ({ id: 'u', orgId: 'o', access: who.grant })
  it('the Sales Consultant reaches the orders and nothing else carved out; the Seller none of them', () => {
    expect(accessRefusal(user(consultant), 'GET', '/api/org/:orgId/invoicing/orders')).toBeNull()
    expect(accessRefusal(user(consultant), 'POST', '/api/org/:orgId/invoicing/reservations')).toBeNull()
    expect(accessRefusal(user(consultant), 'GET', '/api/org/:orgId/invoicing/payment-order')?.code).toBe('permission_required')
    expect(accessRefusal(user(seller), 'GET', '/api/org/:orgId/invoicing/orders')?.code).toBe('permission_required')
  })

  it('what a kept page needs stays open to both', () => {
    for (const who of [seller, consultant]) {
      for (const [method, rest] of [['GET', 'invoicing/contact'], ['GET', 'pricing/resolve'], ['GET', 'warehouse/stock-level'], ['GET', 'invoices'], ['POST', 'invoicing/stock-availability/check']] as const) {
        expect({ rest, refused: accessRefusal(user(who), method, `/api/org/:orgId/${rest}`) }).toEqual({ rest, refused: null })
      }
    }
  })
})
