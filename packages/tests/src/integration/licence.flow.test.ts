import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { OrgLicence } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { entitlementsOf, issueLicences, issuerKey } from 'services/biz/licence/licence-issue.service'
import { forgetLicences, licenceOf } from 'services/biz/licence/master-licence.service'
import { acceptedKeys, signLicence, verifyLicence } from 'services/biz/licence/licence-token'
import { LICENSED_ACTIONS } from 'services/biz/licence/licence-gate'
import { handleUplinkClose, handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'

/**
 * FR-20.55 (plan step P2-3b) — an org's licence to run on a master.
 *
 * Global signs one per entitled org (an Enterprise subscription that is paid, or a sys-admin's
 * pilot) and sends it in the uplink's `welcome`, and again when it changes. The master verifies it
 * against keys built into the package and, once it has run out past its grace, stops opening till
 * sessions and starting sales documents, and nothing else.
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const DAY = 86_400_000
const saved = { role: config.node.role, id: config.node.id, dir: config.licence.dir, created: config.licence.nodeCreatedAt, sysAdmins: config.backup.sysAdmins }
let tmp = ''

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.licence as any).dir = saved.dir
  ;(config.licence as any).nodeCreatedAt = saved.created
  ;(config.backup as any).sysAdmins = saved.sysAdmins
  forgetAllHomes()
  forgetLicences()
  await clearCollections()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

const jwt = async () => ((new Elysia().use((await import('@elysiajs/jwt')).default({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt)
async function bearer(user: any, orgId: string) {
  return (await jwt()).sign({ id: String(user._id), email: user.email, username: user.username, role: user.role, orgId, permissions: [] })
}

function call(app: any, method: string, path: string, token?: string, body?: unknown) {
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }))
}

function fakeWs() {
  const sent: any[] = []
  return { raw: { id: Math.random() }, send: (s: string) => { sent.push(JSON.parse(s)) }, close: () => {}, sent }
}

describe('global: who is entitled, and the licence it signs', () => {
  it('a paid Enterprise subscription or a pilot, the later date winning; never a past-due one', async () => {
    const end = new Date(Date.now() + 20 * DAY)
    const paid = await createTestOrg({ subscription: { plan: 'enterprise', status: 'active', currentPeriodEnd: end, maxUsers: -1, cancelAtPeriodEnd: false } } as any)
    const late = await createTestOrg({ subscription: { plan: 'enterprise', status: 'past_due', currentPeriodEnd: end, maxUsers: -1, cancelAtPeriodEnd: false } } as any)
    const free = await createTestOrg()
    await OrgLicence.create({ orgId: free._id, until: new Date(Date.now() + 5 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date() })
    // A pilot longer than the subscription wins; a revoked one counts for nothing.
    await OrgLicence.create({ orgId: paid._id, until: new Date(Date.now() + 40 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date() })
    await OrgLicence.create({ orgId: late._id, until: new Date(Date.now() + 40 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date(), revokedAt: new Date() })

    const e = await entitlementsOf([paid._id, late._id, free._id])
    expect(e.get(String(paid._id))?.plan).toBe('pilot')
    expect(e.has(String(late._id))).toBe(false)
    expect(e.get(String(free._id))?.plan).toBe('pilot')

    await OrgLicence.deleteOne({ orgId: paid._id })
    expect((await entitlementsOf([paid._id])).get(String(paid._id))).toEqual({ plan: 'enterprise', paidThrough: end })
  })

  it('signs a licence that names the org and the master, and verifies with the keys a master accepts', async () => {
    const org = await createTestOrg()
    await OrgLicence.create({ orgId: org._id, until: new Date(Date.now() + 10 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date() })
    const nodeId = 'master-aaaaaaaaaaaaaaaa'
    const issued = (await issueLicences(nodeId, [org._id])).get(String(org._id))!
    const v = verifyLicence(issued.jws, acceptedKeys())
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.claims).toMatchObject({ sub: String(org._id), node: nodeId, plan: 'pilot', graceDays: 30, org: org.slug })
      expect(v.kid).toBe((issuerKey() as any).key.kid)
    }
    expect((await issueLicences(nodeId, [(await createTestOrg())._id])).size).toBe(0)
  })
})

describe('the uplink delivers it', () => {
  it('in welcome on the interactive socket, and again when a sys-admin moves the pilot', async () => {
    const org = await createTestOrg()
    const admin = await createTestUser(org._id, { role: 'admin', email: 'ops@lgr.test' } as any)
    const stub = makeNodeStub()
    const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
    await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
    const nodeToken = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
    await OrgLicence.create({ orgId: org._id, until: new Date(Date.now() + 10 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date() })

    const hello = (ch: string) => JSON.stringify({ t: 'hello', v: 1, ch, token: nodeToken, bootNonce: 'boot-licence1', versions: { app: '0.1.0', protocol: 1 } })
    const interactive = fakeWs()
    handleUplinkOpen(interactive, 'interactive')
    await handleUplinkMessage(interactive, hello('interactive'))
    const bulk = fakeWs()
    handleUplinkOpen(bulk, 'bulk')
    await handleUplinkMessage(bulk, hello('bulk'))
    try {
      const welcome = interactive.sent.find(m => m.t === 'welcome')
      const v = verifyLicence(welcome.orgs[0].entitlements, acceptedKeys())
      expect(v.ok && v.claims.node).toBe(stub.nodeId)
      expect(bulk.sent.find(m => m.t === 'welcome').orgs[0].entitlements).toBeUndefined()

      // A sys-admin moves the pilot: the master hears it at once, with the new date.
      ;(config.backup as any).sysAdmins = ['ops@lgr.test']
      const app = new Elysia().use(createApiApp())
      const until = new Date(Date.now() + 90 * DAY).toISOString().slice(0, 10)
      const put = await call(app, 'PUT', `/api/admin/licences/${org._id}`, await bearer(admin, String(org._id)), { until, note: 'the first shop' })
      expect(put.status).toBe(200)
      expect((await put.json()).told).toBe(1)
      const pushed = interactive.sent.filter(m => m.t === 'entitlements')
      expect(pushed).toHaveLength(1)
      const again = verifyLicence(pushed[0].jws, acceptedKeys())
      expect(again.ok && again.claims.paidThrough).toBe(`${until}T23:59:59.999Z`)
      expect(bulk.sent.some(m => m.t === 'entitlements')).toBe(false)
    } finally {
      await handleUplinkClose(interactive)
      await handleUplinkClose(bulk)
    }
  })
})

describe('the sys-admins issue pilots and air-gapped licence files', () => {
  it('only a sys-admin, only on global; the date is checked; a file names its master', async () => {
    const org = await createTestOrg()
    const admin = await createTestUser(org._id, { role: 'admin', email: 'owner@acme.test' } as any)
    const token = await bearer(admin, String(org._id))
    const app = new Elysia().use(createApiApp())
    const soon = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10)

    expect((await call(app, 'GET', '/api/admin/licences')).status).toBe(401)
    ;(config.backup as any).sysAdmins = []
    expect((await call(app, 'PUT', `/api/admin/licences/${org._id}`, token, { until: soon })).status).toBe(403)
    ;(config.backup as any).sysAdmins = ['owner@acme.test']

    expect((await call(app, 'PUT', `/api/admin/licences/${org._id}`, token, { until: '2020-01-01' })).status).toBe(422)
    expect((await call(app, 'PUT', `/api/admin/licences/${org._id}`, token, { until: new Date(Date.now() + 800 * DAY).toISOString() })).status).toBe(422)
    expect((await call(app, 'PUT', '/api/admin/licences/0123456789abcdef01234567', token, { until: soon })).status).toBe(404)
    // With no entitlement there is nothing to put in a file.
    expect((await call(app, 'POST', `/api/admin/licences/${org._id}/file`, token, { nodeId: 'master-aaaaaaaaaaaaaaaa' })).status).toBe(409)

    expect((await call(app, 'PUT', `/api/admin/licences/${org._id}`, token, { until: soon })).status).toBe(200)
    const list = await (await call(app, 'GET', '/api/admin/licences', token)).json()
    expect(list.signing.ok).toBe(true)
    const row = list.orgs.find((o: any) => o.id === String(org._id))
    expect(row.pilot.issuedBy).toBe('owner@acme.test')
    expect(row.entitlement.plan).toBe('pilot')

    expect((await call(app, 'POST', `/api/admin/licences/${org._id}/file`, token, { nodeId: 'not-a-node' })).status).toBe(422)
    const file = await (await call(app, 'POST', `/api/admin/licences/${org._id}/file`, token, { nodeId: 'master-aaaaaaaaaaaaaaaa' })).json()
    expect(file.fileName).toBe(`lgr-licence-${org.slug}-master-aaaaaaaaaaaaaaaa.jws`)
    const v = verifyLicence(file.jws, acceptedKeys())
    expect(v.ok && v.claims.node).toBe('master-aaaaaaaaaaaaaaaa')

    // Revoked: no more renewals. A second revoke finds nothing.
    expect((await call(app, 'DELETE', `/api/admin/licences/${org._id}`, token)).status).toBe(200)
    expect((await entitlementsOf([org._id])).size).toBe(0)
    expect((await call(app, 'DELETE', `/api/admin/licences/${org._id}`, token)).status).toBe(404)

    ;(config.node as any).role = 'master'
    expect((await call(app, 'GET', '/api/admin/licences', token)).status).toBe(404)
  })
})

describe('a master enforces it', () => {
  const NODE = 'master-licencetestaaaaa'

  async function aMaster() {
    tmp = mkdtempSync(join(tmpdir(), 'lgr-licences-'))
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = NODE
    ;(config.licence as any).dir = tmp
    const org = await createTestOrg({ settings: { timezone: 'Europe/Sofia' } } as any)
    await homeNewOrg(String(org._id))
    const admin = await createTestUser(org._id, { role: 'admin' } as any)
    const app = new Elysia().use(createApiApp())
    return { orgId: String(org._id), slug: org.slug, token: await bearer(admin, String(org._id)), app }
  }

  function licence(orgId: string, paidThrough: Date, node = NODE) {
    const key = issuerKey()
    if (!key.ok) throw new Error(key.reason)
    writeFileSync(join(tmp, `${orgId}.jws`), signLicence({ sub: orgId, org: 'x', orgName: 'X', node, plan: 'pilot', paidThrough: paidThrough.toISOString(), graceDays: 30 }, key.key))
    forgetLicences()
  }

  const openTill = (m: any) => call(m.app, 'POST', `/api/org/${m.orgId}/trade/pos/session`, m.token, { warehouseId: '0123456789abcdef01234567', openingBalance: 0, currency: 'EUR' })
  const newDoc = (m: any, type: string) => call(m.app, 'POST', `/api/org/${m.orgId}/invoices`, m.token, { type, direction: 'outgoing', issueDate: '2026-10-25', currency: 'EUR', lines: [], subtotal: 0, total: 0 })

  it('with no licence: a 30-day evaluation, then no new till sessions or sales documents', async () => {
    const m = await aMaster()
    ;(config.licence as any).nodeCreatedAt = Math.floor(Date.now() / 1000)
    const fresh = await (await call(m.app, 'GET', `/api/org/${m.orgId}/licence`, m.token)).json()
    expect(fresh).toMatchObject({ applies: true, state: 'evaluation', basis: 'evaluation' })
    expect((await openTill(m)).status).not.toBe(402)

    ;(config.licence as any).nodeCreatedAt = Math.floor((Date.now() - 60 * DAY) / 1000)
    expect((await licenceOf(m.orgId) as any).state).toBe('restricted')
    const till = await openTill(m)
    expect(till.status).toBe(402)
    expect((await till.json())).toMatchObject({ code: 'licence_expired', action: 'opening a till session' })
    expect((await newDoc(m, 'invoice')).status).toBe(402)
    expect((await newDoc(m, 'cash_sale')).status).toBe(402)
    // A credit note of an existing sale, reading, the licence itself: never stopped.
    expect((await newDoc(m, 'credit_note')).status).not.toBe(402)
    expect((await call(m.app, 'GET', `/api/org/${m.orgId}/invoices`, m.token)).status).toBe(200)
    expect((await call(m.app, 'GET', `/api/org/${m.orgId}/licence`, m.token)).status).toBe(200)
  })

  it('a licence for this org and this master lifts it; one for another master does not', async () => {
    const m = await aMaster()
    ;(config.licence as any).nodeCreatedAt = Math.floor((Date.now() - 60 * DAY) / 1000)
    licence(m.orgId, new Date(Date.now() + 10 * DAY))
    expect(await (await call(m.app, 'GET', `/api/org/${m.orgId}/licence`, m.token)).json()).toMatchObject({ state: 'licensed', basis: 'licence', plan: 'pilot' })
    expect((await openTill(m)).status).not.toBe(402)
    expect((await newDoc(m, 'invoice')).status).not.toBe(402)

    licence(m.orgId, new Date(Date.now() + 10 * DAY), 'master-bbbbbbbbbbbbbbbb')
    expect(await licenceOf(m.orgId)).toMatchObject({ state: 'restricted', basis: 'evaluation', problem: 'other_node' })
    expect((await openTill(m)).status).toBe(402)

    writeFileSync(join(tmp, `${m.orgId}.jws`), 'a.forged.licence')
    forgetLicences()
    expect(await licenceOf(m.orgId)).toMatchObject({ problem: 'malformed' })
  })

  it('grace for 30 days after the paid-through date, then restricted', async () => {
    const m = await aMaster()
    ;(config.licence as any).nodeCreatedAt = Math.floor((Date.now() - 400 * DAY) / 1000)
    licence(m.orgId, new Date(Date.now() - 10 * DAY))
    expect(await licenceOf(m.orgId)).toMatchObject({ state: 'grace' })
    expect((await openTill(m)).status).not.toBe(402)
    licence(m.orgId, new Date(Date.now() - 40 * DAY))
    expect(await licenceOf(m.orgId)).toMatchObject({ state: 'restricted', basis: 'licence' })
    expect((await openTill(m)).status).toBe(402)
  })

  it('on global nothing applies', async () => {
    const org = await createTestOrg()
    const admin = await createTestUser(org._id, { role: 'admin' } as any)
    const app = new Elysia().use(createApiApp())
    expect(await (await call(app, 'GET', `/api/org/${org._id}/licence`, await bearer(admin, String(org._id)))).json()).toEqual({ applies: false })
  })
})

describe('the gate names real routes', () => {
  it('every action an expired licence stops is a route the API serves', () => {
    const routes = new Set(((createApiApp() as any).routes as Array<{ method: string; path: string }>).map(r => `${r.method} ${r.path.replace(/\/+$/, '')}`))
    for (const key of LICENSED_ACTIONS.keys()) expect(routes.has(key)).toBe(true)
  })

})
