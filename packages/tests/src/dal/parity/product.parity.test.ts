import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardownMongo, teardownSQLite, createTestOrg } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
  ['sqlite', setupSQLiteRepos, teardownSQLite],
]

for (const [name, setup, cleanup] of backends) {
  describe(`Product Repository [${name}]`, () => {
    let repos: RepositoryRegistry
    let orgId: string
    let contactId: string

    beforeAll(async () => {
      repos = await setup()
    })

    beforeEach(async () => {
      await cleanup()
      orgId = await createTestOrg(repos)

      // Create a contact for custom prices
      const contact = await repos.contacts.create({
        orgId, type: 'customer', companyName: 'Price Customer',
        paymentTermsDays: 30, isActive: true, addresses: [], bankDetails: [],
      } as any)
      contactId = contact.id
    })

    afterAll(async () => {
      // cleanup handled by process exit
    })

    function makeProduct(overrides: Record<string, any> = {}) {
      return {
        orgId,
        sku: `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: 'Test Widget',
        description: 'A test product',
        category: 'electronics',
        type: 'goods',
        unit: 'pcs',
        purchasePrice: 50,
        sellingPrice: 100,
        currency: 'EUR',
        taxRate: 18,
        trackInventory: true,
        isActive: true,
        customPrices: [],
        tagPrices: [],
        variants: [],
        ...overrides,
      } as any
    }

    test('creates product and retrieves it', async () => {
      const product = await repos.products.create(makeProduct({ name: 'Widget A' }))

      expect(product.id).toBeDefined()
      expect(product.name).toBe('Widget A')
      expect(product.purchasePrice).toBe(50)
      expect(product.sellingPrice).toBe(100)
      expect(product.trackInventory).toBe(true)

      const found = await repos.products.findById(product.id)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Widget A')
      expect(found!.sku).toBe(product.sku)
    })

    test('creates product with custom prices', async () => {
      const product = await repos.products.create(makeProduct({
        customPrices: [
          { name: 'Bulk 10+', contactId, price: 90, minQuantity: 10 },
          { name: 'Bulk 50+', contactId, price: 80, minQuantity: 50 },
        ],
      }))

      expect(product.customPrices).toHaveLength(2)
      expect(product.customPrices[0].price).toBe(90)
      expect(product.customPrices[1].price).toBe(80)

      const found = await repos.products.findById(product.id)
      expect(found!.customPrices).toHaveLength(2)
      expect(found!.customPrices[0].contactId).toBe(contactId)
    })

    test('creates product with tag prices', async () => {
      const product = await repos.products.create(makeProduct({
        tagPrices: [
          { name: 'Loyal discount', tag: 'loyal', price: 85, minQuantity: 1 },
          { name: 'Wholesale rate', tag: 'wholesale', price: 70, minQuantity: 10 },
        ],
      }))

      expect(product.tagPrices).toHaveLength(2)
      expect(product.tagPrices[0].name).toBe('Loyal discount')
      expect(product.tagPrices[0].tag).toBe('loyal')
      expect(product.tagPrices[0].price).toBe(85)
      expect(product.tagPrices[1].name).toBe('Wholesale rate')
      expect(product.tagPrices[1].tag).toBe('wholesale')
      expect(product.tagPrices[1].price).toBe(70)

      const found = await repos.products.findById(product.id)
      expect(found!.tagPrices).toHaveLength(2)
      expect(found!.tagPrices[0].name).toBe('Loyal discount')
      expect(found!.tagPrices[0].tag).toBe('loyal')
    })

    test('creates product with custom prices including name', async () => {
      const product = await repos.products.create(makeProduct({
        customPrices: [
          { name: 'VIP Rate', contactId, price: 88, minQuantity: 5 },
        ],
      }))

      expect(product.customPrices[0].name).toBe('VIP Rate')

      const found = await repos.products.findById(product.id)
      expect(found!.customPrices[0].name).toBe('VIP Rate')
    })

    test('update replaces tag prices', async () => {
      const product = await repos.products.create(makeProduct({
        tagPrices: [{ name: 'Old rate', tag: 'loyal', price: 90 }],
      }))

      const updated = await repos.products.update(product.id, {
        tagPrices: [
          { name: 'New loyal', tag: 'loyal', price: 85 },
          { name: 'New wholesale', tag: 'wholesale', price: 70 },
        ],
      } as any)

      expect(updated!.tagPrices).toHaveLength(2)
      expect(updated!.tagPrices[0].name).toBe('New loyal')
      expect(updated!.tagPrices[1].name).toBe('New wholesale')
    })

    test('creates product with variants', async () => {
      const product = await repos.products.create(makeProduct({
        variants: [
          { name: 'Small', options: ['S'] },
          { name: 'Large', options: ['L', 'XL'] },
        ],
      }))

      expect(product.variants).toHaveLength(2)
      expect(product.variants[0].name).toBe('Small')
      expect(product.variants[1].name).toBe('Large')

      const found = await repos.products.findById(product.id)
      expect(found!.variants).toHaveLength(2)
    })

    test('update replaces custom prices', async () => {
      const product = await repos.products.create(makeProduct({
        customPrices: [{ name: 'Bulk 10+', contactId, price: 90, minQuantity: 10 }],
      }))

      const updated = await repos.products.update(product.id, {
        customPrices: [
          { name: 'Bulk 5+', contactId, price: 85, minQuantity: 5 },
          { name: 'Bulk 100+', contactId, price: 75, minQuantity: 100 },
        ],
      } as any)

      expect(updated!.customPrices).toHaveLength(2)
      expect(updated!.customPrices[0].price).toBe(85)
    })

    test('update parent fields preserves children', async () => {
      const product = await repos.products.create(makeProduct({
        customPrices: [{ name: 'Bulk 10+', contactId, price: 90, minQuantity: 10 }],
        variants: [{ name: 'Red', options: ['red'] }],
      }))

      const updated = await repos.products.update(product.id, {
        name: 'Updated Widget',
        sellingPrice: 120,
      } as any)

      expect(updated!.name).toBe('Updated Widget')
      expect(updated!.sellingPrice).toBe(120)
      expect(updated!.customPrices).toHaveLength(1)
      expect(updated!.variants).toHaveLength(1)
    })

    test('unique SKU per org', async () => {
      const sku = `UNIQUE-${Date.now()}`
      await repos.products.create(makeProduct({ sku }))

      await expect(
        repos.products.create(makeProduct({ sku })),
      ).rejects.toThrow()
    })

    test('findMany by category', async () => {
      await repos.products.create(makeProduct({ sku: 'E1', category: 'electronics' }))
      await repos.products.create(makeProduct({ sku: 'E2', category: 'electronics' }))
      await repos.products.create(makeProduct({ sku: 'F1', category: 'furniture' }))

      const electronics = await repos.products.findMany({ orgId, category: 'electronics' })
      expect(electronics).toHaveLength(2)
    })

    test('findAll with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await repos.products.create(makeProduct({ sku: `PAGE-${i}`, name: `Product ${i}` }))
      }

      const page = await repos.products.findAll({ orgId }, { page: 0, size: 2, sort: { createdAt: -1 } })
      expect(page.items).toHaveLength(2)
      expect(page.total).toBe(5)
      expect(page.totalPages).toBe(3)
    })

    test('delete cascades to custom prices and variants', async () => {
      const product = await repos.products.create(makeProduct({
        customPrices: [{ name: 'Bulk 10+', contactId, price: 90, minQuantity: 10 }],
        variants: [{ name: 'Blue', options: ['blue'] }],
      }))

      expect(await repos.products.delete(product.id)).toBe(true)
      expect(await repos.products.findById(product.id)).toBeNull()
    })
  })
}
