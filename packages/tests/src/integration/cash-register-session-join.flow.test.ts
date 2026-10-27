import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices } from '../helpers/till-world'
import { Invoice, POSSession, StockMovement } from 'db/models'
import { loadPosRows } from 'services/biz/cash-register/pos-union'

/**
 * FR-21.31 (D-13, owner 2026-10-21) — a back-office cash sale by a user with an open session joins it.
 *
 * The cash is in that cashier's drawer, so the sale counts in the session's totals and in its close
 * JE (which reads the session's till documents), and, when asked, prints on the session's device as
 * a till sale does. With no open session it stays sessionless. And the terminal rings into the user's
 * OWN session (owner, 2026-10-27): a sale into another cashier's session is refused.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp()
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  forgetDevices()
  await clearCollections()
}, 30_000)

const session = async (id: string) => POSSession.findById(id).lean().exec() as Promise<any>

describe('FR-21.31 — a back-office sale joins its author\'s open session', () => {
  it('joins it: the drawer\'s totals, the close JE\'s rows, and the till\'s register block; nothing prints unasked', async () => {
    const w = await tillWorld(app)
    const before = await session(w.sessionId)

    const res = await w.cashierBackOfficeSale(2)

    expect(res.status).toBe(200)
    const doc: any = await Invoice.findById(res.json.invoice.id).lean()
    expect(doc.register).toMatchObject({ origin: 'pos', joinedFrom: 'backoffice', fiscal: { state: 'none' } })
    expect(String(doc.register.sessionId)).toBe(w.sessionId)
    expect(String(doc.register.cashierId)).toBe(String(w.user._id))
    // The drawer took the money: one more sale, its total, in cash.
    const after = await session(w.sessionId)
    expect(after.transactionCount).toBe(before.transactionCount + 1)
    expect(after.totalSales).toBe(before.totalSales + 24)
    expect(after.totalCash).toBe(before.totalCash + 24)
    // The session's close JE reads the session's till rows: the joined sale is one of them.
    const rows = await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId })
    expect(rows.map(r => r.id)).toEqual([String(doc._id)])
    // Stock left from the line's own warehouse, and no receipt was asked for.
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: doc._id, type: 'dispatch' })).toBe(1)
    expect(w.sim!.receipts).toHaveLength(0)
  }, 60_000)

  it('prints a fiscal receipt on the session\'s device when asked, as the till does', async () => {
    const w = await tillWorld(app)
    const res = await w.cashierBackOfficeSale(1, { receipt: 'fiscal' })
    expect(res.status).toBe(200)
    const doc: any = await Invoice.findById(res.json.invoice.id).lean()
    expect(doc.register.fiscal.state).toBe('printed')
    expect(doc.register.unp).toMatch(/^ED123456-0001-\d{7}$/)
    expect(doc.register.fiscalDeviceNumber).toBe('ED123456')
    expect(w.sim!.receipts.filter(r => r.kind === 'fiscal' && !r.voided)).toHaveLength(1)
  }, 60_000)

  it('a joined sale is the drawer\'s: it cannot be edited or voided, and is reversed by a storno', async () => {
    const w = await tillWorld(app, { device: false })
    const res = await w.cashierBackOfficeSale(1)
    const id = res.json.invoice.id
    expect((await w.call('PUT', `/invoices/${id}`, { notes: 'edited' })).status).toBe(409)
    expect((await w.call('POST', `/invoices/${id}/void`)).status).toBe(409)
    const storno = await w.storno(id)
    expect(storno.status).toBe(200)
    expect(((await Invoice.findById(id).lean()) as any).register.stornoState).toBe('full')
  }, 60_000)

  it('with no open session it stays sessionless, as before', async () => {
    const w = await tillWorld(app)
    const res = await w.backOfficeSale(1)   // the clerk, who has no session
    expect(res.status).toBe(200)
    const doc: any = await Invoice.findById(res.json.invoice.id).lean()
    expect(doc.register.origin).toBe('backoffice')
    expect(doc.register.sessionId).toBeUndefined()
    expect((await session(w.sessionId)).transactionCount).toBe(0)
  }, 60_000)

  it('an imported till day never joins: it is a day\'s takings, not one drawer\'s sale', async () => {
    const w = await tillWorld(app)
    const res = await w.cashierBackOfficeSale(1, { reference: 'salesAnalysis:2026-10-26', tags: ['cash-register-import'] })
    expect(res.status).toBe(200)
    const doc: any = await Invoice.findById(res.json.invoice.id).lean()
    expect(doc.register.origin).toBe('import')
    expect(doc.register.sessionId).toBeUndefined()
  }, 60_000)

  it('a keyed retry of a joined sale replays it: one document, counted once', async () => {
    const w = await tillWorld(app)
    const first = await w.cashierBackOfficeSale(1, {}, 'join-key-0001')
    const again = await w.cashierBackOfficeSale(1, {}, 'join-key-0001')
    expect(again.status).toBe(200)
    expect(again.json.invoice.id).toBe(first.json.invoice.id)
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(1)
    expect((await session(w.sessionId)).transactionCount).toBe(1)
  }, 60_000)
})

describe('the terminal rings into the user\'s own session (owner, 2026-10-27)', () => {
  it('a sale into another cashier\'s session is refused, and nothing is written', async () => {
    const w = await tillWorld(app)
    const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, w.saleBody(1), undefined, w.clerkToken)
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('session_not_yours')
    expect(await Invoice.countDocuments({ orgId: w.oid })).toBe(0)
    expect(w.sim!.receipts).toHaveLength(0)
  }, 60_000)
})
