import type { RepositoryRegistry } from 'dal'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { mongoose } from 'db/connection'

/**
 * Backing for the repository tests in `../repos`.
 *
 * ⚠ It used to set up two backends, Mongo and SQLite, so those suites could assert parity between
 * them — which is what the directory's old name, `parity`, meant. `dal-sqlite` was the desktop's
 * local mode and is gone (FR-14.34), so the SQLite half went with it. What remains still goes
 * through **`dal`'s own interface** rather than reaching for `dal-mongo` directly, which is what
 * makes those 70 test bodies cover the interface at all — they are not redundant with the
 * integration suites, and none of them was deleted.
 */

let mongod: MongoMemoryServer | null = null
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

/** Generate a 24-char hex string compatible with MongoDB ObjectId */
function fakeObjectId(): string {
  const hex = '0123456789abcdef'
  let id = ''
  for (let i = 0; i < 24; i++) id += hex[Math.floor(Math.random() * 16)]
  return id
}

/**
 * Create a test org and return its ID.
 *
 * `ownerId` is a 24-char hex string: a valid ObjectId, and deliberately not a Mongoose
 * `ObjectId` instance, because these tests speak to the backend-agnostic `dal` interface.
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
}
