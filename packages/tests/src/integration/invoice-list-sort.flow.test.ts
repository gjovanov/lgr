import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestInvoice } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { invoiceExportController } from 'invoicing-api/src/controllers/invoice-export.controller'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22.10 (B-12's twin on the document lists): sorting by № works on the sales, purchase,
 * proforma and cash-sale lists, and so does exporting a list sorted that way.
 *
 * The grids sort by the key of the column they render, and the № column's key is `number` — a
 * field `GET /invoices` adds to each row AFTER the query. Mongo sorted on a field no document has,
 * so „№" left the rows as found in both directions; and the list export refused the same key
 * outright (400 „Invalid sortBy: number"). The documents are created out of numbering order here,
 * so neither creation order nor natural order can pass for a sort.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(invoiceController).use(invoiceExportController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

const OUT_OF_ORDER = [2, 3, 1]
const numbered = (prefix: string, n: number) => `${prefix}-2026-${String(n).padStart(5, '0')}`

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const contact = await createTestContact(org._id)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })

  async function make(prefix: string, extra: Record<string, any>) {
    for (const n of OUT_OF_ORDER) {
      await createTestInvoice(org._id, contact._id, { invoiceNumber: numbered(prefix, n), status: 'sent', ...extra } as any)
    }
  }

  /** The numbers `GET /invoices` lists, sorted by the grid's № column. */
  async function list(filter: string, sortOrder: 'asc' | 'desc'): Promise<string[]> {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices?${filter}&page=0&size=10&sortBy=number&sortOrder=${sortOrder}`, {
      headers: { authorization: `Bearer ${token}` },
    }))
    expect(res.status).toBe(200)
    return ((await res.json()) as any).invoices.map((row: any) => row.number)
  }

  async function exportList(path: string, body: Record<string, any>) {
    return app.handle(new Request(`http://localhost/org/${orgId}/invoicing/export${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ format: 'xlsx', mode: 'compact', sortBy: 'number', sortOrder: 'asc', ...body }),
    }))
  }

  return { make, list, exportList }
}

const ascending = (prefix: string) => [1, 2, 3].map((n) => numbered(prefix, n))
const descending = (prefix: string) => [3, 2, 1].map((n) => numbered(prefix, n))

describe('№ sorting on the document lists (FR-22.10)', () => {
  it('sales documents', async () => {
    const w = await world()
    await w.make('INV', { type: 'invoice', direction: 'outgoing' })
    const filter = 'direction=outgoing&types=invoice,credit_note,debit_note'
    expect(await w.list(filter, 'asc')).toEqual(ascending('INV'))
    expect(await w.list(filter, 'desc')).toEqual(descending('INV'))
  })

  it('purchase documents', async () => {
    const w = await world()
    await w.make('BILL', { type: 'invoice', direction: 'incoming', status: 'received' })
    const filter = 'direction=incoming&types=invoice,credit_note,debit_note'
    expect(await w.list(filter, 'asc')).toEqual(ascending('BILL'))
    expect(await w.list(filter, 'desc')).toEqual(descending('BILL'))
  })

  it('proformas', async () => {
    const w = await world()
    await w.make('PRF', { type: 'proforma', direction: 'outgoing', status: 'draft' })
    expect(await w.list('type=proforma', 'asc')).toEqual(ascending('PRF'))
    expect(await w.list('type=proforma', 'desc')).toEqual(descending('PRF'))
  })

  it('cash sales', async () => {
    const w = await world()
    await w.make('CS', { type: 'cash_sale', direction: 'outgoing', status: 'paid' })
    expect(await w.list('type=cash_sale', 'asc')).toEqual(ascending('CS'))
    expect(await w.list('type=cash_sale', 'desc')).toEqual(descending('CS'))
  })

  it('a list sorted by № can still be exported (it answered 400 „Invalid sortBy: number")', async () => {
    const w = await world()
    await w.make('INV', { type: 'invoice', direction: 'outgoing' })
    const list = await w.exportList('/list', { docType: 'invoice', direction: 'outgoing', types: 'invoice,credit_note,debit_note' })
    expect(list.status).toBe(200)
    const kind = await w.exportList('/kind/outgoing', {})
    expect(kind.status).toBe(200)
  })
})
