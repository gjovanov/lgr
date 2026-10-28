import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestInvoice } from '../helpers/factories'
import { dashboardController } from '../../../portal-api/src/controllers/dashboard.controller'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * The portal dashboard's invoice cards are the customer side, as the receivables aging chart beside
 * them is: what customers owe (outstanding, overdue), what they paid in the last 30 days, the sales
 * drafts. The summary was asked for with no direction, so supplier bills were added to all of them.
 *
 * Over HTTP through the real controller: the direction is the controller's to pass.
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(dashboardController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

describe('the dashboard summary', () => {
  it('counts sales only: bills owed or paid stay off the customer cards', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user = await createTestUser(org._id)
    const customer = await createTestContact(org._id, { type: 'customer', companyName: 'Buyer' } as any)
    const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Seller' } as any)
    const now = new Date()
    const overdueDate = new Date(now.getTime() - 10 * 86_400_000)

    // Sales: one paid this week, one owed, one overdue, one draft.
    await createTestInvoice(org._id, customer._id, { status: 'paid', total: 100, amountDue: 0, amountPaid: 100, paidAt: now } as any)
    await createTestInvoice(org._id, customer._id, { status: 'sent', total: 50, amountDue: 50 } as any)
    await createTestInvoice(org._id, customer._id, { status: 'overdue', total: 20, amountDue: 20, dueDate: overdueDate } as any)
    await createTestInvoice(org._id, customer._id, { status: 'draft', total: 5, amountDue: 5 } as any)
    // Bills: the same shapes on the supplier side — none of them is the customer's.
    await createTestInvoice(org._id, supplier._id, { direction: 'incoming', status: 'paid', total: 70, amountDue: 0, amountPaid: 70, paidAt: now } as any)
    await createTestInvoice(org._id, supplier._id, { direction: 'incoming', status: 'received', total: 30, amountDue: 30 } as any)
    await createTestInvoice(org._id, supplier._id, { direction: 'incoming', status: 'overdue', total: 40, amountDue: 40, dueDate: overdueDate } as any)
    await createTestInvoice(org._id, supplier._id, { direction: 'incoming', status: 'draft', total: 9, amountDue: 9 } as any)

    const token = await (signer as any).decorator.jwt.sign({
      id: String(user._id), orgId, role: 'admin', email: 'a@t.bg', username: 'admin',
      firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
    })
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/dashboard/summary`, { headers: { authorization: `Bearer ${token}` } }))
    expect(res.status).toBe(200)
    const { invoices } = await res.json() as any

    expect(invoices.paid30d).toEqual({ amount: 100, count: 1 })
    expect(invoices.outstanding).toEqual({ amount: 70, count: 2 })
    expect(invoices.overdue).toEqual({ amount: 20, count: 1 })
    expect(invoices.drafts).toEqual({ count: 1 })
  }, 60_000)
})
