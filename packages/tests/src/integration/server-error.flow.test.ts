import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestUser, createTestWarehouse } from '../helpers/factories'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { logger } from 'services/logger'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Invoice } from 'db/models'

/**
 * S-12: a 500 tells the caller only what `lib/server-error.ts` lets through, and the log line
 * carries the whole error under the reference the caller was given.
 *
 * Before, the app's `onError` answered every unexpected error with its own message: a duplicate
 * key named the database, collection and index, a schema error the model and the BSON cast, a
 * missing file its path on the server. And the goods receipt with product updates answered its
 * own 500s with the raw message and logged nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any)
    .post('/api/type-error', () => { const order: any = undefined; return order.lines })
    .post('/api/refusal', () => { throw new Error('Insufficient stock for Болт М8') })
    .post('/api/schema', () => { throw new Invoice({}).validateSync() })
    .post('/api/missing-file', async () => Bun.file('/app/uploads/no-such-file.pdf').text())
    .post('/api/json', ({ body }) => ({ ok: body }))
    .use(movementController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/** Every `logger.error` call made while `run` ran. */
async function logged<T>(run: () => Promise<T>): Promise<{ result: T; calls: any[][] }> {
  const spy = spyOn(logger, 'error')
  try {
    const result = await run()
    return { result, calls: spy.mock.calls.map(c => [...c]) }
  } finally {
    spy.mockRestore()
  }
}

async function post(path: string, body = '{}', headers: Record<string, string> = {}) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

describe('S-12: what a 500 says', () => {
  it('answers a bug in our code with a reference, and logs the error under the same reference', async () => {
    const { result: r, calls } = await logged(() => post('/api/type-error'))
    expect(r.status).toBe(500)
    expect(r.json.ref).toMatch(/^[0-9a-f]{10}$/)
    expect(r.json.message).toBe(`Internal server error (ref ${r.json.ref})`)
    expect(JSON.stringify(r.json)).not.toContain('lines')

    expect(calls).toHaveLength(1)
    const [fields, msg] = calls[0]
    expect(fields.ref).toBe(r.json.ref)
    expect(fields.err).toBeInstanceOf(TypeError)
    expect(fields.method).toBe('POST')
    expect(fields.path).toBe('/api/type-error')
    // Bun's own words for it ("undefined is not an object (evaluating 'order.lines')"), kept for the log.
    expect(msg).toContain('lines')
  })

  it('passes the server\'s own words, as the UI has always shown them', async () => {
    const r = await post('/api/refusal')
    expect(r.status).toBe(500)
    expect(r.json.message).toBe('Insufficient stock for Болт М8')
    expect(r.json.ref).toMatch(/^[0-9a-f]{10}$/)
  })

  it('names the fields a schema refused, and nothing of the model or the cast', async () => {
    const r = await post('/api/schema')
    expect(r.status).toBe(500)
    expect(r.json.message.startsWith('Not saved: ')).toBe(true)
    expect(r.json.message).toContain('"issueDate" is required')
    expect(r.json.message).toMatch(/\(and \d+ more\)$/)
    expect(r.json.message).not.toContain('Invoice validation failed')
    expect(r.json.message).not.toContain('Path `')
  })

  it('never quotes a path on the server', async () => {
    const r = await post('/api/missing-file')
    expect(r.status).toBe(500)
    expect(r.json.message).toBe(`Internal server error (ref ${r.json.ref})`)
    expect(JSON.stringify(r.json)).not.toContain('/app/')
    expect(JSON.stringify(r.json)).not.toContain('ENOENT')
  })

  it('answers a body it cannot read with 400, not 500', async () => {
    const r = await post('/api/json', '{"a":')
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ message: 'The request body could not be read' })
  })

  it('a goods receipt under a number that exists: the field, not the driver\'s E11000, and a log line', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user = await createTestUser(org._id)
    const warehouse = await createTestWarehouse(org._id, { isDefault: true } as any)
    const bolt = await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Болт М8', purchasePrice: 5, sellingPrice: 10 } as any)
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
    const token = await (signer as any).decorator.jwt.sign({
      id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
      firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
    })
    const receipt = JSON.stringify({
      movementNumber: 'SM-2026-00001', type: 'receipt', date: '2026-11-09', toWarehouseId: String(warehouse._id),
      lines: [{ productId: String(bolt._id), quantity: 4, unitCost: 5, totalCost: 20 }], totalAmount: 20,
    })
    const auth = { authorization: `Bearer ${token}` }

    const first = await post(`/org/${orgId}/warehouse/movement/with-update`, receipt, auth)
    expect(first.status).toBe(200)

    const { result: again, calls } = await logged(() => post(`/org/${orgId}/warehouse/movement/with-update`, receipt, auth))
    expect(again.status).toBe(500)
    expect(again.json.message).toBe('Not saved: another record already has the same "movementNumber"')
    for (const internal of ['E11000', 'dup key', 'collection', 'index', 'SM-2026-00001']) {
      expect(JSON.stringify(again.json)).not.toContain(internal)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0][0].ref).toBe(again.json.ref)
    expect(String(calls[0][1])).toContain('E11000')
  })
})
