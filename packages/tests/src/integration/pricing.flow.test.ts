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
      tagPrices: [{ name: 'Loyal discount', tag: 'loyal', price: 8 }],
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
      tagPrices: [{ name: 'Loyal discount', tag: 'loyal', price: 8 }],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(8)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]).toEqual({ type: 'base', label: 'Selling price', price: 10 })
    expect(result.steps[1]).toEqual({ type: 'tag', label: 'Loyal discount', price: 8 })
  })

  it('should pick lowest tag price when multiple tags match', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal', 'wholesale'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [
        { name: 'Loyal discount', tag: 'loyal', price: 8 },
        { name: 'Wholesale rate', tag: 'wholesale', price: 7 },
      ],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(7)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[1]).toEqual({ type: 'tag', label: 'Wholesale rate', price: 7 })
  })

  it('should respect tag price minQuantity threshold', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ name: 'Loyal bulk', tag: 'loyal', price: 8, minQuantity: 10 }],
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
      tagPrices: [{ name: 'Expired loyal', tag: 'loyal', price: 8, validTo: past }],
    })

    const result1 = await resolvePrice(String(org._id), String(product1._id), String(contact._id))
    expect(result1.finalPrice).toBe(10)

    // Valid tag price
    const product2 = await createTestProduct(org._id, {
      sku: 'valid',
      sellingPrice: 10,
      tagPrices: [{ name: 'Valid loyal', tag: 'loyal', price: 8, validFrom: past, validTo: future }],
    })

    const result2 = await resolvePrice(String(org._id), String(product2._id), String(contact._id))
    expect(result2.finalPrice).toBe(8)
  })

  it('should let contact custom price override tag price', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ name: 'Loyal discount', tag: 'loyal', price: 8 }],
      customPrices: [{ name: 'VIP deal', contactId: contact._id, price: 7 }],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(7)
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0]).toEqual({ type: 'base', label: 'Selling price', price: 10 })
    expect(result.steps[1]).toEqual({ type: 'tag', label: 'Loyal discount', price: 8 })
    expect(result.steps[2]).toEqual({ type: 'contact', label: 'VIP deal', price: 7 })
  })

  it('should return base price when contact has no tags and no custom price', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: [] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ name: 'Loyal discount', tag: 'loyal', price: 8 }],
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
      customPrices: [{ name: 'Contact 1 special', contactId: contact1._id, price: 7 }],
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
        { name: 'Wholesale rate', tag: 'wholesale', price: 80 },
      ],
      customPrices: [
        { name: 'Partner deal', contactId: contact._id, price: 75 },
      ],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(75)
    expect(result.steps).toHaveLength(3)
    // Full chain: base → tag → contact
    expect(result.steps.map(s => s.type)).toEqual(['base', 'tag', 'contact'])
    expect(result.steps.map(s => s.price)).toEqual([100, 80, 75])
    expect(result.steps.map(s => s.label)).toEqual(['Selling price', 'Wholesale rate', 'Partner deal'])
  })

  it('should throw for non-existent product', async () => {
    const org = await createTestOrg()

    await expect(
      resolvePrice(String(org._id), '000000000000000000000000'),
    ).rejects.toThrow('Product not found')
  })

  it('should use name as label in price steps', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ name: 'Loyalty Program 10%', tag: 'loyal', price: 9 }],
      customPrices: [{ name: 'Annual Contract Rate', contactId: contact._id, price: 8.5 }],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.steps[1].label).toBe('Loyalty Program 10%')
    expect(result.steps[2].label).toBe('Annual Contract Rate')
  })

  it('should persist and return name on tag and custom prices', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['loyal'] })
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      tagPrices: [{ name: 'Summer Loyalty', tag: 'loyal', price: 8 }],
      customPrices: [{ name: 'Preferred Rate', contactId: contact._id, price: 7 }],
    })

    // Verify names are persisted on the product
    const loaded = await Product.findById(product._id).lean()
    expect(loaded!.tagPrices[0].name).toBe('Summer Loyalty')
    expect(loaded!.customPrices[0].name).toBe('Preferred Rate')

    // Verify names appear in price resolution labels
    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))
    expect(result.steps[1].label).toBe('Summer Loyalty')
    expect(result.steps[2].label).toBe('Preferred Rate')
  })
})

describe('Real-World Scenario: Product with tag prices, contact with matching tag', () => {
  it('should resolve "high volume" tag price for Venusart contact', async () => {
    const org = await createTestOrg()

    // Simulate: product "Rozi Test" with two tag-based custom prices
    const product = await createTestProduct(org._id, {
      name: 'Rozi Test',
      sellingPrice: 100,
      tagPrices: [
        { name: 'Price1', tag: 'loyal', price: 80 },
        { name: 'Price2', tag: 'high volume', price: 70 },
      ],
    })

    // Simulate: contact "Venusart e.U." with tag 'high volume'
    const contact = await createTestContact(org._id, {
      companyName: 'Venusart e.U.',
      tags: ['high volume'],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(70)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]).toEqual({ type: 'base', label: 'Selling price', price: 100 })
    expect(result.steps[1]).toEqual({ type: 'tag', label: 'Price2', price: 70 })
  })

  it('should resolve "loyal" tag price for a loyal contact on the same product', async () => {
    const org = await createTestOrg()

    const product = await createTestProduct(org._id, {
      name: 'Rozi Test',
      sellingPrice: 100,
      tagPrices: [
        { name: 'Price1', tag: 'loyal', price: 80 },
        { name: 'Price2', tag: 'high volume', price: 70 },
      ],
    })

    const loyalContact = await createTestContact(org._id, {
      companyName: 'Loyal Corp',
      tags: ['loyal'],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(loyalContact._id))

    expect(result.finalPrice).toBe(80)
    expect(result.steps[1]).toEqual({ type: 'tag', label: 'Price1', price: 80 })
  })

  it('should pick lowest when contact has both "loyal" and "high volume" tags', async () => {
    const org = await createTestOrg()

    const product = await createTestProduct(org._id, {
      name: 'Rozi Test',
      sellingPrice: 100,
      tagPrices: [
        { name: 'Price1', tag: 'loyal', price: 80 },
        { name: 'Price2', tag: 'high volume', price: 70 },
      ],
    })

    const dualTagContact = await createTestContact(org._id, {
      companyName: 'Both Tags Corp',
      tags: ['loyal', 'high volume'],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(dualTagContact._id))

    // Should pick the lowest: 70 (high volume)
    expect(result.finalPrice).toBe(70)
    expect(result.steps[1]).toEqual({ type: 'tag', label: 'Price2', price: 70 })
  })

  it('should return base price for contact with no matching tags', async () => {
    const org = await createTestOrg()

    const product = await createTestProduct(org._id, {
      name: 'Rozi Test',
      sellingPrice: 100,
      tagPrices: [
        { name: 'Price1', tag: 'loyal', price: 80 },
        { name: 'Price2', tag: 'high volume', price: 70 },
      ],
    })

    const noTagContact = await createTestContact(org._id, {
      companyName: 'Regular Corp',
      tags: [],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(noTagContact._id))

    expect(result.finalPrice).toBe(100)
    expect(result.steps).toHaveLength(1)
  })

  it('should let contact-specific custom price override tag price', async () => {
    const org = await createTestOrg()

    const contact = await createTestContact(org._id, {
      companyName: 'Venusart e.U.',
      tags: ['high volume'],
    })

    // Product has both a tag price AND a contact-specific price
    const product = await createTestProduct(org._id, {
      name: 'Rozi Test',
      sellingPrice: 100,
      tagPrices: [
        { name: 'Price2', tag: 'high volume', price: 70 },
      ],
      customPrices: [
        { name: 'Venusart Special', contactId: contact._id, price: 65 },
      ],
    })

    const result = await resolvePrice(String(org._id), String(product._id), String(contact._id))

    expect(result.finalPrice).toBe(65)
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0].label).toBe('Selling price')
    expect(result.steps[1].label).toBe('Price2')
    expect(result.steps[2].label).toBe('Venusart Special')
  })
})
