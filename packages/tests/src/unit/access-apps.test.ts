import { describe, it, expect } from 'bun:test'
import { APP_IDS, APP_REGISTRY, DEFAULT_ROLE_PERMISSIONS, ROLES } from 'config/constants'
import { ROLE_TEMPLATES, appsOpenedBy, compileLegacy, templateGrant, type CapabilityId, type Grant } from 'config/access'

/**
 * FR-27.5 (#529) — the App Hub's tiles in an org on `roles`: the apps whose pages the role opens (`PAGE_ACCESS`), from
 * the live grant, instead of the token's permissions (the role's legacy projection).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })
/** The legacy App Hub's answer (`app-hub.service`): the app's permission, or one that also opens it; an admin every app. */
const legacyTiles = (role: string, perms: readonly string[]) =>
  APP_IDS.filter(a => role === 'admin' || [APP_REGISTRY[a].requiredPermission, ...(APP_REGISTRY[a].alsoOpenedBy ?? [])].some(p => perms.includes(p)))

describe('appsOpenedBy: the apps whose pages a role opens', () => {
  it('an Administrator every app; no grant none', () => {
    expect(appsOpenedBy({ all: true })).toEqual([...APP_IDS])
    expect(appsOpenedBy(null)).toEqual([])
    expect(appsOpenedBy(caps())).toEqual([])
  })

  it('one page of an app is enough, whatever legacy permission the role holds only part of', () => {
    expect(appsOpenedBy(caps('products.view'))).toEqual(['inventory'])
    expect(appsOpenedBy(caps('sales-docs.view'))).toEqual(['invoicing'])
    expect(appsOpenedBy(caps('reports.view'))).toEqual(['reports'])
    expect(appsOpenedBy(caps('products.view', 'sales-docs.view'))).toEqual(['inventory', 'invoicing'])
  })

  it("a lookup opens no page, so no app: an invoice form's product reads are not the Inventory app", () => {
    expect(appsOpenedBy(caps('products.lookup', 'contacts.lookup'))).toEqual([])
  })

  it("each built-in role's tiles are its legacy tiles, but the Warehouse Manager's, which opens Invoicing's orders, contacts and devices", () => {
    for (const role of ROLES) {
      const perms = (DEFAULT_ROLE_PERMISSIONS as Record<string, readonly string[]>)[role] ?? []
      const pages = appsOpenedBy(compileLegacy({ role, permissions: perms }))
      const legacy = legacyTiles(role, perms)
      if (role === 'warehouse_manager') expect({ role, pages }).toEqual({ role, pages: [...new Set([...legacy, 'invoicing'])].sort((a, b) => APP_IDS.indexOf(a) - APP_IDS.indexOf(b)) })
      else expect({ role, pages }).toEqual({ role, pages: legacy })
    }
  })

  it('the Seller and the Sales Consultant templates open Inventory and Invoicing', () => {
    const keys = ROLE_TEMPLATES.map(t => t.key)
    for (const key of ['seller', 'sales_consultant']) {
      expect(keys).toContain(key)
      expect(appsOpenedBy(templateGrant(key))).toEqual(['inventory', 'invoicing'])
    }
  })
})
