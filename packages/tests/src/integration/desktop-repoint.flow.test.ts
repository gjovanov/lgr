import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Desktop, Org, OrgHome, ServerNode } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { signDesktopToken } from 'services/biz/desktop/desktop.service'
import { movedFor } from 'services/biz/desktop/repoint.service'
import { acceptedRepointKeys, verifyRepoint } from 'services/biz/desktop/repoint-token'
import { keysFromSpki } from 'services/biz/crypto/ed-jws'
import { sanitizeHealth } from 'services/biz/node/node.service'
import { Elysia } from 'elysia'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import {
  handleDesktopClose,
  handleDesktopMessage,
  handleDesktopOpen,
  isDesktopOnline,
  repointOrgDesktops,
} from '../../../portal-api/src/websocket/desktop'

/**
 * Desktops follow their org's home (FR-20.82, plan step P3-6b): global's side. A desktop of an org
 * that moved to its master is told where the master answers on the shop's LAN and which CA to pin
 * there, in an instruction signed for that desktop alone, and nothing of it is written here.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-repointtestaaaaa'
const LAN = { url: 'https://192.168.8.115:4443', caFingerprint: `sha256:${'J4_Wvnqz'.repeat(5)}abc` }
const saved = { role: config.node.role }
let app: any

beforeAll(async () => {
  await setupTestDB()
  // The app's own error mapping, as unified.ts mounts it before every controller.
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  ;(config.node as any).role = saved.role
  forgetAllHomes()
  await clearCollections()
}, 60_000)

function fakeWs() {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    raw: { id: Math.random() },
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    sent,
    closed,
    last: (type: string) => [...sent].reverse().find(m => m.type === type),
  }
}

async function till() {
  const org = await createTestOrg()
  const desktop = await Desktop.create({ orgId: org._id, name: 'TILL-1', installationId: `inst-${Math.random()}`, machineId: 'machine-1', publicKey: 'x'.repeat(60), status: 'active' })
  const { token } = signDesktopToken({ desktopId: String(desktop._id), orgId: String(org._id), keyEpoch: (desktop as any).keyEpoch ?? 1 })
  return { orgId: String(org._id), desktopId: String(desktop._id), token }
}

/** What a move to the master leaves on global: the home record, its high-water mark, the registry. */
async function moved(orgId: string, lan: unknown = LAN, status = 'active') {
  await ServerNode.collection.insertOne({ _id: NODE as any, name: 'Kasa server', status, orgIds: [new mongoose.Types.ObjectId(orgId)], linkLevel: 'full', health: { at: new Date(), ...(lan ? { lan } : {}) } })
  await OrgHome.collection.insertOne({ orgId: new mongoose.Types.ObjectId(orgId), home: NODE, epoch: 1, state: 'active', since: new Date() } as any)
  await Org.collection.updateOne({ _id: new mongoose.Types.ObjectId(orgId) }, { $set: { homeEpochHighWater: 1 } })
  forgetAllHomes()
}

async function connect(token: string) {
  const ws = fakeWs()
  handleDesktopOpen(ws)
  await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:auth', token }))
  return ws
}

describe('where a master answers (its health frame)', () => {
  it('is kept only in the shape a desktop would take', () => {
    expect(sanitizeHealth({ lan: LAN }).lan).toEqual(LAN)
    expect(sanitizeHealth({ lan: { url: 'https://[fe80::1]:4443', caFingerprint: LAN.caFingerprint } }).lan).toBeTruthy()
    for (const url of ['http://192.168.8.115:4443', 'https://192.168.8.115:4443/x', 'https://user:pw@192.168.8.115', 'https://a b', 42]) {
      expect(sanitizeHealth({ lan: { ...LAN, url } }).lan).toBeUndefined()
    }
    expect(sanitizeHealth({ lan: { ...LAN, caFingerprint: 'sha256:short' } }).lan).toBeUndefined()
    expect(sanitizeHealth({}).lan).toBeUndefined()
  })
})

describe('what a desktop of a moved org is told (FR-20.82)', () => {
  it('a re-point signed for it alone; "moved" when global cannot say where; nothing while the org is home here', async () => {
    const t = await till()
    expect(await movedFor(t.desktopId, t.orgId)).toBeNull()
    await moved(t.orgId)
    const m = await movedFor(t.desktopId, t.orgId)
    expect(m).toMatchObject({ kind: 'repoint', node: NODE, name: 'Kasa server' })
    const v = verifyRepoint((m as any).instruction, acceptedRepointKeys())
    expect(v.ok).toBe(true)
    expect((v as any).claims).toMatchObject({ v: 1, iss: 'lgrai.app', sub: t.desktopId, org: t.orgId, node: NODE, epoch: 1, server: LAN.url, fp: LAN.caFingerprint })
    // Bound to its desktop: another key, or an altered claim, does not verify.
    const [h, p, sig] = (m as any).instruction.split('.')
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...(v as any).claims, server: 'https://10.6.6.6:4443' })).toString('base64url')}.${sig}`
    expect(verifyRepoint(forged, acceptedRepointKeys())).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyRepoint(`${h}.${p}.${sig}`, new Map())).toEqual({ ok: false, reason: 'unknown_key' })

    // Nothing to send it to: the master never said where it answers, or it was removed.
    await ServerNode.updateOne({ _id: NODE }, { $unset: { 'health.lan': 1 } })
    expect(await movedFor(t.desktopId, t.orgId)).toEqual({ kind: 'moved', node: NODE, name: 'Kasa server' })
    await ServerNode.updateOne({ _id: NODE }, { $set: { 'health.lan': LAN, status: 'revoked' } })
    expect((await movedFor(t.desktopId, t.orgId))?.kind).toBe('moved')
    // A master tells nothing of the kind: the move back is its own (P3-6c).
    ;(config.node as any).role = 'master'
    expect(await movedFor(t.desktopId, t.orgId)).toBeNull()
  }, 60_000)

  it('frozen for a move, the org is still served here: nothing to tell yet', async () => {
    const t = await till()
    await OrgHome.collection.insertOne({ orgId: new mongoose.Types.ObjectId(t.orgId), home: 'global', epoch: 0, state: 'freezing', since: new Date() } as any)
    forgetAllHomes()
    expect(await movedFor(t.desktopId, t.orgId)).toBeNull()
  }, 60_000)
})

describe('the contract the shell verifies (repoint-vector.json)', () => {
  it('global believes the instruction the shell\'s own tests believe, and nothing else', async () => {
    const v = JSON.parse(await Bun.file(new URL('../../../desktop/src-tauri/src/repoint-vector.json', import.meta.url)).text())
    const keys = keysFromSpki([v.spki])
    const jws = v.jwsParts.join('.')
    const r = verifyRepoint(jws, keys, v.nowSec * 1000)
    expect(r).toMatchObject({ ok: true, claims: { sub: v.desktopId, org: v.orgId, node: v.claims.node, epoch: v.claims.epoch, server: v.claims.server, fp: v.claims.fp } })
    // The built-in keys never signed the vector: a throwaway key did.
    expect(verifyRepoint(jws, acceptedRepointKeys(true), v.nowSec * 1000)).toEqual({ ok: false, reason: 'unknown_key' })
  })
})

describe('/ws/desktop for a moved org', () => {
  it('at authentication: the re-point, the refusal an older shell understands, then closed; nothing written', async () => {
    const t = await till()
    await moved(t.orgId)
    const ws = await connect(t.token)
    expect(ws.last('desktop:repoint')).toMatchObject({ node: NODE, name: 'Kasa server' })
    expect(verifyRepoint(ws.last('desktop:repoint').instruction, acceptedRepointKeys()).ok).toBe(true)
    expect(ws.last('desktop:error')).toMatchObject({ code: 'org_moved' })
    expect(ws.last('desktop:authenticated')).toBeUndefined()
    expect(ws.closed).toEqual([{ code: 4401, reason: 'org_moved' }])
    expect(isDesktopOnline(t.desktopId)).toBe(false)
    expect((await Desktop.findById(t.desktopId).lean() as any).lastSeenAt).toBeUndefined()
    handleDesktopClose(ws)
  }, 60_000)

  it('"moved" when global cannot say where the master answers', async () => {
    const t = await till()
    await moved(t.orgId, null)
    const ws = await connect(t.token)
    expect(ws.last('desktop:moved')).toEqual({ type: 'desktop:moved', node: NODE, name: 'Kasa server' })
    expect(ws.last('desktop:repoint')).toBeUndefined()
    expect(ws.closed[0]?.reason).toBe('org_moved')
    handleDesktopClose(ws)
  }, 60_000)

  it('at the flip, a connected desktop of the org is told at once; another org\'s is not', async () => {
    const t = await till()
    const other = await till()
    const ws = await connect(t.token)
    const otherWs = await connect(other.token)
    expect(isDesktopOnline(t.desktopId)).toBe(true)
    await moved(t.orgId)
    expect(await repointOrgDesktops(t.orgId)).toBe(1)
    expect(ws.last('desktop:repoint')).toBeTruthy()
    expect(ws.closed[0]?.reason).toBe('org_moved')
    expect(otherWs.last('desktop:repoint')).toBeUndefined()
    expect(otherWs.closed).toEqual([])
    handleDesktopClose(ws)
    handleDesktopClose(otherWs)
  }, 60_000)

  it('a move that flipped on another process: told on the next heartbeat', async () => {
    const t = await till()
    const ws = await connect(t.token)
    await moved(t.orgId)
    await handleDesktopMessage(ws, JSON.stringify({ type: 'desktop:heartbeat', clientTime: new Date().toISOString() }))
    expect(ws.last('desktop:repoint')).toBeTruthy()
    expect(ws.last('desktop:heartbeat:ack')).toBeUndefined()
    expect(ws.closed[0]?.reason).toBe('org_moved')
    handleDesktopClose(ws)
  }, 60_000)
})

describe('a moved org\'s desktop over HTTP', () => {
  it('a write is the home gate\'s 409, never a 500', async () => {
    const t = await till()
    await moved(t.orgId)
    const res = await app.handle(new Request('http://localhost/api/desktop/v1/self', {
      method: 'PUT',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ appVersion: '0.1.9' }),
    }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'org_home_elsewhere', home: { kind: 'master', state: 'active' } })
  }, 60_000)
})
