import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { BackgroundTask } from 'db/models'
import { startSchedulers, schedulerHealth, stopSchedulers } from 'services/scheduler/registry'
import { startJob } from 'services/background/task.service'
import {
  PROCESS_ID, STALE_MS, heartbeatOwnedTasks, failOrphanedTasks,
} from 'services/background/task-owner'

/**
 * Schedulers start independently; background tasks have an owner (FR-20.23, plan step P0a-6;
 * AC 6 in part).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  stopSchedulers()
  await clearCollections()
})

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('the scheduler registry', () => {
  it('a scheduler that fails to start does not stop the ones after it (AC 6)', async () => {
    const ran: string[] = []
    await startSchedulers([
      { name: 'first', intervalMs: 50, immediate: true, tick: async () => { ran.push('first') } },
      { name: 'broken', intervalMs: 50, load: async () => { throw new Error('module failed to import') }, tick: async () => {} },
      { name: 'after', intervalMs: 50, immediate: true, tick: async () => { ran.push('after') } },
    ])
    await wait(30)

    const h = Object.fromEntries(schedulerHealth().map(s => [s.name, s]))
    expect(h.broken.state).toBe('failed_to_start')
    expect(h.broken.lastError).toContain('module failed to import')
    expect(h.first.state).toBe('running')
    expect(h.after.state).toBe('running')
    expect(ran).toContain('after')
  })

  it('a tick that throws is recorded, and the next tick still runs', async () => {
    let n = 0
    await startSchedulers([
      { name: 'flaky', intervalMs: 40, immediate: true, tick: async () => { n++; if (n === 1) throw new Error('first tick failed') } },
    ])
    await wait(150)

    const [h] = schedulerHealth()
    expect(n).toBeGreaterThanOrEqual(3)
    expect(h.failures).toBe(1)
    expect(h.runs).toBe(n)
    expect(h.lastOkAt).toBeInstanceOf(Date)
    expect(h.lastError).toBeUndefined() // cleared by the next good tick
  })

  it('an interval of 0 means disabled, as the *_CHECK_INTERVAL_MS settings already do', async () => {
    let ran = false
    await startSchedulers([{ name: 'off', intervalMs: 0, immediate: true, tick: async () => { ran = true } }])
    await wait(30)
    expect(schedulerHealth()[0].state).toBe('disabled')
    expect(ran).toBe(false)
  })

  it('immediate runs once at start; without it the first run waits for the interval', async () => {
    let now = 0
    let later = 0
    await startSchedulers([
      { name: 'now', intervalMs: 10_000, immediate: true, tick: async () => { now++ } },
      { name: 'later', intervalMs: 10_000, tick: async () => { later++ } },
    ])
    await wait(30)
    expect([now, later]).toEqual([1, 0])
  })
})

describe('background tasks have an owner', () => {
  async function task(overrides: Record<string, unknown>) {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    return BackgroundTask.create({ orgId: org._id, userId: user._id, type: 'test', status: 'processing', startedAt: new Date(), ...overrides })
  }
  const statusOf = async (id: unknown) => ((await BackgroundTask.findById(id).lean()) as any).status

  it('a task records the process that runs it', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const t = await startJob(String(org._id), String(user._id), 'test', {})
    const doc = await BackgroundTask.findById(t.id).lean() as any
    expect(doc.owner.process).toBe(PROCESS_ID)
    expect(doc.owner.heartbeatAt).toBeInstanceOf(Date)
  })

  it('the heartbeat refreshes this process\'s open tasks, and no one else\'s', async () => {
    const old = new Date(Date.now() - 60_000)
    const mine = await task({ owner: { process: PROCESS_ID, pod: 'me', heartbeatAt: old } })
    const theirs = await task({ owner: { process: 'other-pod', pod: 'them', heartbeatAt: old } })
    const done = await task({ status: 'completed', owner: { process: PROCESS_ID, pod: 'me', heartbeatAt: old } })

    expect(await heartbeatOwnedTasks()).toBe(1)
    const at = async (id: unknown) => ((await BackgroundTask.findById(id).lean()) as any).owner.heartbeatAt.getTime()
    expect(await at(mine._id)).toBeGreaterThan(old.getTime())
    expect(await at(theirs._id)).toBe(old.getTime())
    expect(await at(done._id)).toBe(old.getTime())
  })

  it('only tasks whose owner went quiet are failed — a live pod\'s tasks are left alone', async () => {
    const stale = await task({ owner: { process: 'dead-pod', pod: 'x', heartbeatAt: new Date(Date.now() - STALE_MS - 1000) } })
    const live = await task({ owner: { process: 'live-pod', pod: 'y', heartbeatAt: new Date() } })
    const finished = await task({ status: 'completed', owner: { process: 'dead-pod', pod: 'x', heartbeatAt: new Date(0) } })
    const oldLegacy = await task({ startedAt: new Date(Date.now() - 2 * 3600_000) })
    const newLegacy = await task({ startedAt: new Date() })

    expect(await failOrphanedTasks()).toBe(2)

    expect(await statusOf(stale._id)).toBe('failed')
    expect(await statusOf(oldLegacy._id)).toBe('failed')
    expect(await statusOf(live._id)).toBe('processing')
    expect(await statusOf(finished._id)).toBe('completed')
    expect(await statusOf(newLegacy._id)).toBe('processing')
    const failed = await BackgroundTask.findById(stale._id).lean() as any
    expect(failed.error).toMatch(/Interrupted/)
    expect(failed.completedAt).toBeInstanceOf(Date)
  })
})
