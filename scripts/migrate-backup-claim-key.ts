/**
 * One-off migration: move `BackupRun` onto the `claimKey` claim.
 *
 * Background: the unique `{orgId, kind, date}` index IS the nightly claim, and manual creates
 * were hung off the same key. `kind` is the full-vs-delta axis and a manual bundle is always
 * `full`, so every manual create for one org on one day resolved to the SAME row and upserted
 * over the previous one. The artifacts were all written — the filename suffix saw to that —
 * but all but the newest were left with no row pointing at them: invisible to the history
 * endpoint and unreachable by `runId` for a restore. In one ordering it was worse than
 * invisible: `backupTick` skips an org whose row for today has a `completedAt`, so a manual
 * morning bundle could mark the day done and cost the org its scheduled night.
 *
 * `claimKey` splits the two. `'scheduled'` owns the org-day; a manual create passes a token
 * unique to itself and owns only its own row.
 *
 * ⚠ Mongoose creates the new index but NEVER drops the one it replaces, and while
 * `{orgId, kind, date}` survives it still rejects the second manual row of a day — the exact
 * bug this exists to fix, still in force. Dropping it is the whole point of this script.
 *
 * This script:
 *   1. Backfills `claimKey: 'scheduled'` on every existing row. They are all scheduled runs,
 *      and leaving them unset would break the `coversFrom` chain lookup, which is scoped to
 *      the claim — the first run after deploy would report covering from the beginning of
 *      time because it could not see its own predecessor.
 *   2. Drops the old unique `{orgId, kind, date}` index if present.
 *   3. Ensures the new unique `{orgId, kind, date, claimKey}` index exists.
 *
 * Safe to re-run; each step is a no-op once applied. A database that has never run the
 * previous version needs none of it.
 *
 * Usage:
 *   bun run scripts/migrate-backup-claim-key.ts              # dry-run audit
 *   bun run scripts/migrate-backup-claim-key.ts --execute    # actually migrate
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { BackupRun } from '../packages/db/src/models/index.js'

const execute = process.argv.slice(2).includes('--execute')

const OLD_INDEX = { orgId: 1, kind: 1, date: 1 }
const NEW_INDEX = { orgId: 1, kind: 1, date: 1, claimKey: 1 }

/** Index names are positional, so compare the key spec rather than trusting Mongo's naming. */
function sameKey(a: Record<string, any>, b: Record<string, any>): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k])
}

async function main() {
  await connectDB()
  const coll = BackupRun.collection

  const missing = await BackupRun.countDocuments({ claimKey: { $exists: false } })
  console.log(`rows without claimKey: ${missing}`)

  const indexes = await coll.indexes()
  const old = indexes.find(i => sameKey(i.key as any, OLD_INDEX))
  const current = indexes.find(i => sameKey(i.key as any, NEW_INDEX))
  console.log(`old {orgId,kind,date} index: ${old ? `present (${old.name})` : 'absent'}`)
  console.log(`new {orgId,kind,date,claimKey} index: ${current ? `present (${current.name})` : 'absent'}`)

  if (!execute) {
    console.log('\ndry run — pass --execute to apply')
    await disconnectDB()
    return
  }

  if (missing > 0) {
    const r = await BackupRun.updateMany(
      { claimKey: { $exists: false } },
      { $set: { claimKey: 'scheduled' } },
    ).exec()
    console.log(`backfilled claimKey on ${r.modifiedCount} rows`)
  }

  // ⚠ Backfill FIRST. Creating the unique index while rows still have a missing `claimKey`
  // is fine (they were already unique without it), but dropping the old index before the
  // new one exists leaves a window with no claim at all — and the tick may run in it.
  if (!current) {
    await coll.createIndex(NEW_INDEX as any, { unique: true })
    console.log('created the {orgId,kind,date,claimKey} unique index')
  }

  if (old) {
    await coll.dropIndex(old.name!)
    console.log(`dropped the old ${old.name} index`)
  }

  console.log('\ndone')
  await disconnectDB()
}

main().catch(async e => {
  console.error(e)
  await disconnectDB()
  process.exit(1)
})
