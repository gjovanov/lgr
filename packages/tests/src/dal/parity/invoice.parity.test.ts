import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardownMongo, teardownSQLite, createTestOrg } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
  ['sqlite', setupSQLiteRepos, teardownSQLite],
]

for (const [name, setup, cleanup] of backends) {
  describe(`Invoice Repository [${name}]`, () => {
    let repos: RepositoryRegistry
    let orgId: string
    let contactId: string

    beforeAll(async () => {
      repos = await setup()
    })

    beforeEach(async () => {
      await cleanup()
      orgId = await createTestOrg(repos)
      // Create a test contact for invoices
      const contact = await repos.contacts.create({
        orgId,
        type: 'customer',
        companyName: 'Test Customer',
        email: 'customer@test.com',
        addresses: [],
        bankDetails: [],
        paymentTermsDays: 30,
        isActive: true,
      } as any)
      contactId = contact.id
    })

    afterAll(async () => {
      // cleanup handled by process exit
    })

    function makeInvoice(overrides: Record<string, any> = {}) {
      return {
        orgId,
        invoiceNumber: `INV-${Date.now()}`,
        type: 'invoice',
        direction: 'outgoing',
        status: 'draft',
        contactId,
        issueDate: new Date('2025-01-15'),
        dueDate: new Date('2025-02-15'),
        currency: 'EUR',
        exchangeRate: 1,
        lines: [
          {
            description: 'Widget A',
            quantity: 10,
            unit: 'pcs',
            unitPrice: 25,
            discount: 0,
            taxRate: 18,
            taxAmount: 45,
            lineTotal: 250,
          },
          {
            description: 'Widget B',
            quantity: 5,
            unit: 'pcs',
            unitPrice: 50,
            discount: 10,
            taxRate: 18,
            taxAmount: 40.5,
            lineTotal: 225,
          },
        ],
        payments: [],
        subtotal: 475,
        discountTotal: 10,
        taxTotal: 85.5,
        total: 550.5,
        totalBase: 550.5,
        amountPaid: 0,
        amountDue: 550.5,
        billingAddress: { street: '123 Main St', city: 'Berlin', postalCode: '10115', country: 'DE' },
        attachments: [],
        createdBy: orgId,
        ...overrides,
      } as any
    }

    test('creates invoice with lines and retrieves them', async () => {
      const invoice = await repos.invoices.create(makeInvoice())

      expect(invoice.id).toBeDefined()
      expect(invoice.invoiceNumber).toContain('INV-')
      expect(invoice.lines).toHaveLength(2)
      expect(invoice.lines[0].description).toBe('Widget A')
      expect(invoice.lines[0].quantity).toBe(10)
      expect(invoice.lines[1].description).toBe('Widget B')
      expect(invoice.lines[1].unitPrice).toBe(50)
      expect(invoice.payments).toHaveLength(0)

      // Retrieve by ID and verify lines are hydrated
      const found = await repos.invoices.findById(invoice.id)
      expect(found).not.toBeNull()
      expect(found!.lines).toHaveLength(2)
      expect(found!.lines[0].description).toBe('Widget A')
      expect(found!.lines[1].description).toBe('Widget B')
    })

    test('creates invoice with payments', async () => {
      const invoice = await repos.invoices.create(makeInvoice({
        payments: [
          {
            date: new Date('2025-01-20'),
            amount: 200,
            method: 'bank_transfer',
            reference: 'PAY-001',
          },
          {
            date: new Date('2025-02-01'),
            amount: 350.5,
            method: 'cash',
          },
        ],
        amountPaid: 550.5,
        amountDue: 0,
        status: 'paid',
      }))

      expect(invoice.payments).toHaveLength(2)
      expect(invoice.payments[0].amount).toBe(200)
      expect(invoice.payments[0].method).toBe('bank_transfer')
      expect(invoice.payments[1].amount).toBe(350.5)

      const found = await repos.invoices.findById(invoice.id)
      expect(found!.payments).toHaveLength(2)
      expect(found!.payments[0].reference).toBe('PAY-001')
    })

    test('creates invoice with priceExplanation on lines', async () => {
      const invoice = await repos.invoices.create(makeInvoice({
        lines: [
          {
            description: 'Tagged Product',
            quantity: 5,
            unit: 'pcs',
            unitPrice: 8,
            discount: 0,
            taxRate: 18,
            taxAmount: 7.2,
            lineTotal: 47.2,
            priceExplanation: [
              { type: 'base', label: 'Selling price', price: 10 },
              { type: 'tag', label: 'Loyal discount', price: 8 },
            ],
          },
        ],
        subtotal: 40,
        taxTotal: 7.2,
        total: 47.2,
        totalBase: 47.2,
        amountDue: 47.2,
      }))

      expect(invoice.lines).toHaveLength(1)
      expect(invoice.lines[0].priceExplanation).toHaveLength(2)
      expect(invoice.lines[0].priceExplanation[0].type).toBe('base')
      expect(invoice.lines[0].priceExplanation[0].price).toBe(10)
      expect(invoice.lines[0].priceExplanation[1].type).toBe('tag')
      expect(invoice.lines[0].priceExplanation[1].label).toBe('Loyal discount')
      expect(invoice.lines[0].priceExplanation[1].price).toBe(8)

      const found = await repos.invoices.findById(invoice.id)
      expect(found!.lines[0].priceExplanation).toHaveLength(2)
      expect(found!.lines[0].priceExplanation[0].label).toBe('Selling price')
      expect(found!.lines[0].priceExplanation[1].label).toBe('Loyal discount')
    })

    test('update replaces lines', async () => {
      const invoice = await repos.invoices.create(makeInvoice())
      expect(invoice.lines).toHaveLength(2)

      const updated = await repos.invoices.update(invoice.id, {
        lines: [
          {
            description: 'New Widget',
            quantity: 1,
            unit: 'pcs',
            unitPrice: 100,
            discount: 0,
            taxRate: 18,
            taxAmount: 18,
            lineTotal: 100,
          },
        ],
        subtotal: 100,
        total: 118,
      } as any)

      expect(updated).not.toBeNull()
      expect(updated!.lines).toHaveLength(1)
      expect(updated!.lines[0].description).toBe('New Widget')

      // Verify old lines are gone
      const found = await repos.invoices.findById(invoice.id)
      expect(found!.lines).toHaveLength(1)
    })

    test('update adds payments to existing invoice', async () => {
      const invoice = await repos.invoices.create(makeInvoice())
      expect(invoice.payments).toHaveLength(0)

      const updated = await repos.invoices.update(invoice.id, {
        payments: [
          { date: new Date('2025-01-25'), amount: 100, method: 'cash' },
        ],
        amountPaid: 100,
        amountDue: 450.5,
      } as any)

      expect(updated!.payments).toHaveLength(1)
      expect(updated!.payments[0].amount).toBe(100)
    })

    test('delete removes invoice and its lines/payments', async () => {
      const invoice = await repos.invoices.create(makeInvoice({
        payments: [{ date: new Date(), amount: 50, method: 'cash' }],
      }))

      const deleted = await repos.invoices.delete(invoice.id)
      expect(deleted).toBe(true)

      const found = await repos.invoices.findById(invoice.id)
      expect(found).toBeNull()
    })

    test('findAll with filter on parent fields', async () => {
      await repos.invoices.create(makeInvoice({ invoiceNumber: 'INV-001', status: 'draft' }))
      await repos.invoices.create(makeInvoice({ invoiceNumber: 'INV-002', status: 'sent' }))
      await repos.invoices.create(makeInvoice({ invoiceNumber: 'INV-003', status: 'draft' }))

      const drafts = await repos.invoices.findAll({ orgId, status: 'draft' }, { page: 0, size: 0 })
      expect(drafts.items).toHaveLength(2)
      for (const inv of drafts.items) {
        expect(inv.status).toBe('draft')
        expect(inv.lines).toHaveLength(2) // lines should be hydrated
      }
    })

    test('count works with child table entities', async () => {
      await repos.invoices.create(makeInvoice({ invoiceNumber: 'CNT-001' }))
      await repos.invoices.create(makeInvoice({ invoiceNumber: 'CNT-002' }))

      const count = await repos.invoices.count({ orgId })
      expect(count).toBe(2)
    })

    test('createMany with lines', async () => {
      const items = [
        makeInvoice({ invoiceNumber: 'BATCH-001' }),
        makeInvoice({ invoiceNumber: 'BATCH-002' }),
      ]

      const created = await repos.invoices.createMany(items)
      expect(created).toHaveLength(2)
      expect(created[0].lines).toHaveLength(2)
      expect(created[1].lines).toHaveLength(2)
      expect(created[0].invoiceNumber).toBe('BATCH-001')
    })
  })
}
