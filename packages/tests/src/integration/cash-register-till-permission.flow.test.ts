import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestUser } from '../helpers/factories'
import { POSSession } from 'db/models'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { writeRuleFor } from 'services/biz/route-permission'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-21.32: the till's write routes require `pos.write`.
 *
 * S-28 (2026-10-23) enforces it through the `trade/pos` write rule in every auth plugin; this file
 * pins it for the till. The preflight the spec asks for (who used the till in the last 90 days
 * without the permission) was run read-only on production on 2026-10-27 and found nobody.
 */
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

describe('FR-21.32 — the till writes need pos.write', () => {
  const app = tillApp()
  let w: TillWorld

  beforeAll(async () => { await setupTestDB() }, 60_000)
  afterAll(async () => { await teardownTestDB() }, 60_000)
  afterEach(async () => {
    forgetDevices()
    await clearCollections()
  }, 30_000)

  /** A member of the world's org with a role's default permissions. */
  async function tokenFor(role: keyof typeof DEFAULT_ROLE_PERMISSIONS, operatorCode: string) {
    const user = await createTestUser(w.org._id, { operatorCode, role } as any)
    return (signer as any).decorator.jwt.sign({
      id: String(user._id), orgId: w.orgId, role, email: `${role}@test.com`, username: role,
      firstName: 'Тест', lastName: 'Тестов', operatorCode,
      permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
    })
  }

  it('every write route of the till resolves to a rule that needs pos.write', () => {
    const writes = (posController as any).routes.filter((r: any) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method))
    expect(writes.length).toBeGreaterThan(3)
    for (const r of writes) {
      const rule: any = writeRuleFor(r.method, r.path)
      expect({ route: `${r.method} ${r.path}`, need: rule?.need }).toEqual({ route: `${r.method} ${r.path}`, need: ['pos.write'] })
    }
  })

  it('a role without pos.write is refused at every till door, before anything is written', async () => {
    w = await tillWorld(app, { device: false })
    const sale = await w.sell(1, { nonFiscal: true })
    expect(sale.status).toBe(200)
    const saleId = String(sale.json.transaction.id ?? sale.json.transaction._id)

    for (const [role, code] of [['nra_auditor', '0101'], ['accountant', '0102'], ['warehouse_manager', '0103'], ['member', '0104']] as const) {
      const as = await tokenFor(role, code)
      const doors = [
        ['POST', '/trade/pos/session', { warehouseId: String(w.warehouse._id), openingBalance: 0, currency: 'EUR' }],
        ['POST', `/trade/pos/session/${w.sessionId}/transaction`, w.saleBody(1, { nonFiscal: true })],
        ['POST', `/trade/pos/session/${w.sessionId}/storno`, { originalTransactionId: saleId, reason: 'customer_return' }],
        ['POST', `/trade/pos/session/${w.sessionId}/close`, { closingBalance: 0 }],
      ] as const
      for (const [method, path, body] of doors) {
        const res = await w.call(method, path, body, undefined, as)
        expect({ role, path, status: res.status, code: res.json?.code }).toEqual({ role, path, status: 403, code: 'permission_required' })
      }
    }

    // Nothing moved: the session is still open with the one sale, and the sale was not stornoed.
    const list = await w.call('GET', `/trade/pos/session/${w.sessionId}/transaction?size=50`)
    expect(list.status).toBe(200)
    expect(list.json.transactions.map((t: any) => t.type)).toEqual(['sale'])
    const session: any = await POSSession.findById(w.sessionId).lean().exec()
    expect(session.status).toBe('open')
  })

  it('the sales role, which holds pos.write, works the till', async () => {
    w = await tillWorld(app, { device: false })
    const as = await tokenFor('sales', '0201')
    const opened = await w.call('POST', '/trade/pos/session', { warehouseId: String(w.warehouse._id), openingBalance: 0, currency: 'EUR' }, undefined, as)
    expect(opened.status).toBe(200)
    const sid = String(opened.json.session.id ?? opened.json.session._id)
    const sale = await w.call('POST', `/trade/pos/session/${sid}/transaction`, w.saleBody(1, { nonFiscal: true }), undefined, as)
    expect(sale.status).toBe(200)
  })
})
