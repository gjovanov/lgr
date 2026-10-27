import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { AuditLog, OrgAddress, OrgHome } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { linkAlarmsTick } from 'services/biz/home/series-lock.service'
import { serverStatus } from 'services/biz/node/server-status'
import { nodeSelf } from 'services/biz/node/node.service'
import { serverStatusController } from '../../../portal-api/src/controllers/server-status.controller'
import type { Types } from 'mongoose'

/**
 * Where an inspector reaches the org's server (FR-20.47, plan step P3-8e; Н-18 чл. 52и(1)). A server
 * in the shop is inspected there; one off the premises needs a declared remote path: the tunnel (the
 * org's address, at Full), the roomler overlay or the company's VPN. The trader declares it in Прил.
 * 32, which the status page shows ready to copy, and says when it is missing or broken.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-inspection0000000'
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
  root = mkdtempSync(join(tmpdir(), 'lgr-inspection-'))
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

/** The supervisor's status (`status_file.rs`), at this link level. */
function linkAt(linkLevel: string) {
  writeFileSync(join(root, 'state', 'status.json'), JSON.stringify({
    service: 'lgr-server', version: '0.9.0', uptimeSecs: 60, children: [], licences: [],
    registration: { server: 'https://lgrai.test', nodeId: NODE, linkLevel, orgs: [], registeredAt: 1 },
    writtenAt: new Date().toISOString(),
  }))
}

/** lgrai.app's `/self`, as the link tick hears it: the orgs on this server, with their addresses. */
async function hearSelf(orgs: Array<{ id: string; address: string | null }>) {
  writeFileSync(config.outbox.tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
  const fetchImpl = (async (input: any) => {
    if (new URL(String(input)).pathname === '/api/node/v1/self') return Response.json({ orgs, mirrors: [] })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  await linkAlarmsTick(fetchImpl)
}

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const app = new Elysia().use(serverStatusController)

async function shop(slug: string) {
  const org = await createTestOrg({ slug } as any)
  const orgId = String(org._id)
  await OrgHome.collection.insertOne({ orgId: org._id, home: NODE, epoch: 1, state: 'active', since: new Date() } as any)
  const admin = await createTestUser(org._id as Types.ObjectId, { email: `admin@${slug}.test`, role: 'admin' } as any)
  const member = await createTestUser(org._id as Types.ObjectId, { email: `member@${slug}.test`, role: 'member' } as any)
  const token = async (u: any, role: string) => (signer as any).decorator.jwt.sign({ id: String(u._id), orgId, role, email: `${role}@${slug}.test`, username: role, permissions: [] })
  return { orgId, adminToken: await token(admin, 'admin'), memberToken: await token(member, 'member') }
}

async function declare(orgId: string, token: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost/org/${orgId}/server/inspection`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* empty */ }
  return { status: res.status, json }
}
const shown = async (orgId: string) => ((await serverStatus(orgId)) as any).pril32.inspection

describe('where an inspector reaches the server (FR-20.47, P3-8e)', () => {
  it('undeclared at first, and the page says so; in the shop, no path is asked', async () => {
    const { orgId, adminToken } = await shop('insp-shop')
    linkAt('control')
    expect(await shown(orgId)).toMatchObject({ declared: false, problem: 'undeclared', tunnel: { address: null, problem: 'link_not_full' } })
    const r = await declare(orgId, adminToken, { premises: 'shop', path: 'vpn', detail: 'ignored' })
    expect([r.status, r.json.inspection]).toEqual([200, expect.objectContaining({ declared: true, premises: 'shop', path: null, detail: null, problem: null })])
    expect(await shown(orgId)).toMatchObject({ declared: true, premises: 'shop', problem: null })
    const audit: any = await (async () => {
      for (let i = 0; i < 100; i++) {
        const row = await AuditLog.findOne({ orgId, entityType: 'server' }).lean()
        if (row) return row
        await Bun.sleep(20)
      }
      return null
    })()
    expect([audit?.entityId, audit?.changes?.[0]?.newValue]).toEqual([NODE, { premises: 'shop', path: null, detail: null }])
  })

  it('off the premises: a path is required, and the overlay or a VPN needs the address an inspector uses', async () => {
    const { orgId, adminToken } = await shop('insp-off')
    linkAt('control')
    expect([(await declare(orgId, adminToken, { premises: 'offsite' })).json.code]).toEqual(['path_required'])
    expect([(await declare(orgId, adminToken, { premises: 'offsite', path: 'overlay', detail: '  ' })).json.code]).toEqual(['detail_required'])
    expect((await declare(orgId, adminToken, { premises: 'offsite', path: 'vpn', detail: 'x'.repeat(201) })).status).toBe(422)
    expect((await declare(orgId, adminToken, { premises: 'nowhere' })).json.code).toBe('premises_required')
    const ok = await declare(orgId, adminToken, { premises: 'offsite', path: 'overlay', detail: ' 100.64.0.7 ' })
    expect([ok.status, ok.json.inspection.path, ok.json.inspection.detail, ok.json.inspection.problem]).toEqual([200, 'overlay', '100.64.0.7', null])
    expect(await shown(orgId)).toMatchObject({ premises: 'offsite', path: 'overlay', detail: '100.64.0.7', problem: null })
  })

  it('the tunnel needs the Full link and the org\'s address; it shows the address, and says when it no longer can be', async () => {
    const { orgId, adminToken } = await shop('insp-tunnel')
    linkAt('control')
    await hearSelf([{ id: orgId, address: 'https://insp-tunnel.lgrai.app' }])
    expect((await declare(orgId, adminToken, { premises: 'offsite', path: 'tunnel' })).json.code).toBe('link_not_full')
    linkAt('full')
    await hearSelf([{ id: orgId, address: null }])
    expect((await declare(orgId, adminToken, { premises: 'offsite', path: 'tunnel' })).json.code).toBe('no_address')
    await hearSelf([{ id: orgId, address: 'https://insp-tunnel.lgrai.app' }])
    const ok = await declare(orgId, adminToken, { premises: 'offsite', path: 'tunnel', detail: 'not kept' })
    expect([ok.status, ok.json.inspection]).toEqual([200, expect.objectContaining({ path: 'tunnel', detail: null, address: 'https://insp-tunnel.lgrai.app', problem: null })])
    // The link goes down to Control: the declared path no longer holds, and the page says so.
    linkAt('control')
    expect(await shown(orgId)).toMatchObject({ path: 'tunnel', problem: 'link_not_full' })
  })

  it('the org\'s admins on its server only, each org its own declaration; nothing on lgrai.app', async () => {
    const a = await shop('insp-a')
    const b = await shop('insp-b')
    linkAt('full')
    expect((await declare(a.orgId, a.memberToken, { premises: 'shop' })).status).toBe(403)
    expect((await declare(b.orgId, a.adminToken, { premises: 'shop' })).status).toBe(403)
    expect((await declare(a.orgId, a.adminToken, { premises: 'offsite', path: 'vpn', detail: 'vpn.example.com' })).status).toBe(200)
    expect(await shown(b.orgId)).toMatchObject({ declared: false })
    // On lgrai.app: the home gate refuses a write to an org written on its server; for one that lives
    // there, the page is not there.
    ;(config.node as any).role = 'global'
    forgetAllHomes()
    expect((await declare(a.orgId, a.adminToken, { premises: 'shop' })).json?.code).toBe('org_home_elsewhere')
    await OrgHome.deleteMany({}).exec()
    forgetAllHomes()
    expect((await declare(a.orgId, a.adminToken, { premises: 'shop' })).status).toBe(404)
  })

  it('lgrai.app tells a server each org\'s address, which the tunnel would be', async () => {
    const org = await createTestOrg({ slug: 'insp-self' } as any)
    const other = await createTestOrg({ slug: 'insp-self-2' } as any)
    await OrgAddress.collection.insertMany([
      { label: 'insp-self', orgId: org._id, state: 'active', requestedBy: 'u', requestedAt: new Date() },
      { label: 'insp-self-2', orgId: other._id, state: 'requested', requestedBy: 'u', requestedAt: new Date() },
    ] as any[])
    ;(config.node as any).role = 'global'
    const self = await nodeSelf({ _id: NODE, name: 'n', linkLevel: 'full', status: 'active', keyEpoch: 1, orgIds: [org._id, other._id] } as any)
    const byId = Object.fromEntries(self.orgs.map((o: any) => [o.id, o.address]))
    expect(byId).toEqual({ [String(org._id)]: `https://insp-self.${config.idp.addressApex}`, [String(other._id)]: null })
  })
})
