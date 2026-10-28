import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { PERMISSIONS } from 'config/constants'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestWarehouse } from '../helpers/factories'
import { fiscalDeviceController } from '../../../portal-api/src/controllers/fiscal-device.controller'
import { disconnectAll } from 'fiscal/fiscal-device.service'
import { FiscalDevice } from 'db/models'

/**
 * H6 — a TCP fiscal device's address is the user's, so it decides where the SERVER opens a socket.
 * Saving and connecting must both refuse addresses inside the server's own network.
 *
 * The listener below plays a service on the server's loopback: no test may reach it.
 */
let app: Elysia
let listener: Server
let listenerPort = 0
let accepted = 0
const sockets: Socket[] = []

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(fiscalDeviceController)
  listener = createServer((s) => { accepted++; sockets.push(s) })
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  listenerPort = (listener.address() as any).port
}, 60_000)

afterAll(async () => {
  for (const s of sockets) s.destroy()
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  await disconnectAll()
  accepted = 0
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const token = (orgId: string) =>
  (signer as any).decorator.jwt.sign({ id: '000000000000000000000001', orgId, role: 'admin', permissions: [...PERMISSIONS], ownRecordsModules: [] })

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
  return { orgId: String(org._id), warehouseId: String(wh._id), tok: await token(String(org._id)) }
}

const tcpDevice = (warehouseId: string, connectionParams: Record<string, unknown>, deviceNumber = 'TC000001') => ({
  deviceNumber,
  name: 'Касов апарат TCP',
  manufacturer: 'datecs',
  connectionType: 'tcp',
  connectionParams,
  warehouseId,
})

describe('saving a TCP fiscal device', () => {
  test('a TCP device without an address is refused', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const res = await call('POST', `/org/${orgId}/fiscal/device`, tok, tcpDevice(warehouseId, { tcpPort: listenerPort }))
    expect(res.status).toBe(400)
    expect(res.json.code).toBe('missing_host')
    expect(await FiscalDevice.countDocuments({ orgId })).toBe(0)
  })

  test('loopback and internal addresses are refused, in every spelling', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    for (const ip of ['127.1', '0.0.0.0', '::ffff:127.0.0.1', '10.0.0.5', '192.168.1.20', '172.20.0.10']) {
      const res = await call('POST', `/org/${orgId}/fiscal/device`, tok, tcpDevice(warehouseId, { ip, tcpPort: 4999 }))
      expect({ ip, status: res.status }).toEqual({ ip, status: 400 })
    }
    expect(await FiscalDevice.countDocuments({ orgId })).toBe(0)
  })

  test('a public address is accepted (nothing connects on save)', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const res = await call('POST', `/org/${orgId}/fiscal/device`, tok, tcpDevice(warehouseId, { ip: '8.8.8.8', tcpPort: 4999 }))
    expect(res.status).toBe(200)
  })

  test('an update cannot move a device onto an internal address', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const created = await call('POST', `/org/${orgId}/fiscal/device`, tok, tcpDevice(warehouseId, { ip: '8.8.8.8', tcpPort: 4999 }))
    const id = created.json.fiscalDevice?._id || created.json.fiscalDevice?.id
    const res = await call('PUT', `/org/${orgId}/fiscal/device/${id}`, tok, { connectionParams: { ip: '10.0.0.7', tcpPort: 4999 } })
    expect(res.status).toBe(400)
    const stored: any = await FiscalDevice.findById(id).lean()
    expect(stored.connectionParams.ip).toBe('8.8.8.8')
  })
})

describe('connecting a stored TCP fiscal device', () => {
  test('a stored device without an address is refused before any socket opens, and is not marked error', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    // Saved straight into the collection, past the save-time check.
    const d = await FiscalDevice.create({ ...tcpDevice(warehouseId, { tcpPort: listenerPort }), orgId, status: 'offline', isActive: true } as any)

    const res = await call('POST', `/org/${orgId}/fiscal/device/${d._id}/connect`, tok)
    await new Promise((r) => setTimeout(r, 200))

    expect(res.status).toBe(422)
    expect(res.json.code).toBe('missing_host')
    expect(accepted).toBe(0)
    const stored: any = await FiscalDevice.findById(d._id).lean()
    expect(stored.status).toBe('offline')
  })

  test('a stored device on the cloud metadata address is refused before connecting', async () => {
    const { orgId, warehouseId, tok } = await orgWithWarehouse()
    const d = await FiscalDevice.create({ ...tcpDevice(warehouseId, { ip: '169.254.169.254', tcpPort: 80 }, 'TC000002'), orgId, status: 'offline', isActive: true } as any)
    const res = await call('POST', `/org/${orgId}/fiscal/device/${d._id}/connect`, tok)
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('forbidden')
  })
})
