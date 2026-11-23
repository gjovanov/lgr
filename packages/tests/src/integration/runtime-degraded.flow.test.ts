import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { captureRejection } from '../helpers/capture-rejection'
import { Identity, PostingJob } from 'db/models'
import { mongoose } from 'db/connection'
import { runInRequest } from 'db/home/request-context'
import { GUARD_INDEXES, sameKey } from 'db/indexes/guard-indexes'
import { verifyIndexes } from 'db/indexes/verify'
import { isQueryTimeout, queryTimeLimitNow, shapeOf, QUERY_TIME_LIMIT_MS, QUERY_TIME_LIMIT_LONG_MS } from 'db/plugins/query-time-limit'
import { SessionCheckUnavailableError, forgetIdentity, identityStillValid, liveSessionUser } from 'services/biz/identity/session.service'
import {
  leaseMsOf, newSchedulerHealth, releaseLeasesInDb, releaseSchedulerLeases, runTick, stopSchedulers, takeSchedulerLease, useLeaseTaker,
  type SchedulerDef,
} from 'services/scheduler/registry'
import { taskStore, FINISHED_TASK_TTL_MS } from 'services/background/task.store'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'

/**
 * FR-29 slice F (#794): a server that says when it is degraded (§1.6, §2.7, §6 "Lookups", "Indexes", "registry").
 *
 * - FR-29.23: a lookup that fails is not an answer: a read that throws costs one 503, never a sign-out, and is not
 *   remembered; a person who is gone is signed out as before.
 * - FR-29.24/.25: the declared indexes are verified, a clash that keeps a unique index from building is reported, and
 *   the guard list matches what the models declare.
 * - FR-29.26: a request's reads have a time limit (shape-only logging, the 503).
 * - FR-29.27: a tick does not overlap itself; a `one` job runs under a lease, which a graceful stop gives back.
 * - FR-29.28: the task store forgets a finished task.
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

/** `Identity.findById`, throwing on its next `times` calls (the database did not answer). */
function failingIdentityReads(times: number) {
  const real = Identity.findById.bind(Identity)
  let left = times
  ;(Identity as any).findById = (...args: any[]) => {
    if (left > 0) {
      left--
      return { lean: () => ({ exec: async () => { throw new Error('connection pool cleared') } }) }
    }
    return (real as any)(...args)
  }
  return () => { (Identity as any).findById = real }
}

describe('FR-29.23: a lookup that fails is not an answer', () => {
  it('a read that throws once costs one 503 and no sign-out; the next request passes', async () => {
    const person = await Identity.create({ email: `p-${Date.now()}@lookup.test`, firstName: 'Ana', lastName: 'Lookup', isActive: true, tokenVersion: 2 } as any)
    const iid = String(person._id)
    forgetIdentity(iid)
    const restore = failingIdentityReads(1)
    try {
      const err = await captureRejection(liveSessionUser({ iid, tv: 2, id: '' }))
      expect(err).toBeInstanceOf(SessionCheckUnavailableError)
      expect(err.code).toBe('session_check_unavailable')
      // Not remembered: the next request asks again, and the person is still signed in.
      expect(await liveSessionUser({ iid, tv: 2, id: '' })).toEqual({ iid, tv: 2, id: '' })
    } finally {
      restore()
    }
    // The answer is a 503 with its code, never a 401.
    const set: any = { status: 200, headers: {} }
    const body = spaErrorHandler({})({ code: 'UNKNOWN', error: new SessionCheckUnavailableError(), set, request: new Request('http://localhost/api/x') })
    expect(set.status).toBe(503)
    expect(body).toMatchObject({ code: 'session_check_unavailable' })
  })

  it('a person who is gone or switched off is signed out, as before; a positive answer is remembered', async () => {
    const gone = String(new mongoose.Types.ObjectId())
    expect(await identityStillValid(gone, 0)).toBe(false)
    const off = await Identity.create({ email: `off-${Date.now()}@lookup.test`, firstName: 'Ana', lastName: 'Lookup', isActive: false, tokenVersion: 0 } as any)
    expect(await identityStillValid(String(off._id), 0)).toBe(false)

    const on = await Identity.create({ email: `on-${Date.now()}@lookup.test`, firstName: 'Ana', lastName: 'Lookup', isActive: true, tokenVersion: 0 } as any)
    expect(await identityStillValid(String(on._id), 0)).toBe(true)
    // Remembered: a failing read within the minute is not even made.
    const restore = failingIdentityReads(1)
    try {
      expect(await identityStillValid(String(on._id), 0)).toBe(true)
    } finally {
      restore()
    }
  })
})

describe('FR-29.24/.25: declared indexes are verified', () => {
  it('two rows that clash keep a declared unique index from building, and the verification says so', async () => {
    const coll = mongoose.connection.db!.collection('ixprobes')
    await coll.insertMany([{ code: 'A' }, { code: 'A' }])
    const schema = new mongoose.Schema({ code: String }, { collection: 'ixprobes' })
    schema.index({ code: 1 }, { unique: true })
    const Probe = mongoose.models.IxProbe ?? mongoose.model('IxProbe', schema)
    const report = await verifyIndexes({ models: [Probe.modelName] })
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toMatchObject({ model: 'IxProbe', index: 'code_1' })
    expect(report.failures[0].reason).toMatch(/duplicate|E11000/i)
    await coll.drop()
  })

  it('a model whose indexes built reports nothing', async () => {
    await PostingJob.init()
    const report = await verifyIndexes({ models: ['PostingJob'] })
    expect(report.failures).toEqual([])
  })

  it('every guard index is one its model declares', () => {
    for (const g of GUARD_INDEXES) {
      const declared = mongoose.model(g.model).schema.indexes().some(([fields]) => sameKey(fields as any, g.key))
      expect(`${g.model} ${JSON.stringify(g.key)} ${declared}`).toBe(`${g.model} ${JSON.stringify(g.key)} true`)
    }
  })
})

describe('FR-29.26: query time limits', () => {
  it('a request\'s reads have the limit, an export\'s a longer one, and nothing outside a request', async () => {
    expect(queryTimeLimitNow()).toBeNull()
    const ctx = (route: string) => ({ readOnly: true, route, listedWriter: false })
    expect(await runInRequest(ctx('GET /api/org/:orgId/invoices'), async () => queryTimeLimitNow())).toBe(QUERY_TIME_LIMIT_MS)
    expect(await runInRequest(ctx('GET /api/org/:orgId/invoices/:id/export'), async () => queryTimeLimitNow())).toBe(QUERY_TIME_LIMIT_LONG_MS)
    // A request that has answered no longer limits what it left running.
    const done = { ...ctx('GET /api/org/:orgId/invoices'), done: true }
    expect(await runInRequest(done, async () => queryTimeLimitNow())).toBeNull()
  })

  it('enforced, a request\'s query carries maxTimeMS; the shape of a filter names no value', async () => {
    const before = process.env.QUERY_TIME_LIMIT_MODE
    process.env.QUERY_TIME_LIMIT_MODE = 'enforce'
    const seen: any[] = []
    mongoose.set('debug', (_c: string, _m: string, ...args: unknown[]) => { seen.push(args) })
    try {
      await runInRequest({ readOnly: true, route: 'GET /api/org/:orgId/x', listedWriter: false }, () => PostingJob.find({ state: 'queued' }).exec())
    } finally {
      mongoose.set('debug', false)
      if (before === undefined) delete process.env.QUERY_TIME_LIMIT_MODE
      else process.env.QUERY_TIME_LIMIT_MODE = before
    }
    expect(JSON.stringify(seen)).toContain(`"maxTimeMS":${QUERY_TIME_LIMIT_MS}`)
    expect(shapeOf({ orgId: 'x', state: { $in: ['queued', 'failed'] } })).toEqual({ orgId: '?', state: { $in: ['?'] } })
    expect(isQueryTimeout({ code: 50 })).toBe(true)
    expect(isQueryTimeout({ codeName: 'MaxTimeMSExpired' })).toBe(true)
    expect(isQueryTimeout(new Error('x'))).toBe(false)
    // The answer is 503 `query_timeout`.
    const set: any = { status: 200, headers: {} }
    const body = spaErrorHandler({})({ code: 'UNKNOWN', error: Object.assign(new Error('operation exceeded time limit'), { code: 50 }), set, request: new Request('http://localhost/api/x') })
    expect(set.status).toBe(503)
    expect(body).toMatchObject({ code: 'query_timeout' })
  })
})

describe('FR-29.27: a tick does not overlap itself, and a `one` job runs under a lease', () => {
  it('a slow tick: the next one is skipped while it runs', async () => {
    let runs = 0
    const def: SchedulerDef = { name: 'slow', intervalMs: 10, where: 'every-pod', tick: async () => { runs++; await wait(80) } }
    const h = newSchedulerHealth(def)
    await Promise.all([runTick(def, h), wait(5).then(() => runTick(def, h)), wait(10).then(() => runTick(def, h))])
    expect(runs).toBe(1)
    expect(h.skippedOverlap).toBe(2)
    await runTick(def, h)
    expect(runs).toBe(2)
  })

  it('a `one` job on two pods: the lease lets one run, the other skips, and takes over once it lapses', async () => {
    expect(await takeSchedulerLease('job-x', 'pod-a', 60_000)).toBe(true)
    expect(await takeSchedulerLease('job-x', 'pod-b', 60_000)).toBe(false)
    // The holder renews it.
    expect(await takeSchedulerLease('job-x', 'pod-a', 60_000)).toBe(true)
    // Lapsed (the pod stopped): the other takes it.
    expect(await takeSchedulerLease('job-y', 'pod-a', 1)).toBe(true)
    await wait(10)
    expect(await takeSchedulerLease('job-y', 'pod-b', 60_000)).toBe(true)

    let runs = 0
    const def: SchedulerDef = { name: 'job-x', intervalMs: 1000, where: 'one', tick: async () => { runs++ } }
    useLeaseTaker(takeSchedulerLease, 'pod-b')
    const h = newSchedulerHealth(def)
    await runTick(def, h)
    expect(runs).toBe(0)
    expect(h.skippedLease).toBe(1)
    useLeaseTaker(takeSchedulerLease, 'pod-a')
    await runTick(def, h)
    expect(runs).toBe(1)
    expect(leaseMsOf(1000)).toBe(60_000)
    expect(leaseMsOf(60_000)).toBe(180_000)
  })

  it('a stop gives back the leases it holds: the process after a restart runs the job at its first tick', async () => {
    let runs = 0
    const def: SchedulerDef = { name: 'job-z', intervalMs: 10_000, where: 'one', tick: async () => { runs++ } }
    useLeaseTaker(takeSchedulerLease, 'host#1')
    await runTick(def, newSchedulerHealth(def))
    expect(runs).toBe(1)
    expect(await releaseSchedulerLeases()).toEqual(['job-z'])
    expect(await releaseSchedulerLeases()).toEqual([])
    // Another pid: a minute before the lease would have lapsed.
    useLeaseTaker(takeSchedulerLease, 'host#2')
    const next = newSchedulerHealth(def)
    await runTick(def, next)
    expect(runs).toBe(2)
    expect(next.skippedLease).toBe(0)
  })

  it('a lease taken by a clock 30 days ahead, then put back and restarted, holds off nobody', async () => {
    // As the clock stood when the job last ticked: the lease ends 30 days past the real time.
    const ahead = 30 * 86_400_000
    let runs = 0
    const def: SchedulerDef = { name: 'job-c', intervalMs: 10_000, where: 'one', tick: async () => { runs++ } }
    useLeaseTaker((name, holder, ms) => takeSchedulerLease(name, holder, ms + ahead), 'host#1')
    await runTick(def, newSchedulerHealth(def))
    // Without the stop's release, the next process waits for the clock to catch up.
    expect(await takeSchedulerLease('job-c', 'host#2', 60_000)).toBe(false)
    expect(await releaseSchedulerLeases()).toEqual(['job-c'])
    useLeaseTaker(takeSchedulerLease, 'host#2')
    await runTick(def, newSchedulerHealth(def))
    expect(runs).toBe(2)
  })

  it('a lease is given back only by its holder, and not while its tick runs', async () => {
    expect(await takeSchedulerLease('job-q', 'host#2', 60_000)).toBe(true)
    expect(await releaseLeasesInDb(['job-q'], 'host#1')).toBe(0)
    expect(await takeSchedulerLease('job-q', 'host#3', 60_000)).toBe(false)

    // A tick still running when the stop comes keeps its lease: no other process may run the job beside it.
    let finish!: () => void
    let begun!: () => void
    const started = new Promise<void>(r => { begun = r })
    const def: SchedulerDef = {
      name: 'job-r', intervalMs: 10_000, where: 'one',
      tick: () => new Promise<void>(r => { finish = r; begun() }),
    }
    useLeaseTaker(takeSchedulerLease, 'host#1')
    const tick = runTick(def, newSchedulerHealth(def))
    await started
    expect(await releaseSchedulerLeases()).toEqual([])
    expect(await takeSchedulerLease('job-r', 'host#2', 60_000)).toBe(false)
    finish()
    await tick
    // Finished: the stop's second pass gives it back.
    expect(await releaseSchedulerLeases()).toEqual(['job-r'])
    expect(await takeSchedulerLease('job-r', 'host#2', 60_000)).toBe(true)
  })
})

describe('FR-29.28: the task store is bounded', () => {
  it('a finished task leaves the store after the set time; a running one stays', () => {
    taskStore.clear()
    const task = (id: string, status: any) => ({ id, orgId: 'o', userId: 'u', type: 't', status, progress: 0, logs: [], createdAt: new Date() }) as any
    taskStore.set('done-1', task('done-1', 'completed'))
    taskStore.set('run-1', task('run-1', 'processing'))
    expect(taskStore.sweep(Date.now() + FINISHED_TASK_TTL_MS - 1000)).toBe(0)
    expect(taskStore.sweep(Date.now() + FINISHED_TASK_TTL_MS + 1000)).toBe(1)
    expect(taskStore.get('done-1')).toBeUndefined()
    expect(taskStore.get('run-1')).toBeTruthy()
    taskStore.clear()
  })
})
