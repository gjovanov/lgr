import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardownMongo, teardownSQLite, createTestOrg } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
  ['sqlite', setupSQLiteRepos, teardownSQLite],
]

for (const [name, setup, cleanup] of backends) {
  describe(`Contact Repository [${name}]`, () => {
    let repos: RepositoryRegistry
    let orgId: string

    beforeAll(async () => {
      repos = await setup()
    })

    beforeEach(async () => {
      await cleanup()
      orgId = await createTestOrg(repos)
    })

    afterAll(async () => {
      // cleanup handled by process exit
    })

    test('creates contact with addresses and bank details', async () => {
      const contact = await repos.contacts.create({
        orgId,
        type: 'customer',
        companyName: 'Acme Corp',
        email: 'acme@test.com',
        paymentTermsDays: 30,
        isActive: true,
        addresses: [
          { type: 'billing', street: '123 Main St', city: 'Berlin', postalCode: '10115', country: 'DE', isDefault: true },
          { type: 'shipping', street: '456 Ship Rd', city: 'Munich', postalCode: '80331', country: 'DE', isDefault: false },
        ],
        bankDetails: [
          { bankName: 'Deutsche Bank', accountNumber: 'DE123456', iban: 'DE89370400440532013000', currency: 'EUR', isDefault: true },
        ],
      } as any)

      expect(contact.id).toBeDefined()
      expect(contact.addresses).toHaveLength(2)
      expect(contact.addresses[0].street).toBe('123 Main St')
      expect(contact.addresses[1].city).toBe('Munich')
      expect(contact.bankDetails).toHaveLength(1)
      expect(contact.bankDetails[0].bankName).toBe('Deutsche Bank')

      // Verify hydration on findById
      const found = await repos.contacts.findById(contact.id)
      expect(found!.addresses).toHaveLength(2)
      expect(found!.bankDetails).toHaveLength(1)
      expect(found!.bankDetails[0].iban).toBe('DE89370400440532013000')
    })

    test('creates contact with empty child arrays', async () => {
      const contact = await repos.contacts.create({
        orgId,
        type: 'supplier',
        companyName: 'Empty Supplier',
        paymentTermsDays: 15,
        isActive: true,
        addresses: [],
        bankDetails: [],
      } as any)

      expect(contact.addresses).toHaveLength(0)
      expect(contact.bankDetails).toHaveLength(0)

      const found = await repos.contacts.findById(contact.id)
      expect(found!.addresses).toHaveLength(0)
      expect(found!.bankDetails).toHaveLength(0)
    })

    test('update replaces addresses', async () => {
      const contact = await repos.contacts.create({
        orgId,
        type: 'customer',
        companyName: 'Update Corp',
        paymentTermsDays: 30,
        isActive: true,
        addresses: [
          { type: 'billing', street: 'Old St', city: 'Berlin', postalCode: '10115', country: 'DE', isDefault: true },
        ],
        bankDetails: [],
      } as any)

      const updated = await repos.contacts.update(contact.id, {
        addresses: [
          { type: 'billing', street: 'New St', city: 'Hamburg', postalCode: '20095', country: 'DE', isDefault: true },
          { type: 'shipping', street: 'Ship St', city: 'Hamburg', postalCode: '20095', country: 'DE', isDefault: false },
        ],
      } as any)

      expect(updated!.addresses).toHaveLength(2)
      expect(updated!.addresses[0].street).toBe('New St')
      expect(updated!.addresses[1].street).toBe('Ship St')
    })

    test('update parent fields without touching children', async () => {
      const contact = await repos.contacts.create({
        orgId,
        type: 'customer',
        companyName: 'Keep Children',
        paymentTermsDays: 30,
        isActive: true,
        addresses: [
          { type: 'billing', street: 'Keep St', city: 'Berlin', postalCode: '10115', country: 'DE', isDefault: true },
        ],
        bankDetails: [
          { bankName: 'Keep Bank', accountNumber: 'KEEP123', currency: 'EUR', isDefault: true },
        ],
      } as any)

      // Update only parent field — children should be preserved
      const updated = await repos.contacts.update(contact.id, {
        companyName: 'Updated Name',
      } as any)

      expect(updated!.companyName).toBe('Updated Name')
      expect(updated!.addresses).toHaveLength(1)
      expect(updated!.addresses[0].street).toBe('Keep St')
      expect(updated!.bankDetails).toHaveLength(1)
      expect(updated!.bankDetails[0].bankName).toBe('Keep Bank')
    })

    test('delete cascades to children', async () => {
      const contact = await repos.contacts.create({
        orgId,
        type: 'customer',
        companyName: 'Delete Me',
        paymentTermsDays: 30,
        isActive: true,
        addresses: [
          { type: 'billing', street: 'Gone St', city: 'Berlin', postalCode: '10115', country: 'DE', isDefault: true },
        ],
        bankDetails: [
          { bankName: 'Gone Bank', accountNumber: 'GONE123', currency: 'EUR', isDefault: true },
        ],
      } as any)

      expect(await repos.contacts.delete(contact.id)).toBe(true)
      expect(await repos.contacts.findById(contact.id)).toBeNull()
    })

    test('findMany returns contacts with hydrated children', async () => {
      await repos.contacts.create({
        orgId, type: 'customer', companyName: 'C1', paymentTermsDays: 30, isActive: true,
        addresses: [{ type: 'billing', street: 'S1', city: 'B', postalCode: '1', country: 'DE', isDefault: true }],
        bankDetails: [],
      } as any)
      await repos.contacts.create({
        orgId, type: 'supplier', companyName: 'C2', paymentTermsDays: 15, isActive: true,
        addresses: [],
        bankDetails: [{ bankName: 'B1', accountNumber: 'A1', currency: 'EUR', isDefault: true }],
      } as any)

      const all = await repos.contacts.findMany({ orgId })
      expect(all).toHaveLength(2)

      const c1 = all.find(c => c.companyName === 'C1')!
      const c2 = all.find(c => c.companyName === 'C2')!
      expect(c1.addresses).toHaveLength(1)
      expect(c2.bankDetails).toHaveLength(1)
    })
  })
}
