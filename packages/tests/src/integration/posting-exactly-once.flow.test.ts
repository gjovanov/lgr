import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestAccount, createTestContact, createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { invoiceController } from 'api/src/invoicing/controllers/invoice.controller'
import { journalController } from '../../../api/src/accounting/controllers/journal.controller.js'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { confirmMovement } from 'services/biz/warehouse.service'
import { ensureFiscalPeriod } from 'services/biz/accounting.service'
import { getRepos } from 'services/context'
import { eventBus } from 'services/events/event-bus'
import { registerEventHandlers, resetEventHandlers } from 'services/events/handlers'
import {
  POSTING_MAX_ATTEMPTS, drainPostings, enqueuePosting, postingHealth, runPosting, settlePosting,
} from 'services/biz/postings/posting.service'
import { postingKeyOf } from 'services/biz/postings/posting-rules'
import { renderDigestHtml } from 'services/biz/digest/daily-digest.render'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { Invoice, Journal, JournalEntry, Org, PostingJob, Product, StockMovement } from 'db/models'
import { reportUnposted } from '../../../../scripts/report-unposted'

/**
 * FR-29 slice D (#794): postings that are neither lost nor doubled (§2.5, §6 "Postings").
 *
 * - FR-29.14 a posting key on the entry: one entry per posting, whatever runs it twice;
 * - FR-29.15 the job that owes a posting is written in the state change's transaction: nothing owed when it rolls back,
 *   and nothing lost when the process stops right after the commit (here: no handler ran);
 * - FR-29.16 tried at once, retried by the drain with a growing delay, `failed` after a set number of attempts, with
 *   its last error;
 * - FR-29.17 the accountant's list and "try again", the counts for health, the digest's line;
 * - FR-29.18 the read-only report of what was never posted.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController).use(journalController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  resetEventHandlers()
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 3600_000)

/** An org with a store, an article at 100, and (unless `posts: false`) the books that make it post every event. */
async function world(opts: { posts?: boolean } = {}) {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const customer = await createTestContact(org._id, { companyName: 'Customer Ltd', type: 'customer' } as any)
  const main = await createTestWarehouse(org._id, { name: 'Main store', isDefault: true } as any)
  const bolt = await createTestProduct(org._id, { sku: 'BOLT-01', name: 'Bolt M8', purchasePrice: 5, sellingPrice: 9, taxRate: 20 } as any)
  await createTestStockLevel(org._id, bolt._id, main._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })
  if (opts.posts !== false) {
    const cash = await createTestAccount(org._id, { name: 'Cash', type: 'asset' })
    const bank = await createTestAccount(org._id, { name: 'Bank', type: 'asset' })
    const receivable = await createTestAccount(org._id, { name: 'Receivable', type: 'asset' })
    const revenue = await createTestAccount(org._id, { name: 'Revenue', type: 'revenue', subType: 'operating_revenue' } as any)
    const inventory = await createTestAccount(org._id, { name: 'Inventory', type: 'asset' })
    const cogs = await createTestAccount(org._id, { name: 'COGS', type: 'expense' })
    const sale = await Journal.create({ orgId: org._id, name: 'Sales', code: 'S1', type: 'sale' })
    const cashJ = await Journal.create({ orgId: org._id, name: 'Cash', code: 'C1', type: 'cash', defaultDebitAccountId: cash._id })
    const bankJ = await Journal.create({ orgId: org._id, name: 'Bank', code: 'B1', type: 'bank', defaultDebitAccountId: bank._id })
    await Org.updateOne({ _id: org._id }, {
      $set: {
        'settings.accounting.defaultSaleJournalId': sale._id,
        'settings.accounting.defaultCashJournalId': cashJ._id,
        'settings.accounting.defaultBankJournalId': bankJ._id,
        'settings.accounting.defaultReceivableAccountId': receivable._id,
        'settings.accounting.defaultRevenueAccountId': revenue._id,
        'settings.inventory.defaultInventoryAccountId': inventory._id,
        'settings.inventory.defaultCOGSAccountId': cogs._id,
      },
    }).exec()
    // The org's first entries open its fiscal year: open it here, so an invoice's entry and its dispatch's do not race
    // to (a race the drain would only retry, and this file is about other things).
    await ensureFiscalPeriod(orgId, new Date('2026-11-16'))
    await ensureFiscalPeriod(orgId, new Date())
  }
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  /** A draft sales invoice of `quantity` bolts at 10, paid by bank transfer (so nothing settles on issue). */
  async function draft(quantity = 3) {
    const res = await call('POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: String(customer._id), issueDate: '2026-11-16', currency: 'EUR',
      paymentMethod: 'bank_transfer',
      lines: [{ productId: String(bolt._id), warehouseId: String(main._id), description: 'Bolt M8', quantity, unit: 'pcs', unitPrice: 10, taxRate: 20 }],
      subtotal: quantity * 10, total: +(quantity * 12).toFixed(2),
    })
    expect(res.status).toBe(200)
    return String(res.json.invoice.id || res.json.invoice._id)
  }
  async function issue(id: string) {
    const res = await call('POST', `/invoices/${id}/send`, {})
    expect(res.status).toBe(200)
  }
  const jobs = () => PostingJob.find({ orgId }).lean().exec() as Promise<any[]>
  const entries = (postingKey?: string) => JournalEntry.find({ orgId, ...(postingKey ? { postingKey } : {}) }).lean().exec() as Promise<any[]>
  return { org, orgId, user, main, bolt, call, draft, issue, jobs, entries }
}

/** Wait until `check` holds, or give up after a while (the handlers run after the answer). */
async function until(check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 25))
  }
}

/**
 * The repository's journal-entry create, failing its next `times` calls for an invoice's entry (a store that fails, or
 * a bug). Only the invoice's: its dispatch's valuation is posted at the same moment, and must not take the failure.
 */
function failingEntryCreates(times: number) {
  const repos: any = getRepos()
  const real = repos.journalEntries.create
  let left = times
  repos.journalEntries.create = async function (...args: any[]) {
    if (left > 0 && args[0]?.sourceModule === 'invoicing') {
      left--
      throw new Error('The journal could not be written just now')
    }
    return real.apply(this, args)
  }
  return () => { repos.journalEntries.create = real }
}

describe('FR-29.15: the owed posting is stored with the state change', () => {
  it('an issue writes its job in its transaction: no handler ran, and the drain makes the entry', async () => {
    const w = await world()
    const id = await w.draft()
    await w.issue(id)
    // No handler is registered: the process "stopped" right after the commit. Nothing is lost.
    const owed = await w.jobs()
    const key = `invoice.posted:${id}`
    expect(owed.map(j => j.postingKey).sort()).toEqual([key, `stock.movement.confirmed:${owed.find(j => j.event === 'stock.movement.confirmed')?.movementId}`].sort())
    expect(owed.every(j => j.state === 'queued')).toBe(true)
    expect(await w.entries()).toHaveLength(0)

    await drainPostings()
    const after = await w.jobs()
    expect(after.every(j => j.state === 'done' && j.journalEntryId)).toBe(true)
    const [entry] = await w.entries(key)
    expect(entry).toBeTruthy()
    expect(String((await Invoice.findById(id).lean().exec() as any).journalEntryId)).toBe(String(entry._id))
  })

  it('a failed issue owes nothing: the job rolls back with the issue', async () => {
    const w = await world()
    const id = await w.draft()
    // §1.1's trigger: a layered method with stock and no cost layer refuses the booking.
    await Product.updateOne({ _id: w.bolt._id }, { $set: { costingMethod: 'fifo' } }).exec()
    const refused = await w.call('POST', `/invoices/${id}/send`, {})
    expect(refused.status).toBe(422)
    expect(await w.jobs()).toHaveLength(0)
  })

  it('an organization that does not post owes nothing and gets no row', async () => {
    const w = await world({ posts: false })
    const id = await w.draft()
    await w.issue(id)
    const pay = await w.call('POST', `/invoices/${id}/payments`, { date: '2026-11-16', amount: 10, method: 'bank_transfer' })
    expect(pay.status).toBe(200)
    expect(await w.jobs()).toHaveLength(0)
  })

  it('a payment writes its job with the payment row, and the entry is stamped on that row', async () => {
    const w = await world()
    const id = await w.draft()
    await w.issue(id)
    const pay = await w.call('POST', `/invoices/${id}/payments`, { date: '2026-11-16', amount: 10, method: 'bank_transfer' })
    expect(pay.status).toBe(200)
    const raw: any = await Invoice.findById(id).lean().exec()
    const row = raw.payments[0]
    const key = postingKeyOf({ event: 'payment.recorded', invoiceId: id, paymentId: String(row._id) })
    expect((await w.jobs()).find(j => j.postingKey === key)?.state).toBe('queued')

    await drainPostings()
    const stamped: any = await Invoice.findById(id).lean().exec()
    const [entry] = await w.entries(key)
    expect(String(stamped.payments[0].journalEntryId)).toBe(String(entry._id))
  })

  it('a movement confirmed on its own owes its valuation, which a transfer does not', async () => {
    const w = await world()
    const receipt = await StockMovement.create({
      orgId: w.org._id, movementNumber: 'SM-T-1', type: 'receipt', status: 'draft', date: new Date('2026-11-16'), createdBy: w.user._id,
      toWarehouseId: w.main._id, lines: [{ productId: w.bolt._id, quantity: 4, unitCost: 5, totalCost: 20 }], totalAmount: 20,
    })
    const back = await createTestWarehouse(w.org._id, { name: 'Back store' } as any)
    const transfer = await StockMovement.create({
      orgId: w.org._id, movementNumber: 'SM-T-2', type: 'transfer', status: 'draft', date: new Date('2026-11-16'), createdBy: w.user._id,
      fromWarehouseId: w.main._id, toWarehouseId: back._id, lines: [{ productId: w.bolt._id, quantity: 1, unitCost: 5, totalCost: 5 }], totalAmount: 5,
    })
    await confirmMovement(String(receipt._id))
    await confirmMovement(String(transfer._id))
    expect((await w.jobs()).map(j => j.postingKey)).toEqual([`stock.movement.confirmed:${receipt._id}`])
    await drainPostings()
    expect(await w.entries(`stock.movement.confirmed:${receipt._id}`)).toHaveLength(1)
  })
})

describe('FR-29.14: one entry per posting', () => {
  it('an event emitted twice leaves one entry', async () => {
    registerEventHandlers()
    const w = await world()
    const id = await w.draft()
    await w.issue(id)
    await until(async () => (await w.entries(`invoice.posted:${id}`)).length > 0)
    eventBus.emit('invoice.posted', { invoiceId: id, orgId: w.orgId, userId: String(w.user._id), direction: 'outgoing', total: 36, contactId: '' })
    eventBus.emit('invoice.posted', { invoiceId: id, orgId: w.orgId, userId: String(w.user._id), direction: 'outgoing', total: 36, contactId: '' })
    await new Promise(r => setTimeout(r, 300))
    expect(await w.entries(`invoice.posted:${id}`)).toHaveLength(1)
  })

  it('two runs of one job at once, and a job made done while a second ran: one entry', async () => {
    const w = await world()
    const id = await w.draft()
    await w.issue(id)
    const key = `invoice.posted:${id}`
    // The lease lets one of them in; a third, forced past it, finds the entry by its key.
    await Promise.all([runPosting(w.orgId, key), runPosting(w.orgId, key), settlePosting(w.orgId, { event: 'invoice.posted', invoiceId: id })])
    await PostingJob.updateOne({ orgId: w.orgId, postingKey: key }, { $set: { state: 'queued' }, $unset: { leaseUntil: 1 } }).exec()
    await Invoice.updateOne({ _id: id }, { $unset: { journalEntryId: 1 } }).exec()
    await runPosting(w.orgId, key)
    expect(await w.entries(key)).toHaveLength(1)
  })

  it('the index refuses a second entry with the same key', async () => {
    const w = await world()
    const base = {
      orgId: w.org._id, date: new Date(), description: 'x', type: 'standard', status: 'draft', lines: [], totalDebit: 0, totalCredit: 0,
      createdBy: w.user._id, postingKey: 'invoice.posted:abc', fiscalPeriodId: new mongoose.Types.ObjectId(),
    }
    await JournalEntry.create({ ...base, entryNumber: 'JE-1' })
    let refused: any = null
    try {
      await JournalEntry.create({ ...base, entryNumber: 'JE-2' })
    } catch (e) {
      refused = e
    }
    expect(refused?.code).toBe(11000)
    // Entries without a key are not in the index.
    const { postingKey: _k, ...unkeyed } = base
    await JournalEntry.create({ ...unkeyed, entryNumber: 'JE-3' })
    await JournalEntry.create({ ...unkeyed, entryNumber: 'JE-4' })
  })
})

describe('FR-29.16: tried at once, retried with a growing delay, failed after a set number', () => {
  it('a handler that throws once is retried and leaves one entry; the list was not empty in between', async () => {
    registerEventHandlers()
    const w = await world()
    const id = await w.draft()
    const key = `invoice.posted:${id}`
    const restore = failingEntryCreates(1)
    try {
      await w.issue(id)
      await until(async () => !!(await PostingJob.findOne({ orgId: w.orgId, postingKey: key, attempts: 1 }).lean().exec()))
    } finally {
      restore()
    }
    const job: any = await PostingJob.findOne({ orgId: w.orgId, postingKey: key }).lean().exec()
    expect(job).toMatchObject({ state: 'queued', attempts: 1, lastError: 'The journal could not be written just now' })
    // Not again at once: its next try is later.
    expect(new Date(job.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 10_000)
    const listed = await w.call('GET', '/accounting/journal/postings')
    expect(listed.status).toBe(200)
    expect(listed.json.owed).toBeGreaterThanOrEqual(1)
    expect(listed.json.postings.find((p: any) => p.event === 'invoice.posted')).toMatchObject({ state: 'queued', attempts: 1, document: { kind: 'invoice', id } })

    await drainPostings({ now: FAR_FUTURE() })
    expect(await w.entries(key)).toHaveLength(1)
    expect((await PostingJob.findOne({ orgId: w.orgId, postingKey: key }).lean().exec() as any).state).toBe('done')
    expect((await w.call('GET', '/accounting/journal/postings')).json.owed).toBe(0)
  })

  it('a job that keeps failing is failed with its last error, listed, counted, and posted on "try again"', async () => {
    const w = await world()
    const id = await w.draft()
    await w.issue(id)
    const key = `invoice.posted:${id}`
    await PostingJob.deleteMany({ orgId: w.orgId, event: { $ne: 'invoice.posted' } }).exec()
    const restore = failingEntryCreates(1000)
    try {
      for (let i = 0; i < POSTING_MAX_ATTEMPTS + 2; i++) await drainPostings({ now: FAR_FUTURE() })
    } finally {
      restore()
    }
    const job: any = await PostingJob.findOne({ orgId: w.orgId, postingKey: key }).lean().exec()
    expect(job).toMatchObject({ state: 'failed', attempts: POSTING_MAX_ATTEMPTS, lastError: 'The journal could not be written just now' })
    expect(await w.entries()).toHaveLength(0)
    // The drain leaves it alone now.
    await drainPostings({ now: FAR_FUTURE() })
    expect(await w.entries()).toHaveLength(0)

    const listed = await w.call('GET', '/accounting/journal/postings')
    expect(listed.json).toMatchObject({ owed: 0, failed: 1 })
    expect(await postingHealth()).toMatchObject({ failed: 1, orgsWithFailed: 1 })
    // The digest's operations section names it.
    const html = renderDigestHtml({
      orgId: w.orgId, orgName: 'Demo', date: '2026-11-16', locale: 'en', timezone: 'UTC', generatedAt: new Date().toISOString(), allClear: false,
      ops: { tasks: [], failedEmails: [], failedEmailCount: 0, failedPostingCount: 1, failedPostings: [{ event: 'invoice.posted', document: 'INV-1' }] },
    } as any)
    expect(html).toContain('Journal entries that could not be posted: 1')
    expect(html).toContain('INV-1')

    const retried = await w.call('POST', `/accounting/journal/postings/${job._id}/retry`)
    expect(retried.status).toBe(200)
    expect(retried.json.outcome).toBe('done')
    expect(await w.entries(key)).toHaveLength(1)
    expect((await w.call('GET', '/accounting/journal/postings')).json).toMatchObject({ owed: 0, failed: 0 })
  })

  it('"try again" on another org\'s posting, or on none, is not found', async () => {
    const a = await world()
    const b = await world()
    const id = await b.draft()
    await b.issue(id)
    const job: any = await PostingJob.findOne({ orgId: b.orgId }).lean().exec()
    expect((await a.call('POST', `/accounting/journal/postings/${job._id}/retry`)).status).toBe(404)
    expect((await a.call('POST', `/accounting/journal/postings/${new mongoose.Types.ObjectId()}/retry`)).status).toBe(404)
    expect((await a.call('POST', '/accounting/journal/postings/not-an-id/retry')).status).toBe(404)
  })

  it('a job written twice is one job', async () => {
    const w = await world()
    const id = await w.draft()
    await enqueuePosting(w.orgId, { event: 'invoice.posted', invoiceId: id })
    await enqueuePosting(w.orgId, { event: 'invoice.posted', invoiceId: id })
    expect(await PostingJob.countDocuments({ orgId: w.orgId }).exec()).toBe(1)
  })
})

describe('FR-29.18: what was never posted, read-only', () => {
  it('lists, per org that posts, the issued documents and movements with no entry, and writes nothing', async () => {
    const w = await world()
    const silent = await world({ posts: false })
    const id = await w.draft()
    await w.issue(id)
    await silent.draft()
    // As an older release left it: issued, its job gone, no entry.
    await PostingJob.deleteMany({}).exec()
    const before = await mongoose.connection.db!.collection('invoices').countDocuments()
    const report = await reportUnposted(mongoose.connection.db as any)
    expect(report.map(r => r.orgId)).toEqual([w.orgId])
    expect(report[0].counts).toMatchObject({ documents: 1, movements: 1, payments: 0, sessions: 0 })
    expect(await mongoose.connection.db!.collection('invoices').countDocuments()).toBe(before)
    expect(await PostingJob.countDocuments({}).exec()).toBe(0)
  })
})
