import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { BackupRun, Desktop, FiscalDevice, OrgHome, Outbox, ReplOrg } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { linkAlarmsTick } from 'services/biz/home/series-lock.service'
import { serverStatus } from 'services/biz/node/server-status'
import { serverStatusController } from '../../../portal-api/src/controllers/server-status.controller'
import type { Types } from 'mongoose'

/**
 * A master's own status page (FR-20.98, FR-20.50, plan step P3-8b): what the supervisor last wrote
 * of itself (`state/status.json`, beside the node token), what this database says of the org, and
 * the Прил. 32 fields. An org's admin sees this org's licence, devices and desktops, never another
 * org's on the same server; on lgrai.app the page is not there.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-statustest000000'
const saved = { role: config.node.role, id: (config.node as any).id, tokenFile: config.outbox.tokenFile }
let root = ''

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
beforeEach(() => {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = NODE
  root = mkdtempSync(join(tmpdir(), 'lgr-status-'))
  mkdirSync(join(root, 'state'), { recursive: true })
  ;(config.outbox as any).tokenFile = join(root, 'state', 'node-token.json')
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  forgetAllHomes()
  rmSync(root, { recursive: true, force: true })
  await clearCollections()
}, 60_000)

/** What the supervisor writes every 30 s (`status_file.rs`), as of `writtenAt`. */
function writeStatus(writtenAt: Date, licences: any[]) {
  writeFileSync(join(root, 'state', 'status.json'), JSON.stringify({
    service: 'lgr-server',
    version: '0.9.0',
    uptimeSecs: 3600,
    front: { apiPort: 4001, controlSocket: join(root, 'api.sock') },
    registration: { server: 'https://lgrai.test', nodeId: NODE, linkLevel: 'full', orgs: [], registeredAt: 1 },
    uplink: { interactive: { state: 'connected' }, bulk: { state: 'connected', pacing: { rateBytesPerSec: 65536, delayMs: 12, cuts: 3 } } },
    children: [{ name: 'mongod', state: 'running', failures: 0 }, { name: 'api', state: 'running', failures: 1 }],
    licences,
    update: { state: 'deferred', running: '0.9.0', available: '0.9.1', reason: 'a till is open', blockedWindows: 2, alarm: false, checkedAt: 1 },
    disk: { freeBytes: 40 * 2 ** 30, totalBytes: 100 * 2 ** 30 },
    oplogWindowSecs: null,
    writtenAt: writtenAt.toISOString(),
  }))
}

/** Two orgs written on this server, each with its own devices, desktops and licence. */
async function twoOrgs() {
  const a = await createTestOrg({ slug: 'status-a' } as any)
  const b = await createTestOrg({ slug: 'status-b' } as any)
  const now = Date.now()
  await OrgHome.collection.insertMany([
    { orgId: a._id, home: NODE, epoch: 1, state: 'active', since: new Date() },
    { orgId: b._id, home: NODE, epoch: 1, state: 'active', since: new Date() },
  ] as any[])
  await ReplOrg.collection.insertMany([{ orgId: a._id, seq: 42 }, { orgId: b._id, seq: 7 }] as any[])
  await BackupRun.collection.insertMany([
    { orgId: a._id, kind: 'full', date: '2026-10-26', status: 'completed', completedAt: new Date('2026-10-26T02:00:00Z') },
    { orgId: b._id, kind: 'full', date: '2026-10-20', status: 'completed', completedAt: new Date('2026-10-20T03:33:00Z') },
  ] as any[])
  await Outbox.collection.insertMany([
    { _id: 'sa1', orgId: a._id, kind: 'mail', payload: {}, state: 'queued', nextAt: new Date() },
    { _id: 'sb1', orgId: b._id, kind: 'mail', payload: {}, state: 'queued', nextAt: new Date() },
    { _id: 'sb2', orgId: b._id, kind: 'mail', payload: {}, state: 'sending', nextAt: new Date() },
  ] as any[])
  await FiscalDevice.collection.insertMany([
    { orgId: a._id, deviceNumber: 'ED000001', name: 'Till 1', manufacturer: 'eltrade', connectionType: 'desktop', status: 'online', isActive: true },
    { orgId: a._id, deviceNumber: 'ED000002', name: 'Old till', manufacturer: 'eltrade', connectionType: 'browser', status: 'offline', isActive: false },
    { orgId: b._id, deviceNumber: 'ZK000001', name: 'B till', manufacturer: 'tremol', connectionType: 'browser', status: 'offline', isActive: true },
  ] as any[])
  await Desktop.collection.insertMany([
    { orgId: a._id, name: 'Front', status: 'active', installationId: 'i-a1', lastSeenAt: new Date(now - 60_000) },
    { orgId: a._id, name: 'Back', status: 'active', installationId: 'i-a2', lastSeenAt: new Date(now - 10 * 60_000) },
    { orgId: a._id, name: 'Gone', status: 'revoked', installationId: 'i-a3', lastSeenAt: new Date(now) },
    { orgId: b._id, name: 'B front', status: 'active', installationId: 'i-b1', lastSeenAt: new Date(now) },
  ] as any[])
  const licences = [
    { orgId: String(a._id), org: 'status-a', node: NODE, plan: 'professional', paidThrough: '2027-01-31', graceDays: 14, iat: 1 },
    { orgId: String(b._id), org: 'status-b', node: NODE, plan: 'starter', paidThrough: '2026-11-30', graceDays: 14, iat: 1 },
  ]
  return { a, b, aId: String(a._id), bId: String(b._id), licences }
}

/** lgrai.app's `/self`, as the link-alarm tick hears it: where its copy of each org stands. */
async function hearSelf(mirrors: any[]) {
  writeFileSync(config.outbox.tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
  const fetchImpl = (async (input: any) => {
    if (new URL(String(input)).pathname === '/api/node/v1/self') return Response.json({ mirrors })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  await linkAlarmsTick(fetchImpl)
}

describe('a master\'s status page (P3-8b)', () => {
  it('what the supervisor wrote, and this org\'s own: never another org\'s on the same server', async () => {
    const { aId, bId, licences } = await twoOrgs()
    const now = new Date()
    writeStatus(new Date(now.getTime() - 10_000), licences)
    const lastPageAt = new Date(now.getTime() - 30_000).toISOString()
    await hearSelf([{ orgId: aId, watermark: 40, lastPageAt }, { orgId: bId, watermark: 7, lastPageAt }])

    const s: any = await serverStatus(aId, now)
    expect(s.supervisor).toMatchObject({
      version: '0.9.0',
      uptimeSecs: 3600,
      fresh: true,
      children: [{ name: 'mongod', state: 'running', failures: 0 }, { name: 'api', state: 'running', failures: 1 }],
      uplink: { interactive: 'connected', bulk: 'connected', pacing: { rateBytesPerSec: 65536, delayMs: 12 } },
      update: { state: 'deferred', running: '0.9.0', available: '0.9.1', reason: 'a till is open', blockedWindows: 2, alarm: false },
      disk: { freeBytes: 40 * 2 ** 30, totalBytes: 100 * 2 ** 30 },
      oplogWindowSecs: null,
      linkLevel: 'full',
    })
    expect(s.org).toMatchObject({
      home: { here: true, state: 'active', numberingLocked: false },
      journalHead: 42,
      // lgrai.app holds 40 of the 42 changes recorded here.
      mirror: { watermark: 40, behind: 2, lastPageAt },
      outboxQueued: 1,
      licence: { plan: 'professional', paidThrough: '2027-01-31', graceDays: 14, error: null },
      fiscalDevices: [{ name: 'Till 1', deviceNumber: 'ED000001', manufacturer: 'eltrade', connectionType: 'desktop', status: 'online' }],
      // Two active desktops, one seen in the last five minutes; the removed one does not count.
      desktops: { active: 2, online: 1 },
    })
    expect(new Date(s.org.lastBackupAt).toISOString()).toBe('2026-10-26T02:00:00.000Z')
    expect(s.pril32).toMatchObject({ installation: 'lan', database: 'MongoDB', mirror: 'https://lgrai.test', linkLevel: 'full', desktops: 2, version: '0.9.0' })
    expect(typeof s.pril32.host).toBe('string')
    // Nothing of the other org, and nothing of the supervisor's own plumbing.
    const wire = JSON.stringify(s)
    for (const other of ['starter', 'ZK000001', 'B front', '2026-10-20T03:33', 'controlSocket', 'api.sock']) expect(wire).not.toContain(other)

    // The other org's admin sees the other org.
    const t: any = await serverStatus(bId, now)
    expect(t.org).toMatchObject({ journalHead: 7, mirror: { behind: 0 }, outboxQueued: 2, licence: { plan: 'starter' }, desktops: { active: 1, online: 1 } })
    expect(t.org.fiscalDevices.map((d: any) => d.deviceNumber)).toEqual(['ZK000001'])
  }, 60_000)

  it('says when the supervisor is not writing, and still shows the org', async () => {
    const { aId, licences } = await twoOrgs()
    const now = new Date()
    // Five minutes old: the supervisor stopped writing.
    writeStatus(new Date(now.getTime() - 5 * 60_000), licences)
    const stale: any = await serverStatus(aId, now)
    expect(stale.supervisor.fresh).toBe(false)
    // No file at all: no supervisor, the org as this database holds it.
    rmSync(join(root, 'state', 'status.json'))
    const none: any = await serverStatus(aId, now)
    expect(none.supervisor).toBeNull()
    expect(none.org).toMatchObject({ journalHead: 42, licence: null, desktops: { active: 2 } })
    expect(none.pril32).toMatchObject({ mirror: null, linkLevel: null, version: null })
  }, 60_000)

  it('an unreadable licence is said to be, without its contents', async () => {
    const { aId } = await twoOrgs()
    writeStatus(new Date(), [{ orgId: aId, error: 'the signature does not verify' }])
    const s: any = await serverStatus(aId)
    expect(s.org.licence).toEqual({ plan: null, paidThrough: null, graceDays: null, error: 'the signature does not verify' })
  }, 60_000)

  it('is not there on lgrai.app, nor for an id that is not one', async () => {
    const { aId } = await twoOrgs()
    expect(await serverStatus('not-an-id')).toBeNull()
    ;(config.node as any).role = 'global'
    expect(await serverStatus(aId)).toBeNull()
  }, 60_000)
})

describe('the routes (P3-8b)', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  const app = new Elysia().use(serverStatusController)
  async function tokenFor(user: { id: string; orgId: string; role: string }) {
    return (signer as any).decorator.jwt.sign({ id: user.id, orgId: user.orgId, role: user.role, email: `${user.role}@status.test`, username: user.role, permissions: [] })
  }
  async function call(path: string, token?: string) {
    const res = await app.handle(new Request(`http://localhost${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }))
    let json: any = null
    try { json = await res.json() } catch { /* empty */ }
    return { status: res.status, json }
  }

  it('for the org\'s admins on the server: 401 anonymous, 403 a member or another org, 404 on lgrai.app', async () => {
    const { a, aId, bId, licences } = await twoOrgs()
    writeStatus(new Date(), licences)
    const admin = await createTestUser(a._id as Types.ObjectId, { email: 'admin@status.test', role: 'admin' } as any)
    const member = await createTestUser(a._id as Types.ObjectId, { email: 'member@status.test', role: 'member' } as any)
    const adminToken = await tokenFor({ id: String(admin._id), orgId: aId, role: 'admin' })
    const memberToken = await tokenFor({ id: String(member._id), orgId: aId, role: 'member' })

    expect((await call(`/org/${aId}/server/status`)).status).toBe(401)
    expect((await call(`/org/${aId}/server/here`)).status).toBe(401)

    const ok = await call(`/org/${aId}/server/status`, adminToken)
    expect(ok.status).toBe(200)
    expect(ok.json.status.org.licence).toMatchObject({ plan: 'professional' })
    expect((await call(`/org/${aId}/server/here`, adminToken)).json).toEqual({ server: true })

    expect((await call(`/org/${aId}/server/status`, memberToken)).status).toBe(403)
    expect((await call(`/org/${aId}/server/here`, memberToken)).json).toEqual({ server: false })
    // The admin of one org on this server, asking for another's: the tenant guard.
    expect((await call(`/org/${bId}/server/status`, adminToken)).status).toBe(403)

    ;(config.node as any).role = 'global'
    expect((await call(`/org/${aId}/server/status`, adminToken)).status).toBe(404)
    expect((await call(`/org/${aId}/server/here`, adminToken)).json).toEqual({ server: false })
  }, 60_000)
})
