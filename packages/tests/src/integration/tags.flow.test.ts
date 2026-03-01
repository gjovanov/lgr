import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestTag, createTestProduct, createTestContact, createTestWarehouse, createTestEmployee, createTestLead, createTestDeal, createTestPipeline } from '../helpers/factories'
import { Tag, Product, Contact, Warehouse, Employee, Lead, Deal } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Tag CRUD', () => {
  it('should create a tag', async () => {
    const org = await createTestOrg()
    const tag = await createTestTag(org._id, { type: 'product', value: 'electronics' })

    expect(tag).toBeDefined()
    expect(tag.type).toBe('product')
    expect(tag.value).toBe('electronics')
    expect(String(tag.orgId)).toBe(String(org._id))
  })

  it('should enforce unique constraint on orgId + type + value', async () => {
    const org = await createTestOrg()
    await createTestTag(org._id, { type: 'product', value: 'electronics' })

    // Second create with same key should either throw or be silently rejected
    try {
      await createTestTag(org._id, { type: 'product', value: 'electronics' })
    } catch {
      // expected: duplicate key error
    }

    // Regardless of throw, only one tag should exist
    const count = await Tag.countDocuments({ orgId: org._id, type: 'product', value: 'electronics' })
    expect(count).toBe(1)
  })

  it('should allow same value for different types', async () => {
    const org = await createTestOrg()
    const tag1 = await createTestTag(org._id, { type: 'product', value: 'premium' })
    const tag2 = await createTestTag(org._id, { type: 'contact', value: 'premium' })

    expect(tag1).toBeDefined()
    expect(tag2).toBeDefined()
    expect(tag1.type).toBe('product')
    expect(tag2.type).toBe('contact')
  })

  it('should allow same value for different orgs', async () => {
    const org1 = await createTestOrg()
    const org2 = await createTestOrg()
    const tag1 = await createTestTag(org1._id, { type: 'product', value: 'electronics' })
    const tag2 = await createTestTag(org2._id, { type: 'product', value: 'electronics' })

    expect(tag1).toBeDefined()
    expect(tag2).toBeDefined()
  })

  it('should rename a tag and update all product references', async () => {
    const org = await createTestOrg()
    const tag = await createTestTag(org._id, { type: 'product', value: 'electronics' })

    // Create products with this tag
    const p1 = await createTestProduct(org._id, { tags: ['electronics', 'gadgets'] })
    const p2 = await createTestProduct(org._id, { tags: ['electronics'] })
    const p3 = await createTestProduct(org._id, { tags: ['furniture'] })

    // Rename the tag
    const oldValue = tag.value
    tag.value = 'electronics-v2'
    await tag.save()

    // Update all products that had the old tag
    await Product.updateMany(
      { orgId: org._id, tags: oldValue },
      { $set: { 'tags.$[elem]': 'electronics-v2' } },
      { arrayFilters: [{ elem: oldValue }] },
    )

    // Verify
    const updated1 = await Product.findById(p1._id)
    const updated2 = await Product.findById(p2._id)
    const updated3 = await Product.findById(p3._id)

    expect(updated1!.tags).toContain('electronics-v2')
    expect(updated1!.tags).toContain('gadgets')
    expect(updated1!.tags).not.toContain('electronics')
    expect(updated2!.tags).toContain('electronics-v2')
    expect(updated3!.tags).toContain('furniture')
    expect(updated3!.tags).not.toContain('electronics-v2')
  })

  it('should delete a tag and remove from all products', async () => {
    const org = await createTestOrg()
    await createTestTag(org._id, { type: 'product', value: 'to-delete' })

    const p1 = await createTestProduct(org._id, { tags: ['to-delete', 'keep-me'] })
    const p2 = await createTestProduct(org._id, { tags: ['to-delete'] })

    // Remove from all products
    await Product.updateMany(
      { orgId: org._id, tags: 'to-delete' },
      { $pull: { tags: 'to-delete' } },
    )
    await Tag.deleteOne({ orgId: org._id, type: 'product', value: 'to-delete' })

    const updated1 = await Product.findById(p1._id)
    const updated2 = await Product.findById(p2._id)
    const tagCount = await Tag.countDocuments({ orgId: org._id, type: 'product', value: 'to-delete' })

    expect(tagCount).toBe(0)
    expect(updated1!.tags).toContain('keep-me')
    expect(updated1!.tags).not.toContain('to-delete')
    expect(updated2!.tags).toHaveLength(0)
  })
})

describe('Tag Auto-Creation on Entity Save', () => {
  it('should auto-create tag documents when product is saved with new tags', async () => {
    const org = await createTestOrg()

    // Create product with tags
    await createTestProduct(org._id, { tags: ['new-tag-1', 'new-tag-2'] })

    // Simulate the upsert pattern used in controllers
    const tags = ['new-tag-1', 'new-tag-2']
    await Tag.bulkWrite(
      tags.map((value) => ({
        updateOne: {
          filter: { orgId: org._id, type: 'product', value },
          update: { $setOnInsert: { orgId: org._id, type: 'product', value } },
          upsert: true,
        },
      })),
    )

    const tagDocs = await Tag.find({ orgId: org._id, type: 'product' }).lean().exec()
    expect(tagDocs).toHaveLength(2)
    expect(tagDocs.map((t: any) => t.value).sort()).toEqual(['new-tag-1', 'new-tag-2'])
  })

  it('should not duplicate tags on upsert', async () => {
    const org = await createTestOrg()

    // Create existing tag
    await createTestTag(org._id, { type: 'product', value: 'existing-tag' })

    // Upsert with same tag
    await Tag.bulkWrite([
      {
        updateOne: {
          filter: { orgId: org._id, type: 'product', value: 'existing-tag' },
          update: { $setOnInsert: { orgId: org._id, type: 'product', value: 'existing-tag' } },
          upsert: true,
        },
      },
    ])

    const tagCount = await Tag.countDocuments({ orgId: org._id, type: 'product', value: 'existing-tag' })
    expect(tagCount).toBe(1)
  })
})

describe('Tag Search', () => {
  it('should search tags by partial value (case-insensitive)', async () => {
    const org = await createTestOrg()
    await createTestTag(org._id, { type: 'product', value: 'electronics' })
    await createTestTag(org._id, { type: 'product', value: 'electrical' })
    await createTestTag(org._id, { type: 'product', value: 'furniture' })
    await createTestTag(org._id, { type: 'product', value: 'ELECTRO-parts' })

    const results = await Tag.find({
      orgId: org._id,
      type: 'product',
      value: { $regex: 'elec', $options: 'i' },
    }).sort({ value: 1 }).lean().exec()

    expect(results).toHaveLength(3)
    expect(results.map((t: any) => t.value)).toEqual(['ELECTRO-parts', 'electrical', 'electronics'])
  })

  it('should filter tags by type', async () => {
    const org = await createTestOrg()
    await createTestTag(org._id, { type: 'product', value: 'tag-a' })
    await createTestTag(org._id, { type: 'product', value: 'tag-b' })
    await createTestTag(org._id, { type: 'contact', value: 'tag-c' })
    await createTestTag(org._id, { type: 'lead', value: 'tag-d' })

    const productTags = await Tag.find({ orgId: org._id, type: 'product' }).lean().exec()
    const contactTags = await Tag.find({ orgId: org._id, type: 'contact' }).lean().exec()
    const leadTags = await Tag.find({ orgId: org._id, type: 'lead' }).lean().exec()

    expect(productTags).toHaveLength(2)
    expect(contactTags).toHaveLength(1)
    expect(leadTags).toHaveLength(1)
  })
})

describe('Tag Filtering on Entities', () => {
  it('should filter products by single tag', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { tags: ['electronics', 'premium'] })
    await createTestProduct(org._id, { tags: ['electronics'] })
    await createTestProduct(org._id, { tags: ['furniture'] })

    const filter: Record<string, any> = { orgId: org._id, tags: { $in: ['electronics'] } }
    const result = await paginateQuery(Product, filter, { page: 0, size: 10 })

    expect(result.total).toBe(2)
  })

  it('should filter products by multiple tags (ANY match)', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { tags: ['electronics'] })
    await createTestProduct(org._id, { tags: ['furniture'] })
    await createTestProduct(org._id, { tags: ['clothing'] })

    const filter: Record<string, any> = { orgId: org._id, tags: { $in: ['electronics', 'furniture'] } }
    const result = await paginateQuery(Product, filter, { page: 0, size: 10 })

    expect(result.total).toBe(2)
  })

  it('should filter contacts by tags', async () => {
    const org = await createTestOrg()
    await createTestContact(org._id, { tags: ['vip', 'enterprise'] })
    await createTestContact(org._id, { tags: ['vip'] })
    await createTestContact(org._id, { tags: ['small-business'] })

    const filter: Record<string, any> = { orgId: org._id, tags: { $in: ['vip'] } }
    const result = await paginateQuery(Contact, filter, { page: 0, size: 10 })

    expect(result.total).toBe(2)
  })

  it('should filter leads by tags', async () => {
    const org = await createTestOrg()
    await createTestLead(org._id, { tags: ['hot-lead', 'inbound'] })
    await createTestLead(org._id, { tags: ['cold-lead'] })

    const filter: Record<string, any> = { orgId: org._id, tags: { $in: ['hot-lead'] } }
    const result = await paginateQuery(Lead, filter, { page: 0, size: 10 })

    expect(result.total).toBe(1)
  })

  it('should filter deals by tags', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const pipeline = await createTestPipeline(org._id)
    await createTestDeal(org._id, contact._id, pipeline._id, { tags: ['high-value'] })
    await createTestDeal(org._id, contact._id, pipeline._id, { tags: ['low-value'] })

    const filter: Record<string, any> = { orgId: org._id, tags: { $in: ['high-value'] } }
    const result = await paginateQuery(Deal, filter, { page: 0, size: 10 })

    expect(result.total).toBe(1)
  })

  it('should filter employees by tags', async () => {
    const org = await createTestOrg()
    await createTestEmployee(org._id, { tags: ['remote', 'senior'] })
    await createTestEmployee(org._id, { tags: ['office'] })

    const filter: Record<string, any> = { orgId: org._id, tags: { $in: ['remote'] } }
    const result = await paginateQuery(Employee, filter, { page: 0, size: 10 })

    expect(result.total).toBe(1)
  })

  it('should return all items when no tag filter applied', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { tags: ['electronics'] })
    await createTestProduct(org._id, { tags: ['furniture'] })
    await createTestProduct(org._id, { tags: [] })

    const filter: Record<string, any> = { orgId: org._id }
    const result = await paginateQuery(Product, filter, { page: 0, size: 10 })

    expect(result.total).toBe(3)
  })
})

describe('Tag Type Scoping', () => {
  it('should scope tags by type - product tags not visible in contact queries', async () => {
    const org = await createTestOrg()
    await createTestTag(org._id, { type: 'product', value: 'product-only' })
    await createTestTag(org._id, { type: 'contact', value: 'contact-only' })

    const productTags = await Tag.find({ orgId: org._id, type: 'product' }).lean().exec()
    const contactTags = await Tag.find({ orgId: org._id, type: 'contact' }).lean().exec()

    expect(productTags.map((t: any) => t.value)).toContain('product-only')
    expect(productTags.map((t: any) => t.value)).not.toContain('contact-only')
    expect(contactTags.map((t: any) => t.value)).toContain('contact-only')
    expect(contactTags.map((t: any) => t.value)).not.toContain('product-only')
  })
})

describe('Tag Multi-Tenancy', () => {
  it('should isolate tags between organizations', async () => {
    const org1 = await createTestOrg()
    const org2 = await createTestOrg()

    await createTestTag(org1._id, { type: 'product', value: 'org1-tag' })
    await createTestTag(org2._id, { type: 'product', value: 'org2-tag' })

    const org1Tags = await Tag.find({ orgId: org1._id }).lean().exec()
    const org2Tags = await Tag.find({ orgId: org2._id }).lean().exec()

    expect(org1Tags).toHaveLength(1)
    expect(org1Tags[0].value).toBe('org1-tag')
    expect(org2Tags).toHaveLength(1)
    expect(org2Tags[0].value).toBe('org2-tag')
  })

  it('should not leak entity tags across organizations', async () => {
    const org1 = await createTestOrg()
    const org2 = await createTestOrg()

    await createTestProduct(org1._id, { tags: ['secret-tag'] })
    await createTestProduct(org2._id, { tags: ['other-tag'] })

    const org1Products = await Product.find({ orgId: org1._id, tags: { $in: ['secret-tag'] } }).lean().exec()
    const org2Products = await Product.find({ orgId: org2._id, tags: { $in: ['secret-tag'] } }).lean().exec()

    expect(org1Products).toHaveLength(1)
    expect(org2Products).toHaveLength(0)
  })
})

describe('Tag Rename Propagation Across Entity Types', () => {
  it('should rename contact tag and update all contacts', async () => {
    const org = await createTestOrg()
    await createTestTag(org._id, { type: 'contact', value: 'vip' })
    await createTestContact(org._id, { tags: ['vip', 'enterprise'] })
    await createTestContact(org._id, { tags: ['vip'] })

    // Rename
    await Tag.updateOne({ orgId: org._id, type: 'contact', value: 'vip' }, { $set: { value: 'premium' } })
    await Contact.updateMany(
      { orgId: org._id, tags: 'vip' },
      { $set: { 'tags.$[elem]': 'premium' } },
      { arrayFilters: [{ elem: 'vip' }] },
    )

    const contacts = await Contact.find({ orgId: org._id }).lean().exec()
    for (const c of contacts) {
      expect(c.tags).not.toContain('vip')
      expect(c.tags).toContain('premium')
    }
  })

  it('should delete warehouse tag and remove from all warehouses', async () => {
    const org = await createTestOrg()
    await createTestTag(org._id, { type: 'warehouse', value: 'cold-storage' })
    await createTestWarehouse(org._id, { tags: ['cold-storage', 'primary'] })
    await createTestWarehouse(org._id, { tags: ['cold-storage'] })

    await Warehouse.updateMany(
      { orgId: org._id, tags: 'cold-storage' },
      { $pull: { tags: 'cold-storage' } },
    )
    await Tag.deleteOne({ orgId: org._id, type: 'warehouse', value: 'cold-storage' })

    const warehouses = await Warehouse.find({ orgId: org._id }).lean().exec()
    for (const w of warehouses) {
      expect(w.tags).not.toContain('cold-storage')
    }
    const tagCount = await Tag.countDocuments({ orgId: org._id, type: 'warehouse', value: 'cold-storage' })
    expect(tagCount).toBe(0)
  })
})
