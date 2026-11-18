import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { tokenize } from 'services/biz/auth.service'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestWarehouse, createTestUser } from '../helpers/factories'
import { fiscalDeviceController } from '../../../portal-api/src/controllers/fiscal-device.controller'
import { disconnectAll } from 'fiscal/fiscal-device.service'
import { AuditLog, FiscalDevice } from 'db/models'

/**
 * FR-32.24 finding: what the device form, the device list and the till send to `/fiscal/device` is what is stored.
 *
 * - `PUT /:id` did not name `status`: the list's and the till's status writes answered 200 and stored nothing. It names
 *   the model's enum now, and a value outside it is a 422.
 * - `POST /` did not name `isActive`, which the form's Active switch sends: a device always started active.
 * - The model requires a device's warehouse, so a cleared one (`null`) stays a 422 on both, and nothing changes.
 */
let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(fiscalDeviceController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  await disconnectAll()
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

/** A session of a real admin, as sign-in issues it. */
const adminToken = async (orgId: string) =>
  (signer as any).decorator.jwt.sign(await tokenize(await createTestUser(orgId as any, { role: 'admin' } as any)))

async function call(method: string, path: string, tok: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

async function orgWithWarehouse() {
  const org = await createTestOrg()
  const wh = await createTestWarehouse(org._id)
  return { orgId: String(org._id), warehouseId: String(wh._id), tok: await adminToken(String(org._id)) }
}

/** The body the device form sends for a new browser-bridged device. */
const formDevice = (warehouseId: string | null, extra: Record<string, unknown> = {}) => ({
  name: 'Каса 1',
  deviceNumber: 'DT000001',
  manufacturer: 'datecs',
  connectionType: 'browser',
  warehouseId,
  ...extra,
})

async function createDevice(orgId: string, warehouseId: string, tok: string, extra: Record<string, unknown> = {}) {
  const res = await call('POST', `/org/${orgId}/fiscal/device`, tok, formDevice(warehouseId, extra))
  expect(res.status).toBe(200)
  return String(res.json.fiscalDevice?._id || res.json.fiscalDevice?.id)
}

describe('a device\'s status, written by the device list and the till', () => {
  test('each of the model\'s statuses is stored and read back', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const id = await createDevice(orgId, warehouseId, tok)

    for (const status of ['online', 'error', 'offline'] as const) {
      const res = await call('PUT', `/org/${orgId}/fiscal/device/${id}`, tok, { status })
      expect(res.status).toBe(200)
      const read = await call('GET', `/org/${orgId}/fiscal/device/${id}`, tok)
      expect({ status, stored: read.json.fiscalDevice.status }).toEqual({ status, stored: status })
    }
  })

  test('a status change is audited as an update of the device', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const id = await createDevice(orgId, warehouseId, tok)

    expect((await call('PUT', `/org/${orgId}/fiscal/device/${id}`, tok, { status: 'online' })).status).toBe(200)
    // The audit row is written without being awaited.
    let rows: any[] = []
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      rows = await AuditLog.find({ orgId, entityType: 'fiscal_device', entityId: id, action: 'update' }).lean()
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 50))
    }
    expect(rows).toHaveLength(1)
  })

  test('a status the model does not name is refused (422) and nothing changes', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const id = await createDevice(orgId, warehouseId, tok)

    for (const status of ['maintenance', 'inactive', 'ONLINE', '']) {
      const res = await call('PUT', `/org/${orgId}/fiscal/device/${id}`, tok, { status })
      expect({ status, code: res.status }).toEqual({ status, code: 422 })
    }
    const stored: any = await FiscalDevice.findById(id).lean()
    expect(stored.status).toBe('offline')
  })
})

describe('the device form\'s create', () => {
  test('its Active switch is kept: a device created inactive is stored inactive', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const id = await createDevice(orgId, warehouseId, tok, { isActive: false })
    const stored: any = await FiscalDevice.findById(id).lean()
    expect(stored.isActive).toBe(false)
  })

  test('a device created active, or without saying, is active', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const sent = await createDevice(orgId, warehouseId, tok, { isActive: true })
    const unsaid = await createDevice(orgId, warehouseId, tok, { deviceNumber: 'DT000002' })
    const stored: any[] = await FiscalDevice.find({ _id: { $in: [sent, unsaid] } }).lean()
    expect(stored.map(d => d.isActive)).toEqual([true, true])
  })
})

describe('a device\'s warehouse, which the model requires', () => {
  test('a create with a cleared warehouse is refused (422) and nothing is stored', async () => {
    const { orgId, tok } = await orgWithWarehouse()
    const res = await call('POST', `/org/${orgId}/fiscal/device`, tok, formDevice(null))
    expect(res.status).toBe(422)
    expect(await FiscalDevice.countDocuments({ orgId })).toBe(0)
  })

  test('an update that clears the warehouse is refused (422) and the device keeps its warehouse', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const id = await createDevice(orgId, warehouseId, tok)
    const res = await call('PUT', `/org/${orgId}/fiscal/device/${id}`, tok, { name: 'Каса 2', warehouseId: null })
    expect(res.status).toBe(422)
    const stored: any = await FiscalDevice.findById(id).lean()
    expect({ name: stored.name, warehouseId: String(stored.warehouseId) }).toEqual({ name: 'Каса 1', warehouseId })
  })
})
