import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact } from '../helpers/factories'
import { Subscription, Invoice } from 'db/models'
import {
  activateSubscription,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  generateSubscriptionInvoices,
} from 'services/biz/subscription.service'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
})

async function createTestSubscription(
  orgId: any,
  partnerId: any,
  createdBy: any,
  overrides: any = {},
) {
  const now = new Date()
  const defaults = {
    orgId,
    name: `Sub-${Date.now()}`,
    partnerId,
    state: 'draft',
    lines: [
      { name: 'Monthly Plan', quantity: 1, priceUnit: 100, discount: 0, priceSubtotal: 100 },
      { name: 'Extra Users (5)', quantity: 5, priceUnit: 10, discount: 0, priceSubtotal: 50 },
    ],
    recurringInterval: 1,
    recurringPeriod: 'month',
    dateStart: now,
    nextInvoiceDate: now,
    currency: 'EUR',
    amountRecurring: 150,
    autoRenew: true,
    invoiceIds: [],
    createdBy,
  }
  return Subscription.create({ ...defaults, ...overrides })
}

describe('Subscription Flow', () => {
  it('should create a subscription with lines and computed MRR', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)

    const sub = await createTestSubscription(org._id, contact._id, user._id)

    expect(sub.state).toBe('draft')
    expect(sub.lines).toHaveLength(2)
    expect(sub.amountRecurring).toBe(150) // 100 + 50
    expect(sub.name).toBeDefined()
  })

  it('should activate a draft subscription (draft → active)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const sub = await createTestSubscription(org._id, contact._id, user._id)

    const activated = await activateSubscription(String(sub._id), String(org._id))

    expect(activated.state).toBe('active')
  })

  it('should pause an active subscription (active → paused)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const sub = await createTestSubscription(org._id, contact._id, user._id, { state: 'active' })

    const paused = await pauseSubscription(String(sub._id), String(org._id))

    expect(paused.state).toBe('paused')
  })

  it('should resume a paused subscription (paused → active)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const sub = await createTestSubscription(org._id, contact._id, user._id, { state: 'paused' })

    const resumed = await resumeSubscription(String(sub._id), String(org._id))

    expect(resumed.state).toBe('active')
  })

  it('should cancel an active subscription with reason', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const sub = await createTestSubscription(org._id, contact._id, user._id, { state: 'active' })

    const cancelled = await cancelSubscription(String(sub._id), String(org._id), 'Too expensive')

    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.cancellationReason).toBe('Too expensive')
    expect(cancelled.cancellationDate).toBeDefined()
  })

  it('should generate invoice from active subscription', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)

    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000) // yesterday
    const sub = await createTestSubscription(org._id, contact._id, user._id, {
      state: 'active',
      nextInvoiceDate: pastDate,
    })

    const count = await generateSubscriptionInvoices(String(org._id))

    expect(count).toBe(1)

    // Verify invoice was created
    const invoices = await Invoice.find({ orgId: org._id })
    expect(invoices).toHaveLength(1)
    expect(invoices[0].lines).toHaveLength(2)
    expect(invoices[0].total).toBe(150) // 100 + 50

    // Verify nextInvoiceDate was advanced
    const updatedSub = await Subscription.findById(sub._id)
    expect(updatedSub!.nextInvoiceDate.getTime()).toBeGreaterThan(pastDate.getTime())

    // Verify invoiceIds was updated
    expect(updatedSub!.invoiceIds).toHaveLength(1)
  })

  it('should reject cancelling an already cancelled subscription', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const sub = await createTestSubscription(org._id, contact._id, user._id, { state: 'cancelled' })

    await expect(
      cancelSubscription(String(sub._id), String(org._id), 'reason'),
    ).rejects.toThrow('Only active or paused subscriptions can be cancelled')
  })

  it('should reject activating a non-draft subscription', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const sub = await createTestSubscription(org._id, contact._id, user._id, { state: 'active' })

    await expect(
      activateSubscription(String(sub._id), String(org._id)),
    ).rejects.toThrow('Only draft subscriptions can be activated')
  })

  it('should error on non-existent subscription', async () => {
    const org = await createTestOrg()

    await expect(
      activateSubscription('000000000000000000000000', String(org._id)),
    ).rejects.toThrow('Subscription not found')
  })

  it('should not generate invoices for paused subscriptions', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)

    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await createTestSubscription(org._id, contact._id, user._id, {
      state: 'paused',
      nextInvoiceDate: pastDate,
    })

    const count = await generateSubscriptionInvoices(String(org._id))
    expect(count).toBe(0)
  })

  it('should not generate invoices when nextInvoiceDate is in the future', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await createTestSubscription(org._id, contact._id, user._id, {
      state: 'active',
      nextInvoiceDate: futureDate,
    })

    const count = await generateSubscriptionInvoices(String(org._id))
    expect(count).toBe(0)
  })
})
