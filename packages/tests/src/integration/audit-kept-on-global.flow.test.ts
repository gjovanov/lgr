import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { AuditLog, GlobalAuditEntry, Org, OrgHome } from 'db/models'
import { mongoose } from 'db/connection'
import { forgetAllHomes } from 'db/home/home'
import {
  auditHealth, createAuditEntry, generateCorrelationId, queryAuditLogs, queryByCorrelationId, queryDistinctFilters, recordAuditEntry,
} from 'services/biz/audit-log.service'
import { homeDigests } from 'services/biz/move/home-digest'
import { auditSignIn } from '../../../api/src/auth/session-answer'
import { config } from 'config'

/**
 * FR-29.21 with FR-20.4: global's own audit entries about an org whose home is a server.
 *
 * The write guard refuses every write of an org that is not home here, the audit trail's too, so a sign-in on lgrai.app
 * into such an org, or a change on its Servers page, was only logged as an audit write failure. Global keeps them now,
 * in `GlobalAuditEntry` (node state). Never in the org's trail: on global that trail is the server's mirror, which a
 * move back compares by count and hash, and a row of global's own there would fail it for good.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const { Types } = mongoose
const SERVER = 'node-shop-kept0000000001'
const saved = { role: config.node.role, id: config.node.id }

beforeAll(async () => { await setupTestDB() }, 120_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  // Below the write guard: the trail of an org away from home is not this node's to delete.
  await clearCollections()
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  forgetAllHomes()
})

/** Two orgs and a person in the first: the first will be homed on a server, the second stays home here. */
async function world() {
  const away = await createTestOrg()
  const here = await createTestOrg()
  const user = await createTestUser(away._id, { role: 'admin' } as any)
  return { away: String(away._id), here: String(here._id), userId: String(user._id), user }
}

/** The org's home becomes a server (or another state), as a move leaves it on global. */
async function homeElsewhere(orgId: string, home = SERVER, state = 'active') {
  await OrgHome.create({ orgId, home, epoch: 1, state } as any)
  await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
  forgetAllHomes()
}

const entry = (orgId: string, userId: string, extra: Record<string, unknown> = {}) => ({
  orgId, userId, action: 'update', module: 'admin', entityType: 'node', entityId: new Types.ObjectId().toHexString(), entityName: 'Shop server', ...extra,
})

async function until(check: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return false
}

const kept = (orgId: string) => GlobalAuditEntry.countDocuments({ orgId: new Types.ObjectId(orgId) }).exec()
const inTrail = (orgId: string) => AuditLog.countDocuments({ orgId: new Types.ObjectId(orgId) }).exec()

describe('on global, an entry about an org whose home is a server', () => {
  it('is kept on global, with where the home was, and is no write failure', async () => {
    const w = await world()
    await homeElsewhere(w.away)
    const before = auditHealth()

    createAuditEntry(entry(w.away, w.userId))

    expect(await until(async () => (await kept(w.away)) === 1)).toBe(true)
    const row: any = await GlobalAuditEntry.findOne({ orgId: w.away }).lean().exec()
    expect([row.home, row.homeState, row.homeEpoch, row.action, row.module, row.entityType, row.entityName])
      .toEqual([SERVER, 'active', 1, 'update', 'admin', 'node', 'Shop server'])
    expect(String(row.userId)).toBe(w.userId)
    expect(row.timestamp instanceof Date).toBe(true)
    expect(await inTrail(w.away)).toBe(0)
    const after = auditHealth()
    expect(after.writeFailures).toBe(before.writeFailures)
    expect(after.keptOnGlobal).toBe(before.keptOnGlobal + 1)
  })

  it('also while the org freezes for a move, home still here', async () => {
    const w = await world()
    await homeElsewhere(w.away, 'global', 'freezing')
    createAuditEntry(entry(w.away, w.userId))
    expect(await until(async () => (await kept(w.away)) === 1)).toBe(true)
    const row: any = await GlobalAuditEntry.findOne({ orgId: w.away }).lean().exec()
    expect([row.home, row.homeState]).toEqual(['global', 'freezing'])
    expect(await inTrail(w.away)).toBe(0)
  })

  it("an org at home here writes its trail, as it always did", async () => {
    const w = await world()
    await homeElsewhere(w.away)
    createAuditEntry(entry(w.here, w.userId))
    expect(await until(async () => (await inTrail(w.here)) === 1)).toBe(true)
    expect(await kept(w.here)).toBe(0)
  })

  it('awaited, it is kept only when the caller asks: a gate on the trail stays shut', async () => {
    const w = await world()
    await homeElsewhere(w.away)
    const before = auditHealth()

    // A payroll reveal goes on only with the entry in the trail: it must still be told no.
    expect(await recordAuditEntry(entry(w.away, w.userId, { action: 'reveal' }))).toBe(false)
    expect(await kept(w.away)).toBe(0)
    expect(auditHealth().writeFailures).toBe(before.writeFailures + 1)

    expect(await recordAuditEntry(entry(w.away, w.userId), { keepOnGlobal: true })).toBe(true)
    expect(await kept(w.away)).toBe(1)
    expect(await inTrail(w.away)).toBe(0)
  })

  it('a sign-in on global into the org is kept there', async () => {
    const w = await world()
    await homeElsewhere(w.away)
    await auditSignIn({ id: w.userId, orgId: w.away, firstName: 'Ana', lastName: 'Admin' } as any, 'lgr')
    const row: any = await GlobalAuditEntry.findOne({ orgId: w.away }).lean().exec()
    expect([row?.action, row?.module, row?.entityType, String(row?.entityId), row?.entityName]).toEqual(['login', 'auth', 'user', w.userId, 'Ana Admin'])
    expect(row.changes.map((c: any) => [c.field, c.newValue])).toEqual([['method', 'lgr']])
    expect(await inTrail(w.away)).toBe(0)
  })
})

describe('a server keeps the rule it had', () => {
  it('an entry about an org it is not home of is refused and counted, and nothing is kept', async () => {
    const w = await world()
    await homeElsewhere(w.away)
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = 'master-not-this-org000001'
    forgetAllHomes()
    const before = auditHealth()

    createAuditEntry(entry(w.away, w.userId))

    expect(await until(async () => auditHealth().writeFailures === before.writeFailures + 1)).toBe(true)
    expect(await kept(w.away)).toBe(0)
    expect(await inTrail(w.away)).toBe(0)
    expect(await recordAuditEntry(entry(w.away, w.userId), { keepOnGlobal: true })).toBe(false)
    expect(await kept(w.away)).toBe(0)
  })
})

describe('the move back never sees them', () => {
  it("the org's digests are the same with global's own entries as without them", async () => {
    const w = await world()
    for (let i = 0; i < 2; i++) await AuditLog.create({ ...entry(w.away, w.userId), orgId: new Types.ObjectId(w.away), userId: new Types.ObjectId(w.userId) })
    await homeElsewhere(w.away)
    const db = mongoose.connection.db as any
    const before = await homeDigests(db, new Types.ObjectId(w.away))
    // The trail is compared: that is why global's own entries cannot live in it.
    expect(before.auditlogs?.count).toBe(2)

    createAuditEntry(entry(w.away, w.userId))
    expect(await recordAuditEntry(entry(w.away, w.userId), { keepOnGlobal: true })).toBe(true)
    expect(await until(async () => (await kept(w.away)) === 2)).toBe(true)

    expect(await homeDigests(db, new Types.ObjectId(w.away))).toEqual(before)
  })
})

describe('the audit page on global reads both', () => {
  /** The trail at t1, t3, t5 (written while the org was home here) and global's own at t2, t4. */
  async function seeded() {
    const w = await world()
    const at = (n: number) => new Date(Date.UTC(2026, 10, 23, 12, 0, n))
    const correlationId = generateCorrelationId()
    for (const n of [1, 3, 5]) {
      await AuditLog.create({
        orgId: new Types.ObjectId(w.away), userId: new Types.ObjectId(w.userId), action: 'create', module: 'invoicing',
        entityType: 'contact', entityId: new Types.ObjectId(), entityName: `trail ${n}`, timestamp: at(n),
        ...(n === 3 ? { correlationId: new Types.ObjectId(correlationId) } : {}),
      })
    }
    await homeElsewhere(w.away)
    for (const n of [2, 4]) {
      await GlobalAuditEntry.create({
        orgId: new Types.ObjectId(w.away), userId: new Types.ObjectId(w.userId), action: 'login', module: 'auth',
        entityType: 'user', entityId: new Types.ObjectId(w.userId), entityName: `kept ${n}`, timestamp: at(n),
        home: SERVER, homeState: 'active', homeEpoch: 1,
        ...(n === 4 ? { correlationId: new Types.ObjectId(correlationId) } : {}),
      })
    }
    return { ...w, correlationId }
  }

  it('merged by time, with the total and the pages across both', async () => {
    const w = await seeded()
    const names = async (page: number) => (await queryAuditLogs(w.away, { page, size: 2 })).auditLogs.map(l => l.entityName)
    const first = await queryAuditLogs(w.away, { page: 0, size: 2 })
    expect([first.total, first.totalPages]).toEqual([5, 3])
    expect(first.auditLogs.map(l => l.entityName)).toEqual(['trail 5', 'kept 4'])
    expect(await names(1)).toEqual(['trail 3', 'kept 2'])
    expect(await names(2)).toEqual(['trail 1'])
    // Who: global's own entries name their person like the trail's.
    expect(first.auditLogs[1].userName).toBe(first.auditLogs[0].userName)
    expect(first.auditLogs[1].userName.length).toBeGreaterThan(0)
    // A filter reaches both.
    const logins = await queryAuditLogs(w.away, { module: 'auth' })
    expect([logins.total, logins.auditLogs.map(l => l.entityName)]).toEqual([2, ['kept 4', 'kept 2']])
  })

  it('the filters and a correlation offer both', async () => {
    const w = await seeded()
    const f = await queryDistinctFilters(w.away)
    expect([f.modules, f.actions, f.entityTypes]).toEqual([['auth', 'invoicing'], ['create', 'login'], ['contact', 'user']])
    expect((await queryByCorrelationId(w.away, w.correlationId)).map(l => l.entityName)).toEqual(['trail 3', 'kept 4'])
  })

  it('a server reads its trail alone', async () => {
    const w = await seeded()
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = SERVER
    const page = await queryAuditLogs(w.away, { size: 10 })
    expect([page.total, page.auditLogs.map(l => l.entityName)]).toEqual([3, ['trail 5', 'trail 3', 'trail 1']])
    expect((await queryDistinctFilters(w.away)).modules).toEqual(['invoicing'])
  })
})
