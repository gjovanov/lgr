import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { paginateQuery } from 'services/utils/pagination'
import { Lead } from 'db/models'
import { createTestOrg, createTestLead } from '../../helpers/factories'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('paginateQuery', () => {
  it('should return default pagination (page=0, size=10)', async () => {
    const org = await createTestOrg({ slug: 'pag-default' })
    for (let i = 0; i < 15; i++) {
      await createTestLead(org._id, { contactName: `Lead ${i}` })
    }

    const result = await paginateQuery(Lead, { orgId: org._id }, {})
    expect(result.page).toBe(0)
    expect(result.size).toBe(10)
    expect(result.items).toHaveLength(10)
    expect(result.total).toBe(15)
    expect(result.totalPages).toBe(2)
  })

  it('should navigate to page 1', async () => {
    const org = await createTestOrg({ slug: 'pag-page1' })
    for (let i = 0; i < 15; i++) {
      await createTestLead(org._id, { contactName: `Lead ${i}` })
    }

    const result = await paginateQuery(Lead, { orgId: org._id }, { page: '1' })
    expect(result.page).toBe(1)
    expect(result.size).toBe(10)
    expect(result.items).toHaveLength(5)
    expect(result.total).toBe(15)
  })

  it('should respect custom size', async () => {
    const org = await createTestOrg({ slug: 'pag-custom-size' })
    for (let i = 0; i < 10; i++) {
      await createTestLead(org._id, { contactName: `Lead ${i}` })
    }

    const result = await paginateQuery(Lead, { orgId: org._id }, { size: '5' })
    expect(result.size).toBe(5)
    expect(result.items).toHaveLength(5)
    expect(result.total).toBe(10)
    expect(result.totalPages).toBe(2)
  })

  it('should return all items when size=0', async () => {
    const org = await createTestOrg({ slug: 'pag-all' })
    for (let i = 0; i < 25; i++) {
      await createTestLead(org._id, { contactName: `Lead ${i}` })
    }

    const result = await paginateQuery(Lead, { orgId: org._id }, { size: '0' })
    expect(result.size).toBe(0)
    expect(result.items).toHaveLength(25)
    expect(result.total).toBe(25)
    expect(result.totalPages).toBe(1)
  })

  it('should sort ascending by specified field', async () => {
    const org = await createTestOrg({ slug: 'pag-sort-asc' })
    await createTestLead(org._id, { contactName: 'Charlie' })
    await createTestLead(org._id, { contactName: 'Alice' })
    await createTestLead(org._id, { contactName: 'Bob' })

    const result = await paginateQuery(Lead, { orgId: org._id }, {
      sortBy: 'contactName', sortOrder: 'asc',
    })
    expect(result.items[0].contactName).toBe('Alice')
    expect(result.items[1].contactName).toBe('Bob')
    expect(result.items[2].contactName).toBe('Charlie')
  })

  it('should sort descending by specified field', async () => {
    const org = await createTestOrg({ slug: 'pag-sort-desc' })
    await createTestLead(org._id, { contactName: 'Charlie' })
    await createTestLead(org._id, { contactName: 'Alice' })
    await createTestLead(org._id, { contactName: 'Bob' })

    const result = await paginateQuery(Lead, { orgId: org._id }, {
      sortBy: 'contactName', sortOrder: 'desc',
    })
    expect(result.items[0].contactName).toBe('Charlie')
    expect(result.items[1].contactName).toBe('Bob')
    expect(result.items[2].contactName).toBe('Alice')
  })

  it('should apply filters combined with pagination', async () => {
    const org = await createTestOrg({ slug: 'pag-filter' })
    for (let i = 0; i < 8; i++) {
      await createTestLead(org._id, { status: 'new', contactName: `New ${i}` })
    }
    for (let i = 0; i < 4; i++) {
      await createTestLead(org._id, { status: 'qualified', contactName: `Qualified ${i}` })
    }

    const result = await paginateQuery(Lead, { orgId: org._id, status: 'new' }, { size: '5' })
    expect(result.total).toBe(8)
    expect(result.items).toHaveLength(5)
    expect(result.totalPages).toBe(2)

    const page2 = await paginateQuery(Lead, { orgId: org._id, status: 'new' }, { page: '1', size: '5' })
    expect(page2.items).toHaveLength(3)
  })

  it('should use default sortBy and sortOrder from defaults', async () => {
    const org = await createTestOrg({ slug: 'pag-defaults' })
    await createTestLead(org._id, { contactName: 'Charlie' })
    await createTestLead(org._id, { contactName: 'Alice' })
    await createTestLead(org._id, { contactName: 'Bob' })

    const result = await paginateQuery(Lead, { orgId: org._id }, {}, {
      sortBy: 'contactName', sortOrder: 'asc',
    })
    expect(result.items[0].contactName).toBe('Alice')
    expect(result.items[2].contactName).toBe('Charlie')
  })

  it('should return empty result for empty collection', async () => {
    const org = await createTestOrg({ slug: 'pag-empty' })
    const result = await paginateQuery(Lead, { orgId: org._id }, {})
    expect(result.items).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.totalPages).toBe(0)
  })

  it('should handle negative page gracefully', async () => {
    const org = await createTestOrg({ slug: 'pag-negative' })
    await createTestLead(org._id, { contactName: 'Test' })

    const result = await paginateQuery(Lead, { orgId: org._id }, { page: '-1' })
    expect(result.page).toBe(0)
    expect(result.items).toHaveLength(1)
  })
})
