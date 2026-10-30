import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { mongoose } from 'db/connection'
import { initServiceContext } from 'services/context'

/**
 * A replica set that outlives the test files, started by `with-test-mongo.ts` (CI). Unset, each
 * file starts and stops its own, as it always did.
 *
 * ⚠ Why: per file, starting a replica set took ~0.9 s, `syncIndexes()` on its empty database
 * ~1.0 s, and stopping it ~0.3 s, against a few hundred milliseconds of tests in a typical file
 * (measured on the CI runner's shape, 2026-10-30). With the shared one, a test process keeps ONE
 * database from file to file and empties it at the start of each, so its indexes stay and
 * `syncIndexes()` only checks them: ~0.2 s a file.
 */
const SHARED_URI = process.env.LGR_TEST_MONGO_URI || ''

let mongod: MongoMemoryReplSet | null = null
let refCount = 0
let connectingPromise: Promise<void> | null = null

/** `uri` with `db` as its database, its options kept (`?replicaSet=…`). Not `URL`: it refuses a host list. */
function withDatabase(uri: string, db: string): string {
  const m = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/.exec(uri)
  if (!m) throw new Error(`LGR_TEST_MONGO_URI is not a MongoDB URI: ${uri}`)
  return `${m[1]}/${db}${m[2] ?? ''}`
}

export async function setupTestDB() {
  refCount++
  // If already connecting, wait for it
  if (connectingPromise) {
    await connectingPromise
    return
  }
  if (mongoose.connection.readyState === 1) {
    return
  }
  // First caller creates the connection.
  // Replica set required so code using mongoose.startSession() + session.withTransaction()
  // works in tests the same way it works against the containerised replset.
  connectingPromise = (async () => {
    if (SHARED_URI) {
      // One database per test process: the process runs one file at a time (Bun's --parallel runs
      // files in several processes), so whatever is in it was left by the previous file.
      await mongoose.connect(withDatabase(SHARED_URI, `lgr_test_${process.pid}`))
      await clearCollections()
    } else {
      mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
      await mongoose.connect(mongod.getUri())
    }
    // Ensure all model indexes are built before tests run. On the reused database they exist, and
    // this also drops any a previous file added that no model declares.
    await mongoose.syncIndexes()
    // Initialize service context with Mongo-backed DAL repos
    const { createMongoRepositories } = await import('dal-mongo')
    const repos = await createMongoRepositories({ backend: 'mongo' })
    initServiceContext(repos)
  })()
  await connectingPromise
}

/** The running test database's URI, for a child process that has to use the same one. */
export function testDbUri(): string {
  if (SHARED_URI) return withDatabase(SHARED_URI, mongoose.connection.name)
  if (!mongod) throw new Error('testDbUri() before setupTestDB()')
  return mongod.getUri(mongoose.connection.name)
}

export async function teardownTestDB() {
  refCount--
  if (refCount > 0) return
  connectingPromise = null
  await mongoose.disconnect()
  if (mongod) {
    await mongod.stop()
    mongod = null
  }
}

export async function clearCollections() {
  const db = mongoose.connection.db
  if (db) {
    const collections = await db.listCollections({}, { nameOnly: true }).toArray()
    await Promise.all(
      // system.* (a view's definition, say) refuses a plain delete.
      collections.filter(c => !c.name.startsWith('system.')).map(c => db.collection(c.name).deleteMany({})),
    )
  }
}
