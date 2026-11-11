import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { AREAS, holdsArea, type Area } from 'config/constants'
import { ROLE_TEMPLATES, grantHoldsArea, projectGrant, templateGrant, type CapabilityId, type Grant } from 'config/access'
import { startPage, viewerHoldsArea, type PageViewer } from 'ui-shared/nav/page-registry'

/**
 * FR-27.5 (#529) — the client's area-wide gates (the portal: the App Hub, the Dashboard, Settings and the Portal tile;
 * the Products page's export) follow the live role where one decides, not the token's claims. The claims are the
 * role's legacy projection, which may carry no `areas` list (every area) for a role that holds nothing of one, and
 * do not change until the next sign-in. Where the claims decide, the answer is `holdsArea`'s, exactly as before.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })

describe('grantHoldsArea: an FR-26 area, asked of a role', () => {
  it('an Administrator holds every area; no grant holds none', () => {
    for (const a of AREAS) {
      expect(grantHoldsArea({ all: true }, a)).toBe(true)
      expect(grantHoldsArea(null, a)).toBe(false)
    }
  })

  it('holds an area where it holds anything of it, a whole feature or the one action the area carves out', () => {
    expect(grantHoldsArea(caps('dashboard.view'), 'portal')).toBe(true)
    expect(grantHoldsArea(caps('users.view'), 'portal')).toBe(true)
    expect(grantHoldsArea(caps('products.export'), 'catalogExport')).toBe(true)
    expect(grantHoldsArea(caps('bills.view'), 'purchases')).toBe(true)
    expect(grantHoldsArea(caps('stock-levels.view'), 'stockControl')).toBe(true)
    // `stock-levels.lookup` is the product page reading levels: not the area's page.
    expect(grantHoldsArea(caps('stock-levels.lookup'), 'stockControl')).toBe(false)
    expect(grantHoldsArea(caps('sales-docs.view', 'products.view'), 'portal')).toBe(false)
    expect(grantHoldsArea(caps('products.view'), 'catalogExport')).toBe(false)
  })

  it("is what each built-in role's projection lists, where it lists areas", () => {
    let listed = 0
    for (const t of ROLE_TEMPLATES) {
      const grant = templateGrant(t.key)
      const areas = projectGrant(grant).legacy.areas
      if (!areas) continue
      listed++
      expect({ key: t.key, areas: [...areas].sort() }).toEqual({ key: t.key, areas: AREAS.filter(a => grantHoldsArea(grant, a)).sort() })
    }
    expect(listed).toBeGreaterThan(0) // the Seller and the Sales Consultant
  })
})

describe('viewerHoldsArea: the live role where one decides, else the claims', () => {
  // A role of sales documents and products, and nothing of the portal. Its token's claims carry no `areas` list.
  const clerkClaims: PageViewer = { role: 'member', permissions: ['invoicing.read', 'inventory.read'] }
  const live = (grant: Grant): PageViewer => ({ ...clerkClaims, grant })

  it('the claims decide: holdsArea, unchanged, for every area', () => {
    const shapes: PageViewer[] = [
      clerkClaims,
      { role: 'member', permissions: ['invoicing.read'], areas: ['orders'] },
      { role: 'member', permissions: [], areas: [] },
      { role: 'admin', permissions: [], areas: [] },
    ]
    for (const who of shapes) for (const a of AREAS) expect(viewerHoldsArea(who, a as Area)).toBe(holdsArea(who as any, a as Area))
    expect(viewerHoldsArea(null, 'portal')).toBe(false)
  })

  it("a role decides, live: no portal and no export where the role holds none, though the claims list no areas", () => {
    const role = live(caps('sales-docs.view', 'products.view', 'products.lookup'))
    expect(holdsArea(role as any, 'portal')).toBe(true) // what the token says
    expect(viewerHoldsArea(role, 'portal')).toBe(false)
    expect(viewerHoldsArea(role, 'catalogExport')).toBe(false)
    expect(startPage(role)).not.toBe('/dashboard')
  })

  it('an edit that gives the portal or the export back reaches the same gates', () => {
    const role = live(caps('sales-docs.view', 'products.view', 'products.export', 'dashboard.view'))
    expect(viewerHoldsArea(role, 'portal')).toBe(true)
    expect(viewerHoldsArea(role, 'catalogExport')).toBe(true)
    expect(startPage(role)).toBe('/dashboard')
    expect(viewerHoldsArea(live({ all: true }), 'portal')).toBe(true)
  })
})

describe('ratchet: no client gate reads an FR-26 area from the token', () => {
  const ROOT = join(import.meta.dir, '..', '..', '..', '..')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(vue|ts)$/.test(p) && !p.endsWith('.d.ts')) out.push(p)
    }
    return out
  }
  const files = readdirSync(join(ROOT, 'packages'))
    .filter(p => p.endsWith('-ui') || p === 'ui-shared' || p === 'ui-shell')
    .flatMap(p => {
      try { return walk(join(ROOT, 'packages', p, 'src')) } catch { return [] }
    })
    .map(p => ({ file: relative(join(ROOT, 'packages'), p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

  /** `legacyCanOpenPage` (the differential test's oracle, until Phase 3) and `viewerHoldsArea`'s own legacy branch. */
  const ALLOWED = new Set(['ui-shared/src/nav/page-registry.ts'])

  it('finds the client sources', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('holdsArea is called only by page-registry: every other gate asks viewerHoldsArea or the grant', () => {
    expect(files.filter(f => /\bholdsArea\s*\(/.test(f.text) && !ALLOWED.has(f.file)).map(f => f.file)).toEqual([])
  })
})
