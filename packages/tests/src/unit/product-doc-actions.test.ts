import { describe, it, expect } from 'bun:test'
import { NEW_DOCUMENT_MENU, pageById, type PageViewer } from 'ui-shared/nav/page-registry'
import { DEFAULT_ROLE_PERMISSIONS, type Role } from 'config/constants'
// The rules the Products list and the product page offer their actions by (`inventory-ui` is a
// private app package).
import {
  INACTIVE_KEY,
  productDocActions,
  withProduct,
} from '../../../inventory-ui/src/composables/product-doc-actions'

/**
 * FR-22.47 — an article offers „Заприходи", „Продай" and „Резервирай", in the Products list's row
 * menu and on its own page; each opens the document with the article on its first line.
 *
 * Which of them a person sees is the „+ Нов" menu's rule (FR-22 §5.8): the form's PAGE_REGISTRY row
 * and the write permission its Save needs — `page-registry.test` holds those rows to the server's
 * write rules. On top of it: a service has no stock to receive or hold, and a deactivated article
 * is not sold or reserved (listed, disabled, with the reason).
 */

const ID = '6a1f00000000000000000001'
const article = { _id: ID }
const role = (r: Role): PageViewer => ({ role: r, permissions: DEFAULT_ROLE_PERMISSIONS[r] })
const keys = (who: PageViewer | null, product: Parameters<typeof productDocActions>[0] = article) =>
  productDocActions(product, who).map((a) => a.key)

describe('productDocActions — what an article offers (FR-22.47)', () => {
  it('opens the forms „+ Нов" opens, each on this article', () => {
    const actions = productDocActions(article, { role: 'admin', permissions: [] })
    expect(actions.map((a) => [a.key, a.appId, a.path])).toEqual([
      ['receive', 'inventory', `/inventory/movements/new?productId=${ID}`],
      ['sell', 'invoicing', `/invoicing/invoices/new?productId=${ID}`],
      ['reserve', 'invoicing', `/invoicing/reservations/new?productId=${ID}`],
    ])
    const menu = new Set(NEW_DOCUMENT_MENU.flat().map((e) => e.pageId))
    for (const a of actions) {
      const pageId = a.path.split('?')[0]
      expect(menu.has(pageId), pageId).toBe(true)
      // The icon and the document's name are the registry row's, as „+ Нов" shows them.
      expect(a.icon).toBe(pageById(pageId)!.icon)
      expect(a.pageLabelKey).toBe(pageById(pageId)!.labelKey)
      expect(a.disabledKey).toBeNull()
    }
    expect(actions.map((a) => a.labelKey)).toEqual([
      'warehouse.productActions.receive',
      'warehouse.productActions.sell',
      'warehouse.productActions.reserve',
    ])
  })

  it('offers each action only to a role whose Save the form\'s API takes', () => {
    expect(keys(role('admin'))).toEqual(['receive', 'sell', 'reserve'])
    expect(keys(role('manager'))).toEqual(['receive', 'sell', 'reserve'])
    // Moves stock, invoices nothing.
    expect(keys(role('warehouse_manager'))).toEqual(['receive'])
    // Sells and reserves; reads stock rather than moving it.
    expect(keys(role('sales'))).toEqual(['sell', 'reserve'])
    expect(keys(role('accountant'))).toEqual(['sell', 'reserve'])
    // Read-only roles, and nobody signed in.
    expect(keys(role('member'))).toEqual([])
    expect(keys(role('nra_auditor'))).toEqual([])
    expect(keys(role('hr_manager'))).toEqual([])
    expect(keys(null)).toEqual([])
  })

  it('a PIN session reaches the till alone, even an admin\'s', () => {
    expect(keys({ role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, amr: ['pin'] })).toEqual([])
  })

  it('a deactivated article is not sold or reserved: listed, disabled, with the reason', () => {
    const actions = productDocActions({ _id: ID, isActive: false }, role('admin'))
    expect(actions.map((a) => [a.key, a.disabledKey])).toEqual([
      // Goods still arrive for an article being phased out.
      ['receive', null],
      ['sell', INACTIVE_KEY],
      ['reserve', INACTIVE_KEY],
    ])
  })

  it('a service has no stock to receive or hold: it is only sold', () => {
    expect(keys(role('admin'), { _id: ID, trackInventory: false })).toEqual(['sell'])
    expect(keys(role('warehouse_manager'), { _id: ID, trackInventory: false })).toEqual([])
    const deactivated = productDocActions({ _id: ID, trackInventory: false, isActive: false }, role('admin'))
    expect(deactivated.map((a) => [a.key, a.disabledKey])).toEqual([['sell', INACTIVE_KEY]])
  })

  it('an article without the flags is active and stock-tracked, as everywhere else', () => {
    const legacy = productDocActions({ _id: ID }, role('admin'))
    expect(legacy.map((a) => a.key)).toEqual(['receive', 'sell', 'reserve'])
    expect(legacy.every((a) => a.disabledKey === null)).toBe(true)
    expect(keys(role('admin'), { _id: ID, isActive: true, trackInventory: true })).toEqual(['receive', 'sell', 'reserve'])
  })
})

describe('withProduct', () => {
  it('adds the article to the form\'s own query, encoded', () => {
    expect(withProduct('/invoicing/invoices/new', 'abc')).toBe('/invoicing/invoices/new?productId=abc')
    expect(withProduct('/invoicing/invoices/new?type=credit_note', 'abc')).toBe('/invoicing/invoices/new?type=credit_note&productId=abc')
    expect(withProduct('/inventory/movements/new', 'a b&c')).toBe('/inventory/movements/new?productId=a%20b%26c')
  })
})
