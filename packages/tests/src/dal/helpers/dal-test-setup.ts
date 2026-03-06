import type { RepositoryRegistry } from 'dal'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { mongoose } from 'db/connection'

let mongod: MongoMemoryServer | null = null
let sqliteGetDb: (() => import('bun:sqlite').Database) | null = null
let mongoSetupPromise: Promise<void> | null = null

/**
 * Create a RepositoryRegistry backed by MongoDB (mongodb-memory-server).
 */
export async function setupMongoRepos(): Promise<RepositoryRegistry> {
  if (!mongoSetupPromise) {
    mongoSetupPromise = (async () => {
      if (mongoose.connection.readyState !== 1) {
        mongod = await MongoMemoryServer.create()
        const uri = mongod.getUri()
        await mongoose.connect(uri)
      }
      // Import dal-mongo first to register all models
      const { createMongoRepositories: create } = await import('dal-mongo')
      // Now sync indexes (all models are registered)
      await ensureMongoIndexes()
      return create
    })()
  }
  const createFn = await mongoSetupPromise
  return createFn({ backend: 'mongo' })
}

/**
 * Create a RepositoryRegistry backed by SQLite (in-memory).
 * Each call closes any previous DB and creates a fresh one.
 */
export async function setupSQLiteRepos(): Promise<RepositoryRegistry> {
  const { createSQLiteRepositories, closeDatabase, getDatabase } = await import('dal-sqlite')
  // Close previous DB to get a completely fresh instance
  closeDatabase()
  const repos = await createSQLiteRepositories({ backend: 'sqlite', sqlitePath: ':memory:' })
  sqliteGetDb = getDatabase
  return repos
}

let indexSyncDone = false

/**
 * Ensure MongoDB indexes are synced (only runs once per process).
 */
async function ensureMongoIndexes(): Promise<void> {
  if (indexSyncDone) return
  await mongoose.syncIndexes()
  indexSyncDone = true
}

/**
 * No-op for between-test cleanup in MongoDB.
 * Tests use unique orgIds for isolation so no cleanup is needed.
 */
export async function teardownMongo(): Promise<void> {
  // Intentionally empty
}

/**
 * Clean all data in SQLite (between tests).
 * Deletes all rows from all tables (respects foreign keys via PRAGMA order).
 */
export async function teardownSQLite(): Promise<void> {
  if (!sqliteGetDb) return
  try {
    const db = sqliteGetDb()
    // Get all user tables (not sqlite_ internal or FTS shadow tables)
    const tables = db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_migrations' ORDER BY name`
    ).all() as { name: string }[]

    // Temporarily disable foreign keys for clean deletion
    db.exec('PRAGMA foreign_keys = OFF')
    for (const { name } of tables) {
      try { db.exec(`DELETE FROM "${name}"`) } catch {}
    }
    db.exec('PRAGMA foreign_keys = ON')
  } catch {}
}

/** Generate a 24-char hex string compatible with MongoDB ObjectId */
function fakeObjectId(): string {
  const hex = '0123456789abcdef'
  let id = ''
  for (let i = 0; i < 24; i++) id += hex[Math.floor(Math.random() * 16)]
  return id
}

/**
 * Create a test org and return its ID. Works for both backends.
 * Uses a 24-char hex string for ownerId (valid ObjectId format for Mongo, valid string for SQLite).
 */
export async function createTestOrg(repos: RepositoryRegistry): Promise<string> {
  const ownerId = fakeObjectId()
  const org = await repos.orgs.create({
    name: 'Test Org',
    slug: `test-org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId,
    settings: {
      baseCurrency: 'EUR',
      fiscalYearStart: 1,
      dateFormat: 'DD.MM.YYYY',
      timezone: 'Europe/Berlin',
      locale: 'en',
      taxConfig: { vatEnabled: true, defaultVatRate: 18, vatRates: [], taxIdLabel: 'VAT ID' },
      payroll: { payFrequency: 'monthly', socialSecurityRate: 0, healthInsuranceRate: 0, pensionRate: 0 },
      modules: ['accounting'],
    },
    subscription: { plan: 'professional', maxUsers: 50, status: 'active', cancelAtPeriodEnd: false },
  } as any)
  return org.id
}

export async function teardownAll(): Promise<void> {
  await mongoose.disconnect()
  if (mongod) {
    await mongod.stop()
    mongod = null
  }
  if (sqliteGetDb) {
    try {
      const { closeDatabase } = await import('dal-sqlite')
      closeDatabase()
    } catch {}
    sqliteGetDb = null
  }
}
