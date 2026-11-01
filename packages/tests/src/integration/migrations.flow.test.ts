import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestProduct, createTestWarehouse, createTestContact, createTestPOSSession, createTestPOSTransaction,
} from '../helpers/factories'
import type { Types } from 'mongoose'
import { mongoose } from 'db/connection'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import {
  runMigrations, migrationStatus, previewMigrations, checksumOf, assertRegistryOrder, holderIsGone,
  MigrationChecksumError, MigrationLockError, COLLECTION,
} from 'migrations/runner'
import { MIGRATIONS } from 'migrations/registry'
import type { Migration } from 'migrations/types'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * The versioned migrations runner (FR-20.19, plan step P0b-7; AC 8).
 *
 * The property AC 8 names is the last describe: EVERY registered migration, run twice on a seeded
 * database, changes nothing the second time. It iterates the real registry, so a migration added
 * later is held to it the day it is registered.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const db = () => mongoose.connection.db!

/** A migration that counts its runs and leaves a mark. */
function counting(id: string, sink: string[], extra: Partial<Migration> = {}): Migration {
  return {
    id,
    description: `test ${id}`,
    async up(ctx) {
      sink.push(id)
      await ctx.db.collection('migration_marks').updateOne({ _id: id as any }, { $set: { at: 1 } }, { upsert: true })
    },
    ...extra,
  }
}

describe('0011-printer-gate-off (FR-23)', () => {
  const GATE = 'settings.cashRegister.requireConnectedDevice'
  const gate = async (id: unknown) => ((await db().collection('orgs').findOne({ _id: id as any })) as any)?.settings?.cashRegister?.requireConnectedDevice
  const migration = MIGRATIONS.find(m => m.id === '0011-printer-gate-off')!
  const ctx = (orgFilter: Record<string, unknown> = {}) => ({ db: db(), log: () => {}, orgFilter })

  /** An org with its switch `value`, and a device or not. */
  async function org(slug: string, o: { value?: boolean; device?: 'active' | 'inactive' } = {}) {
    const row = await createTestOrg({ slug } as any)
    await db().collection('orgs').updateOne({ _id: row._id as any }, o.value === undefined ? { $unset: { [GATE]: 1 } } : { $set: { [GATE]: o.value } })
    if (o.device) await db().collection('fiscaldevices').insertOne({ orgId: row._id, deviceNumber: `ED${slug}`, isActive: o.device === 'active' } as any)
    return row._id
  }
  async function world() {
    return {
      unset: await org('no-device'),
      active: await org('with-device', { device: 'active' }),
      gone: await org('deactivated', { device: 'inactive' }),
      on: await org('switched-on', { value: true }),
      off: await org('switched-off', { value: false }),
    }
  }

  it('off on an org with no active device whose switch is unset, and nowhere else', async () => {
    const w = await world()

    await migration.up(ctx())

    expect(await gate(w.unset)).toBe(false)
    expect(await gate(w.gone)).toBe(false)
    // A till depends on unset reading as on, and a value somebody set is theirs.
    expect(await gate(w.active)).toBeUndefined()
    expect(await gate(w.on)).toBe(true)
    expect(await gate(w.off)).toBe(false)
  })

  it('takes only the orgs homed on this node, by id on `orgs` and by org on the devices', async () => {
    const w = await world()

    await migration.up(ctx({ orgId: { $in: [w.active, w.gone] } }))

    expect(await gate(w.gone)).toBe(false)
    expect(await gate(w.unset)).toBeUndefined()
    expect(await gate(w.active)).toBeUndefined()
  })

  it('a dry run says what it would do, and writes nothing', async () => {
    const w = await world()

    const lines = await migration.preview!(ctx())

    expect(lines.map(l => l.split(' ')[1]).sort()).toEqual(['deactivated', 'no-device'])
    expect(await gate(w.unset)).toBeUndefined()
    expect(await gate(w.gone)).toBeUndefined()
    await migration.up(ctx())
    expect(await migration.preview!(ctx())).toEqual(['nothing to change'])
  })

  it('previewMigrations leaves the pending ones pending, and takes no lock', async () => {
    const w = await world()
    await runMigrations({ db: db(), migrations: MIGRATIONS.filter(m => m.id < migration.id), appVersion: 'v-test' })

    const pending = await previewMigrations({ db: db() })

    expect(pending.map(p => p.id)).toEqual([migration.id])
    expect(pending[0].lines).toHaveLength(2)
    expect(await gate(w.unset)).toBeUndefined()
    expect(await db().collection(COLLECTION).findOne({ _id: migration.id as any })).toBeNull()
    expect(await db().collection(COLLECTION).findOne({ _id: '__lock__' as any })).toBeNull()
  })

  it('run twice it writes nothing the second time', async () => {
    const w = await world()
    await migration.up(ctx())
    await db().collection('orgs').updateOne({ _id: w.unset as any }, { $set: { [GATE]: true } })

    await migration.up(ctx())

    expect(await gate(w.unset)).toBe(true)
  })
})

describe('the runner', () => {
  it('applies pending migrations in order, records each, and applies nothing the second time', async () => {
    const ran: string[] = []
    const migrations = [counting('0001-a', ran), counting('0002-b', ran)]

    const first = await runMigrations({ db: db(), migrations, appVersion: 'v-test' })
    const second = await runMigrations({ db: db(), migrations, appVersion: 'v-test' })

    expect(first.applied).toEqual(['0001-a', '0002-b'])
    expect(second.applied).toEqual([])
    expect(second.alreadyApplied).toEqual(['0001-a', '0002-b'])
    expect(ran).toEqual(['0001-a', '0002-b'])

    const rec = await db().collection(COLLECTION).findOne({ _id: '0002-b' as any }) as any
    expect(rec).toMatchObject({ description: 'test 0002-b', appVersion: 'v-test', checksum: checksumOf(migrations[1]) })
    expect(rec.appliedAt).toBeInstanceOf(Date)
    expect(typeof rec.durationMs).toBe('number')
    // The lock is released.
    expect(await db().collection(COLLECTION).findOne({ _id: '__lock__' as any })).toBeNull()
  })

  it('a newly added migration runs on a database that has the earlier ones', async () => {
    const ran: string[] = []
    await runMigrations({ db: db(), migrations: [counting('0001-a', ran)] })
    const res = await runMigrations({ db: db(), migrations: [counting('0001-a', ran), counting('0002-b', ran)] })
    expect(res.applied).toEqual(['0002-b'])
    expect(ran).toEqual(['0001-a', '0002-b'])
  })

  it('refuses to start when an applied migration\'s code changed — and runs nothing at all', async () => {
    const ran: string[] = []
    await runMigrations({ db: db(), migrations: [counting('0001-a', ran)] })
    const edited: Migration = { ...counting('0001-a', ran), async up() { /* edited after release */ } }

    const err = await captureRejection(runMigrations({ db: db(), migrations: [edited, counting('0002-b', ran)] }))
    expect(err).toBeInstanceOf(MigrationChecksumError)
    expect(ran).toEqual(['0001-a']) // 0002 did not run either
    expect(await db().collection(COLLECTION).findOne({ _id: '__lock__' as any })).toBeNull()

    // Accepting it is explicit, per id, and re-records the checksum.
    const ok = await runMigrations({ db: db(), migrations: [edited, counting('0002-b', ran)], acceptChanged: ['0001-a'] })
    expect(ok.applied).toEqual(['0002-b'])
    const status = await migrationStatus(db(), [edited])
    expect(status[0].state).toBe('applied')
  })

  it('a failing migration is not recorded; those before it are, and the lock is released', async () => {
    const ran: string[] = []
    const migrations = [
      counting('0001-a', ran),
      { id: '0002-boom', description: 'fails', async up() { throw new Error('boom') } },
      counting('0003-c', ran),
    ]
    const err = await captureRejection(runMigrations({ db: db(), migrations }))
    expect((err as Error).message).toBe('boom')
    const ids = (await db().collection(COLLECTION).find({}).toArray()).map(r => r._id)
    expect(ids).toEqual(['0001-a'])
    expect(ran).toEqual(['0001-a'])
  })

  it('two nodes starting at once: each migration runs exactly once, both finish up to date', async () => {
    const ran: string[] = []
    const slow: Migration = {
      id: '0001-slow', description: 'slow',
      async up() { ran.push('0001-slow'); await new Promise(r => setTimeout(r, 300)) },
    }
    const migrations = [slow, counting('0002-b', ran)]
    const [a, b] = await Promise.all([
      runMigrations({ db: db(), migrations }),
      runMigrations({ db: db(), migrations }),
    ])
    expect(ran).toEqual(['0001-slow', '0002-b'])
    expect([...a.applied, ...b.applied].sort()).toEqual(['0001-slow', '0002-b'])
  })

  it('a lock left by a crashed node is taken over once it lapses; a live one is waited for, then refused', async () => {
    const ran: string[] = []
    await db().collection(COLLECTION).insertOne({ _id: '__lock__' as any, owner: 'crashed', expiresAt: new Date(Date.now() - 1000) })
    expect((await runMigrations({ db: db(), migrations: [counting('0001-a', ran)] })).applied).toEqual(['0001-a'])

    await db().collection(COLLECTION).insertOne({ _id: '__lock__' as any, owner: 'busy-node', expiresAt: new Date(Date.now() + 60_000) })
    const err = await captureRejection(runMigrations({ db: db(), migrations: [counting('0002-b', ran)], lockWaitMs: 500 }))
    expect(err).toBeInstanceOf(MigrationLockError)
    expect((err as Error).message).toContain('busy-node')
  })

  it('a lock a run on THIS machine left behind is taken over at once, not after it lapses', async () => {
    // The first rollback lane (2026-10-29): the update helper stopped a version a second after
    // systemd started it, in the middle of its boot-time migrations, and the version it went back to
    // waited for the lock to lapse: ten minutes alive and not serving.
    const gone = Bun.spawn(['bun', '-e', '0'])
    await gone.exited
    const ran: string[] = []
    const logged: string[] = []
    const owner = `${hostname()}:${gone.pid}:${randomUUID()}`
    await db().collection(COLLECTION).insertOne({ _id: '__lock__' as any, owner, expiresAt: new Date(Date.now() + 10 * 60_000) })
    const started = Date.now()
    const res = await runMigrations({ db: db(), migrations: [counting('0001-a', ran)], lockWaitMs: 30_000, log: m => logged.push(m) })
    expect(res.applied).toEqual(['0001-a'])
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(logged.some(m => m.includes('took over the lock'))).toBe(true)
    expect(await db().collection(COLLECTION).findOne({ _id: '__lock__' as any })).toBeNull()
  })

  it('a lock held by a live process on this machine is still waited for', async () => {
    const alive = Bun.spawn(['bun', '-e', 'await Bun.sleep(30000)'])
    try {
      const ran: string[] = []
      await db().collection(COLLECTION).insertOne({
        _id: '__lock__' as any,
        owner: `${hostname()}:${alive.pid}:${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
      const err = await captureRejection(runMigrations({ db: db(), migrations: [counting('0001-a', ran)], lockWaitMs: 800 }))
      expect(err).toBeInstanceOf(MigrationLockError)
      expect(ran).toEqual([])
    } finally {
      alive.kill()
      await alive.exited
    }
  })

  it('judges a holder only on this machine, and only by whether its process exists', () => {
    const here = 'shop-pc'
    const id = randomUUID()
    const dead = () => false
    const live = () => true
    expect(holderIsGone(`shop-pc:4242:${id}`, here, dead)).toBe(true)
    expect(holderIsGone(`shop-pc:4242:${id}`, here, live)).toBe(false)
    // Another machine (global's other pods), or an owner from before the host was named: lapses only.
    expect(holderIsGone(`lgr-7fffb54d89-2nb58:4242:${id}`, here, dead)).toBe(false)
    expect(holderIsGone(`node:4242:${id}`, here, dead)).toBe(false)
    expect(holderIsGone('busy-node', here, dead)).toBe(false)
    // This process's own pid exists: a run of this process, or another container's pid 1, is waited for.
    expect(holderIsGone(`${hostname()}:${process.pid}:${id}`)).toBe(false)
  })

  it('passes the org scope through to each migration', async () => {
    let seen: unknown
    const scope = { orgId: { $in: ['x'] } }
    await runMigrations({ db: db(), migrations: [{ id: '0001-a', description: 'a', async up(ctx) { seen = ctx.orgFilter } }], orgFilter: scope })
    expect(seen).toEqual(scope)
  })

  it('status: applied, pending, changed, and ones recorded by a newer build', async () => {
    const ran: string[] = []
    await runMigrations({ db: db(), migrations: [counting('0001-a', ran), counting('0009-newer', ran)] })
    const status = await migrationStatus(db(), [counting('0001-a', ran), counting('0002-b', ran)])
    expect(status.map(s => `${s.id}:${s.state}`)).toEqual(['0001-a:applied', '0002-b:pending', '0009-newer:unknown'])
  })
})

describe('the registry', () => {
  it('is in id order with unique, well-formed ids', () => {
    expect(() => assertRegistryOrder(MIGRATIONS)).not.toThrow()
    expect(MIGRATIONS[0].id).toBe('0000-baseline')
  })

  it('a registry out of order is refused before anything runs', async () => {
    const ran: string[] = []
    const err = await captureRejection(runMigrations({ db: db(), migrations: [counting('0002-b', ran), counting('0001-a', ran)] }))
    expect((err as Error).message).toMatch(/out of order/)
    expect(ran).toEqual([])
  })
})

describe('every registered migration runs twice on a seeded database with no change the second time (AC 8)', () => {
  /** Every collection but the runner's own, as comparable text. */
  async function snapshot(): Promise<string> {
    const out: string[] = []
    for (const c of (await db().listCollections().toArray()).map(c => c.name).sort()) {
      if (c === COLLECTION || c.startsWith('system.')) continue
      const docs = await db().collection(c).find({}).sort({ _id: 1 }).toArray()
      out.push(`${c}:${JSON.stringify(docs)}`)
    }
    return out.join('\n')
  }

  it('the whole registry, applied then re-run migration by migration', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    await createTestContact(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { warehouseId: wh._id } as any)
    // FR-21: a till session with a sale and its storno (0008 copies them), and a back-office cash sale
    // (0008 labels its origin).
    const session = await createTestPOSSession(org._id, wh._id as Types.ObjectId, user._id as Types.ObjectId)
    const line = { productId: product._id, name: 'Bolt', quantity: 1, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 10 }
    const sale = await createTestPOSTransaction(org._id, session._id as Types.ObjectId, user._id as Types.ObjectId, {
      status: 'cancelled', lines: [line], subtotal: 10, taxTotal: 2, total: 12, payments: [{ method: 'cash', amount: 12 }],
    } as any)
    await createTestPOSTransaction(org._id, session._id as Types.ObjectId, user._id as Types.ObjectId, {
      type: 'storno', originalTransactionId: sale._id, lines: [line], subtotal: 10, taxTotal: 2, total: 12, payments: [{ method: 'cash', amount: 12 }],
    } as any)
    await db().collection('invoices').insertOne({
      orgId: org._id, invoiceNumber: 'CS-2026-00001', type: 'cash_sale', direction: 'outgoing', status: 'paid', currency: 'EUR',
      exchangeRate: 1, issueDate: new Date(), dueDate: new Date(), lines: [], subtotal: 10, taxTotal: 2, total: 12,
      billingAddress: {}, attachments: [], createdBy: user._id,
    })

    await runMigrations({ db: db() })
    const once = await snapshot()
    for (const m of MIGRATIONS) await m.up({ db: db(), log: () => {}, orgFilter: {} })
    expect(await snapshot()).toBe(once)
  }, 60_000)
})
