import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Org, OrgHome } from 'db/models'
import { homeOf, isHomeHere, forgetAllHomes } from 'db/home/home'
import { READ_ONLY_WRITES, isReadOnlyRoute } from 'services/biz/route-class'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * Only the home writes (FR-20.3, FR-20.4, plan step P0b-2 part 1; AC 1, 2).
 *
 * Over the real route table: for an org whose home is elsewhere, no writing route answers 2xx and
 * the gate's 409 is what most of them answer; the reading routes and the read-only POSTs still
 * work. With no home records — every org today — nothing changes (the tenant-isolation suite and
 * every other suite run that way).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
let orgId: string
let token: string

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())
  const org = await createTestOrg({ slug: 'home-gate' } as any)
  orgId = String(org._id)
  const user = await createTestUser(org._id, { role: 'admin' } as any)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'a@home.test', username: 'a', firstName: 'A', lastName: 'A',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}, 120_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  await OrgHome.deleteMany({}).exec()
  await Org.updateOne({ _id: orgId }, { $unset: { homeEpochHighWater: 1 } }).exec()
  ;(config.node as any).role = 'global'
  ;(config.node as any).id = undefined
  forgetAllHomes()
})

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const orgRoutes = () =>
  ((createApiApp() as any).routes as Array<{ method: string; path: string }>).filter(r => r.path.includes(':orgId'))
const url = (path: string) => path.replace(':orgId', orgId).replace(/:\w+/g, '000000000000000000000000')

describe('home records', () => {
  it('no record: the org is home on global — every org today', async () => {
    expect(await homeOf(orgId)).toEqual({ home: 'global', epoch: 0, state: 'active' })
    expect(await isHomeHere(orgId)).toBe(true)
  })

  it('a row naming a master: not home on global', async () => {
    await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
    await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
    expect(await isHomeHere(orgId)).toBe(false)
  })

  it('fails closed: a row that disagrees with the high-water mark is hold', async () => {
    await OrgHome.create({ orgId, home: 'global', epoch: 1 })
    await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 2 } }).exec()
    const info = await homeOf(orgId)
    expect(info.state).toBe('hold')
    expect(info.reason).toBe('epoch_disagrees')
    expect(await isHomeHere(orgId)).toBe(false)
  })

  it('fails closed: no row for an org that has had a node is hold, not global', async () => {
    await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 3 } }).exec()
    const info = await homeOf(orgId)
    expect(info).toMatchObject({ home: 'global', state: 'hold', reason: 'row_missing_after_move' })
    expect(await isHomeHere(orgId)).toBe(false)
  })

  it('any state but active writes nothing, even at home', async () => {
    for (const state of ['freezing', 'frozen', 'fenced', 'hold']) {
      await OrgHome.deleteMany({}).exec()
      forgetAllHomes()
      await OrgHome.create({ orgId, home: 'global', epoch: 0, state })
      expect(await isHomeHere(orgId)).toBe(false)
    }
  })

  it('on a master: home when the row names this node, never by default', async () => {
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = 'node-shop-1'
    expect(await isHomeHere(orgId)).toBe(false) // no row = global's

    await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
    forgetAllHomes()
    expect(await isHomeHere(orgId)).toBe(true)
  })
})

describe('the route gate (FR-20.4)', () => {
  it('every route is classified, and every read-only POST is a mounted route', () => {
    const mounted = new Set(orgRoutes().map(r => `${r.method} ${r.path}`))
    expect([...READ_ONLY_WRITES].filter(k => !mounted.has(k))).toEqual([])
    for (const r of orgRoutes()) expect(typeof isReadOnlyRoute(r.method, r.path)).toBe('boolean')
  })

  it('home elsewhere: no writing route answers 2xx, and the gate\'s 409 is what they answer', async () => {
    await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
    await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
    forgetAllHomes()

    const writes = orgRoutes().filter(r => !isReadOnlyRoute(r.method, r.path))
    const handled: string[] = []
    let gated = 0
    for (const r of writes) {
      const res = await call(r.method, url(r.path))
      if (res.status >= 200 && res.status < 300) handled.push(`${r.method} ${r.path} → ${res.status}`)
      if (res.status === 409 && res.json?.code === 'org_home_elsewhere') gated++
    }
    expect(handled).toEqual([])
    // Body validation runs before the gate on routes with a schema, so not all answer 409; the
    // ones without a schema must, and they are most of them.
    expect(gated).toBeGreaterThan(writes.length / 3)
  }, 300_000)

  it('home elsewhere: the reading routes still answer (a mirror is read-only, not dark)', async () => {
    await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
    await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
    forgetAllHomes()

    expect((await call('GET', `/api/org/${orgId}/invoices/`)).status).toBe(200)
    expect((await call('GET', `/api/org/${orgId}/accounting/accounts`)).status).not.toBe(409)
    const report = await call('POST', `/api/org/${orgId}/reports/inventory-valuation/run`, { params: {} })
    expect(report.json?.code).not.toBe('org_home_elsewhere')
  })

  it('at home (no records): a write goes through as it always did', async () => {
    const res = await call('POST', `/api/org/${orgId}/accounting/payment-terms`, { name: 'Net 30', lines: [{ type: 'balance', value: 100, days: 30 }] })
    expect(res.status).toBe(200)
  })

  it('the 409 says why, and names where the home is', async () => {
    await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
    await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
    forgetAllHomes()
    const res = await call('POST', `/api/org/${orgId}/accounting/payment-terms`, { name: 'Net 30', lines: [{ type: 'balance', value: 100, days: 30 }] })
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ code: 'org_home_elsewhere', home: { kind: 'master', state: 'active' } })
  })
})
