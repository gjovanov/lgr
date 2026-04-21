import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { mongoose } from 'db/connection'
import { initServiceContext } from 'services/context'

let mongod: MongoMemoryReplSet | null = null
let refCount = 0
let connectingPromise: Promise<void> | null = null

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
    mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    const uri = mongod.getUri()
    await mongoose.connect(uri)
    // Ensure all model indexes are built before tests run
    await mongoose.syncIndexes()
    // Initialize service context with Mongo-backed DAL repos
    const { createMongoRepositories } = await import('dal-mongo')
    const repos = await createMongoRepositories({ backend: 'mongo' })
    initServiceContext(repos)
  })()
  await connectingPromise
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
    const collections = await db.listCollections().toArray()
    await Promise.all(
      collections.map(c => db.collection(c.name).deleteMany({})),
    )
  }
}
