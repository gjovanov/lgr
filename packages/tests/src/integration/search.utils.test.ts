import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestContact } from '../helpers/factories'
import { buildSearchFilter } from 'services/biz/search.utils'
import { Product, Contact } from 'db/models'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('buildSearchFilter', () => {
  it('returns empty object for empty search', () => {
    expect(buildSearchFilter('', ['name'])).toEqual({})
    expect(buildSearchFilter('   ', ['name'])).toEqual({})
  })

  it('returns empty object for empty fields', () => {
    expect(buildSearchFilter('test', [])).toEqual({})
  })

  it('builds single-keyword $or filter', () => {
    const filter = buildSearchFilter('bolt', ['name', 'sku'])
    expect(filter.$or).toHaveLength(2)
    expect(filter.$or[0]).toEqual({ name: { $regex: 'bolt', $options: 'i' } })
    expect(filter.$or[1]).toEqual({ sku: { $regex: 'bolt', $options: 'i' } })
  })

  it('builds multi-keyword $and filter', () => {
    const filter = buildSearchFilter('bolt stainless', ['name', 'sku'])
    expect(filter.$and).toHaveLength(2)
    expect(filter.$and[0].$or).toHaveLength(2)
    expect(filter.$and[1].$or).toHaveLength(2)
  })

  it('escapes regex special characters', () => {
    const filter = buildSearchFilter('M8*10', ['name'])
    expect(filter.$or[0].name.$regex).toBe('M8\\*10')
  })

  it('uses $text when hasTextIndex and all full words', () => {
    const filter = buildSearchFilter('bolt stainless', ['name'], { hasTextIndex: true })
    expect(filter.$text).toBeDefined()
    expect(filter.$text.$search).toBe('bolt stainless')
  })

  it('falls back to $regex for short keywords even with text index', () => {
    const filter = buildSearchFilter('bo', ['name'], { hasTextIndex: true })
    expect(filter.$text).toBeUndefined()
    expect(filter.$or).toBeDefined()
  })

  it('falls back to $regex for regex metacharacters even with text index', () => {
    const filter = buildSearchFilter('M8*10', ['name'], { hasTextIndex: true })
    expect(filter.$text).toBeUndefined()
    expect(filter.$or).toBeDefined()
  })
})

describe('Search with MongoDB', () => {
  it('finds products by partial name (case-insensitive)', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { sku: 'A1', name: 'Stainless Steel Bolt M8' })
    await createTestProduct(org._id, { sku: 'A2', name: 'Galvanized Nut M10' })
    await createTestProduct(org._id, { sku: 'A3', name: 'Carbon Steel Washer' })

    const filter = { orgId: org._id, ...buildSearchFilter('stainless', ['name', 'sku', 'description']) }
    const results = await Product.find(filter).lean()
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('Stainless Steel Bolt M8')
  })

  it('finds products by partial SKU', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { sku: 'DIN-1481-M8', name: 'Spring Pin' })
    await createTestProduct(org._id, { sku: 'DIN-1481-M10', name: 'Spring Pin Large' })
    await createTestProduct(org._id, { sku: 'ISO-4762-M8', name: 'Socket Head Screw' })

    const filter = { orgId: org._id, ...buildSearchFilter('DIN-1481', ['name', 'sku']) }
    const results = await Product.find(filter).lean()
    expect(results).toHaveLength(2)
  })

  it('multi-keyword AND: all keywords must match', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { sku: 'B1', name: 'Stainless Steel Bolt' })
    await createTestProduct(org._id, { sku: 'B2', name: 'Carbon Steel Bolt' })
    await createTestProduct(org._id, { sku: 'B3', name: 'Stainless Steel Nut' })

    const filter = { orgId: org._id, ...buildSearchFilter('stainless bolt', ['name', 'sku']) }
    const results = await Product.find(filter).lean()
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('Stainless Steel Bolt')
  })

  it('case-insensitive: finds regardless of case', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { sku: 'C1', name: 'UPPERCASE PRODUCT' })

    const filter = { orgId: org._id, ...buildSearchFilter('uppercase', ['name']) }
    const results = await Product.find(filter).lean()
    expect(results).toHaveLength(1)
  })

  it('finds contacts across multiple fields', async () => {
    const org = await createTestOrg()
    await createTestContact(org._id, { companyName: 'Venusart e.U.', email: 'info@venusart.at' })
    await createTestContact(org._id, { companyName: 'Other Corp', email: 'other@test.com' })

    // Search by partial company name
    const filter1 = { orgId: org._id, ...buildSearchFilter('venus', ['companyName', 'firstName', 'lastName', 'email']) }
    const r1 = await Contact.find(filter1).lean()
    expect(r1).toHaveLength(1)

    // Search by email domain
    const filter2 = { orgId: org._id, ...buildSearchFilter('venusart.at', ['companyName', 'firstName', 'lastName', 'email']) }
    const r2 = await Contact.find(filter2).lean()
    expect(r2).toHaveLength(1)
  })

  it('$text search works for full words on products (text index exists)', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { sku: 'T1', name: 'Stainless Steel Bolt' })
    await createTestProduct(org._id, { sku: 'T2', name: 'Carbon Steel Nut' })

    // $text search — "stainless" is a full word, matches via text index
    const filter = { orgId: org._id, ...buildSearchFilter('stainless', ['name'], { hasTextIndex: true }) }
    const results = await Product.find(filter).lean()
    expect(results).toHaveLength(1)
  })
})
