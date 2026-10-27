import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { BackupRun, MirrorState, OrgHome, ReplOrg, Sequence, ServerNode } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { hwmFile, journalHwmTick, linkAlarmsTick, lockLegalSeries, mirrorLegalSeries } from 'services/biz/home/series-lock.service'
import { recordLastNumbers, legalSeriesOf } from 'services/biz/move/promote.service'
import { getNextNumber } from 'services/biz/sequence.service'
import { nodeSelf } from 'services/biz/node/node.service'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { applyRestore, inspectBundle } from 'services/biz/backup/backup-restore.service'

/**
 * A master whose database went back in time locks its legal series (FR-20.51, FR-20.71, plan step
 * P3-7): a restore, the journal below its own high-water mark, lgrai.app refusing its history, a
 * clone. A person's recording of the last numbers opens them, above the mirror's when linked, and a
 * signal from before it does not lock again.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-serieslocktest00'
const saved = { role: config.node.role, id: (config.node as any).id, tokenFile: config.outbox.tokenFile, upload: config.upload.dir }
let root = ''
let n = 0
const year = new Date().getFullYear()

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
beforeEach(() => {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = NODE
  root = mkdtempSync(join(tmpdir(), 'lgr-sl-'))
  ;(config.upload as any).dir = join(root, 'uploads')
  mkdirSync(join(root, 'state'), { recursive: true })
  ;(config.outbox as any).tokenFile = join(root, 'state', 'node-token.json')
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  ;(config.upload as any).dir = saved.upload
  forgetAllHomes()
  rmSync(root, { recursive: true, force: true })
  await clearCollections()
}, 60_000)

/** An org homed on this master, its journal at `seq`, and a sales series at 120. */
async function homeHere(seq = 50) {
  const org = await createTestOrg({ slug: `series-lock-${++n}` } as any)
  // Home here first: on a master, the write guard refuses an org's writes anywhere else.
  await OrgHome.collection.insertOne({ orgId: org._id, home: NODE, epoch: 1, state: 'active', since: new Date() } as any)
  forgetAllHomes()
  const admin = await createTestUser(org._id as any, { role: 'admin' } as any)
  await ReplOrg.collection.insertOne({ orgId: org._id, enabled: true, seq, pages: [] } as any)
  await Sequence.collection.insertOne({ orgId: org._id, prefix: 'SALES_DOC', year, lastNumber: 120 } as any)
  forgetAllHomes()
  return { orgId: String(org._id), oid: org._id as any, admin, by: { id: String(admin._id) } }
}
const all = async (orgId: string, last: number) => (await legalSeriesOf(orgId)).map(s => ({ ...s, last: s.prefix === 'SALES_DOC' ? last : s.last }))
const frozen = async (oid: unknown) => ((await OrgHome.findOne({ orgId: oid }).lean()) as any)?.seriesFrozen
const markOf = (orgId: string) => JSON.parse(readFileSync(hwmFile()!, 'utf8'))[orgId]?.seq

describe('the restore lock (FR-20.51)', () => {
  it('locks when the journal falls below its own mark, kept outside the database, and stays open after the unlock', async () => {
    const s = await homeHere(50)
    expect(await journalHwmTick()).toBe(0)
    expect(markOf(s.orgId)).toBe(50)
    await ReplOrg.updateOne({ orgId: s.oid }, { $set: { seq: 60 } })
    expect(await journalHwmTick()).toBe(0)
    expect(markOf(s.orgId)).toBe(60)
    // The database is restored from a backup: its journal is behind what this server journaled.
    await ReplOrg.updateOne({ orgId: s.oid }, { $set: { seq: 40 } })
    expect(await journalHwmTick()).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'restored', detail: expect.stringMatching(/at 40.*up to 60/) })
    expect(markOf(s.orgId)).toBe(60)
    expect((await captureRejection(getNextNumber(s.orgId, 'SALES_DOC')))?.code).toBe('series_frozen')
    // A person reads the last numbers off the paper: numbering resumes above them, and the mark starts again.
    await recordLastNumbers(s.orgId, s.by, await all(s.orgId, 133))
    expect(await frozen(s.oid)).toBeUndefined()
    expect(markOf(s.orgId)).toBe(40)
    expect(await journalHwmTick()).toBe(0)
    expect(await getNextNumber(s.orgId, 'SALES_DOC')).toBe(`SALES_DOC-${year}-00134`)
    // An org not written here is never this server's to lock.
    const away = await homeHere(5)
    await OrgHome.updateOne({ orgId: away.oid }, { $set: { home: 'global' } })
    const hwm = JSON.parse(readFileSync(hwmFile()!, 'utf8'))
    writeFileSync(hwmFile()!, JSON.stringify({ ...hwm, [away.orgId]: { seq: 99, at: new Date().toISOString() } }))
    forgetAllHomes()
    expect(await journalHwmTick()).toBe(0)
    expect(await frozen(away.oid)).toBeUndefined()
  }, 60_000)

  it('locks on what lgrai.app says of this server: a clone alarm, a history that went back; never on an older one after the unlock', async () => {
    const s = await homeHere()
    writeFileSync(config.outbox.tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
    let self: any = {}
    const fetchImpl = (async (input: any) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/node/v1/self') return Response.json(self)
      if (url.pathname === '/api/node/v1/legal-series' && url.searchParams.get('orgId') === s.orgId) return Response.json({ series: [{ prefix: 'SALES_DOC', year, last: 140 }] })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    expect(await linkAlarmsTick(fetchImpl)).toBe(0)
    const cloned = new Date()
    self = { cloneAlarm: { at: cloned } }
    expect(await linkAlarmsTick(fetchImpl)).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'clone' })
    // The unlock, above the mirror's number too (140 > the person's 125).
    const floor = await mirrorLegalSeries(s.orgId, fetchImpl)
    expect(floor).toEqual([{ prefix: 'SALES_DOC', year, last: 140 }])
    await recordLastNumbers(s.orgId, s.by, await all(s.orgId, 125), floor)
    expect(await getNextNumber(s.orgId, 'SALES_DOC')).toBe(`SALES_DOC-${year}-00141`)
    // The same alarm, still standing: it does not lock again.
    expect(await linkAlarmsTick(fetchImpl)).toBe(0)
    // A newer refusal of its history does.
    self = { wentBack: [{ orgId: s.orgId, reason: 'diverged', at: new Date(Date.now() + 1000) }] }
    expect(await linkAlarmsTick(fetchImpl)).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'went_back', detail: expect.stringContaining('diverged') })
    // Locked once: a second signal changes nothing.
    expect(await lockLegalSeries(s.orgId, 'clone')).toBe(false)
  }, 60_000)

  it('global tells a master what it holds against it: a clone alarm, and a refusal newer than its last page', async () => {
    ;(config.node as any).role = 'global'
    // On lgrai.app the org is the mirror of the master's: nothing of it is written here.
    const org = await createTestOrg({ slug: `series-lock-${++n}` } as any)
    const s = { orgId: String(org._id), oid: org._id as any }
    const other = await createTestOrg({ slug: `series-lock-other-${n}` } as any)
    await ServerNode.collection.insertOne({ _id: NODE, name: 'Shop', orgIds: [s.oid, other._id], linkLevel: 'full', status: 'active', keyEpoch: 1, cloneAlarm: { at: new Date(), channel: 'bulk', bootNonces: ['a', 'b'] } } as any)
    const node: any = await ServerNode.findById(NODE).lean()
    const old = new Date(Date.now() - 60_000)
    await MirrorState.collection.insertMany([
      { orgId: s.oid, nodeId: NODE, watermark: 9, lastPageAt: old, lastRefusal: { reason: 'diverged', at: new Date() }, refused: 1, alarms: [] },
      // Pages flowed after this refusal: it is over.
      { orgId: other._id, nodeId: NODE, watermark: 9, lastPageAt: new Date(), lastRefusal: { reason: 'stale_journal', at: old }, refused: 1, alarms: [] },
    ] as any)
    const self: any = await nodeSelf(node)
    expect(self.cloneAlarm?.at).toBeTruthy()
    expect(self.wentBack).toEqual([{ orgId: s.orgId, reason: 'diverged', at: expect.any(Date) }])
  }, 60_000)

  it('an in-app restore on a master locks the series before its first write, and a refused one locks nothing', async () => {
    const s = await homeHere()
    await createTestContact(s.oid, { companyName: 'Before the backup' } as any)
    const outcome = await runBackupForOrg(s.orgId, '2026-10-26', { kind: 'full' })
    expect(outcome?.status).toBe('completed')
    const run: any = await BackupRun.findOne({ orgId: s.oid }).lean()
    const actor = { userId: String(s.admin._id), email: 'admin@lock.test' }
    // Refused before anything is written: not inspected. Numbering stays open.
    const refused = await captureRejection(applyRestore(s.orgId, { type: 'run', runId: String(run._id) }, { mode: 'merge', inspectionId: String(new mongoose.Types.ObjectId()), actor }))
    expect(refused?.message).toMatch(/inspect/)
    expect(await frozen(s.oid)).toBeUndefined()
    const inspection: any = await inspectBundle(s.orgId, { type: 'run', runId: String(run._id) }, actor)
    const applied: any = await applyRestore(s.orgId, { type: 'run', runId: String(run._id) }, { mode: 'merge', inspectionId: String(inspection._id), actor })
    expect(applied.status).toBe('completed')
    expect(await frozen(s.oid)).toMatchObject({ reason: 'restored', detail: 'restored from a backup' })
    expect((await captureRejection(getNextNumber(s.orgId, 'SALES_DOC')))?.code).toBe('series_frozen')
  }, 120_000)
})
