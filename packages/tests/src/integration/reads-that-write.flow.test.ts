import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Invoice, Org, OrgApp, OrgHome, Tag } from 'db/models'
import { forgetAllHomes, HomeElsewhereError } from 'db/home/home'
import { currentRequest, readOnlyWrites, runInRequest } from 'db/home/request-context'
import { GET_WRITERS } from 'services/biz/route-class'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * Reads that write (FR-20.6, plan step P0b-4; AC 4).
 *
 * A read is what a mirror answers, so a read that writes is how a mirror becomes a second writer —
 * a companion document printed on a mirror must never allocate its number there. Every request
 * runs in a context naming its route; the write guard records any write made inside a read-only
 * one, and refuses it when the org's home is elsewhere unless the route is in `GET_WRITERS` (whose
 * entries check the home themselves).
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
  const org = await createTestOrg({ slug: 'reads-that-write' } as any)
  orgId = String(org._id)
  const user = await createTestUser(org._id, { role: 'admin' } as any)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'a@rtw.test', username: 'a', firstName: 'A', lastName: 'A',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}, 120_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  await OrgHome.deleteMany({}).exec()
  await Org.updateOne({ _id: orgId }, { $unset: { homeEpochHighWater: 1 } }).exec()
  forgetAllHomes()
  readOnlyWrites.clear()
})

async function moveAway() {
  await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
  await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
  forgetAllHomes()
}

async function get(path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const getRoutes = () =>
  ((createApiApp() as any).routes as Array<{ method: string; path: string }>).filter(r => r.method === 'GET')

describe('the route table: only listed GETs write', () => {
  it('walking every GET route records writes only under GET_WRITERS', async () => {
    // The map is per process: other suites' requests land in it too, so measure this walk alone.
    readOnlyWrites.clear()
    const routes = getRoutes()
    expect(routes.length).toBeGreaterThan(100)
    for (const r of routes) {
      await get(r.path.replace(':orgId', orgId).replace(/:\w+/g, '000000000000000000000000'))
    }
    // The App Hub's lazy insert must actually have been seen, or this proves nothing.
    expect([...readOnlyWrites.keys()]).toContain('GET /api/org/:orgId/apps/')
    const unlisted = [...readOnlyWrites.entries()].filter(([route]) => !GET_WRITERS.has(route))
    expect(unlisted).toEqual([])
  }, 300_000)

  it('a request leaves no context behind', async () => {
    await get(`/api/org/${orgId}/apps/`)
    await Bun.sleep(10)
    expect(currentRequest()).toBeNull()
  })
})

describe('on a mirror (AC 4)', () => {
  it('printing a companion with no number yet is refused 409, and allocates nothing', async () => {
    const contact = await createTestContact((await Org.findById(orgId))!._id)
    const inv = await createTestInvoice(contact.orgId as any, contact._id, { status: 'sent' } as any)
    await moveAway()

    const res = await get(`/api/org/${orgId}/invoicing/export/${inv._id}?format=xlsx&doc=certificate`)

    expect(res.status).toBe(409)
    expect(res.json?.code).toBe('org_home_elsewhere')
    expect((await Invoice.findById(inv._id).lean() as any).certificateNumber).toBeFalsy()
  })

  it('reprinting a companion that already has its number still works', async () => {
    const contact = await createTestContact((await Org.findById(orgId))!._id)
    const inv = await createTestInvoice(contact.orgId as any, contact._id, { status: 'sent', certificateNumber: 'CERT-1' } as any)
    await moveAway()

    const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/invoicing/export/${inv._id}?format=xlsx&doc=certificate`, { headers: { authorization: `Bearer ${token}` } }))

    expect(res.status).toBe(200)
  })

  it('the App Hub lists every app and inserts nothing', async () => {
    await OrgApp.deleteMany({ orgId }).exec()
    await moveAway()

    const res = await get(`/api/org/${orgId}/apps/`)

    expect(res.status).toBe(200)
    expect((res.json?.apps ?? []).length).toBeGreaterThan(0)
    expect(await OrgApp.countDocuments({ orgId })).toBe(0)
  })

  it('an unlisted write inside a read-only request is refused', async () => {
    await moveAway()
    const err = await captureRejection(runInRequest(
      { readOnly: true, route: 'GET /api/org/:orgId/probe', orgId, listedWriter: false },
      () => Tag.create({ orgId, value: 'x', type: 'contact' } as any),
    ))
    expect(err).toBeInstanceOf(HomeElsewhereError)
    expect(readOnlyWrites.get('GET /api/org/:orgId/probe')?.size).toBe(1)
  })
})

describe('at home', () => {
  it('an unlisted write inside a read-only request is recorded, not refused', async () => {
    const tag = await runInRequest(
      { readOnly: true, route: 'GET /api/org/:orgId/probe', orgId, listedWriter: false },
      () => Tag.create({ orgId, value: 'y', type: 'contact' } as any),
    )
    expect(tag._id).toBeDefined()
    expect([...readOnlyWrites.keys()]).toEqual(['GET /api/org/:orgId/probe'])
  })
})
