import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestContact,
  createTestInvoice,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
} from '../helpers/factories'
import { Invoice, StockMovement, StockLevel, Sequence } from 'db/models'
import { sequenceGroupFor } from 'services/biz/sequence-registry'
import {
  getNextInvoiceNumber,
  getNextDraftInvoiceNumber,
  currentMaxSuffix,
} from 'services/biz/invoice-numbering.service'
import { createInvoiceStockMovement, reverseInvoiceStockMovement } from 'services/biz/invoicing.service'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { validateRelatedInvoiceRef } from 'invoicing-api/src/controllers/invoice.controller'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

// FR-01 (#8): invoice / credit note / debit note merged per side — one prefix, one
// sequence, direction-aware side effects, mandatory related invoice.
describe('Unified document types (FR-01)', () => {
  describe('sequence grouping + numbering', () => {
    it('maps notes onto the side they correct', () => {
      expect(sequenceGroupFor('credit_note', 'outgoing')).toBe('invoice')
      expect(sequenceGroupFor('debit_note', 'outgoing')).toBe('invoice')
      expect(sequenceGroupFor('credit_note', 'incoming')).toBe('bill')
      expect(sequenceGroupFor('debit_note', 'incoming')).toBe('bill')
      expect(sequenceGroupFor('invoice', 'incoming')).toBe('bill')
      expect(sequenceGroupFor('proforma', 'outgoing')).toBe('proforma')
    })

    it('outgoing invoice + CN + DN interleave in one INV series', async () => {
      const org = await createTestOrg()
      const orgId = String(org._id)
      const year = new Date().getFullYear()

      const inv = await getNextInvoiceNumber(orgId, 'outgoing', 'invoice')
      const cn = await getNextInvoiceNumber(orgId, 'outgoing', 'credit_note')
      const dn = await getNextInvoiceNumber(orgId, 'outgoing', 'debit_note')

      expect(inv).toBe(`INV-${year}-00001`)
      expect(cn).toBe(`INV-${year}-00002`)
      expect(dn).toBe(`INV-${year}-00003`)
    })

    it('drafts of all three sales types share the DRF-INV series', async () => {
      const org = await createTestOrg()
      const orgId = String(org._id)
      const year = new Date().getFullYear()

      const d1 = await getNextDraftInvoiceNumber(orgId, 'outgoing', 'invoice')
      const d2 = await getNextDraftInvoiceNumber(orgId, 'outgoing', 'credit_note')
      const d3 = await getNextDraftInvoiceNumber(orgId, 'outgoing', 'debit_note')

      expect(d1).toBe(`DRF-INV-${year}-00001`)
      expect(d2).toBe(`DRF-INV-${year}-00002`)
      expect(d3).toBe(`DRF-INV-${year}-00003`)
    })

    it('incoming notes draw from the BILL / DRF-BILL series', async () => {
      const org = await createTestOrg()
      const orgId = String(org._id)
      const year = new Date().getFullYear()

      expect(await getNextInvoiceNumber(orgId, 'incoming', 'invoice')).toBe(`BILL-${year}-00001`)
      expect(await getNextInvoiceNumber(orgId, 'incoming', 'credit_note')).toBe(`BILL-${year}-00002`)
      expect(await getNextDraftInvoiceNumber(orgId, 'incoming', 'debit_note')).toBe(`DRF-BILL-${year}-00001`)
    })

    it('reconciliation still counts historic CRN-/DBN- numbers toward the SALES_DOC max', async () => {
      const org = await createTestOrg()
      const user = await createTestUser(org._id)
      const contact = await createTestContact(org._id)
      const year = new Date().getFullYear()

      await Invoice.create({
        orgId: org._id,
        invoiceNumber: `CRN-${year}-00042`,
        type: 'credit_note',
        direction: 'outgoing',
        status: 'sent',
        contactId: contact._id,
        issueDate: new Date(), dueDate: new Date(),
        currency: 'EUR', exchangeRate: 1, lines: [],
        subtotal: 10, taxTotal: 2, total: 12, totalBase: 12, amountPaid: 0, amountDue: 12,
        billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
        createdBy: user._id,
      } as any)

      expect(await currentMaxSuffix(String(org._id), 'SALES_DOC', year)).toBe(42)
      // Counter untouched (0) → next allocation must land ABOVE the legacy CRN suffix.
      const next = await getNextInvoiceNumber(String(org._id), 'outgoing', 'invoice')
      expect(next).toBe(`INV-${year}-00043`)
      const seq = await Sequence.findOne({ orgId: org._id, prefix: 'SALES_DOC', year }).lean()
      expect(seq?.lastNumber).toBe(43)
    })
  })

  describe('related-invoice validation', () => {
    it('requires a related invoice for both note types', async () => {
      const org = await createTestOrg()
      const err = await validateRelatedInvoiceRef(String(org._id), {
        type: 'credit_note', direction: 'outgoing', contactId: undefined, relatedInvoiceId: undefined,
      })
      expect(err).toContain('required')
      const err2 = await validateRelatedInvoiceRef(String(org._id), {
        type: 'debit_note', direction: 'incoming', contactId: undefined, relatedInvoiceId: undefined,
      })
      expect(err2).toContain('required')
      // Plain invoices never fail this check.
      expect(await validateRelatedInvoiceRef(String(org._id), { type: 'invoice', direction: 'outgoing' })).toBeNull()
    })

    it('rejects wrong type, wrong direction, draft status and contact mismatch', async () => {
      const org = await createTestOrg()
      const contact = await createTestContact(org._id)
      const other = await createTestContact(org._id, { companyName: 'Other Ltd' })

      const proforma = await createTestInvoice(org._id, contact._id, {
        type: 'proforma', direction: 'outgoing', status: 'sent', invoiceNumber: 'PRF-X-1',
      })
      const bill = await createTestInvoice(org._id, contact._id, {
        type: 'invoice', direction: 'incoming', status: 'received', invoiceNumber: 'BILL-X-1',
      })
      const draft = await createTestInvoice(org._id, contact._id, {
        type: 'invoice', direction: 'outgoing', status: 'draft', invoiceNumber: 'DRF-X-1',
      })
      const issued = await createTestInvoice(org._id, contact._id, {
        type: 'invoice', direction: 'outgoing', status: 'sent', invoiceNumber: 'INV-X-1',
      })

      const base = { type: 'credit_note', direction: 'outgoing', contactId: String(contact._id) }
      expect(await validateRelatedInvoiceRef(String(org._id), { ...base, relatedInvoiceId: String(proforma._id) }))
        .toContain('not an invoice')
      expect(await validateRelatedInvoiceRef(String(org._id), { ...base, relatedInvoiceId: String(bill._id) }))
        .toContain('same side')
      expect(await validateRelatedInvoiceRef(String(org._id), { ...base, relatedInvoiceId: String(draft._id) }))
        .toContain('draft')
      expect(await validateRelatedInvoiceRef(String(org._id), {
        ...base, contactId: String(other._id), relatedInvoiceId: String(issued._id),
      })).toContain('different contact')
      // Happy path — same side, issued, same contact.
      expect(await validateRelatedInvoiceRef(String(org._id), { ...base, relatedInvoiceId: String(issued._id) }))
        .toBeNull()
      // Incoming note against an issued bill — also fine.
      expect(await validateRelatedInvoiceRef(String(org._id), {
        type: 'debit_note', direction: 'incoming', contactId: String(contact._id), relatedInvoiceId: String(bill._id),
      })).toBeNull()
    })
  })

  describe('direction-aware stock matrix', () => {
    async function seed(qty = 100) {
      const org = await createTestOrg()
      const user = await createTestUser(org._id)
      const contact = await createTestContact(org._id)
      const product = await createTestProduct(org._id, { sku: `UDT-${Date.now()}-${Math.floor(qty)}` })
      const warehouse = await createTestWarehouse(org._id)
      await createTestStockLevel(org._id, product._id, warehouse._id, {
        quantity: qty, availableQuantity: qty, avgCost: 10,
      })
      return { org, user, contact, product, warehouse }
    }

    function noteLines(product: any, warehouse: any) {
      return [{
        productId: product._id, description: 'x', quantity: 5, unit: 'pcs',
        unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 10, lineTotal: 60,
        warehouseId: warehouse._id,
      }]
    }

    it('outgoing credit note restocks (return INTO the warehouse) — unchanged behavior', async () => {
      const { org, user, contact, product, warehouse } = await seed()
      const cn = await createTestInvoice(org._id, contact._id, {
        type: 'credit_note', direction: 'outgoing', invoiceNumber: 'CN-OUT-1',
        lines: noteLines(product, warehouse),
      })
      await createInvoiceStockMovement(cn, String(user._id))

      const mov = await StockMovement.findOne({ orgId: org._id, invoiceId: cn._id }).lean()
      expect(mov!.type).toBe('return')
      expect(String(mov!.toWarehouseId)).toBe(String(warehouse._id))
      expect(mov!.fromWarehouseId).toBeFalsy()
      const level = await StockLevel.findOne({ orgId: org._id, productId: product._id }).lean()
      expect(level!.quantity).toBe(105)
    })

    it('incoming credit note de-stocks (return OUT to the supplier) and void restores', async () => {
      const { org, user, contact, product, warehouse } = await seed()
      const cn = await createTestInvoice(org._id, contact._id, {
        type: 'credit_note', direction: 'incoming', invoiceNumber: 'CN-IN-1',
        lines: noteLines(product, warehouse),
      })
      await createInvoiceStockMovement(cn, String(user._id))

      const mov = await StockMovement.findOne({ orgId: org._id, invoiceId: cn._id }).lean()
      expect(mov!.type).toBe('return')
      expect(String(mov!.fromWarehouseId)).toBe(String(warehouse._id))
      expect(mov!.toWarehouseId).toBeFalsy()
      let level = await StockLevel.findOne({ orgId: org._id, productId: product._id }).lean()
      expect(level!.quantity).toBe(95)

      // Void: the reversal receives the goods back in.
      await reverseInvoiceStockMovement(cn, String(user._id))
      const reversal = await StockMovement.find({ orgId: org._id, invoiceId: cn._id }).sort({ createdAt: 1 }).lean()
      expect(reversal.at(-1)!.type).toBe('receipt')
      level = await StockLevel.findOne({ orgId: org._id, productId: product._id }).lean()
      expect(level!.quantity).toBe(100)
    })

    it('incoming debit note books a receipt like a bill', async () => {
      const { org, user, contact, product, warehouse } = await seed()
      const dn = await createTestInvoice(org._id, contact._id, {
        type: 'debit_note', direction: 'incoming', invoiceNumber: 'DN-IN-1',
        lines: noteLines(product, warehouse),
      })
      await createInvoiceStockMovement(dn, String(user._id))

      const mov = await StockMovement.findOne({ orgId: org._id, invoiceId: dn._id }).lean()
      expect(mov!.type).toBe('receipt')
      expect(String(mov!.toWarehouseId)).toBe(String(warehouse._id))
      const level = await StockLevel.findOne({ orgId: org._id, productId: product._id }).lean()
      expect(level!.quantity).toBe(105)
    })
  })

  describe('contact ledger summary', () => {
    it('incoming credit notes subtract from purchases; outgoing keep subtracting from sales', async () => {
      const org = await createTestOrg()
      const contact = await createTestContact(org._id)
      const mk = (type: string, direction: string, total: number, n: string) =>
        createTestInvoice(org._id, contact._id, {
          type, direction, status: direction === 'incoming' ? 'received' : 'sent',
          invoiceNumber: n, subtotal: total, taxTotal: 0, total,
        })

      await mk('invoice', 'outgoing', 200, 'L-INV-1')
      await mk('credit_note', 'outgoing', 50, 'L-CN-OUT')
      await mk('invoice', 'incoming', 300, 'L-BILL-1')
      await mk('credit_note', 'incoming', 80, 'L-CN-IN')

      const ledger = await getContactLedger(String(org._id), String(contact._id), {})
      expect(ledger.summary.totalSales).toBe(150)      // 200 − 50
      expect(ledger.summary.totalPurchases).toBe(220)  // 300 − 80
      expect(ledger.summary.balance).toBe(-70)
    })
  })
})
