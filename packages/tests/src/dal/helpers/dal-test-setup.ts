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
 * How many suites are still using the shared server.
 *
 * ⚠ Refcounted because the nine `../repos/*.repo.test.ts` files run in ONE Bun process and share
 * one server. Stopping it in the first file's `afterAll` would take the database out from under
 * the other eight.
 */
let users = 0

/**
 * Create a RepositoryRegistry backed by MongoDB (mongodb-memory-server).
 */
export async function setupMongoRepos(): Promise<RepositoryRegistry> {
  users++
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

/**
 * Release this suite's hold on the shared server, stopping it once nobody is left.
 *
 * ⚠ **This is a disk leak fix, and the leak was ~300 MB per `bun run test`.** The nine repo suites
 * started a `MongoMemoryServer` and their `afterAll` said "cleanup handled by process exit" — which
 * is false. `mongodb-memory-server` removes its `dbPath` inside `stop()`, not on exit, so every run
 * left a ~302 MB `%TEMP%/mongo-mem-*` directory behind. 36 of them had accumulated (10.9 GB) before
 * anybody noticed, and `teardownAll` — which did the right thing — was **called by nothing**: its
 * only reference in the repository was its own definition.
 *
 * ⚠ Still best-effort on the stop itself. An abnormal exit (a killed run, a hook timeout cascade)
 * skips `afterAll` entirely and no in-process fix can cover that, which is why
 * `scripts/clean-mongo-mem.ts` exists as the sweeper.
 */
export async function releaseMongoRepos(): Promise<void> {
  users--
  if (users > 0) return
  mongoSetupPromise = null
  indexSyncDone = false
  await mongoose.disconnect().catch(() => {})
  if (mongod) {
    // `doCleanup` is the default, but it is named here because it is the entire point: without it
    // the process leaves its data directory on disk.
    await mongod.stop({ doCleanup: true, force: false }).catch(() => {})
    mongod = null
  }
}

/** @deprecated Use {@link releaseMongoRepos} — it refcounts, this does not. */
export async function teardownAll(): Promise<void> {
  users = 1
  await releaseMongoRepos()
}
