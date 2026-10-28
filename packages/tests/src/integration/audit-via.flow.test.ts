import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { requestVia } from '../../../portal-api/src/front/front-guard'
import { AuditLog, Desktop, OrgHome } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { runInRequest } from 'db/home/request-context'
import { createAuditEntry, queryAuditLogs } from 'services/biz/audit-log.service'
import { signDesktopToken } from 'services/biz/desktop/desktop.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-20.48: on the org's own server every audit entry says where it came from, so an auditor can
 * tell a till from a remote session: `lan:<desktopId>`, `tunnel`, or `loopback` (the server's
 * console, and its own work). Over the real route table, as the supervisor's front stamps requests.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const SECRET = 'f'.repeat(43)
const NODE = 'master-auditvia000000000'
const saved = { role: config.node.role, id: config.node.id, front: { ...config.front } }
let app: Elysia
let orgId: string
let userId: string
let token: string
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())
  const org = await createTestOrg({ slug: 'audit-via' } as any)
  orgId = String(org._id)
  const user = await createTestUser(org._id, { role: 'admin' } as any)
  userId = String(user._id)
  token = await (signer as any).decorator.jwt.sign({
    id: userId, orgId, role: 'admin', email: 'a@via.test', username: 'a', firstName: 'A', lastName: 'A',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}, 120_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  await OrgHome.deleteMany({}).exec()
  await AuditLog.deleteMany({}).exec()
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  Object.assign(config.front, saved.front)
  forgetAllHomes()
})

/** This process as the org's server, behind the supervisor's front (or not). */
async function asMaster(front = true) {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = NODE
  Object.assign(config.front, front ? { secret: SECRET, hosts: ['kasa-1.local'] } : { secret: undefined, hosts: [] })
  await OrgHome.create({ orgId, home: NODE, epoch: 1, state: 'active' } as any)
  forgetAllHomes()
}

/** A contact made over the API, stamped as the front would; the audit entry it wrote. */
async function made(name: string, stamp: Record<string, string>) {
  const res = await app.handle(new Request(`http://kasa-1.local/api/org/${orgId}/invoicing/contact`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', host: 'kasa-1.local', ...stamp },
    body: JSON.stringify({ type: 'customer', companyName: name }),
  }))
  expect(res.status).toBe(200)
  const end = Date.now() + 5000
  for (;;) {
    const row: any = await AuditLog.findOne({ orgId, entityType: 'contact', entityName: name }).lean()
    if (row) return row
    if (Date.now() > end) throw new Error(`no audit entry for ${name}`)
    await Bun.sleep(20)
  }
}
const stamp = (source: string, extra: Record<string, string> = {}) => ({ 'x-lgr-front': SECRET, 'x-lgr-source': source, ...extra })

describe('where an audit entry came from (FR-20.48)', () => {
  it('on the server: the org\'s address, the console, a till by its credential, the shop\'s network without one', async () => {
    await asMaster()
    expect((await made('Through the address', stamp('tunnel'))).via).toBe('tunnel')
    expect((await made('At the console', stamp('console'))).via).toBe('loopback')
    const desktop = await Desktop.collection.insertOne({ orgId: (await OrgHome.findOne({}).lean() as any).orgId, name: 'Till 1', status: 'active', keyEpoch: 1, createdAt: new Date() } as any)
    const desktopId = String(desktop.insertedId)
    const credential = signDesktopToken({ desktopId, orgId, keyEpoch: 1 }).token
    expect((await made('At the till', stamp('lan', { 'x-lgr-desktop-token': credential }))).via).toBe(`lan:${desktopId}`)
    expect((await made('On the network', stamp('lan'))).via).toBe('lan')
    // A forged credential names no desktop.
    expect((await made('Forged till', stamp('lan', { 'x-lgr-desktop-token': `${credential.slice(0, -4)}AAAA` }))).via).toBe('lan')

    // The audit page names the till.
    const page = await queryAuditLogs(orgId, { entityType: 'contact', size: 50 })
    const byName = Object.fromEntries(page.auditLogs.map((l: any) => [l.entityName, l]))
    expect([byName['At the till'].via, byName['At the till'].viaDesktop]).toEqual([`lan:${desktopId}`, 'Till 1'])
    expect([byName['Through the address'].via, byName['Through the address'].viaDesktop]).toEqual(['tunnel', undefined])
  })

  it('the server\'s own work, outside any request, is the server itself; a request\'s own via wins; an explicit one wins over both', async () => {
    await asMaster()
    createAuditEntry({ orgId, userId, action: 'update', module: 'admin', entityType: 'job', entityId: 'tick', entityName: 'a tick' })
    await runInRequest({ readOnly: false, route: 'POST /x', listedWriter: false, via: 'tunnel' }, async () => {
      createAuditEntry({ orgId, userId, action: 'update', module: 'admin', entityType: 'job', entityId: 'req', entityName: 'in a request' })
      createAuditEntry({ orgId, userId, action: 'update', module: 'admin', entityType: 'job', entityId: 'sock', entityName: 'a socket', via: 'lan:abc' })
    })
    const end = Date.now() + 5000
    let rows: any[] = []
    while (rows.length < 3 && Date.now() < end) {
      rows = await AuditLog.find({ orgId, entityType: 'job' }).lean()
      await Bun.sleep(20)
    }
    expect(Object.fromEntries(rows.map(r => [r.entityName, r.via]))).toEqual({ 'a tick': 'loopback', 'in a request': 'tunnel', 'a socket': 'lan:abc' })
  })

  it('a server without a front (development) is the server itself; lgrai.app records none', async () => {
    await asMaster(false)
    expect((await made('Dev server', {})).via).toBe('loopback')
    await OrgHome.deleteMany({}).exec()
    ;(config.node as any).role = 'global'
    ;(config.node as any).id = undefined
    Object.assign(config.front, { secret: undefined, hosts: [] })
    forgetAllHomes()
    expect((await made('On lgrai.app', {})).via).toBeUndefined()
  })

  it('requestVia reads the stamps only behind the front', () => {
    const r = (h: Record<string, string>) => new Request('http://kasa-1.local/', { headers: h })
    Object.assign(config.front, { secret: undefined })
    expect(requestVia(r({ 'x-lgr-source': 'tunnel' }))).toBeUndefined()
    Object.assign(config.front, { secret: SECRET })
    expect([requestVia(r({ 'x-lgr-source': 'tunnel' })), requestVia(r({ 'x-lgr-source': 'console' })), requestVia(r({ 'x-lgr-source': 'everywhere' })), requestVia(null)]).toEqual(['tunnel', 'loopback', undefined, undefined])
  })
})
