import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { config } from 'config'
import { BackupRun, OrgHome, Outbox } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { masterHealth } from 'services/biz/node/master-health'

/**
 * FR-20.98–20.101 (plan step P3-8): what a master's health frame says of its orgs, beside the
 * machine: the newest backup of an org written here, the orgs it is fenced for, and what waits to go
 * to the internet. Read by the supervisor through the control socket, once a minute.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-healthtest0000000'
const saved = { role: config.node.role, id: (config.node as any).id }

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

describe('a master\'s account of its orgs (P3-8)', () => {
  it('the newest completed backup of an org written here, the fenced ones, and the outbox', async () => {
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = NODE
    const here = await createTestOrg({ slug: 'mh-here' } as any)
    const fenced = await createTestOrg({ slug: 'mh-fenced' } as any)
    const elsewhere = await createTestOrg({ slug: 'mh-elsewhere' } as any)
    await OrgHome.collection.insertMany([
      { orgId: here._id, home: NODE, epoch: 1, state: 'active', since: new Date() },
      { orgId: fenced._id, home: NODE, epoch: 1, state: 'fenced', since: new Date() },
      { orgId: elsewhere._id, home: 'global', epoch: 2, state: 'active', since: new Date() },
    ] as any[])
    // Nothing backed up yet, nothing queued.
    expect(await masterHealth()).toEqual({ lastBackupAt: null, fenced: 1, outboxQueued: 0 })
    const older = new Date('2026-10-25T02:00:00Z')
    const newer = new Date('2026-10-26T02:00:00Z')
    await BackupRun.collection.insertMany([
      { orgId: here._id, kind: 'full', date: '2026-10-25', status: 'completed', completedAt: older },
      { orgId: here._id, kind: 'full', date: '2026-10-26', status: 'completed', completedAt: newer },
      // A run that failed, and another org's newer one: neither counts.
      { orgId: here._id, kind: 'full', date: '2026-10-27', status: 'failed' },
      { orgId: elsewhere._id, kind: 'full', date: '2026-10-27', status: 'completed', completedAt: new Date('2026-10-27T02:00:00Z') },
    ] as any[])
    await Outbox.collection.insertMany([
      { _id: 'm1', orgId: here._id, kind: 'mail', payload: {}, state: 'queued', nextAt: new Date() },
      { _id: 'm2', orgId: here._id, kind: 'mail', payload: {}, state: 'sending', nextAt: new Date() },
      { _id: 'm3', orgId: here._id, kind: 'mail', payload: {}, state: 'sent', nextAt: new Date() },
    ] as any[])
    expect(await masterHealth()).toEqual({ lastBackupAt: newer.toISOString(), fenced: 1, outboxQueued: 2 })
  })

  it('on lgrai.app, nothing: it is not a master', async () => {
    ;(config.node as any).role = 'global'
    expect(await masterHealth()).toBeNull()
  })
})
