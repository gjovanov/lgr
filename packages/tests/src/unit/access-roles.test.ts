import { describe, it, expect } from 'bun:test'
import { DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, ROLE_PERMISSION_SET_NAMES, type Role } from 'config/constants'
import {
  ROLE_TEMPLATES, can, compileLegacy, grantOfRole, legacyClaimsOf, legacyKeyOf, sameGrant, templateGrant, unknownCaps,
} from 'config/access'

/**
 * FR-27.3 (#529) — the built-in roles grant today's access of their legacy role, and a stored role grants what it
 * says and nothing it does not.
 */

describe('the built-in templates', () => {
  it('one per legacy role, under the names people know', () => {
    expect(ROLE_TEMPLATES.map(t => t.key)).toEqual([...ROLES])
    expect(new Set(ROLE_TEMPLATES.map(t => t.name)).size).toBe(ROLES.length)
    for (const [role, name] of Object.entries(ROLE_PERMISSION_SET_NAMES)) {
      expect({ role, name: ROLE_TEMPLATES.find(t => t.key === role)?.name }).toEqual({ role, name })
    }
  })

  it("each grants exactly what its role's defaults give today", () => {
    for (const role of ROLES) {
      const areas = DEFAULT_ROLE_AREAS[role as Role]
      const today = compileLegacy({ role, permissions: DEFAULT_ROLE_PERMISSIONS[role], ...(areas ? { areas } : {}) })
      expect({ role, same: sameGrant(templateGrant(role), today) }).toEqual({ role, same: true })
    }
  })

  it('the Administrator holds everything', () => {
    expect(templateGrant('admin').all).toBe(true)
    expect(grantOfRole({ all: true }).all).toBe(true)
  })
})

describe('a stored role', () => {
  it('built-in and never edited: its template, whatever caps it stored', () => {
    expect(sameGrant(grantOfRole({ isBuiltin: true, edited: false, templateKey: 'seller', caps: [] }), templateGrant('seller'))).toBe(true)
  })

  it('edited, or custom: what it was saved with', () => {
    const g = grantOfRole({ isBuiltin: true, edited: true, templateKey: 'seller', caps: ['products.view'] })
    expect(can(g, 'products.view')).toBe(true)
    expect(can(g, 'sales-docs.view')).toBe(false)
  })

  it('an id the catalogue does not know is no grant, and is listed (FR-27.8)', () => {
    const role = { caps: ['products.view', 'products.teleport'] }
    expect(can(grantOfRole(role), 'products.view')).toBe(true)
    expect(unknownCaps(role)).toEqual(['products.teleport'])
  })
})

describe('legacyClaimsOf: what tokenize() reads', () => {
  it('no set: the role defaults, the own list on top, the role areas', () => {
    expect(legacyClaimsOf({ role: 'member', permissions: ['inventory.write'] }, [])).toMatchObject({
      role: 'member', permissions: [...DEFAULT_ROLE_PERMISSIONS.member, 'inventory.write'],
    })
    expect(legacyClaimsOf({ role: 'seller' }, []).areas).toEqual([])
    expect(legacyClaimsOf({ role: 'member' }, []).areas).toBeUndefined()
  })

  it('sets: their union, every permission for an admin set, the areas merged', () => {
    expect(legacyClaimsOf({ role: 'member', permissions: ['payroll.read'] }, [{ permissions: ['invoicing.read'] }, { permissions: ['pos.read'] }]).permissions).toEqual(['invoicing.read', 'pos.read'])
    expect(legacyClaimsOf({ role: 'member' }, [{ permissions: [], isAdmin: true }]).permissions).toEqual([...PERMISSIONS])
    expect(legacyClaimsOf({ role: 'member' }, [{ areas: [] }, { areas: ['orders'] }]).areas).toEqual(['orders'])
    expect(legacyClaimsOf({ role: 'member' }, [{ areas: [] }, {}]).areas).toBeUndefined()
  })

  it('legacyKeyOf: the same access, the same key, whatever the order', () => {
    expect(legacyKeyOf({ role: 'member', permissions: ['b', 'a'] })).toBe(legacyKeyOf({ role: 'member', permissions: ['a', 'b'] }))
    expect(legacyKeyOf({ role: 'member', permissions: [], areas: [] })).not.toBe(legacyKeyOf({ role: 'member', permissions: [] }))
  })
})
