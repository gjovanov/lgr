import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, type Role } from 'config/constants'
import {
  CAPABILITIES, CATALOGUE, LEGACY_CANNOT_WITHHOLD, LEGACY_ROLE_WITHHOLDS, beyondLevel, can, compileLegacy, legacyClaimsOf, levelOf,
  levelsOf, projectGrant, sameGrant, summarize, templateDefaults, templateGrant, type CapabilityId, type Grant,
} from 'config/access'

/**
 * The owner, 2026-11-12: "Manual price, unavailable for Seller, but available for Sales Consultant."
 *
 * `sales-docs.manual-price`: a sales document line's price TYPED rather than picked from what the price engine offers.
 * Legacy: `invoicing.write` grants it, the Seller's role NAME withholds it (`LEGACY_ROLE_WITHHOLDS`), so nobody else's
 * access changes. Roles: the built-in templates follow, and the projection stays exact for both.
 */

const MANUAL: CapabilityId = 'sales-docs.manual-price'
/** What a person of this role holds with no permission set: the role's defaults and areas, as `tokenize()` reads them. */
const byRole = (role: Role): Grant => compileLegacy(legacyClaimsOf({ role }, []))
const set = (role: Role) => ({ permissions: [...DEFAULT_ROLE_PERMISSIONS[role]], areas: DEFAULT_ROLE_AREAS[role] ? [...DEFAULT_ROLE_AREAS[role]!] : undefined })

describe('the capability', () => {
  it('is a Sales documents action, an extra in the editor, and work rather than reading', () => {
    expect(CAPABILITIES.has(MANUAL)).toBe(true)
    const docs = CATALOGUE.find(f => f.id === 'sales-docs')!
    const l = levelsOf(docs)
    expect(l.extras).toContain(MANUAL)
    expect([...l.view, ...l.work, ...l.full]).not.toContain(MANUAL)
    // A role that reads sales documents and may type a price works on them: the summary does not call it read-only.
    const s = summarize({ caps: new Set<CapabilityId>(['sales-docs.view', MANUAL]) })
    expect(s.canCreate).toContain('sales-docs')
    expect(s.readOnly).not.toContain('sales-docs')
  })

  it('every name that withholds is a role, and withholds only catalogued capabilities', () => {
    for (const [role, caps] of Object.entries(LEGACY_ROLE_WITHHOLDS)) {
      expect((ROLES as readonly string[]).includes(role)).toBe(true)
      for (const c of caps ?? []) expect(CAPABILITIES.has(c)).toBe(true)
    }
    expect(LEGACY_ROLE_WITHHOLDS).toEqual({ seller: [MANUAL] })
  })
})

describe('the legacy model: who types a price', () => {
  it('by role, with no permission set', () => {
    const holds = Object.fromEntries(ROLES.map(r => [r, can(byRole(r), MANUAL)]))
    expect(holds).toEqual({
      admin: true, manager: true, accountant: true, hr_manager: false, warehouse_manager: false,
      sales: true, seller: false, sales_consultant: true, member: false, nra_auditor: false,
    })
  })

  it("the Seller and the Sales Consultant hold the same permissions: the role's NAME decides", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.seller).toEqual(DEFAULT_ROLE_PERMISSIONS.sales_consultant)
    // A Seller on the Sales Consultant's set does not type a price; a Sales Consultant on the Seller's set does.
    expect(can(compileLegacy(legacyClaimsOf({ role: 'seller' }, [set('sales_consultant')])), MANUAL)).toBe(false)
    expect(can(compileLegacy(legacyClaimsOf({ role: 'sales_consultant' }, [set('seller')])), MANUAL)).toBe(true)
    // Nor with `invoicing.write` given to the Seller by hand, nor with every permission there is (an `isAdmin` set).
    expect(can(compileLegacy(legacyClaimsOf({ role: 'seller', permissions: ['invoicing.write'] }, [])), MANUAL)).toBe(false)
    expect(can(compileLegacy(legacyClaimsOf({ role: 'seller' }, [{ isAdmin: true }])), MANUAL)).toBe(false)
    // A Seller loses nothing else: what his role gave before, but the typed price.
    const seller = byRole('seller') as { caps: ReadonlySet<CapabilityId> }
    const consultant = byRole('sales_consultant') as { caps: ReadonlySet<CapabilityId> }
    expect([...consultant.caps].filter(c => !seller.caps.has(c)).filter(c => !c.startsWith('orders.')).sort()).toEqual([MANUAL])
  })

  it('whoever writes documents types a price: `invoicing.write`, on any role but the Seller', () => {
    for (const role of ROLES) {
      if (role === 'admin') continue
      const g = compileLegacy({ role, permissions: ['invoicing.write'] })
      expect({ role, holds: can(g, MANUAL) }).toEqual({ role, holds: role !== 'seller' })
    }
    for (const p of PERMISSIONS) {
      if (p === 'invoicing.write') continue
      expect({ p, holds: can(compileLegacy({ role: 'member', permissions: [p] }), MANUAL) }).toEqual({ p, holds: false })
    }
  })
})

describe('the roles model: the built-in roles', () => {
  it('the templates follow the legacy roles: the Seller without, the Sales Consultant and Sales with', () => {
    expect(can(templateGrant('seller'), MANUAL)).toBe(false)
    expect(can(templateGrant('sales_consultant'), MANUAL)).toBe(true)
    expect(can(templateGrant('sales'), MANUAL)).toBe(true)
    expect(can(templateGrant('manager'), MANUAL)).toBe(true)
    expect(can(templateGrant('accountant'), MANUAL)).toBe(true)
    // A new organization's roles (FR-27.11.B) start from the template's defaults.
    expect(can(templateDefaults('seller'), MANUAL)).toBe(false)
    expect(can(templateDefaults('sales_consultant'), MANUAL)).toBe(true)
  })

  it('the editor shows it ticked on the Sales Consultant, unticked on the Seller', () => {
    const docs = CATALOGUE.find(f => f.id === 'sales-docs')!
    expect(levelOf(docs, templateGrant('seller'))).toBe(levelOf(docs, templateGrant('sales_consultant')))
    expect(beyondLevel(docs, templateGrant('sales_consultant'))).toContain(MANUAL)
    expect(beyondLevel(docs, templateGrant('seller'))).not.toContain(MANUAL)
  })
})

describe('the projection a release that reads no roles serves', () => {
  const served = (g: Grant) => compileLegacy(projectGrant(g).legacy)

  it('is exact for both templates, under the key that says it', () => {
    const seller = projectGrant(templateGrant('seller'))
    expect({ role: seller.legacy.role, exact: seller.exact, same: sameGrant(served(templateGrant('seller')), templateGrant('seller')) })
      .toEqual({ role: 'seller', exact: true, same: true })
    const consultant = projectGrant(templateGrant('sales_consultant'))
    expect({ exact: consultant.exact, same: sameGrant(served(templateGrant('sales_consultant')), templateGrant('sales_consultant')) })
      .toEqual({ exact: true, same: true })
    expect(can(served(templateGrant('sales_consultant')), MANUAL)).toBe(true)
  })

  it("a new organization's Seller (the template's defaults) projects to the Seller's key: no typed price", () => {
    const p = projectGrant(templateDefaults('seller'))
    expect(p.legacy.role).toBe('seller')
    expect(p.legacy.permissions).toContain('invoicing.write')
    expect(can(compileLegacy(p.legacy), MANUAL)).toBe(false)
  })

  it('a Sales Consultant made without the typed price is said exactly by the Seller key with its areas', () => {
    const consultant = templateGrant('sales_consultant') as { caps: ReadonlySet<CapabilityId> }
    const without: Grant = { caps: new Set([...consultant.caps].filter(c => c !== MANUAL)) }
    const p = projectGrant(without)
    expect({ role: p.legacy.role, areas: p.legacy.areas, exact: p.exact }).toEqual({ role: 'seller', areas: ['orders'], exact: true })
  })

  it('a key that only withholds is taken only where it serves more of the role', () => {
    // The Member lacks the typed price but writes nothing: its key stays.
    expect(projectGrant(templateGrant('member')).legacy.role).toBe('member')
    // Writing documents without the typed price, on top of a manager's name-given checks: the manager's key, less
    // `invoicing.write` (no key both gives those and withholds the price), so it is not exact, and never more.
    const manager = templateGrant('manager') as { caps: ReadonlySet<CapabilityId> }
    const p = projectGrant({ caps: new Set([...manager.caps].filter(c => c !== MANUAL)) })
    expect(p.exact).toBe(false)
    expect(can(compileLegacy(p.legacy), MANUAL)).toBe(false)
  })

  it('never projects a role holding the typed price to the Seller, nor serves it to one lacking it (2000 random roles)', () => {
    const all = [...CAPABILITIES] as CapabilityId[]
    let seed = 1112
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const failures: string[] = []
    for (let i = 0; i < 2000; i++) {
      const density = random()
      const grant: Grant = { caps: new Set(all.filter(() => random() < density)) }
      const p = projectGrant(grant)
      const out = compileLegacy(p.legacy)
      if (can(grant, MANUAL) && p.legacy.role === 'seller') failures.push(`role of ${(grant as any).caps.size} caps holding it projected to seller`)
      if (!can(grant, MANUAL) && can(out, MANUAL)) failures.push(`role of ${(grant as any).caps.size} caps lacking it served it`)
      const beyond = out.all ? ['*'] : [...out.caps].filter(c => !can(grant, c) && !LEGACY_CANNOT_WITHHOLD.includes(c))
      if (beyond.length) failures.push(`served beyond the role: ${beyond.join(', ')}`)
    }
    expect(failures.slice(0, 5)).toEqual([])
  })
})

describe('the words, in four locales', () => {
  const locale = (loc: string) => JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'ui-shared', 'src', 'locales', `${loc}.json`), 'utf8'))
  for (const loc of ['en', 'bg', 'de', 'mk']) {
    it(loc, () => {
      const l = locale(loc)
      expect(typeof l.access.action.manual_price).toBe('string')
      // The hint of a price field that takes only picks.
      expect(typeof l.invoicing.pricePickOnly).toBe('string')
    })
  }
})
