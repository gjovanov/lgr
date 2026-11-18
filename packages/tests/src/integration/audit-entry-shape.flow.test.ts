import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestAccount, createTestContact, createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { orderController } from 'invoicing-api/src/controllers/order.controller'
import { internalOrderController } from 'invoicing-api/src/controllers/internal-order.controller'
import { auditLogController } from '../../../portal-api/src/controllers/audit-log.controller.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import {
  SEARCHABLE_ENTITY_TYPES, auditHealth, changesOf, createAuditEntry, queryAuditLogs, recordAuditEntry, searchEntitiesByType, systemActor,
  type AuditChanges,
} from 'services/biz/audit-log.service'
import { ensureFiscalPeriod } from 'services/biz/accounting.service'
import { drainPostings } from 'services/biz/postings/posting.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { AuditLog, Journal, JournalEntry, Org, Product } from 'db/models'

/**
 * FR-29 slice E (#794): the audit trail (§1.5, §2.6, §6 "Audit").
 *
 * - FR-29.19: the sixteen call sites that pass `changes` as a map (`{ invoiceNumber: { from, to } }`) store the fields
 *   they name, with their old and new values. Mongoose used to cast the map to one element with no fields;
 * - FR-29.20: an entry written by a handler or a job has the system as its actor and names it; the page reads "System";
 * - FR-29.21: a failed write is logged and counted, and the action it belongs to still succeeds;
 * - FR-29.22: every entity type the search offers finds matches; the keyword is escaped.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any)
    .use(invoiceController).use(orderController).use(internalOrderController).use(auditLogController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const customer = await createTestContact(org._id, { companyName: 'Customer Ltd', type: 'customer' } as any)
  const supplier = await createTestContact(org._id, { companyName: 'Supplier Ltd', type: 'supplier' } as any)
  const main = await createTestWarehouse(org._id, { name: 'Main store', isDefault: true } as any)
  const bolt = await createTestProduct(org._id, { sku: 'BOLT-01', name: 'Bolt M8.*(x', purchasePrice: 5, sellingPrice: 9, taxRate: 20 } as any)
  const nut = await createTestProduct(org._id, { sku: 'NUT-01', name: 'Nut M8x20', purchasePrice: 2, sellingPrice: 4, taxRate: 20 } as any)
  await createTestStockLevel(org._id, bolt._id, main._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  async function draft(direction: 'outgoing' | 'incoming') {
    const res = await call('POST', '/invoices', {
      type: 'invoice', direction, contactId: String(direction === 'outgoing' ? customer._id : supplier._id), issueDate: '2026-11-16',
      currency: 'EUR', paymentMethod: 'bank_transfer',
      lines: [{ productId: String(bolt._id), warehouseId: String(main._id), description: 'Bolt', quantity: 2, unit: 'pcs', unitPrice: 10, taxRate: 20 }],
      subtotal: 20, total: 24,
    })
    expect(res.status).toBe(200)
    return String(res.json.invoice.id || res.json.invoice._id)
  }
  /** The entries of one record, waiting for the fire-and-forget write. */
  async function rows(filter: Record<string, unknown>, count = 1): Promise<any[]> {
    for (let i = 0; i < 200; i++) {
      const found = await AuditLog.find({ orgId: org._id, ...filter }).sort({ timestamp: 1 }).lean().exec()
      if (found.length >= count) return found
      await new Promise(r => setTimeout(r, 15))
    }
    return AuditLog.find({ orgId: org._id, ...filter }).lean().exec()
  }
  return { org, orgId, user, customer, supplier, main, bolt, nut, call, draft, rows }
}

const fields = (row: any) => (row?.changes ?? []).map((c: any) => [c.field, c.oldValue, c.newValue])

describe('FR-29.19: one shape for `changes`', () => {
  it('each map a call site passes is stored as the fields it names, old and new', async () => {
    const w = await world()
    // The sixteen call sites' shapes, as they write them (§1.5).
    const SITES: Array<[string, AuditChanges, unknown[][]]> = [
      ['reservation.cancel', { quantity: { to: 3 }, status: { to: 'cancelled' } }, [['quantity', null, 3], ['status', null, 'cancelled']]],
      ['reservation.update', { quantity: { from: 2, to: 3 }, contactId: { from: 'a', to: 'b' } }, [['quantity', 2, 3], ['contactId', 'a', 'b']]],
      ['reservation.repeat', { repeatOf: { to: 'r1' } }, [['repeatOf', null, 'r1']]],
      ['reservation.preempt', { preemptedBy: { to: 'RES-2' }, internalOrderId: { to: 'o1' } }, [['preemptedBy', null, 'RES-2'], ['internalOrderId', null, 'o1']]],
      ['reservation.preempted-from', { preemptedFrom: { to: 'RES-1' } }, [['preemptedFrom', null, 'RES-1']]],
      ['order.create', { reservations: { to: 2 } }, [['reservations', null, 2]]],
      ['order.send', { orderNumber: { from: 'DRF-1', to: 'ORDO-1' } }, [['orderNumber', 'DRF-1', 'ORDO-1']]],
      ['order.release', { reservationId: { to: 'r9' } }, [['reservationId', null, 'r9']]],
      ['order.convert', { invoice: { to: 'INV-1' } }, [['invoice', null, 'INV-1']]],
      ['invoice.send', { draftNumber: { from: 'DRAFT-1', to: null }, invoiceNumber: { from: 'DRAFT-1', to: 'INV-1' } }, [['draftNumber', 'DRAFT-1', null], ['invoiceNumber', 'DRAFT-1', 'INV-1']]],
      ['invoice.receive', { invoiceNumber: { from: 'DRAFT-2', to: 'BILL-1' } }, [['invoiceNumber', 'DRAFT-2', 'BILL-1']]],
      ['invoice.quote-convert', { status: { from: 'sent', to: 'converted' }, invoice: { to: 'INV-2' } }, [['status', 'sent', 'converted'], ['invoice', null, 'INV-2']]],
      ['internal-order.confirm', { orderNumber: { from: 'DRF-ORDI-1', to: 'ORDI-1' } }, [['orderNumber', 'DRF-ORDI-1', 'ORDI-1']]],
      ['internal-order.generate', { order: { to: 'ORDO-2' } }, [['order', null, 'ORDO-2']]],
      ['internal-order.convert', { invoice: { to: 'INV-3' } }, [['invoice', null, 'INV-3']]],
      ['doc-import.commit', { invoiceNumber: { from: 'DRAFT-3', to: 'INV-4' } }, [['invoiceNumber', 'DRAFT-3', 'INV-4']]],
    ]
    expect(SITES).toHaveLength(16)
    for (const [action, changes, expected] of SITES) {
      expect(await recordAuditEntry({ orgId: w.orgId, userId: String(w.user._id), action, module: 'invoicing', entityType: 'probe', entityId: String(w.bolt._id), changes })).toBe(true)
      const [row] = await w.rows({ action })
      expect(fields(row)).toEqual(expected)
    }
    // The array passes as it is.
    expect(changesOf([{ field: 'a', oldValue: 1, newValue: 2 }])).toEqual([{ field: 'a', oldValue: 1, newValue: 2 }])
  })

  it('issuing a draft stores a row whose changes name the number (§7.5)', async () => {
    const w = await world()
    const id = await w.draft('outgoing')
    const res = await w.call('POST', `/invoices/${id}/send`, {})
    expect(res.status).toBe(200)
    const [row] = await w.rows({ action: 'send', entityType: 'invoice' })
    const byField = Object.fromEntries(fields(row).map((f: unknown[]) => [f[0], f.slice(1)]))
    expect(byField.invoiceNumber[1]).toBe(res.json.invoice.invoiceNumber)
    expect(byField.invoiceNumber[0]).toMatch(/\S/)
    expect(byField.draftNumber).toEqual([byField.invoiceNumber[0], null])
  })

  it('receiving a bill, sending a supplier order and confirming a customer order store their number change', async () => {
    const w = await world()
    const bill = await w.draft('incoming')
    expect((await w.call('POST', `/invoices/${bill}/receive`, {})).status).toBe(200)
    const order = await w.call('POST', '/invoicing/orders', {
      issueDate: '2026-11-16',
      supplierGroups: [{ supplierId: String(w.supplier._id), lines: [{ productId: String(w.bolt._id), description: 'Bolt', quantity: 5, unit: 'pcs', allocations: [{ warehouseId: String(w.main._id), quantity: 5 }] }] }],
    })
    expect((await w.call('POST', `/invoicing/orders/${order.json.order._id}/send`)).status).toBe(200)
    const ordi = await w.call('POST', '/invoicing/internal-orders', {
      contactId: String(w.customer._id), issueDate: '2026-11-16', requestedDeliveryDate: '2026-11-30',
      lines: [{ productId: String(w.bolt._id), description: 'Bolt', quantity: 2 }],
    })
    expect((await w.call('POST', `/invoicing/internal-orders/${ordi.json.internalOrder._id}/confirm`)).status).toBe(200)

    for (const [action, entityType, field] of [['receive', 'invoice', 'invoiceNumber'], ['send', 'order', 'orderNumber'], ['confirm', 'internal_order', 'orderNumber']]) {
      const [row] = await w.rows({ action, entityType })
      const [f] = fields(row)
      expect(f[0]).toBe(field)
      expect(f[1]).toBeTruthy()
      expect(f[2]).toBeTruthy()
      expect(f[1]).not.toBe(f[2])
    }
  })
})

describe('FR-29.20: a system actor', () => {
  it('the journal entry made for an issue has a "System" row naming its event (§7.5)', async () => {
    const w = await world()
    const receivable = await createTestAccount(w.org._id, { name: 'Receivable', type: 'asset' })
    const revenue = await createTestAccount(w.org._id, { name: 'Revenue', type: 'revenue', subType: 'operating_revenue' } as any)
    const sale = await Journal.create({ orgId: w.org._id, name: 'Sales', code: 'S1', type: 'sale' })
    await Org.updateOne({ _id: w.org._id }, {
      $set: {
        'settings.accounting.defaultSaleJournalId': sale._id,
        'settings.accounting.defaultReceivableAccountId': receivable._id,
        'settings.accounting.defaultRevenueAccountId': revenue._id,
      },
    }).exec()
    await ensureFiscalPeriod(w.orgId, new Date('2026-11-16'))
    const id = await w.draft('outgoing')
    expect((await w.call('POST', `/invoices/${id}/send`, {})).status).toBe(200)
    await drainPostings()
    const entry: any = await JournalEntry.findOne({ orgId: w.org._id, postingKey: `invoice.posted:${id}` }).lean().exec()
    expect(entry).toBeTruthy()
    const [row] = await w.rows({ entityType: 'journal_entry', entityId: entry._id })
    expect(row.actor).toEqual({ kind: 'system', name: 'invoice.posted' })
    expect(row.userId).toBeUndefined()

    const page = await queryAuditLogs(w.orgId, { entityType: 'journal_entry' })
    expect(page.auditLogs[0]).toMatchObject({ system: true, systemName: 'invoice.posted', userName: 'System' })
  })

  it('a job\'s entry and the old `userId: \'system\'` are stored with the system as actor; a person\'s as before', async () => {
    const w = await world()
    expect(await recordAuditEntry({ orgId: w.orgId, actor: systemActor('backup'), action: 'create', module: 'admin', entityType: 'backup', entityId: 'b1' })).toBe(true)
    expect(await recordAuditEntry({ orgId: w.orgId, userId: 'system', action: 'auto_create', module: 'accounting', entityType: 'journal_entry', entityId: String(w.bolt._id) })).toBe(true)
    expect(await recordAuditEntry({ orgId: w.orgId, userId: String(w.user._id), action: 'update', module: 'warehouse', entityType: 'product', entityId: String(w.bolt._id) })).toBe(true)
    const all = await AuditLog.find({ orgId: w.org._id }).sort({ timestamp: 1 }).lean().exec() as any[]
    expect(all.map(r => r.actor ?? null)).toEqual([{ kind: 'system', name: 'backup' }, { kind: 'system', name: 'auto_create' }, null])
    expect(String(all[2].userId)).toBe(String(w.user._id))
  })
})

describe('FR-29.21: a failed audit write is loud, and the action still succeeds', () => {
  it('is counted for health, never thrown', async () => {
    const w = await world()
    const before = auditHealth().writeFailures
    // An entry with nobody behind it: no person, no system, no script.
    expect(await recordAuditEntry({ orgId: w.orgId, action: 'x', module: 'm', entityType: 't', entityId: 'e' })).toBe(false)
    // A cast that throws at once (an org id that is no id) is caught as well.
    createAuditEntry({ orgId: 'not-an-id', userId: String(w.user._id), action: 'x', module: 'm', entityType: 't', entityId: 'e' })
    // And the async failure of a fire-and-forget write.
    createAuditEntry({ orgId: w.orgId, action: 'y', module: 'm', entityType: 't', entityId: 'e' })
    for (let i = 0; i < 100 && auditHealth().writeFailures < before + 3; i++) await new Promise(r => setTimeout(r, 15))
    expect(auditHealth().writeFailures).toBe(before + 3)
    expect(auditHealth().lastFailureAt).toBeInstanceOf(Date)
  })
})

describe('FR-29.22: the entity search', () => {
  it('offers only types it searches, and each finds its records', async () => {
    const w = await world()
    for (const gone of ['department', 'lead', 'deal', 'pipeline']) expect(SEARCHABLE_ENTITY_TYPES).not.toContain(gone)
    const filters = await w.call('GET', '/audit-logs/filters')
    expect(filters.status).toBe(200)
    expect(filters.json.searchableEntityTypes).toEqual([...SEARCHABLE_ENTITY_TYPES])
    expect(await searchEntitiesByType(w.orgId, 'department', 'x')).toEqual([])

    const id = await w.draft('outgoing')
    const found = {
      product: await searchEntitiesByType(w.orgId, 'product', 'nut'),
      contact: await searchEntitiesByType(w.orgId, 'contact', 'customer'),
      warehouse: await searchEntitiesByType(w.orgId, 'warehouse', 'main'),
      invoice: await searchEntitiesByType(w.orgId, 'invoice', ''),
    }
    expect(found.product.map(r => r.label)).toEqual(['Nut M8x20'])
    expect(found.contact.map(r => r.label)).toEqual(['Customer Ltd'])
    expect(found.warehouse.map(r => r.label)).toEqual(['Main store'])
    expect(found.invoice.map(r => r.id)).toEqual([id])
  })

  it('a keyword of pattern characters finds the rows that contain them, and nothing else', async () => {
    const w = await world()
    expect((await searchEntitiesByType(w.orgId, 'product', '.*(')).map(r => r.label)).toEqual(['Bolt M8.*(x'])
    expect(await searchEntitiesByType(w.orgId, 'product', '.*')).toHaveLength(1)
    const res = await w.call('GET', `/audit-logs/search-entities?entityType=product&q=${encodeURIComponent('M8.*(')}`)
    expect(res.status).toBe(200)
    expect(res.json.results.map((r: any) => r.label)).toEqual(['Bolt M8.*(x'])
    // Another org's records are not found.
    const other = await world()
    expect((await searchEntitiesByType(other.orgId, 'product', 'nut')).map(r => r.id)).not.toContain(String(w.nut._id))
    await Product.deleteMany({}).exec()
  })
})
