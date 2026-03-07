import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact } from '../helpers/factories'
import { Contact } from 'db/models'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Contact Tax Fields', () => {
  it('should persist taxNumber and vatNumber on contact', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, {
      taxNumber: '205174895',
      vatNumber: 'BG205174895',
    })

    // Re-fetch from DB
    const fetched = await Contact.findById(contact._id)
    expect(fetched).toBeDefined()
    expect(fetched!.taxNumber).toBe('205174895')
    expect(fetched!.vatNumber).toBe('BG205174895')
  })

  it('should find contact by vatNumber', async () => {
    const org = await createTestOrg()
    await createTestContact(org._id, {
      vatNumber: 'ATU66280133',
      companyName: 'Austrian Test GmbH',
    })

    const found = await Contact.findOne({ orgId: org._id, vatNumber: 'ATU66280133' })
    expect(found).toBeDefined()
    expect(found!.companyName).toBe('Austrian Test GmbH')
  })

  it('should find contact by taxNumber', async () => {
    const org = await createTestOrg()
    await createTestContact(org._id, {
      taxNumber: '123456789',
      companyName: 'Tax Number Test Co',
    })

    const found = await Contact.findOne({ orgId: org._id, taxNumber: '123456789' })
    expect(found).toBeDefined()
    expect(found!.companyName).toBe('Tax Number Test Co')
  })

  it('should store both taxNumber and vatNumber independently', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, {
      taxNumber: '205174895',
      vatNumber: 'BG205174895',
      taxId: 'legacy-id',
    })

    const fetched = await Contact.findById(contact._id)
    expect(fetched!.taxNumber).toBe('205174895')
    expect(fetched!.vatNumber).toBe('BG205174895')
    expect(fetched!.taxId).toBe('legacy-id')
  })
})
