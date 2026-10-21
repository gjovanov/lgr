import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mongoose } from 'db/connection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { BackgroundTask, Desktop, Org, OrgHome } from 'db/models'
import { forgetAllHomes, homeScope } from 'db/home/home'
import { digestTick } from 'services/biz/digest/digest-runner.service'
import { backupTick } from 'services/biz/backup/backup-runner.service'
import { reapEphemeralDesktops } from 'services/biz/desktop/desktop.service'
import { failOrphanedTasks } from 'services/background/task-owner'
import { config } from 'config'

/**
 * Schedulers gated by home (FR-20.85, plan step P0b-5; AC 6).
 *
 * Every org loop a scheduler runs takes only the orgs whose home is this node: global skips the
 * orgs that moved to a master, a master sees only its own. The ticks below run at an hour when no
 * digest or backup is due, so `checked` — what the loop selected — is the whole observation and
 * nothing is mailed or bundled.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const EARLY = new Date('2026-09-03T00:30:00.000Z')   // hour 0 in UTC: before any configured hour

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  await clearCollections()
  forgetAllHomes()
  ;(config.node as any).role = 'global'
  ;(config.node as any).id = undefined
})

async function moveAway(orgId: unknown) {
  await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
  await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
  forgetAllHomes()
}

/** Two orgs opted in to both schedulers, due at 23:00 UTC. */
async function world() {
  const settings = { timezone: 'UTC', dailyDigest: { enabled: true, hour: 23 }, backup: { enabled: true, hour: 23 } }
  const home = await createTestOrg()
  const away = await createTestOrg()
  await Org.updateMany({ _id: { $in: [home._id, away._id] } }, { $set: { 'settings.timezone': 'UTC', 'settings.dailyDigest': settings.dailyDigest, 'settings.backup': settings.backup } }).exec()
  return { home, away }
}

describe('homeScope(field)', () => {
  it('puts the same condition on the field asked for', async () => {
    const { away } = await world()
    await moveAway(away._id)
    const byOrg = await homeScope() as any
    const byId = await homeScope('_id') as any
    expect(byOrg.orgId.$nin.map(String)).toEqual([String(away._id)])
    expect(byId._id.$nin.map(String)).toEqual([String(away._id)])
    expect(byId.orgId).toBeUndefined()
  })
})

describe('the org loops skip orgs homed elsewhere (AC 6)', () => {
  it('digest and backup: both orgs while nothing moved', async () => {
    await world()
    expect((await digestTick(EARLY)).checked).toBe(2)
    expect((await backupTick(EARLY)).checked).toBe(2)
  })

  it('digest and backup on global leave out an org whose home is a master', async () => {
    const { away } = await world()
    await moveAway(away._id)
    expect((await digestTick(EARLY)).checked).toBe(1)
    expect((await backupTick(EARLY)).checked).toBe(1)
  })

  it('on a master they see only the orgs homed there', async () => {
    const { away } = await world()
    await moveAway(away._id)
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = 'node-shop-1'
    forgetAllHomes()
    const orgs = await Org.find({ 'settings.dailyDigest.enabled': true, ...(await homeScope('_id')) }, { _id: 1 }).lean()
    expect(orgs.map(o => String(o._id))).toEqual([String(away._id)])
    expect((await digestTick(EARLY)).checked).toBe(1)
  })

  it('the desktop reaper leaves a silent till of an org homed elsewhere', async () => {
    const { home, away } = await world()
    const old = new Date(Date.now() - 86_400_000)
    const row = (orgId: unknown) => ({ _id: new mongoose.Types.ObjectId(), orgId, name: 'lane', ephemeral: true, ephemeralTtlSec: 60, lastSeenAt: old })
    const [here, there] = [row(home._id), row(away._id)]
    await Desktop.collection.insertMany([here, there])
    await moveAway(away._id)

    expect(await reapEphemeralDesktops(new Date())).toBe(1)

    expect(await Desktop.findById(here._id).lean()).toBeNull()
    expect(await Desktop.findById(there._id).lean()).not.toBeNull()
  })

  it('the orphaned-task sweep fails only the home orgs\' tasks, instead of being refused whole', async () => {
    const { home, away } = await world()
    const stale = { status: 'processing', owner: { process: 'gone', pod: 'gone', heartbeatAt: new Date(Date.now() - 3_600_000) }, logs: [] }
    await BackgroundTask.collection.insertMany([
      { ...stale, orgId: home._id, userId: new mongoose.Types.ObjectId(), type: 'probe' },
      { ...stale, orgId: away._id, userId: new mongoose.Types.ObjectId(), type: 'probe' },
    ])
    await moveAway(away._id)

    expect(await failOrphanedTasks()).toBe(1)

    const st = async (orgId: unknown) => (await BackgroundTask.findOne({ orgId }).lean() as any).status
    expect(await st(home._id)).toBe('failed')
    expect(await st(away._id)).toBe('processing')
  })
})
