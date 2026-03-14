import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestProduct } from '../helpers/factories'
import { resolvePrice } from 'services/biz/pricing.service'
import { Product, Contact, Tag } from 'db/models'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Tag-Based Pricing', () => {
  it('should return base selling price when no contact', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { sellingPrice: 10 })

    const result = await resolvePrice(String(org._id), String(product._id))

    expect(result.finalPrice).toBe(10)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toEqual({ type: 'base', label: 'Selling price', price: 10 })
  })

  it('should return base price when contact has no matching tags', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['vip'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ tag: 'loyal', price: 8 }],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(10)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].type).toBe('base')
  })

  it('should apply tag-based price when contact tag matches', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ tag: 'loyal', price: 8 }],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(8)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]).toEqual({ type: 'base', label: 'Selling price', price: 10 })
    expect(result.steps[1]).toEqual({ type: 'tag', label: "Tag 'loyal'", price: 8 })
  })

  it('should pick lowest tag price when multiple tags match', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal', 'wholesale'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [
        { tag: 'loyal', price: 8 },
        { tag: 'wholesale', price: 7 },
      ],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(7)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[1]).toEqual({ type: 'tag', label: "Tag 'wholesale'", price: 7 })
  })

  it('should respect tag price minQuantity threshold', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ tag: 'loyal', price: 8, minQuantity: 10 }],
    })

    // Below threshold
    const result1 = await resolvePrice(String(org._id), String(product._id), String(contact._id), 5)
    expect(result1.finalPrice).toBe(10)
    expect(result1.steps).toHaveLength(1)

    // At threshold
    const result2 = await resolvePrice(String(org._id), String(product._id), String(contact._id), 10)
    expect(result2.finalPrice).toBe(8)
    expect(result2.steps).toHaveLength(2)
  })

  it('should respect tag price date validity', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal'] })

    const past = new Date('2020-01-01')
    const future = new Date('2030-12-31')

    // Expired tag price
    const product1 = await createTestProduct(org._id, {
      sku: 'expired',
      sellingPrice: 10,
      tagPrices: [{ tag: 'loyal', price: 8, validTo: past }],
    })

    const result1 = await resolvePrice(String(org._id), String(product1._id), String(contact._id))
    expect(result1.finalPrice).toBe(10)

    // Valid tag price
    const product2 = await createTestProduct(org._id, {
      sku: 'valid',
      sellingPrice: 10,
      tagPrices: [{ tag: 'loyal', price: 8, validFrom: past, validTo: future }],
    })

    const result2 = await resolvePrice(String(org._id), String(product2._id), String(contact._id))
    expect(result2.finalPrice).toBe(8)
  })

  it('should let contact custom price override tag price', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ tag: 'loyal', price: 8 }],
      customPrices: [{ contactId: contact._id, price: 7 }],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(7)
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0]).toEqual({ type: 'base', label: 'Selling price', price: 10 })
    expect(result.steps[1]).toEqual({ type: 'tag', label: "Tag 'loyal'", price: 8 })
    expect(result.steps[2]).toEqual({ type: 'contact', label: 'Contact custom price', price: 7 })
  })

  it('should return base price when contact has no tags and no custom price', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: [] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ tag: 'loyal', price: 8 }],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(10)
    expect(result.steps).toHaveLength(1)
  })

  it('should not apply custom price for different contact', async () => {
    const org = await createTestOrg()
    const contact1 = await createTestContact(org._id, { email: 'one@test.com' })
    const contact2 = await createTestContact(org._id, { email: 'two@test.com' })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      customPrices: [{ contactId: contact1._id, price: 7 }],
    })

    // Contact 1 should get custom price
    const result1 = await resolvePrice(String(org._id), String(product._id), String(contact1._id))
    expect(result1.finalPrice).toBe(7)

    // Contact 2 should get base price
    const result2 = await resolvePrice(String(org._id), String(product._id), String(contact2._id))
    expect(result2.finalPrice).toBe(10)
  })

  it('should handle product with both tag and custom prices selecting best', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['wholesale'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 100,
      tagPrices: [
        { tag: 'wholesale', price: 80 },
      ],
      customPrices: [
        { contactId: contact._id, price: 75 },
      ],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(75)
    expect(result.steps).toHaveLength(3)
    // Full chain: base → tag → contact
    expect(result.steps.map(s => s.type)).toEqual(['base', 'tag', 'contact'])
    expect(result.steps.map(s => s.price)).toEqual([100, 80, 75])
  })

  it('should throw for non-existent product', async () => {
    const org = await createTestOrg()

    await expect(
      resolvePrice(String(org._id), '000000000000000000000000'),
    ).rejects.toThrow('Product not found')
  })
})
