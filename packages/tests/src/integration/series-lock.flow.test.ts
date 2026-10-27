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
import { REPLACE_REFUSED, hwmFile, journalHwmTick, linkAlarmsTick, lockLegalSeries, mirrorLegalSeries, reportOrgState } from 'services/biz/home/series-lock.service'
import { recordLastNumbers, legalSeriesOf } from 'services/biz/move/promote.service'
import { getNextNumber } from 'services/biz/sequence.service'
import { nodeSelf, orgStateFor, recordOrgState } from 'services/biz/node/node.service'
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
    // A refusal of its history does: the first sign that it went back, recorded.
    self = { wentBack: [{ orgId: s.orgId, reason: 'diverged', at: new Date(Date.now() + 1000) }] }
    expect(await linkAlarmsTick(fetchImpl)).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'went_back', detail: expect.stringContaining('diverged') })
    expect(((await ReplOrg.findOne({ orgId: s.oid }).lean()) as any).wentBack).toMatchObject({ reason: 'diverged' })
    // Locked once: a second signal changes nothing.
    expect(await lockLegalSeries(s.orgId, 'clone')).toBe(false)
    // Unlocked; the pump's next session sends the refused history again and lgrai.app dates its
    // refusal anew. The record decides, not the date: nothing locks again until a re-seed.
    await recordLastNumbers(s.orgId, s.by, await all(s.orgId, 150))
    self = { wentBack: [{ orgId: s.orgId, reason: 'diverged', at: new Date(Date.now() + 60_000) }] }
    expect(await linkAlarmsTick(fetchImpl)).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
  }, 60_000)

  it('locks when lgrai.app holds more of the journal than the database has: a reverted disk took its own mark back with it', async () => {
    // The mark beside the token went back with the disk: only global's watermark is still ahead.
    const s = await homeHere(50)
    writeFileSync(config.outbox.tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
    let self: any = { mirrors: [{ orgId: s.orgId, watermark: 50, lastPageAt: new Date() }] }
    const fetchImpl = (async (input: any) => (new URL(String(input)).pathname === '/api/node/v1/self' ? Response.json(self) : new Response('{}', { status: 404 }))) as unknown as typeof fetch
    // Level with the mirror, or ahead of it: the healthy case.
    expect(await linkAlarmsTick(fetchImpl)).toBe(0)
    await ReplOrg.updateOne({ orgId: s.oid }, { $set: { seq: 70 } })
    self = { mirrors: [{ orgId: s.orgId, watermark: 64, lastPageAt: new Date() }] }
    expect(await linkAlarmsTick(fetchImpl)).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    // The disk is reverted to a snapshot taken at 40; lgrai.app applied pages up to 64 since.
    await ReplOrg.updateOne({ orgId: s.oid }, { $set: { seq: 40 } })
    expect(await journalHwmTick()).toBe(0)
    expect(await linkAlarmsTick(fetchImpl)).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'went_back', detail: expect.stringMatching(/up to 64.*at 40 here/) })
    expect(((await ReplOrg.findOne({ orgId: s.oid }).lean()) as any).wentBack).toMatchObject({ reason: 'mirror_ahead' })
    // A person records the numbers; the database is still behind (no re-seed yet): the same event.
    await recordLastNumbers(s.orgId, s.by, await all(s.orgId, 121))
    expect(await linkAlarmsTick(fetchImpl)).toBe(0)
    expect(await getNextNumber(s.orgId, 'SALES_DOC')).toBe(`SALES_DOC-${year}-00122`)
    // Once a re-seed has cleared the record, a database behind the mirror again is a new event.
    await ReplOrg.collection.updateOne({ orgId: s.oid }, { $unset: { wentBack: '' } })
    self = { mirrors: [{ orgId: s.orgId, watermark: 90, lastPageAt: new Date() }] }
    expect(await linkAlarmsTick(fetchImpl)).toBe(1)
  }, 60_000)

  it('the master tells lgrai.app what it found, and lgrai.app keeps only what it may: its orgs, known reasons, bounded text', async () => {
    const s = await homeHere(70)
    writeFileSync(config.outbox.tokenFile, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
    await ReplOrg.collection.updateOne({ orgId: s.oid }, { $set: { wentBack: { at: new Date(), reason: 'mirror_ahead', detail: 'lgrai.app holds more' } } })
    await lockLegalSeries(s.orgId, 'went_back', 'lgrai.app holds more')
    let sent: any = null
    const fetchImpl = (async (input: any, init: any) => {
      if (new URL(String(input)).pathname !== '/api/node/v1/org-state' || init?.method !== 'POST') return new Response('{}', { status: 404 })
      sent = JSON.parse(String(init.body))
      return Response.json({ ok: true, orgs: 1 })
    }) as unknown as typeof fetch
    expect(await reportOrgState(fetchImpl)).toBe(true)
    expect(sent.orgs).toEqual([{
      orgId: s.orgId,
      head: 70,
      wentBack: { at: expect.any(String), reason: 'mirror_ahead', detail: 'lgrai.app holds more' },
      numbering: { since: expect.any(String), reason: 'went_back', detail: 'lgrai.app holds more' },
    }])

    // On lgrai.app: kept for the orgs the server is registered for, and nothing it should not say.
    ;(config.node as any).role = 'global'
    const other = await createTestOrg({ slug: `series-lock-other-${n}` } as any)
    const stranger = await createTestOrg({ slug: `series-lock-stranger-${n}` } as any)
    await ServerNode.collection.insertOne({ _id: NODE, name: 'Shop', orgIds: [s.oid, other._id], linkLevel: 'full', status: 'active', keyEpoch: 1 } as any)
    const node: any = await ServerNode.findById(NODE).lean()
    const kept = await recordOrgState(node, {
      orgs: [
        { ...sent.orgs[0], numbering: { ...sent.orgs[0].numbering, since: new Date(Date.now() + 86_400_000).toISOString(), detail: 'x'.repeat(2000) } },
        { orgId: String(other._id), head: 3, wentBack: { at: new Date().toISOString(), reason: 'made_up' }, numbering: { reason: 'because' } },
        // Another org's, which the server is not registered for: never kept.
        { orgId: String(stranger._id), head: 9, numbering: { since: new Date().toISOString(), reason: 'clone' } },
        { orgId: s.orgId, head: 1 },
      ],
    })
    expect(kept).toBe(2)
    const row: any = await ServerNode.findById(NODE).lean()
    const mine = orgStateFor(row, s.orgId) as any
    expect(mine.wentBack).toMatchObject({ reason: 'mirror_ahead', detail: 'lgrai.app holds more' })
    expect(mine.numbering.reason).toBe('went_back')
    expect(mine.numbering.detail).toHaveLength(300)
    expect(new Date(mine.numbering.since).getTime()).toBeLessThanOrEqual(Date.now())
    // An unknown reason is dropped, and the account of one org never shows another's.
    expect(orgStateFor(row, String(other._id))).toEqual({ at: expect.any(Date) })
    expect(orgStateFor(row, String(stranger._id))).toBeNull()
  }, 60_000)

  it('global tells a master what it holds against it: a clone alarm, and a refusal newer than its last page', async () => {
    ;(config.node as any).role = 'global'
    // On lgrai.app the org is the mirror of the master's: nothing of it is written here.
    const org = await createTestOrg({ slug: `series-lock-${++n}` } as any)
    const s = { orgId: String(org._id), oid: org._id as any }
    const other = await createTestOrg({ slug: `series-lock-other-${n}` } as any)
    await ServerNode.collection.insertOne({ _id: NODE, name: 'Shop', orgIds: [s.oid, other._id], linkLevel: 'full', status: 'active', keyEpoch: 1, cloneAlarm: { at: new Date(), channel: 'bulk', bootNonces: ['a', 'b'] } } as any)
    const old = new Date(Date.now() - 60_000)
    const third = await createTestOrg({ slug: `series-lock-third-${n}` } as any)
    await MirrorState.collection.insertMany([
      { orgId: s.oid, nodeId: NODE, watermark: 9, chainHash: 'a'.repeat(64), lastPageAt: old, lastRefusal: { reason: 'diverged', at: new Date() }, refused: 1, alarms: [] },
      // Pages flowed after this refusal: it is over.
      { orgId: other._id, nodeId: NODE, watermark: 12, chainHash: 'b'.repeat(64), lastPageAt: new Date(), lastRefusal: { reason: 'stale_journal', at: old }, refused: 1, alarms: [] },
      // A refusal before any page: no chain, so nothing of this server's journal is held.
      { orgId: third._id, watermark: 0, chainHash: '', lastRefusal: { reason: 'gap', at: new Date() }, refused: 1, alarms: [] },
    ] as any)
    await ServerNode.updateOne({ _id: NODE }, { $push: { orgIds: third._id } } as any)
    const self: any = await nodeSelf((await ServerNode.findById(NODE).lean()) as any)
    expect(self.cloneAlarm?.at).toBeTruthy()
    expect(self.wentBack).toEqual([{ orgId: s.orgId, reason: 'diverged', at: expect.any(Date) }])
    expect(self.mirrors.sort((a: any, b: any) => a.watermark - b.watermark)).toEqual([
      { orgId: s.orgId, watermark: 9, lastPageAt: expect.any(Date) },
      { orgId: String(other._id), watermark: 12, lastPageAt: expect.any(Date) },
    ])
  }, 60_000)

  it('an in-app Replace on a master lgrai.app never knew locks the series before its first write; a refused one, or a Merge, locks nothing', async () => {
    const s = await homeHere()
    const org: any = await mongoose.connection.db!.collection('orgs').findOne({ _id: s.oid })
    await createTestContact(s.oid, { companyName: 'Before the backup' } as any)
    const outcome = await runBackupForOrg(s.orgId, '2026-10-26', { kind: 'full' })
    expect(outcome?.status).toBe('completed')
    const run: any = await BackupRun.findOne({ orgId: s.oid }).lean()
    const actor = { userId: String(s.admin._id), email: 'admin@lock.test' }
    const src = { type: 'run' as const, runId: String(run._id) }
    // Refused before anything is written: not inspected. Numbering stays open.
    const refused = await captureRejection(applyRestore(s.orgId, src, { mode: 'replace', confirmSlug: org.slug, inspectionId: String(new mongoose.Types.ObjectId()), actor }))
    expect(refused?.message).toMatch(/inspect/)
    expect(await frozen(s.oid)).toBeUndefined()
    const inspection: any = await inspectBundle(s.orgId, src, actor)
    // A Merge adds only what is missing, every counter clamped upwards: nothing goes back.
    const merged: any = await applyRestore(s.orgId, src, { mode: 'merge', inspectionId: String(inspection._id), actor })
    expect(merged.status).toBe('completed')
    expect(await frozen(s.oid)).toBeUndefined()
    // After the backup: a contact the Replace below takes away again.
    await createTestContact(s.oid, { companyName: 'After the backup' } as any)
    const replaced: any = await applyRestore(s.orgId, src, { mode: 'replace', confirmSlug: org.slug, inspectionId: String(inspection._id), actor })
    expect(replaced.status).toBe('completed')
    expect(await mongoose.connection.db!.collection('contacts').countDocuments({ orgId: s.oid, companyName: 'After the backup' })).toBe(0)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'restored', detail: 'restored from a backup' })
    expect((await captureRejection(getNextNumber(s.orgId, 'SALES_DOC')))?.code).toBe('series_frozen')
  }, 120_000)

  it('a Replace on a master lgrai.app knows is refused before anything is read or written: its pages would take the mirror back with it', async () => {
    const s = await homeHere()
    const org: any = await mongoose.connection.db!.collection('orgs').findOne({ _id: s.oid })
    await createTestContact(s.oid, { companyName: 'Before the backup' } as any)
    await runBackupForOrg(s.orgId, '2026-10-26', { kind: 'full' })
    const run: any = await BackupRun.findOne({ orgId: s.oid }).lean()
    const actor = { userId: String(s.admin._id), email: 'admin@lock.test' }
    const src = { type: 'run' as const, runId: String(run._id) }
    const inspection: any = await inspectBundle(s.orgId, src, actor)
    await createTestContact(s.oid, { companyName: 'After the backup' } as any)
    const replace = () => captureRejection(applyRestore(s.orgId, src, { mode: 'replace', confirmSlug: org.slug, inspectionId: String(inspection._id), actor }))
    const saved = config.replication.registrationFile
    try {
      // Registered with lgrai.app (at any link level).
      ;(config.replication as any).registrationFile = join(root, 'state', 'registration.json')
      writeFileSync(config.replication.registrationFile, JSON.stringify({ server: 'https://lgrai.test', nodeId: NODE, linkLevel: 'control', orgs: [], registeredAt: 0 }))
      expect((await replace())?.message).toBe(REPLACE_REFUSED)
      ;(config.replication as any).registrationFile = ''
      // Or no registration on record, but pages of the org were built for the mirror.
      await ReplOrg.updateOne({ orgId: s.oid }, { $set: { pages: [{ toSeq: 9, hash: 'c'.repeat(64), at: new Date() }] } })
      expect((await replace())?.message).toBe(REPLACE_REFUSED)
    } finally {
      ;(config.replication as any).registrationFile = saved
    }
    // Nothing was written, nothing locked, and a Merge still runs.
    expect(await mongoose.connection.db!.collection('contacts').countDocuments({ orgId: s.oid, companyName: 'After the backup' })).toBe(1)
    expect(await mongoose.connection.db!.collection('restoreruns').countDocuments({ orgId: s.oid, mode: 'replace' })).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    expect(((await applyRestore(s.orgId, src, { mode: 'merge', inspectionId: String(inspection._id), actor })) as any).status).toBe('completed')
    expect(await frozen(s.oid)).toBeUndefined()
  }, 120_000)
})
