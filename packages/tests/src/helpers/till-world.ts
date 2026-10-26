import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import type { Types } from 'mongoose'
import {
  createTestOrg,
  createTestUser,
  createTestWarehouse,
  createTestProduct,
  createTestStockLevel,
  createTestFiscalDevice,
} from './factories'
import { EltradeSimulator } from './eltrade-simulator'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { cashRegisterController } from 'invoicing-api/src/controllers/cash-register.controller'
import { stockAvailabilityController } from 'invoicing-api/src/controllers/stock-availability.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { StockLevel } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-21 R2 — a till to test the cash-register service through: an org, a warehouse with stock, a
 * cashier with an operator code, an Eltrade played by `EltradeSimulator` (unless `device: false`),
 * and a session opened through the till's own route. Every door is mounted: the till, the back
 * office's `POST /invoices`, and the journal.
 */
export const tillApp = () => new Elysia()
  .onError(spaErrorHandler({}) as any)
  .use(invoiceController)
  .use(posController)
  .use(cashRegisterController)
  .use(stockAvailabilityController)

const registered: string[] = []
/** Unregister the simulated devices; call it in `afterEach`. */
export function forgetDevices() {
  for (const id of registered.splice(0)) unregisterPrinter(id)
}

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

export interface TillWorldOptions {
  device?: boolean
  role?: string
  /** On hand in the warehouse, at `avgCost` 4. */
  stock?: number
}

export async function tillWorld(app: Elysia, opts: TillWorldOptions = {}) {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const warehouse = await createTestWarehouse(org._id)
  const role = opts.role ?? 'admin'
  const user = await createTestUser(org._id, { operatorCode: '0001', role } as any)
  const product = await createTestProduct(org._id, { name: 'Болт DIN 933 М8Х25', sellingPrice: 10, purchasePrice: 4, taxRate: 20, unit: 'бр.' } as any)
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: opts.stock ?? 10, availableQuantity: opts.stock ?? 10, avgCost: 4 } as any)

  let sim: EltradeSimulator | null = null
  if (opts.device !== false) {
    const device = await createTestFiscalDevice(org._id, warehouse._id, {
      name: 'Eltrade A3', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'online',
    } as any)
    const deviceId = String(device._id)
    sim = new EltradeSimulator()
    registerPrinter(deviceId, new EltradeFiscalPrinter(sim.exchange, deviceId))
    registered.push(deviceId)
  }

  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role, email: 'cashier@test.com', username: 'cashier',
    firstName: 'Иван', lastName: 'Петров', operatorCode: '0001',
    permissions: DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] || DEFAULT_ROLE_PERMISSIONS.admin,
    ownRecordsModules: [],
  })

  async function call(method: string, path: string, body?: any, key?: string) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  const opened = await call('POST', '/trade/pos/session', { warehouseId: String(warehouse._id), openingBalance: 100, currency: 'EUR' })
  if (opened.status !== 200) throw new Error(`session open: ${opened.status} ${JSON.stringify(opened.json)}`)
  const session = opened.json.session

  /** `quantity` × 10.00 net at 20 %, paid with `tendered` in cash (or by card). */
  const saleBody = (quantity = 2, o: { nonFiscal?: boolean; method?: string; tendered?: number } = {}) => ({
    type: 'sale',
    lines: [{
      productId: String(product._id), name: 'Болт DIN 933 М8Х25', quantity, unitPrice: 10, discount: 0,
      taxRate: 20, taxAmount: 2 * quantity, lineTotal: 10 * quantity,
    }],
    subtotal: 10 * quantity, discountTotal: 0, taxTotal: 2 * quantity, total: 12 * quantity,
    payments: [{ method: o.method ?? 'cash', amount: o.tendered ?? 12 * quantity }],
    changeDue: 0,
    nonFiscal: o.nonFiscal ?? false,
  })
  const sessionId = String(session.id ?? session._id)
  const sell = (quantity = 2, o: Parameters<typeof saleBody>[1] = {}, key?: string) =>
    call('POST', `/trade/pos/session/${sessionId}/transaction`, saleBody(quantity, o), key)
  const storno = (saleId: string, key?: string, body: Record<string, unknown> = {}) =>
    call('POST', `/trade/pos/session/${sessionId}/storno`, { originalTransactionId: saleId, reason: 'customer_return', ...body }, key)

  /** A back-office cash sale, through `POST /invoices`. */
  const backOfficeSale = (quantity = 2, extra: Record<string, unknown> = {}) => call('POST', '/invoices', {
    type: 'cash_sale', direction: 'outgoing', issueDate: '2026-10-26', currency: 'EUR',
    lines: [{
      productId: String(product._id), warehouseId: String(warehouse._id), description: 'Болт DIN 933 М8Х25',
      quantity, unit: 'бр.', unitPrice: 10, taxRate: 20,
    }],
    subtotal: 10 * quantity, taxTotal: 2 * quantity, total: 12 * quantity, paymentMethod: 'cash',
    ...extra,
  })

  const stock = async () => {
    const level: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id }).lean().exec()
    return { quantity: level?.quantity, avgCost: level?.avgCost }
  }

  return {
    org, orgId, warehouse, user, product, sim, token, session, sessionId,
    call, saleBody, sell, storno, backOfficeSale, stock,
    oid: org._id as Types.ObjectId,
  }
}

export type TillWorld = Awaited<ReturnType<typeof tillWorld>>
