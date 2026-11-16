import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestContact, createTestWarehouse } from '../helpers/factories'
import { buildSearchFilter } from 'services/biz/search.utils'
import { Product, Contact, Warehouse } from 'db/models'

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
    await createTestContact(org._id, { companyName: 'Тестарт ЕООД' })
    await createTestContact(org._id, { companyName: 'Other Corp' })

    const filter = {
      orgId: org._id,
      ...buildSearchFilter('тестарт', ['companyName'], { lowered: { companyName: 'companyNameLower' } }),
    }
    const results = await Contact.find(filter).lean()
    expect(results).toHaveLength(1)
    expect(results[0].companyName).toBe('Тестарт ЕООД')
  })
})

/**
 * #759. A mirror follows its source wherever an update gives the source its value. Product, Contact and Warehouse
 * all have `timestamps: true`, and that is what hid a field named at the top level: Mongoose has already put a
 * `$set` of its own (the `updatedAt`) into the update when the plugin's hook runs, so reading "`$set`, or else the
 * update itself" never looked at the top level, and the search kept reading the old text.
 */
describe('a mirror follows its source wherever an update names it (#759)', () => {
  it('updateOne, the field at the top level', async () => {
    const org = await createTestOrg()
    const p = await createTestProduct(org._id, { sku: 'T-1', name: 'Гайка' })
    await Product.updateOne({ _id: p._id }, { name: 'ВИНТ' })
    const after = await Product.findById(p._id).lean()
    expect([after?.name, after?.nameLower]).toEqual(['ВИНТ', 'винт'])
  })

  it('findOneAndUpdate, the field at the top level', async () => {
    const org = await createTestOrg()
    const p = await createTestProduct(org._id, { sku: 'T-2', name: 'Гайка' })
    const after = await Product.findOneAndUpdate({ _id: p._id }, { name: 'ШАЙБА' }, { new: true }).lean()
    expect([after?.name, after?.nameLower]).toEqual(['ШАЙБА', 'шайба'])
  })

  it("the repository's by-id update, which sends its fields at the top level", async () => {
    const org = await createTestOrg()
    const p = await createTestProduct(org._id, { sku: 'T-3', name: 'Гайка' })
    const { getRepos } = await import('services/context')
    await getRepos().products.update(String(p._id), { name: 'БОЛТ', category: 'Крепежи' } as any)
    const after = await Product.findById(p._id).lean()
    expect([after?.nameLower, after?.categoryLower]).toEqual(['болт', 'крепежи'])
  })

  it('updateMany, the field at the top level', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { sku: 'T-4', name: 'Първи' })
    await createTestProduct(org._id, { sku: 'T-5', name: 'Втори' })
    await Product.updateMany({ orgId: org._id }, { category: 'БОЛТОВЕ' })
    const after = await Product.find({ orgId: org._id }).lean()
    expect(after.map((p) => p.categoryLower)).toEqual(['болтове', 'болтове'])
  })

  it('one field at the top level and another under $set, in one update', async () => {
    const org = await createTestOrg()
    const w = await createTestWarehouse(org._id, { name: 'Склад', code: 'WH-A' })
    await Warehouse.updateOne({ _id: w._id }, { name: 'ИЗТОК', $set: { code: 'WH-Б' } })
    const after = await Warehouse.findById(w._id).lean()
    expect([after?.nameLower, after?.codeLower]).toEqual(['изток', 'wh-б'])
  })

  it('a list at the top level is mirrored entry by entry', async () => {
    const org = await createTestOrg()
    const c = await createTestContact(org._id, { companyName: 'Керамика ЕООД' })
    await Contact.updateOne({ _id: c._id }, { aliases: ['КЕРАМИКА-1', 'Keramika'] })
    const after = await Contact.findById(c._id).lean()
    expect(after?.aliasesLower).toEqual(['керамика-1', 'keramika'])
  })

  it('the search finds the document by its new name, and no longer by the old one', async () => {
    const org = await createTestOrg()
    const c = await createTestContact(org._id, { companyName: 'Стара Фирма' })
    await Contact.findOneAndUpdate({ _id: c._id }, { companyName: 'Нова Фирма' })
    const by = (term: string) =>
      Contact.find({ orgId: org._id, ...buildSearchFilter(term, ['companyName'], { lowered: { companyName: 'companyNameLower' } }) }).lean()
    expect((await by('нова')).map((r) => r.companyName)).toEqual(['Нова Фирма'])
    expect(await by('стара')).toEqual([])
  })

  it('$setOnInsert: a document an upsert makes has its mirror', async () => {
    const org = await createTestOrg()
    await Warehouse.updateOne({ orgId: org._id, code: 'WH-NEW' }, { $setOnInsert: { name: 'Нов Склад' } }, { upsert: true })
    const made = await Warehouse.findOne({ orgId: org._id, code: 'WH-NEW' }).lean()
    expect([made?.name, made?.nameLower]).toEqual(['Нов Склад', 'нов склад'])
  })

  it('$unset of a source removes its mirror', async () => {
    const org = await createTestOrg()
    const c = await createTestContact(org._id, { companyName: 'Фирма', representative: 'Иван Петров' })
    expect((await Contact.findById(c._id).lean())?.representativeLower).toBe('иван петров')
    await Contact.updateOne({ _id: c._id }, { $unset: { representative: 1 } })
    const after = await Contact.findById(c._id).lean()
    expect([after?.representative, after?.representativeLower]).toEqual([undefined, undefined])
  })

  it('a source set to null empties its mirror', async () => {
    const org = await createTestOrg()
    const c = await createTestContact(org._id, { companyName: 'Фирма', email: 'Office@Firma.BG' })
    expect((await Contact.findById(c._id).lean())?.emailLower).toBe('office@firma.bg')
    await Contact.updateOne({ _id: c._id }, { $set: { email: null } })
    const after = await Contact.findById(c._id).lean()
    expect([after?.email, after?.emailLower]).toEqual([null, null])
  })

  it('an update that names no source leaves the mirrors as they are', async () => {
    const org = await createTestOrg()
    const p = await createTestProduct(org._id, { sku: 'T-9', name: 'Гайка' })
    await Product.updateOne({ _id: p._id }, { sellingPrice: 7, $set: { purchasePrice: 3 } })
    const after = await Product.findById(p._id).lean()
    expect([after?.sellingPrice, after?.purchasePrice, after?.nameLower, after?.skuLower]).toEqual([7, 3, 'гайка', 't-9'])
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
