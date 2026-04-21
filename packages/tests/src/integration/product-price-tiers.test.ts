import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestContact } from '../helpers/factories'
import { Product } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/**
 * Phase 1 — Product.priceTiers[] schema + validation.
 * Covers round-trip, 10-slot cap, required fields, negative finalPrice,
 * and the backfill-equivalent default-slot seeding pattern.
 */
describe('Product.priceTiers schema', () => {
  it('persists and reloads 10 tier slots (round-trip)', async () => {
    const org = await createTestOrg()
    const tiers = Array.from({ length: 10 }, (_, i) => ({
      name: `Price ${i + 1}`,
      percent: i * 5,
      finalPrice: 100 + i * 5,
      manualOverride: false,
      contactIds: [],
      tags: [],
    }))
    const product = await createTestProduct(org._id, { sellingPrice: 100, priceTiers: tiers } as any)

    const fresh = await Product.findById(product._id).lean()
    expect(fresh?.priceTiers).toHaveLength(10)
    expect(fresh?.priceTiers[0]).toMatchObject({ name: 'Price 1', percent: 0, finalPrice: 100, manualOverride: false })
    expect(fresh?.priceTiers[9]).toMatchObject({ name: 'Price 10', percent: 45, finalPrice: 145 })
  })

  it('rejects a 11th tier (cap at 10 slots)', async () => {
    const org = await createTestOrg()
    const tiers = Array.from({ length: 11 }, (_, i) => ({
      name: `Price ${i + 1}`,
      percent: 0,
      finalPrice: 100,
      manualOverride: false,
    }))
    await expect(
      createTestProduct(org._id, { priceTiers: tiers } as any),
    ).rejects.toThrow(/priceTiers exceeds maximum of 10 slots/)
  })

  it('rejects a tier without a name', async () => {
    const org = await createTestOrg()
    await expect(
      createTestProduct(org._id, { priceTiers: [{ percent: 0, finalPrice: 100, manualOverride: false }] } as any),
    ).rejects.toThrow(/name/i)
  })

  it('rejects a tier with negative finalPrice', async () => {
    const org = await createTestOrg()
    await expect(
      createTestProduct(org._id, { priceTiers: [{ name: 'Bad', percent: 0, finalPrice: -1, manualOverride: false }] } as any),
    ).rejects.toThrow()
  })

  it('accepts tiers with filter fields (contactIds, tags, minQuantity, validFrom/validTo)', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const now = new Date()
    const later = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    const tiers = [{
      name: 'VIP',
      percent: 10,
      finalPrice: 90,
      manualOverride: false,
      contactIds: [contact._id],
      tags: ['vip', 'gold'],
      minQuantity: 5,
      validFrom: now,
      validTo: later,
    }]
    const product = await createTestProduct(org._id, { sellingPrice: 100, priceTiers: tiers } as any)
    const fresh = await Product.findById(product._id).lean()
    expect(fresh?.priceTiers[0].tags).toEqual(['vip', 'gold'])
    expect(fresh?.priceTiers[0].contactIds).toHaveLength(1)
    expect(fresh?.priceTiers[0].minQuantity).toBe(5)
  })

  it('defaults priceTiers to [] when not provided', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const fresh = await Product.findById(product._id).lean()
    expect(Array.isArray(fresh?.priceTiers)).toBe(true)
    expect(fresh?.priceTiers).toHaveLength(0)
  })
})

describe('Product.priceTiers backfill pattern (idempotent default-slot seeding)', () => {
  function defaultTiers(sellingPrice: number) {
    return Array.from({ length: 10 }, (_, i) => ({
      name: `Price ${i + 1}`,
      percent: 0,
      finalPrice: sellingPrice,
      manualOverride: false,
      contactIds: [],
      tags: [],
    }))
  }

  it('seeds 10 tiers for a product with empty priceTiers', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { sellingPrice: 42 })
    // Pre-state
    const before = await Product.findById(product._id).lean()
    expect(before?.priceTiers).toHaveLength(0)

    // Run the seed logic (as the backfill script would)
    await Product.updateOne(
      { _id: product._id, 'priceTiers.0': { $exists: false } },
      { $set: { priceTiers: defaultTiers(42) } },
    ).exec()

    const after = await Product.findById(product._id).lean()
    expect(after?.priceTiers).toHaveLength(10)
    expect(after?.priceTiers.every(t => t.finalPrice === 42 && t.percent === 0)).toBe(true)
  })

  it('is idempotent — does not touch products that already have tiers', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, {
      sellingPrice: 42,
      priceTiers: [{ name: 'Existing', percent: 5, finalPrice: 40, manualOverride: true }],
    } as any)

    // Run seed logic: should skip because priceTiers.0 exists.
    await Product.updateOne(
      { _id: product._id, 'priceTiers.0': { $exists: false } },
      { $set: { priceTiers: defaultTiers(42) } },
    ).exec()

    const after = await Product.findById(product._id).lean()
    expect(after?.priceTiers).toHaveLength(1)
    expect(after?.priceTiers[0].name).toBe('Existing')
    expect(after?.priceTiers[0].manualOverride).toBe(true)
  })
})
