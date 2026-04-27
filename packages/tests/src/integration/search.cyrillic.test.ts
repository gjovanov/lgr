import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestContact } from '../helpers/factories'
import { buildSearchFilter } from 'services/biz/search.utils'
import { Product, Contact } from 'db/models'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('Cyrillic case-insensitive search via lowered mirror fields', () => {
  it('finds product "ЩИФТ" when searching with mixed-case Cyrillic input', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { sku: 'BG-1', name: 'ЩИФТ M8x20' })
    await createTestProduct(org._id, { sku: 'BG-2', name: 'Винт M10' })

    const fieldsMap = { name: 'nameLower', sku: 'skuLower' }

    for (const term of ['щифт', 'ЩИФТ', 'щиФТ', 'ЩифТ']) {
      const filter = { orgId: org._id, ...buildSearchFilter(term, ['name', 'sku'], { lowered: fieldsMap }) }
      const results = await Product.find(filter).lean()
      expect(results.map(r => r.name)).toEqual(['ЩИФТ M8x20'])
    }
  })

  it('maintains nameLower automatically on save and update', async () => {
    const org = await createTestOrg()
    const p = await createTestProduct(org._id, { sku: 'X-1', name: 'Гайка' })
    const fresh = await Product.findById(p._id).lean()
    expect(fresh?.nameLower).toBe('гайка')

    await Product.updateOne({ _id: p._id }, { $set: { name: 'ВИНТ' } })
    const after = await Product.findById(p._id).lean()
    expect(after?.nameLower).toBe('винт')
  })

  it('finds contact by lowercased company name', async () => {
    const org = await createTestOrg()
    await createTestContact(org._id, { companyName: 'Венусарт ЕООД' })
    await createTestContact(org._id, { companyName: 'Other Corp' })

    const filter = {
      orgId: org._id,
      ...buildSearchFilter('венусарт', ['companyName'], { lowered: { companyName: 'companyNameLower' } }),
    }
    const results = await Contact.find(filter).lean()
    expect(results).toHaveLength(1)
    expect(results[0].companyName).toBe('Венусарт ЕООД')
  })
})

describe('DAL pagination size <= 0 returns all rows', () => {
  it('product findAll with size=0 returns all rows (no 1000-cap)', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 25; i++) {
      await createTestProduct(org._id, { sku: `P-${i}`, name: `Product ${i}` })
    }

    const { getRepos } = await import('services/context')
    const result = await getRepos().products.findAll({ orgId: String(org._id) } as any, { page: 0, size: 0 })
    expect(result.items.length).toBe(25)
    expect(result.total).toBe(25)
    expect(result.totalPages).toBe(1)
  })
})
