import { describe, it, expect } from 'bun:test'
import { createApiApp } from '../../../portal-api/src/api.js'
import { AREAS, DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, type Role } from 'config/constants'
import {
  EXACT_READS, EXACT_WRITES, LEGACY_BRIDGE, LEGACY_ROLE_CAPS, PAGE_ACCESS, READ_PREFIXES, WRITE_PREFIXES,
  accessRuleFor, canOpen, isCapability,
} from 'config/access'
import { orgRouteRest, permissionRefusal } from 'services/biz/route-permission'
import { accessRefusal, grantOf } from 'services/biz/access/evaluate'
import { PAGE_REGISTRY, PORTAL_PAGES, canOpenPage, type PageViewer } from 'ui-shared/nav/page-registry'

/**
 * FR-27 §6 — the differential test, the safety net of Phase 0 (#529).
 *
 * The evaluator (`services/biz/access/evaluate.ts`) on the grant `compileLegacy` gives a session must answer every
 * org route as `permissionRefusal` does, and every page as `canOpenPage` does: allowed or refused, nothing else.
 *
 * Over every route of the real route table, and every session shape: each role, with no permission, each single
 * permission, its default permissions and an unknown one; FR-26's areas absent, `[]`, each one alone and all of
 * them; and a PIN sign-in. Single permissions suffice for the rest: a route or a page needs ANY of its permissions,
 * and the compiled grant is the union of the permissions' capabilities, so both answers are an OR over them.
 *
 * No database: the rules are pure, and the route table is read from the app as built.
 */

interface Shape extends PageViewer {
  label: string
}

const ROUTES = (() => {
  const seen = new Set<string>()
  const out: Array<{ method: string; path: string }> = []
  for (const r of (createApiApp() as any).routes as Array<{ method: string; path: string }>) {
    if (orgRouteRest(r.path) === null) continue
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ method: r.method, path: r.path })
  }
  return out
})()

const AREA_VARIANTS: Array<readonly string[] | undefined> = [undefined, [], ...AREAS.map(a => [a]), [...AREAS]]

function shapes(): Shape[] {
  const out: Shape[] = []
  for (const role of ROLES) {
    const permissionSets: Array<[string, readonly string[]]> = [
      ['none', []],
      ...PERMISSIONS.map(p => [p, [p]] as [string, readonly string[]]),
      ['defaults', DEFAULT_ROLE_PERMISSIONS[role]],
      ['unknown', ['sales.read']],
    ]
    for (const [name, permissions] of permissionSets) {
      for (const areas of AREA_VARIANTS) {
        out.push({ label: `${role} ${name} areas=${areas ? `[${areas.join(',')}]` : 'absent'}`, role, permissions: [...permissions], ...(areas ? { areas: [...areas] } : {}) })
      }
    }
    out.push({ label: `${role} defaults pin`, role, permissions: [...DEFAULT_ROLE_PERMISSIONS[role]], amr: ['pin'] })
    const areas = DEFAULT_ROLE_AREAS[role as Role]
    if (areas) out.push({ label: `${role} defaults own areas`, role, permissions: [...DEFAULT_ROLE_PERMISSIONS[role]], areas: [...areas] })
  }
  return out
}
const SHAPES = shapes()

describe('FR-27 Phase 0: the evaluator answers as today', () => {
  it('every org route has a rule in the new table', () => {
    expect(ROUTES.length).toBeGreaterThan(400)
    const missing = ROUTES.filter(r => !accessRuleFor(r.method, orgRouteRest(r.path)!)).map(r => `${r.method} ${r.path}`)
    expect(missing).toEqual([])
  })

  it('no exact rule names a route that does not exist', () => {
    const reads = new Set(ROUTES.filter(r => ['GET', 'HEAD'].includes(r.method)).map(r => orgRouteRest(r.path)!))
    const writes = new Set(ROUTES.map(r => `${r.method} ${orgRouteRest(r.path)}`))
    expect([...EXACT_READS.keys()].filter(k => !reads.has(k))).toEqual([])
    expect([...EXACT_WRITES.keys()].filter(k => !writes.has(k))).toEqual([])
  })

  it('every route: allowed or refused as permissionRefusal answers, for every shape', () => {
    const differences: string[] = []
    for (const shape of SHAPES) {
      for (const { method, path } of ROUTES) {
        const before = permissionRefusal(shape as any, method, path) === null
        const after = accessRefusal(shape, method, path) === null
        if (before !== after) differences.push(`${shape.label}: ${method} ${path} was ${before ? 'allowed' : 'refused'}, now ${after ? 'allowed' : 'refused'}`)
      }
    }
    expect(differences.slice(0, 40)).toEqual([])
    expect(differences.length).toBe(0)
  })

  it('every page: opened or not as canOpenPage answers, for every shape', () => {
    const differences: string[] = []
    for (const shape of SHAPES) {
      for (const page of [...PAGE_REGISTRY, ...PORTAL_PAGES]) {
        const before = canOpenPage(page, shape)
        const after = canOpen(page.id, grantOf(shape), shape.amr)
        if (before !== after) differences.push(`${shape.label}: ${page.id} was ${before ? 'open' : 'closed'}, now ${after ? 'open' : 'closed'}`)
      }
    }
    expect(differences.slice(0, 40)).toEqual([])
    expect(differences.length).toBe(0)
  })
})

describe('FR-27.1: the tables name the catalogue', () => {
  it('every capability the bridge, the role table, the routes and the pages name is in the catalogue', () => {
    const named = [
      ...Object.values(LEGACY_BRIDGE).flat(),
      ...Object.values(LEGACY_ROLE_CAPS).flatMap(c => c ?? []),
      ...[...READ_PREFIXES, ...WRITE_PREFIXES, ...EXACT_READS, ...EXACT_WRITES].flatMap(([, rule]) => ('anyOf' in rule ? rule.anyOf : [])),
      ...Object.values(PAGE_ACCESS).flatMap(p => p.anyOf),
    ]
    expect([...new Set(named.filter(c => !isCapability(c)))]).toEqual([])
  })

  it('every page of the registry has an entry, and no entry names a page that does not exist', () => {
    const ids = [...PAGE_REGISTRY, ...PORTAL_PAGES].map(p => p.id)
    expect(ids.filter(id => !PAGE_ACCESS[id])).toEqual([])
    expect(Object.keys(PAGE_ACCESS).filter(id => !ids.includes(id))).toEqual([])
  })

  it('the bridge has a row for every permission', () => {
    expect(PERMISSIONS.filter(p => !LEGACY_BRIDGE[p])).toEqual([])
  })
})
