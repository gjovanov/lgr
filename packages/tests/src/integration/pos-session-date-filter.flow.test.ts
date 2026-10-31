import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { createTestPOSSession } from '../helpers/factories'
import { Org, POSSession } from 'db/models'

/**
 * The POS Sessions page always sent `dateFrom` / `dateTo`, and `GET /trade/pos/session` read neither:
 * the filter changed nothing. It filters on `openedAt` by the org's local day now, the end date
 * whole. The pod runs on UTC, so the day of a session opened after midnight in the shop is not the
 * day UTC names.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() })

describe('the list\'s date filter', () => {
  /** 2026-10-31 is EET, UTC+2: the Bulgarian day runs from 22:00 UTC on the 30th. */
  async function sessionsAt(...openedAt: string[]) {
    const w = await tillWorld(app)
    await Org.updateOne({ _id: w.oid }, { $set: { 'settings.timezone': 'Europe/Sofia' } }).exec()
    for (const at of openedAt) {
      await createTestPOSSession(w.oid, w.warehouse._id as any, w.user._id as any, { openedAt: new Date(at), sessionNumber: at, status: 'closed' } as any)
    }
    return w
  }
  const listed = async (w: TillWorld, query: string) => {
    const { status, json } = await w.call('GET', `/trade/pos/session?status=closed&size=0${query}`)
    expect(status).toBe(200)
    return json.sessions.map((s: any) => s.sessionNumber).sort()
  }

  it('a day is the org\'s: a session opened after midnight in Sofia is that day\'s, whatever UTC says', async () => {
    const w = await sessionsAt('2026-10-30T21:59:00.000Z', '2026-10-30T22:00:00.000Z', '2026-10-31T21:59:59.000Z', '2026-10-31T22:00:00.000Z')
    expect(await listed(w, '&dateFrom=2026-10-31&dateTo=2026-10-31')).toEqual(['2026-10-30T22:00:00.000Z', '2026-10-31T21:59:59.000Z'])
    expect(await listed(w, '&dateFrom=2026-10-30&dateTo=2026-10-30')).toEqual(['2026-10-30T21:59:00.000Z'])
  })

  it('either end alone; the end date whole, inclusive', async () => {
    const w = await sessionsAt('2026-10-30T10:00:00.000Z', '2026-10-31T10:00:00.000Z', '2026-11-01T10:00:00.000Z')
    expect(await listed(w, '&dateFrom=2026-10-31')).toEqual(['2026-10-31T10:00:00.000Z', '2026-11-01T10:00:00.000Z'])
    expect(await listed(w, '&dateTo=2026-10-31')).toEqual(['2026-10-30T10:00:00.000Z', '2026-10-31T10:00:00.000Z'])
    expect(await listed(w, '')).toHaveLength(3)
  })

  it('an org with no zone of its own keeps Bulgarian days, not the pod\'s', async () => {
    const w = await sessionsAt('2026-10-30T21:59:00.000Z', '2026-10-30T22:00:00.000Z')
    await Org.updateOne({ _id: w.oid }, { $unset: { 'settings.timezone': 1 } }).exec()
    expect(await listed(w, '&dateFrom=2026-10-31&dateTo=2026-10-31')).toEqual(['2026-10-30T22:00:00.000Z'])
  })

  it('reads the org\'s own zone when it has one', async () => {
    const w = await sessionsAt('2026-10-31T03:00:00.000Z', '2026-10-31T05:00:00.000Z')
    await Org.updateOne({ _id: w.oid }, { $set: { 'settings.timezone': 'America/New_York' } }).exec()
    // 03:00 UTC is 23:00 on the 30th in New York, 05:00 UTC is 01:00 on the 31st.
    expect(await listed(w, '&dateFrom=2026-10-31&dateTo=2026-10-31')).toEqual(['2026-10-31T05:00:00.000Z'])
  })

  it('a value that is not a calendar date bounds nothing, as on every other list', async () => {
    const w = await sessionsAt('2026-10-31T10:00:00.000Z')
    expect(await listed(w, '&dateFrom=yesterday')).toHaveLength(1)
  })

  it('keeps the other filters', async () => {
    const w = await sessionsAt('2026-10-31T10:00:00.000Z')
    await POSSession.updateOne({ orgId: w.oid, sessionNumber: '2026-10-31T10:00:00.000Z' }, { $set: { status: 'open' } }).exec()
    expect(await listed(w, '&dateFrom=2026-10-31&dateTo=2026-10-31')).toEqual([])
  })
})
