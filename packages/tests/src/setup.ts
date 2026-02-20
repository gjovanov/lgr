import { MongoMemoryServer } from 'mongodb-memory-server'
import { mongoose } from 'db/connection'

let mongod: MongoMemoryServer | null = null
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
  // First caller creates the connection
  connectingPromise = (async () => {
    mongod = await MongoMemoryServer.create()
    const uri = mongod.getUri()
    await mongoose.connect(uri)
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
    await db.dropDatabase()
  }
}
