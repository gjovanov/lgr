import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { User } from 'db/models'
import { accessRuleFor, isCapability } from 'config/access'
import { tokenize } from 'services/biz/auth.service'
import { orgRouteRest } from 'services/biz/route-permission'

/**
 * S-28's order on a route whose controller decides (`self`): a role that may not write there is refused BEFORE its
 * body is validated, by the rule's `floor` (`config/access/routes.ts`, `floorRefusal`), so it gets 403 and never a
 * 422 describing the body. Found by the #493 walk on production (2026-11-11): a Seller's `POST fiscal/device {}`
 * answered 422.
 *
 * Over the real route table: every write route whose rule names a floor, with an empty body, as a Seller (none of the
 * floors) and as an Administrator (all of them).
 *
 * NOTE: no `.rejects` / `.resolves` (Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let orgId = ''
const tokens: Record<string, string> = {}
const ID = '000000000000000000000001'

interface Floored { method: string; path: string; floor: readonly string[] }
let floored: Floored[] = []

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org = await createTestOrg({ slug: 'self-floors' } as any)
  orgId = String(org._id)
  const seller = await createTestUser(org._id, { role: 'seller', username: 'floor-seller', email: 'seller@self-floors.test' } as any)
  const admin = await createTestUser(org._id, { role: 'admin', username: 'floor-admin', email: 'admin@self-floors.test' } as any)
  tokens.seller = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(seller._id).exec())!))
  tokens.admin = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(admin._id).exec())!))

  const seen = new Set<string>()
  for (const r of (createApiApp() as any).routes as { method: string; path: string }[]) {
    const method = String(r.method).toUpperCase()
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !r.path.startsWith('/api/org/:orgId')) continue
    const rest = orgRouteRest(r.path)
    if (rest === null) continue
    const rule = accessRuleFor(method, rest) as any
    if (!rule?.self || !rule.floor?.length) continue
    const key = `${method} ${r.path}`
    if (seen.has(key)) continue
    seen.add(key)
    floored.push({ method, path: r.path, floor: rule.floor })
  }
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

async function call(method: string, path: string, token: string) {
  const url = path.replace(':orgId', orgId).replace(/:[A-Za-z]+/g, ID)
  const res = await app.handle(new Request(`http://localhost${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'DELETE' ? undefined : '{}',
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

describe('S-28: a self route refuses before validating whoever holds none of its floor', () => {
  it('finds the floored routes: the devices, people, invites, roles and sets, apps, the digest, the org', () => {
    const prefixes = new Set(floored.map(f => orgRouteRest(f.path)!.split('/')[0]))
    for (const p of ['fiscal', 'user', 'invite', 'roles', 'permission-sets', 'apps', 'digest']) expect(prefixes.has(p)).toBe(true)
    expect(floored.length).toBeGreaterThan(20)
    expect(floored.flatMap(f => f.floor).filter(c => !isCapability(c))).toEqual([])
  })

  it('a Seller is refused every one of them with 403, the floor named, never a 422', async () => {
    const wrong: string[] = []
    for (const f of floored) {
      const r = await call(f.method, f.path, tokens.seller)
      if (r.status !== 403 || r.json?.code !== 'permission_required') wrong.push(`${f.method} ${f.path}: ${r.status} ${r.json?.code ?? ''}`)
    }
    expect(wrong).toEqual([])
  })

  it('an Administrator passes every floor: what answers is the route itself', async () => {
    const stopped: string[] = []
    for (const f of floored) {
      const r = await call(f.method, f.path, tokens.admin)
      if (r.status === 403 && r.json?.code === 'permission_required' && Array.isArray(r.json?.capabilities)) stopped.push(`${f.method} ${f.path}`)
    }
    expect(stopped).toEqual([])
  })
})
