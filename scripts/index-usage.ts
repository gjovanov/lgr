/**
 * FR-30.5: which indexes are used, read from the database's own counters.
 *
 * For each collection the app's models name: every index with its size and its `$indexStats` counter (`accesses.ops`
 * since `accesses.since`, the process start of the member that answered). An index with no use since then is listed
 * as a candidate to drop; the list goes into migration `00NN-drop-unused-indexes` unless a reason to keep it is written
 * beside it there (a unique key, a query that runs once a month, a sort the planner chooses only at size).
 *
 * Counters and sizes only: no document is read. ⚠ On a replica set the counters are the answering member's: read it
 * on the primary, a week or more after the indexes of slice A were built (FR-30.5), and not soon after a restart.
 *
 * Usage: MONGODB_URI=… bun run scripts/index-usage.ts [--json] [--collections invoices,products]
 */
import { connectDB, disconnectDB, mongoose } from '../packages/db/src/connection.js'
// The models register their collections' names.
import '../packages/db/src/models/index.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const only = args.includes('--collections') ? args[args.indexOf('--collections') + 1]!.split(',') : null

export interface IndexUse {
  collection: string
  name: string
  key: Record<string, unknown>
  ops: number
  since: string | null
  sizeKb: number
  unique: boolean
}

/** Every index of the named collections with its counter and size. Exported for the test. */
export async function indexUsage(db: any, collections: string[]): Promise<IndexUse[]> {
  const out: IndexUse[] = []
  const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name))
  for (const collection of collections) {
    if (!present.has(collection)) continue
    const coll = db.collection(collection)
    const [stats, specs, sizes] = await Promise.all([
      coll.aggregate([{ $indexStats: {} }]).toArray(),
      coll.indexes(),
      db.command({ collStats: collection }).then((s: any) => s.indexSizes ?? {}, () => ({})),
    ])
    const specByName = new Map(specs.map((s: any) => [s.name, s]))
    for (const s of stats as any[]) {
      const spec: any = specByName.get(s.name) ?? {}
      out.push({
        collection, name: s.name, key: s.key, ops: Number(s.accesses?.ops ?? 0),
        since: s.accesses?.since ? new Date(s.accesses.since).toISOString() : null,
        sizeKb: Math.round((Number(sizes[s.name] ?? 0) / 1024) * 10) / 10, unique: !!spec.unique,
      })
    }
  }
  return out.sort((a, b) => a.collection.localeCompare(b.collection) || a.ops - b.ops)
}

async function main() {
  // Counters only; building indexes is the app's (scripts/lib/require-indexes.ts).
  await connectDB({ readOnly: true })
  const db = mongoose.connection.db!
  const collections = only ?? Object.values(mongoose.models).map((m: any) => m.collection.collectionName)
  const rows = await indexUsage(db, [...new Set(collections)].sort())
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    let current = ''
    for (const r of rows) {
      if (r.collection !== current) console.log(`\n${(current = r.collection)}`)
      const flag = r.name === '_id_' ? '' : r.ops === 0 ? (r.unique ? '  unused (unique: keep)' : '  UNUSED') : ''
      console.log(`  ${r.name.padEnd(48)} ${String(r.ops).padStart(10)} ops  ${String(r.sizeKb).padStart(9)} KB  since ${r.since ?? '-'}${flag}`)
    }
    const unused = rows.filter((r) => r.ops === 0 && r.name !== '_id_' && !r.unique)
    console.log(`\n${unused.length} unused, not unique: ${unused.reduce((s, r) => s + r.sizeKb, 0).toFixed(0)} KB`)
  }
  await disconnectDB()
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
