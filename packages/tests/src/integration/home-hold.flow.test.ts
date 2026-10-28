import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { config } from 'config'
import { Org, OrgHome, ServerNode } from 'db/models'
import { forgetAllHomes, homeOf, isHomeHere } from 'db/home/home'
import { heldHomes, holdAfterRestore, noteReportedHomes, releaseHold } from 'services/biz/home/home-hold.service'
import { recordOrgState } from 'services/biz/node/node.service'
import { alarmsOfNodes } from 'services/biz/node/node-alarms'
import { adminNodesController } from '../../../portal-api/src/controllers/admin-nodes.controller'

/**
 * An org's home record fails closed on lgrai.app (FR-20.3, AC 55, plan step P3-8d):
 * - a master registered for the org reporting a NEWER home record than global's puts the org on hold
 *   (global's database is older than the last move), and only a sys-admin settles it: adopt the
 *   server's record, or release global's;
 * - after a disaster-recovery restore every org with a server goes on hold; the org's server
 *   reconnecting with the same record releases it, and a newer one turns it into the first case.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-holdtest000000000'
const OTHER = 'master-holdother00000000'
const saved = { role: config.node.role, admins: [...config.backup.sysAdmins] }

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
beforeEach(() => {
  ;(config.node as any).role = 'global'
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  config.backup.sysAdmins.splice(0, config.backup.sysAdmins.length, ...saved.admins)
  forgetAllHomes()
  await clearCollections()
}, 60_000)

/** An org a master writes at `epoch`, as global's (restored) record has it, and the master registered for it. */
async function movedOrg(slug: string, epoch: number, nodeId = NODE) {
  const org = await createTestOrg({ slug } as any)
  await OrgHome.collection.insertOne({ orgId: org._id, home: nodeId, epoch, state: 'active', since: new Date() } as any)
  await Org.collection.updateOne({ _id: org._id }, { $set: { homeEpochHighWater: epoch } })
  forgetAllHomes()
  return { org, orgId: String(org._id) }
}

async function register(nodeId: string, orgIds: unknown[], status = 'active') {
  await ServerNode.collection.insertOne({ _id: nodeId, name: nodeId, installationId: `inst-${nodeId}`, orgIds, linkLevel: 'full', status, keyEpoch: 1 } as any)
  return (await ServerNode.findById(nodeId).lean()) as any
}

describe('a newer home record from a server holds the org on lgrai.app (FR-20.3, AC 55)', () => {
  it('holds it, raises it for the sys-admin, and adopting the server\'s record makes the server home', async () => {
    const { org, orgId } = await movedOrg('hold-newer', 2)
    const node = await register(NODE, [org._id])
    // The same record: nothing.
    expect(await noteReportedHomes(node, [{ orgId, epoch: 2 }])).toEqual({ held: 0, released: 0 })
    // A newer one: global's database is older than the last move.
    expect(await noteReportedHomes(node, [{ orgId, epoch: 3 }])).toEqual({ held: 1, released: 0 })
    expect(await homeOf(orgId, { fresh: true })).toMatchObject({ home: NODE, epoch: 2, state: 'hold' })
    // Said again: still one hold; a newer claim updates what adopting would take.
    expect(await noteReportedHomes(node, [{ orgId, epoch: 4 }])).toEqual({ held: 0, released: 0 })
    const [held] = await heldHomes()
    expect(held).toMatchObject({ orgId, slug: 'hold-newer', home: NODE, epoch: 2, reason: 'higher_epoch', claim: { nodeId: NODE, epoch: 4 } })
    const alarms = (await alarmsOfNodes([node])).get(NODE) ?? []
    expect(alarms).toContainEqual({ kind: 'home_hold', value: 1 })

    const adopted = await releaseHold(orgId, 'ops@lgr.test', { adopt: true })
    expect(adopted).toEqual({ home: NODE, epoch: 4, state: 'active' })
    expect(await homeOf(orgId, { fresh: true })).toMatchObject({ home: NODE, epoch: 4, state: 'active' })
    expect(((await Org.findById(org._id).lean()) as any).homeEpochHighWater).toBe(4)
    expect(((await OrgHome.findOne({ orgId: org._id }).lean()) as any).released).toMatchObject({ by: 'ops@lgr.test', how: 'adopted', reason: 'higher_epoch' })
    expect(await heldHomes()).toEqual([])
  }, 60_000)

  it('an org global thinks it writes, of which its server says it moved: held, and released back to global by a sys-admin', async () => {
    const org = await createTestOrg({ slug: 'hold-never-moved' } as any)
    const orgId = String(org._id)
    const node = await register(NODE, [org._id])
    expect(await isHomeHere(orgId)).toBe(true)
    expect((await noteReportedHomes(node, [{ orgId, epoch: 1 }])).held).toBe(1)
    forgetAllHomes()
    expect(await isHomeHere(orgId)).toBe(false)
    // Nothing to adopt but what was claimed; releasing keeps global's own record.
    const released = await releaseHold(orgId, 'ops@lgr.test')
    expect(released).toEqual({ home: 'global', epoch: 0, state: 'active' })
    forgetAllHomes()
    expect(await isHomeHere(orgId)).toBe(true)
  }, 60_000)

  it('only from a server registered for the org, and not revoked: no server can hold another org', async () => {
    const { orgId } = await movedOrg('hold-stranger', 2)
    const stranger = await register(OTHER, [])
    const revoked = await register(NODE, [], 'revoked')
    expect((await noteReportedHomes(stranger, [{ orgId, epoch: 9 }])).held).toBe(0)
    expect((await noteReportedHomes({ ...revoked, orgIds: [orgId] }, [{ orgId, epoch: 9 }])).held).toBe(0)
    expect((await homeOf(orgId, { fresh: true })).state).toBe('active')
    // Nonsense is nothing either.
    const node = await register('master-holdthird00000000', [orgId])
    expect((await noteReportedHomes(node, [{ orgId, epoch: -1 }, { orgId, epoch: 1.5 }, { orgId: 'x', epoch: 5 }])).held).toBe(0)
  }, 60_000)

  it('rides the master\'s report every minute: what it writes, never what it holds fenced or on hold', async () => {
    const { org, orgId } = await movedOrg('hold-report', 5)
    const second = await createTestOrg({ slug: 'hold-report-fenced' } as any)
    await OrgHome.collection.insertOne({ orgId: second._id, home: NODE, epoch: 2, state: 'active', since: new Date() } as any)
    await Org.collection.updateOne({ _id: second._id }, { $set: { homeEpochHighWater: 2 } })
    const node = await register(NODE, [org._id, second._id])
    await recordOrgState(node, { orgs: [{ orgId, head: 10, epoch: 6, state: 'active' }, { orgId: String(second._id), head: 1, epoch: 3, state: 'fenced' }] })
    forgetAllHomes()
    expect((await homeOf(orgId, { fresh: true })).state).toBe('hold')
    expect((await homeOf(String(second._id), { fresh: true })).state).toBe('active')
    // An older master sends no epoch: nothing to weigh.
    await recordOrgState(node, { orgs: [{ orgId: String(second._id), head: 1 }] })
    expect((await homeOf(String(second._id), { fresh: true })).state).toBe('active')
    // `frozen` at a move's new epoch is the master importing, before global flips: no claim, or the
    // hold would break the move itself.
    await recordOrgState(node, { orgs: [{ orgId: String(second._id), head: 1, epoch: 3, state: 'frozen' }] })
    expect((await homeOf(String(second._id), { fresh: true })).state).toBe('active')
  }, 60_000)
})

describe('after a disaster-recovery restore of lgrai.app (FR-20.3, AC 55)', () => {
  it('every org with a server goes on hold; its server reconnecting with the same record releases it, a newer one is for a sys-admin', async () => {
    const same = await movedOrg('dr-same', 2)
    const newer = await movedOrg('dr-newer', 2)
    // Moved back to global (a high-water mark, global home), and one only registered with a server.
    const back = await createTestOrg({ slug: 'dr-back' } as any)
    await OrgHome.collection.insertOne({ orgId: back._id, home: 'global', epoch: 3, state: 'active', since: new Date() } as any)
    await Org.collection.updateOne({ _id: back._id }, { $set: { homeEpochHighWater: 3 } })
    const registered = await createTestOrg({ slug: 'dr-registered' } as any)
    const untouched = await createTestOrg({ slug: 'dr-untouched' } as any)
    const node = await register(NODE, [same.org._id, newer.org._id, registered._id])

    const dry = await holdAfterRestore()
    expect(dry.held).toBe(4)
    expect(dry.orgs).not.toContain(String(untouched._id))
    expect((await homeOf(same.orgId, { fresh: true })).state).toBe('active')
    expect((await holdAfterRestore({ execute: true })).held).toBe(4)
    for (const id of [same.orgId, newer.orgId, String(back._id), String(registered._id)]) expect((await homeOf(id, { fresh: true })).state).toBe('hold')
    forgetAllHomes()
    expect(await isHomeHere(String(untouched._id))).toBe(true)
    // Again: nothing more to hold.
    expect((await holdAfterRestore({ execute: true })).held).toBe(0)

    // The server reconnects and reports: the same record releases, a newer one holds for a sys-admin.
    expect(await noteReportedHomes(node, [{ orgId: same.orgId, epoch: 2 }, { orgId: newer.orgId, epoch: 3 }])).toEqual({ held: 1, released: 1 })
    expect(await homeOf(same.orgId, { fresh: true })).toMatchObject({ home: NODE, epoch: 2, state: 'active' })
    const reasons = Object.fromEntries((await heldHomes()).map(h => [h.slug, h.reason]))
    expect(reasons).toEqual({ 'dr-newer': 'higher_epoch', 'dr-back': 'dr_restore', 'dr-registered': 'dr_restore' })
    // An org global writes again after its move back: a sys-admin releases it.
    expect(await releaseHold(String(back._id), 'ops@lgr.test')).toEqual({ home: 'global', epoch: 3, state: 'active' })
    forgetAllHomes()
    expect(await isHomeHere(String(back._id))).toBe(true)
  }, 60_000)

  it('a hold derived from the record is listed, and released by agreeing the high-water mark with the row', async () => {
    const { org, orgId } = await movedOrg('derived', 2)
    await Org.collection.updateOne({ _id: org._id }, { $set: { homeEpochHighWater: 5 } })
    forgetAllHomes()
    expect(await heldHomes()).toMatchObject([{ orgId, reason: 'epoch_disagrees', home: NODE, epoch: 2, highWater: 5 }])
    // Nothing a server claimed: nothing to adopt.
    let refused: any = null
    try { await releaseHold(orgId, 'ops@lgr.test', { adopt: true }) } catch (e) { refused = e }
    expect(refused?.code).toBe('nothing_to_adopt')
    expect(await releaseHold(orgId, 'ops@lgr.test')).toEqual({ home: NODE, epoch: 2, state: 'active' })
    expect(((await Org.findById(org._id).lean()) as any).homeEpochHighWater).toBe(2)
    expect(await heldHomes()).toEqual([])
    let notHeld: any = null
    try { await releaseHold(orgId, 'ops@lgr.test') } catch (e) { notHeld = e }
    expect(notHeld?.code).toBe('not_held')
  }, 60_000)
})

describe('the sys-admin routes (P3-8d)', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  const app = new Elysia().use(adminNodesController)
  const tokenFor = (email: string, orgId: string) => (signer as any).decorator.jwt.sign({ id: '6a0000000000000000000001', orgId, role: 'admin', email, username: 'ops', permissions: [] })
  async function call(path: string, token: string, method = 'GET', body?: unknown) {
    const res = await app.handle(new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))
    let json: any = null
    try { json = await res.json() } catch { /* empty */ }
    return { status: res.status, json }
  }

  it('a sys-admin lists, holds after a restore and releases; an org admin gets 403; a master 404', async () => {
    const { org, orgId } = await movedOrg('routes-hold', 2)
    await register(NODE, [org._id])
    config.backup.sysAdmins.splice(0, config.backup.sysAdmins.length, 'ops@lgr.test')
    const ops = await tokenFor('ops@lgr.test', orgId)
    const orgAdmin = await tokenFor('someone@lgr.test', orgId)
    expect((await call('/admin/nodes/held', orgAdmin)).status).toBe(403)
    expect((await call('/admin/nodes/held/after-restore', orgAdmin, 'POST')).status).toBe(403)
    expect((await call('/admin/nodes/held', ops)).json).toEqual({ held: [] })
    expect((await call('/admin/nodes/held/after-restore', ops)).json).toMatchObject({ held: 1 })
    expect((await call('/admin/nodes/held/after-restore', ops, 'POST')).json).toMatchObject({ held: 1 })
    expect((await call('/admin/nodes/held', ops)).json.held).toMatchObject([{ orgId, reason: 'dr_restore' }])
    expect((await call(`/admin/nodes/held/${orgId}/release`, orgAdmin, 'POST', {})).status).toBe(403)
    const released = await call(`/admin/nodes/held/${orgId}/release`, ops, 'POST', {})
    expect(released.json).toEqual({ home: { home: NODE, epoch: 2, state: 'active' } })
    expect((await call(`/admin/nodes/held/${orgId}/release`, ops, 'POST', {})).status).toBe(409)
    ;(config.node as any).role = 'master'
    expect((await call('/admin/nodes/held', ops)).status).toBe(404)
  }, 60_000)
})
