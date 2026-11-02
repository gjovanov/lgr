import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { Db } from 'mongodb'
import type { Migration, MigrationContext, MigrationRecord } from './types.js'
import { MIGRATIONS } from './registry.js'

/**
 * The versioned migrations runner (FR-20.19, plan step P0b-7).
 *
 * Runs every registered migration that `_migrations` does not record, in registry order, one node
 * at a time, and records each one when it finishes. Called by `unified.ts` before `listen` when
 * `MIGRATIONS_AUTO=true`, and by `bun run migrate` (the plan's `lgr-api migrate`).
 *
 * ⚠ What it does NOT do: take the backup FR-20.19 asks for first. That belongs to whoever starts
 * it — the master's supervisor runs one before `migrate` (plan A.3, start order step 5), and on
 * global the nightly backup and `deploy-prod` cover it. A backup of every org on every boot of
 * every pod would be the wrong place for it.
 */

export const COLLECTION = '_migrations'
const LOCK_ID = '__lock__'

export class MigrationChecksumError extends Error {
  constructor(public migrationId: string) {
    super(
      `Migration ${migrationId} was applied, but its code has changed since. A released migration is never ` +
      'edited: put the change in a new migration. If the change is known to be harmless (a comment, a rename), ' +
      `accept it with \`bun run migrate --accept-changed ${migrationId}\`.`,
    )
    this.name = 'MigrationChecksumError'
  }
}

export class MigrationLockError extends Error {
  constructor(owner: string) {
    super(`Another node (${owner}) is running migrations and has not finished. Retry once it has.`)
    this.name = 'MigrationLockError'
  }
}

const digest = (id: string, text: string) => createHash('sha256').update(id).update('\n').update(text).digest('hex')

/**
 * What identifies a migration's code: its id and its file's fingerprint (`fingerprint.ts`).
 *
 * ⚠ Never `up.toString()`, which this used to be. That is the function as the RUNTIME prints it,
 * and a bundle prints it differently: the bundler renames identifiers across modules. A bundled
 * runner read five of the six released migrations as changed, and a changed one stops the run, so
 * a server package could not have started against a database migrated from source (FR-20 plan step
 * P0b-9). The file's fingerprint is the same from source and from a bundle.
 */
export function checksumOf(m: Migration): string {
  return m.fingerprint ? digest(m.id, `file:${m.fingerprint}`) : legacyChecksumOf(m)
}

/**
 * The checksum runners recorded before the fingerprint: `up`'s source, whitespace collapsed. Still
 * how a migration without a fingerprint (a test's) is identified.
 */
export function legacyChecksumOf(m: Migration): string {
  return digest(m.id, m.up.toString().replace(/\s+/g, ' ').trim())
}

/**
 * The record names this code. A record a runner made before the fingerprint matches on the legacy
 * checksum. ⚠ Only a runner run from SOURCE can recompute that one (a bundle prints `up`
 * differently, the bug above), so a database must meet a source runner of this version, which
 * re-records it, before a bundled one: the cloud's `bun run migrate` does that.
 */
function recordMatches(rec: MigrationRecord, m: Migration): 'current' | 'legacy' | false {
  if (rec.checksum === checksumOf(m)) return 'current'
  if (m.fingerprint && rec.checksum === legacyChecksumOf(m)) return 'legacy'
  return false
}

/** Ids are unique and the registry is in id order — so "run in order" means one thing. */
export function assertRegistryOrder(migrations: Migration[]): void {
  const ids = migrations.map(m => m.id)
  for (const id of ids) {
    if (!/^\d{4}-[a-z0-9-]+$/.test(id)) throw new Error(`Migration id "${id}" is not NNNN-kebab-name`)
  }
  if (new Set(ids).size !== ids.length) throw new Error('Two migrations share an id')
  const sorted = [...ids].sort()
  if (sorted.join() !== ids.join()) throw new Error(`Migrations are registered out of order: ${ids.join(', ')}`)
}

export interface RunOptions {
  db: Db
  migrations?: Migration[]
  appVersion?: string
  orgFilter?: Record<string, unknown>
  /** Re-record these applied migrations' changed checksums instead of refusing to start. */
  acceptChanged?: string[]
  log?: (message: string, extra?: Record<string, unknown>) => void
  /** How long the lock lasts without being renewed; a crashed holder's lock lapses after it. */
  lockTtlMs?: number
  /** How long to wait for another node's run before giving up. */
  lockWaitMs?: number
}

export interface RunResult {
  applied: string[]
  alreadyApplied: string[]
}

/** This run, as its lock names it: the machine, the process and the run (`host:pid:uuid`). */
function lockOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`
}

/** Whether `pid` is a process on this machine. EPERM is one this process may not signal: it exists. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

/**
 * Whether a lock's holder is a process that no longer exists ON THIS MACHINE, so its lock can be
 * taken over now rather than when it lapses (10 minutes).
 *
 * ⚠ Why: a master's API runs the migrations at every start, and a start stopped in that second (the
 * update helper's rollback stops the version systemd had just started again, a power cut, a crash)
 * left the lock held. The next start then waited for it to lapse, alive and not serving: the first
 * rollback lane's shop would have had no server for ten minutes.
 *
 * Only a holder on this host can be judged. Global's pods are separate machines, so one pod cannot
 * see another's processes, and a lock there still lapses on its own. A pid that exists, this
 * process's own included, is waited for: a reused pid, or two containers given one hostname whose
 * pid numbering both start at 1, then cost the lapse, never a second run alongside a live one.
 */
export function holderIsGone(owner: string, here = hostname(), exists: (pid: number) => boolean = processExists): boolean {
  const m = /^(.+):(\d+):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(owner)
  if (!m || m[1] !== here) return false
  return !exists(Number(m[2]))
}

async function acquireLock(db: Db, owner: string, ttlMs: number, waitMs: number, log: RunOptions['log']): Promise<void> {
  const coll = db.collection<any>(COLLECTION)
  const deadline = Date.now() + waitMs
  for (;;) {
    const now = new Date()
    try {
      // Matches a free or lapsed lock; when the lock is held, the upsert's insert collides on _id.
      await coll.updateOne(
        { _id: LOCK_ID, $or: [{ expiresAt: { $lt: now } }, { expiresAt: { $exists: false } }] },
        { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } },
        { upsert: true },
      )
      return
    } catch (e: any) {
      if (e?.code !== 11000) throw e
    }
    // Held. By a process on this machine that is gone: taken over from that exact holder, so two
    // starts racing for a dead holder's lock cannot both win it.
    const held = await coll.findOne({ _id: LOCK_ID })
    if (held && holderIsGone(String(held.owner ?? ''))) {
      const taken = await coll.updateOne(
        { _id: LOCK_ID, owner: held.owner },
        { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } },
      )
      if (taken.modifiedCount === 1) {
        log?.('Migrations: took over the lock of a run on this machine that ended without releasing it', { previousOwner: held.owner })
        return
      }
    }
    if (Date.now() >= deadline) {
      const held = await coll.findOne({ _id: LOCK_ID })
      throw new MigrationLockError(String(held?.owner ?? 'unknown'))
    }
    await new Promise(r => setTimeout(r, 250))
  }
}

async function renewLock(db: Db, owner: string, ttlMs: number): Promise<void> {
  await db.collection<any>(COLLECTION).updateOne(
    { _id: LOCK_ID, owner },
    { $set: { expiresAt: new Date(Date.now() + ttlMs) } },
  )
}

async function releaseLock(db: Db, owner: string): Promise<void> {
  await db.collection<any>(COLLECTION).deleteOne({ _id: LOCK_ID, owner })
}

export interface MigrationPreview {
  id: string
  description: string
  /** What it would do; null when it cannot say. */
  lines: string[] | null
}

/**
 * What the pending migrations would do, as far as each can say. Writes nothing and takes no lock, so
 * it records nothing either: a run after it still applies them.
 */
export async function previewMigrations(opts: Pick<RunOptions, 'db' | 'migrations' | 'orgFilter' | 'log'>): Promise<MigrationPreview[]> {
  const { db, migrations = MIGRATIONS, orgFilter = {}, log = () => {} } = opts
  const applied = new Set((await db.collection<MigrationRecord>(COLLECTION).find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id))
  const out: MigrationPreview[] = []
  for (const m of migrations) {
    if (applied.has(m.id)) continue
    out.push({ id: m.id, description: m.description, lines: m.preview ? await m.preview({ db, log, orgFilter }) : null })
  }
  return out
}

export async function runMigrations(opts: RunOptions): Promise<RunResult> {
  const {
    db,
    migrations = MIGRATIONS,
    appVersion = process.env.APP_VERSION || 'dev',
    orgFilter = {},
    acceptChanged = [],
    log = () => {},
    lockTtlMs = 10 * 60_000,
    lockWaitMs = 15 * 60_000,
  } = opts
  assertRegistryOrder(migrations)

  const owner = lockOwner()
  await acquireLock(db, owner, lockTtlMs, lockWaitMs, log)
  const result: RunResult = { applied: [], alreadyApplied: [] }
  try {
    const coll = db.collection<MigrationRecord>(COLLECTION)
    const records = new Map((await coll.find({ _id: { $ne: LOCK_ID } }).toArray()).map(r => [r._id, r]))
    const ctx: MigrationContext = { db, log, orgFilter }

    // Every checksum is checked before ANY migration runs: a changed one stops the run whole.
    for (const m of migrations) {
      const rec = records.get(m.id)
      if (!rec) continue
      const sum = checksumOf(m)
      const match = recordMatches(rec, m)
      if (match === 'current') continue
      if (match === 'legacy') {
        // The same code, recorded under the old checksum: re-recorded under the file's.
        await coll.updateOne({ _id: m.id }, { $set: { checksum: sum } })
        log(`Re-recorded ${m.id} under its file fingerprint`)
        continue
      }
      if (!acceptChanged.includes(m.id)) throw new MigrationChecksumError(m.id)
      await coll.updateOne({ _id: m.id }, { $set: { checksum: sum } })
      log(`Accepted the changed checksum of ${m.id}`)
    }

    for (const m of migrations) {
      if (records.has(m.id)) {
        result.alreadyApplied.push(m.id)
        continue
      }
      const started = Date.now()
      log(`Applying ${m.id}: ${m.description}`)
      await m.up(ctx)
      const durationMs = Date.now() - started
      await coll.insertOne({
        _id: m.id,
        description: m.description,
        appliedAt: new Date(),
        durationMs,
        appVersion,
        checksum: checksumOf(m),
      })
      log(`Applied ${m.id} in ${durationMs} ms`)
      result.applied.push(m.id)
      await renewLock(db, owner, lockTtlMs)
    }
  } finally {
    await releaseLock(db, owner)
  }
  return result
}

export interface MigrationState {
  id: string
  description: string
  /** `changed`: applied, but its code differs from what ran. `unknown`: recorded, not in this build. */
  state: 'applied' | 'pending' | 'changed' | 'unknown'
  appliedAt?: Date
  appVersion?: string
}

/** What `--status` prints: every migration this build knows, plus any it does not. */
export async function migrationStatus(db: Db, migrations: Migration[] = MIGRATIONS): Promise<MigrationState[]> {
  const records = await db.collection<MigrationRecord>(COLLECTION).find({ _id: { $ne: LOCK_ID } }).toArray()
  const byId = new Map(records.map(r => [r._id, r]))
  const known = migrations.map((m): MigrationState => {
    const rec = byId.get(m.id)
    if (!rec) return { id: m.id, description: m.description, state: 'pending' }
    return {
      id: m.id, description: m.description, appliedAt: rec.appliedAt, appVersion: rec.appVersion,
      state: recordMatches(rec, m) ? 'applied' : 'changed',
    }
  })
  // Recorded by a newer build, e.g. after a binary rollback. Expand-then-contract keeps that safe.
  const ids = new Set(migrations.map(m => m.id))
  const unknown = records
    .filter(r => !ids.has(r._id))
    .map((r): MigrationState => ({ id: r._id, description: r.description, state: 'unknown', appliedAt: r.appliedAt, appVersion: r.appVersion }))
  return [...known, ...unknown]
}
