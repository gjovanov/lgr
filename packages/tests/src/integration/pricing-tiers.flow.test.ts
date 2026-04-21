import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestProduct } from '../helpers/factories'
import { resolvePrice } from 'services/biz/pricing.service'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/**
 * Phase 2 — resolvePrice() honors filtered tiers; filterless tiers are storage-only.
 */
describe('Price tier resolution (positive)', () => {
  it('applies a tag-filtered tier when contact has matching tag', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['vip'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [{ name: 'VIP', percent: 10, finalPrice: 90, manualOverride: false, tags: ['vip'] }],
    } as any)

    const r = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(r.finalPrice).toBe(90)
    const tier = r.steps.find(s => s.type === 'tier')
    expect(tier?.label).toBe('VIP')
    expect(tier?.price).toBe(90)
  })

  it('applies a contactId-filtered tier when contact matches', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [{ name: 'Acme', percent: 5, finalPrice: 95, manualOverride: false, contactIds: [contact._id] }],
    } as any)

    const r = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(r.finalPrice).toBe(95)
    expect(r.steps.find(s => s.type === 'tier')?.label).toBe('Acme')
  })

  it('picks the lowest finalPrice when multiple tiers match', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['vip', 'gold'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [
        { name: 'VIP', percent: 10, finalPrice: 90, manualOverride: false, tags: ['vip'] },
        { name: 'Gold', percent: 20, finalPrice: 80, manualOverride: false, tags: ['gold'] },
      ],
    } as any)

    const r = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(r.finalPrice).toBe(80)
    expect(r.steps.find(s => s.type === 'tier')?.label).toBe('Gold')
  })

  it('respects minQuantity on a tier', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['vip'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [{ name: 'Bulk', percent: 0, finalPrice: 80, manualOverride: false, tags: ['vip'], minQuantity: 10 }],
    } as any)

    // qty < min → skip
    const r1 = await resolvePrice(String(org._id), String(product._id), String(contact._id), 5)
    expect(r1.finalPrice).toBe(100)
    expect(r1.steps.find(s => s.type === 'tier')).toBeUndefined()

    // qty == min → apply
    const r2 = await resolvePrice(String(org._id), String(product._id), String(contact._id), 10)
    expect(r2.finalPrice).toBe(80)
  })

  it('contact custom price still wins over a tier price (most-specific rule)', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['vip'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [{ name: 'VIP', percent: 10, finalPrice: 90, manualOverride: false, tags: ['vip'] }],
      customPrices: [{ name: 'Special deal', contactId: contact._id, price: 50 }],
    } as any)

    const r = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(r.finalPrice).toBe(50)
    // Both tier and contact steps appear — contact is last and wins.
    expect(r.steps.at(-1)?.type).toBe('contact')
  })
})

describe('Price tier resolution (negative)', () => {
  it('filterless tier is display-only — never wins resolution', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [{ name: 'Slot 1', percent: 0, finalPrice: 1, manualOverride: false }], // would be absurdly cheap if it won
    } as any)

    const r = await resolvePrice(String(org._id), String(product._id), String(contact._id))
    expect(r.finalPrice).toBe(100)
    expect(r.steps.find(s => s.type === 'tier')).toBeUndefined()
  })

  it('expired tier (validTo in past) never wins', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['vip'] })
    const yesterday = new Date(Date.now() - 86400_000)
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [{ name: 'Old promo', percent: 10, finalPrice: 90, manualOverride: false, tags: ['vip'], validTo: yesterday }],
    } as any)
    const r = await resolvePrice(String(org._id), String(product._id), String(contact._id))
    expect(r.finalPrice).toBe(100)
  })

  it('future tier (validFrom in future) never wins', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['vip'] })
    const nextWeek = new Date(Date.now() + 7 * 86400_000)
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [{ name: 'Upcoming', percent: 10, finalPrice: 90, manualOverride: false, tags: ['vip'], validFrom: nextWeek }],
    } as any)
    const r = await resolvePrice(String(org._id), String(product._id), String(contact._id))
    expect(r.finalPrice).toBe(100)
  })

  it('tag-filtered tier does not match contact without that tag', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['regular'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [{ name: 'VIP only', percent: 10, finalPrice: 90, manualOverride: false, tags: ['vip'] }],
    } as any)
    const r = await resolvePrice(String(org._id), String(product._id), String(contact._id))
    expect(r.finalPrice).toBe(100)
  })

  it('contactId-filtered tier does not match when contactId differs', async () => {
    const org = await createTestOrg()
    const allowed = await createTestContact(org._id, { name: 'Allowed Co' })
    const other = await createTestContact(org._id, { name: 'Other Co' })
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      priceTiers: [{ name: 'Allowed only', percent: 10, finalPrice: 90, manualOverride: false, contactIds: [allowed._id] }],
    } as any)
    const r = await resolvePrice(String(org._id), String(product._id), String(other._id))
    expect(r.finalPrice).toBe(100)
  })

  it('no tiers array leaves resolution unchanged', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['vip'] })
    const product = await createTestProduct(org._id, { sellingPrice: 100 })
    const r = await resolvePrice(String(org._id), String(product._id), String(contact._id))
    expect(r.finalPrice).toBe(100)
    expect(r.steps.find(s => s.type === 'tier')).toBeUndefined()
  })
})
