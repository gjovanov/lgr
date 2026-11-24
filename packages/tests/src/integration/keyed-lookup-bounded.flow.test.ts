import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Glob } from 'bun'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { forgetDevices, tillApp, tillWorld } from '../helpers/till-world'
import { mongoose } from 'db/connection'
import { Invoice, POSSession } from 'db/models'
import { clientKeyIs } from 'services/biz/hot-path-key'
import type { Elysia } from 'elysia'

/**
 * #785: a keyed till request reads its key through the index, however many documents the org has.
 *
 * The `{orgId, clientKey}` indexes of `Invoice` and `POSSession` are partial (`clientKey: { $type: 'string' }`).
 * On `{ orgId, clientKey: key }` the planner cannot prove that filter, so it took another `orgId` index and
 * read every document of the org. Each keyed till sale asked for its new key that way: after 8,600 sales the
 * FR-20 soak's master read 8,600 invoices a sale, and the sale's time crept up with them. `clientKeyIs(key)`
 * puts the `$type` beside the equality, and the lookup reads one index entry.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  forgetDevices()
  await mongoose.connection.db!.command({ profile: 0 })
  await clearCollections()
})

/** `n` finished till sales of other sessions, each with its key, written raw: what weeks of trading leave. */
async function history(orgId: mongoose.Types.ObjectId, n: number) {
  const now = new Date()
  const docs = Array.from({ length: n }, (_, i) => ({
    orgId, type: 'cash_sale', direction: 'outgoing', status: 'paid', currency: 'EUR',
    invoiceNumber: `CS-2020-${String(i + 1).padStart(5, '0')}`, clientKey: `history-key-${i}`,
    issueDate: now, dueDate: now, subtotal: 10, taxTotal: 2, total: 12, completedAt: now,
    lines: [{ productId: new mongoose.Types.ObjectId(), description: 'Болт', quantity: 1, unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
    register: { origin: 'pos', sessionId: new mongoose.Types.ObjectId(), fiscal: { state: 'printed' } },
    createdAt: now, updatedAt: now,
  }))
  for (let i = 0; i < docs.length; i += 1000) await Invoice.collection.insertMany(docs.slice(i, i + 1000) as any)
}

/** What MongoDB's profiler saw of `run`: every operation, with what it examined. */
async function profiled(run: () => Promise<unknown>): Promise<any[]> {
  const db = mongoose.connection.db!
  await db.command({ profile: 0 })
  await db.collection('system.profile').drop().catch(() => {})
  await db.createCollection('system.profile', { capped: true, size: 16 * 1024 * 1024 })
  await db.command({ profile: 2, slowms: 0 })
  try {
    await run()
  } finally {
    await db.command({ profile: 0 })
  }
  return db.collection('system.profile').find({}).toArray()
}

/** The filter an operation ran with, whatever the command. */
const filterOf = (op: any) => op.command?.filter ?? op.command?.query ?? op.command?.q ?? {}

describe('a keyed lookup reads its key through the index (#785)', () => {
  it('a keyed till sale reads no more documents in an org with a long history', async () => {
    const w = await tillWorld(app)
    const N = 3000
    await history(w.oid, N)

    const ops = await profiled(async () => {
      const sold = await w.sell(1, {}, 'keyed-sale-785-0001')
      expect(sold.status).toBe(200)
    })

    const keyed = ops.filter(op => op.ns?.endsWith('.invoices') && 'clientKey' in filterOf(op))
    expect(keyed.length).toBeGreaterThan(0)
    for (const op of keyed) {
      // One index entry, never the org's documents: on an equality alone this was all N.
      expect(op.planSummary).toContain('clientKey')
      expect(op.docsExamined ?? 0).toBeLessThanOrEqual(1)
      expect(op.keysExamined ?? 0).toBeLessThanOrEqual(2)
    }
    // And nothing else the sale reads walks the history: every invoice read examines a handful of documents.
    const invoiceReads = ops.filter(op => op.ns?.endsWith('.invoices'))
    const most = Math.max(...invoiceReads.map(op => op.docsExamined ?? 0))
    expect(most).toBeLessThan(20)
  })

  it('a keyed retry finds the sale its key made, through the index', async () => {
    const w = await tillWorld(app)
    await history(w.oid, 1500)
    const first = await w.sell(1, {}, 'keyed-sale-785-0002')
    expect(first.status).toBe(200)

    const ops = await profiled(async () => {
      const again = await w.sell(1, {}, 'keyed-sale-785-0002')
      expect(again.status).toBe(200)
      expect(again.json.transaction.id).toBe(first.json.transaction.id)
    })

    const keyed = ops.filter(op => op.ns?.endsWith('.invoices') && 'clientKey' in filterOf(op))
    expect(keyed.length).toBeGreaterThan(0)
    for (const op of keyed) {
      expect(op.planSummary).toContain('clientKey')
      expect(op.docsExamined ?? 0).toBeLessThanOrEqual(1)
    }
  })

  it('both models, and the $in form, plan on the partial unique index', async () => {
    const orgId = new mongoose.Types.ObjectId()
    await history(orgId, 200)
    const invoice: any = await Invoice.find({ orgId, clientKey: clientKeyIs('no-such-key-785') }).limit(1).explain('executionStats')
    expect(JSON.stringify(invoice.queryPlanner.winningPlan)).toContain('orgId_1_clientKey_1')
    expect(invoice.executionStats.totalDocsExamined).toBe(0)

    const several: any = await Invoice.find({ orgId, clientKey: clientKeyIs(['history-key-3', 'history-key-7']) }).explain('executionStats')
    expect(JSON.stringify(several.queryPlanner.winningPlan)).toContain('orgId_1_clientKey_1')
    expect(several.executionStats.nReturned).toBe(2)
    expect(several.executionStats.totalDocsExamined).toBe(2)

    const session: any = await POSSession.find({ orgId, clientKey: clientKeyIs('no-such-key-785') }).limit(1).explain('queryPlanner')
    expect(JSON.stringify(session.queryPlanner.winningPlan)).toContain('orgId_1_clientKey_1')
  })

  it('no server code looks a client key up by its equality alone', () => {
    const root = join(import.meta.dir, '..', '..', '..')
    // A read or write that names `clientKey: <a value>` in its filter. A write of the field itself
    // (`{ ...(key ? { clientKey: key } : {}) }` in a document) is not on a line that calls one of these.
    const call = /\b(find|findOne|findById|exists|countDocuments|findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany)\(/
    const bare = /[{,]\s*clientKey:\s*(?!clientKeyIs\(|\{)[A-Za-z_$][\w$.]*/
    const offenders: string[] = []
    for (const dir of ['services/src', 'api/src', 'fiscal/src', 'db/src', 'migrations/src']) {
      for (const f of new Glob('**/*.ts').scanSync({ cwd: join(root, dir) })) {
        const lines = readFileSync(join(root, dir, f), 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (call.test(line) && bare.test(line)) offenders.push(`${dir}/${f}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })
})
