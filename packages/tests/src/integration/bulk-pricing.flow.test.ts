import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestContact } from '../helpers/factories'
import { bulkAdjustPrices } from 'services/biz/bulk-pricing.service'
import { Product } from 'db/models'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('Bulk Price Adjustment', () => {
  it('should adjust selling price by percentage for tagged products', async () => {
    const org = await createTestOrg()
    const p1 = await createTestProduct(org._id, { sku: 'BOLT-1', sellingPrice: 100, tags: ['u-bolts'] })
    const p2 = await createTestProduct(org._id, { sku: 'BOLT-2', sellingPrice: 200, tags: ['u-bolts'] })
    await createTestProduct(org._id, { sku: 'OTHER', sellingPrice: 50, tags: ['nuts'] })

    const result = await bulkAdjustPrices(String(org._id), {
      productTagFilters: ['u-bolts'],
      sellingPricePercent: 10,
    })

    expect(result.productsUpdated).toBe(2)
    expect(result.pricesAdjusted).toBe(2)

    const updated1 = await Product.findById(p1._id).lean()
    expect(updated1!.sellingPrice).toBe(110)

    const updated2 = await Product.findById(p2._id).lean()
    expect(updated2!.sellingPrice).toBe(220)
  })

  it('should also adjust custom prices when flag is set', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    await createTestProduct(org._id, {
      sku: 'CP-1',
      sellingPrice: 100,
      tags: ['u-bolts'],
      tagPrices: [{ name: 'Loyal', tag: 'loyal', price: 80 }],
      customPrices: [{ name: 'VIP', contactId: contact._id, price: 70 }],
    })

    const result = await bulkAdjustPrices(String(org._id), {
      productTagFilters: ['u-bolts'],
      sellingPricePercent: 10,
      adjustCustomPrices: true,
    })

    expect(result.productsUpdated).toBe(1)
    // 1 selling + 1 tagPrice + 1 customPrice = 3
    expect(result.pricesAdjusted).toBe(3)

    const updated = await Product.findById((await Product.findOne({ sku: 'CP-1' }))!._id).lean()
    expect(updated!.sellingPrice).toBe(110)
    expect(updated!.tagPrices[0].price).toBe(88)
    expect(updated!.customPrices[0].price).toBe(77)
  })

  it('should adjust only matching custom price tags in mode 2', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, {
      sku: 'TAG-1',
      sellingPrice: 100,
      tagPrices: [
        { name: 'Loyal', tag: 'loyal', price: 80 },
        { name: 'VIP', tag: 'vip', price: 70 },
      ],
    })

    const result = await bulkAdjustPrices(String(org._id), {
      customPriceTagFilters: ['loyal'],
      customPricePercent: -5,
    })

    expect(result.productsUpdated).toBe(1)
    expect(result.pricesAdjusted).toBe(1)

    const updated = await Product.findOne({ sku: 'TAG-1' }).lean()
    expect(updated!.tagPrices[0].price).toBe(76) // 80 * 0.95
    expect(updated!.tagPrices[1].price).toBe(70) // unchanged
  })

  it('should handle negative percentage (price decrease)', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { sku: 'DEC-1', sellingPrice: 100, tags: ['sale'] })

    await bulkAdjustPrices(String(org._id), {
      productTagFilters: ['sale'],
      sellingPricePercent: -20,
    })

    const updated = await Product.findOne({ sku: 'DEC-1' }).lean()
    expect(updated!.sellingPrice).toBe(80)
  })

  it('should not modify products without matching tags', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { sku: 'NONE', sellingPrice: 100, tags: ['other'] })

    const result = await bulkAdjustPrices(String(org._id), {
      productTagFilters: ['nonexistent'],
      sellingPricePercent: 50,
    })

    expect(result.productsUpdated).toBe(0)
    expect(result.pricesAdjusted).toBe(0)

    const unchanged = await Product.findOne({ sku: 'NONE' }).lean()
    expect(unchanged!.sellingPrice).toBe(100)
  })

  it('should use separate custom price percent when provided', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, {
      sku: 'SEP-1',
      sellingPrice: 100,
      tags: ['bolts'],
      tagPrices: [{ name: 'Bulk', tag: 'bulk', price: 80 }],
    })

    await bulkAdjustPrices(String(org._id), {
      productTagFilters: ['bolts'],
      sellingPricePercent: 10,
      adjustCustomPrices: true,
      customPricePercent: 5,
    })

    const updated = await Product.findOne({ sku: 'SEP-1' }).lean()
    expect(updated!.sellingPrice).toBe(110) // +10%
    expect(updated!.tagPrices[0].price).toBe(84) // +5%
  })
})
