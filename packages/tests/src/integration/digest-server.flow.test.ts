import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { config } from 'config'
import { BackupRun, OrgHome, Outbox, ReplOrg } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { buildDailyDigest, buildServerSection } from 'services/biz/digest/daily-digest.service'
import { renderDigestHtml } from 'services/biz/digest/daily-digest.render'
import { isSectionError, type DigestServer } from 'services/biz/digest/daily-digest.types'

/**
 * FR-20.100 (plan step P3-8b): the daily digest of an org written on its own server says, every
 * morning, how far lgrai.app's copy holds it, its last backup there, and what waits for the
 * internet, each line red past FR-20.101's threshold. Built only on that server: lgrai.app writes no
 * digest for an org it does not write.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-digestserver00000'
const saved = { role: config.node.role, id: (config.node as any).id }
const HOUR = 3_600_000
const NOW = new Date('2026-10-27T05:00:00Z')
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR)

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  forgetAllHomes()
  await clearCollections()
}, 60_000)

/** An org written on this server since `homeFor` hours, its journal at 42. */
async function homed(slug: string, homeFor = 48) {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = NODE
  const org = await createTestOrg({ slug } as any)
  await OrgHome.collection.insertOne({ orgId: org._id, home: NODE, epoch: 1, state: 'active', since: ago(homeFor) } as any)
  await ReplOrg.collection.insertOne({ orgId: org._id, seq: 42 } as any)
  return { org, orgId: String(org._id) }
}

const heard = (orgId: string, h: number, mirror?: { watermark: number; lastPageAt: Date }) => ({
  at: ago(h),
  body: { mirrors: mirror ? [{ orgId, watermark: mirror.watermark, lastPageAt: mirror.lastPageAt.toISOString() }] : [] },
})

describe('the digest of an org written on its own server (FR-20.100)', () => {
  it('a day with nothing to report: the copy current, a fresh backup, nothing waiting', async () => {
    const { org, orgId } = await homed('ds-clean')
    await BackupRun.collection.insertOne({ orgId: org._id, kind: 'full', date: '2026-10-27', status: 'completed', completedAt: ago(3) } as any)
    const s = await buildServerSection(orgId, { now: NOW, uptimeSecs: 86_400, self: heard(orgId, 0.05, { watermark: 42, lastPageAt: ago(0.2) }) })
    expect(s).toEqual({ heardHours: 0, mirror: { behind: 0, lastPageHours: 0 }, backupHours: 3, queued: 0, alarms: [] })
  })

  it('lgrai.app unheard for an hour: never, by a server that has run that long; not yet, just after a start', async () => {
    const { orgId } = await homed('ds-unheard')
    const gone = await buildServerSection(orgId, { now: NOW, uptimeSecs: 86_400, self: heard(orgId, 3, { watermark: 42, lastPageAt: ago(3) }) })
    expect(gone.alarms).toContain('unheard')
    expect(gone.heardHours).toBe(3)
    // What lgrai.app said three hours ago is not where its copy is now.
    expect(gone.mirror).toBeUndefined()
    expect((await buildServerSection(orgId, { now: NOW, uptimeSecs: 2 * 3600, self: null })).alarms).toContain('unheard')
    expect((await buildServerSection(orgId, { now: NOW, uptimeSecs: 600, self: null })).alarms).not.toContain('unheard')
  })

  it('the copy behind with nothing received for an hour; behind but moving is not a lag', async () => {
    const { orgId } = await homed('ds-lag')
    const stuck = await buildServerSection(orgId, { now: NOW, uptimeSecs: 86_400, self: heard(orgId, 0, { watermark: 30, lastPageAt: ago(2) }) })
    expect(stuck.mirror).toEqual({ behind: 12, lastPageHours: 2 })
    expect(stuck.alarms).toContain('mirror_lag')
    const moving = await buildServerSection(orgId, { now: NOW, uptimeSecs: 86_400, self: heard(orgId, 0, { watermark: 30, lastPageAt: ago(0.1) }) })
    expect(moving.alarms).not.toContain('mirror_lag')
  })

  it('no backup once the org has been written here 26 hours; one over 26 hours old', async () => {
    const fresh = await homed('ds-new', 2)
    const self = { at: NOW, body: { mirrors: [] } }
    expect((await buildServerSection(fresh.orgId, { now: NOW, uptimeSecs: 86_400, self })).alarms).toEqual([])
    const settled = await homed('ds-settled', 30)
    expect((await buildServerSection(settled.orgId, { now: NOW, uptimeSecs: 86_400, self })).alarms).toEqual(['backup_none'])
    await BackupRun.collection.insertOne({ orgId: settled.org._id, kind: 'full', date: '2026-10-25', status: 'completed', completedAt: ago(30) } as any)
    const stale = await buildServerSection(settled.orgId, { now: NOW, uptimeSecs: 86_400, self })
    expect(stale.alarms).toEqual(['backup_stale'])
    expect(stale.backupHours).toBe(30)
  })

  it('what waits for the internet, red once the oldest has waited an hour', async () => {
    const { org, orgId } = await homed('ds-queued', 2)
    const self = { at: NOW, body: { mirrors: [] } }
    await Outbox.collection.insertMany([
      { _id: 'dq1', orgId: org._id, kind: 'mail', payload: {}, state: 'queued', nextAt: NOW, createdAt: ago(0.25) },
      { _id: 'dq2', orgId: org._id, kind: 'mail', payload: {}, state: 'sent', nextAt: NOW, createdAt: ago(5) },
    ] as any[])
    const recent = await buildServerSection(orgId, { now: NOW, uptimeSecs: 86_400, self })
    expect([recent.queued, recent.oldestQueuedHours, recent.alarms]).toEqual([1, 0, []])
    await Outbox.collection.insertOne({ _id: 'dq3', orgId: org._id, kind: 'mail', payload: {}, state: 'sending', nextAt: NOW, createdAt: ago(3) } as any)
    const old = await buildServerSection(orgId, { now: NOW, uptimeSecs: 86_400, self })
    expect([old.queued, old.oldestQueuedHours, old.alarms]).toEqual([2, 3, ['queued_old']])
  })

  it('in the digest on the server only, keeping the day off "all clear" when a line is red', async () => {
    const { orgId } = await homed('ds-digest')
    const d = await buildDailyDigest(orgId, '2026-10-26')
    const server = d.server as DigestServer
    expect(server).toBeDefined()
    expect(isSectionError(server)).toBe(false)
    // An org written here 48 h with no backup: red, whatever lgrai.app last said.
    expect(server.alarms).toContain('backup_none')
    expect(d.allClear).toBe(false)
    // Switched off, it is not built.
    expect((await buildDailyDigest(orgId, '2026-10-26', { sections: { server: false } })).server).toBeUndefined()
    // On lgrai.app: not there.
    ;(config.node as any).role = 'global'
    expect((await buildDailyDigest(orgId, '2026-10-26')).server).toBeUndefined()
  })

  it('renders three lines in the org\'s language, red past the threshold', () => {
    const base = { orgId: 'x', orgName: 'Shop', date: '2026-10-26', timezone: 'Europe/Sofia', generatedAt: NOW.toISOString(), allClear: false }
    const red: DigestServer = { heardHours: 0, mirror: { behind: 12, lastPageHours: 2 }, queued: 2, oldestQueuedHours: 3, alarms: ['mirror_lag', 'backup_none', 'queued_old'] }
    const html = renderDigestHtml({ ...base, locale: 'bg', server: red } as any)
    expect(html).toContain('Сървърът на организацията')
    expect(html).toContain('изостава с 12 промени; последната пристигна преди 2 ч.')
    expect(html).toContain('НЯМА архив на организацията на сървъра')
    expect(html).toContain('2, най-старото чака от 3 ч.')
    expect(html.match(/color:#c62828">[^<]*(Копието|Последен архив|Чака интернет)/g)?.length).toBe(3)
    const calm = renderDigestHtml({ ...base, locale: 'en', server: { heardHours: 0, mirror: { behind: 0, lastPageHours: 0 }, backupHours: 3, queued: 0, alarms: [] } } as any)
    expect(calm).toContain('lgrai.app’s copy: up to date')
    expect(calm).toContain('Last backup on the server: 3 h ago')
    expect(calm).toContain('Waiting for the internet: none')
    expect(calm).not.toContain('#c62828">lgrai')
    const unheard = renderDigestHtml({ ...base, locale: 'en', server: { queued: 0, alarms: ['unheard'] } } as any)
    expect(unheard).toContain('not heard from lgrai.app since the server started')
  })
})
