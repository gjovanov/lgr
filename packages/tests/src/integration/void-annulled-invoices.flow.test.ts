import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections, testDbUri } from '../setup'
import {
  createTestOrg,
  createTestContact,
  createTestInvoice,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
  createTestStockMovement,
} from '../helpers/factories'
import { AuditLog, Invoice, StockLevel, StockMovement } from 'db/models'
import { applyVoid, planVoid } from '../../../../scripts/lib/void-annulled'

/**
 * `void-annulled-invoices.ts` (2026-11-02): an invoice PlusMinus annulled is marked `voided` in LGR
 * where the API's void refuses it (`paid`). It changes the status, one history entry and one audit
 * row, and NOTHING else: no stock, no payment. Run for real, through the CLI, too.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

async function world() {
  const org = await createTestOrg()
  const contact = await createTestContact(org._id)
  return { org, contact }
}

/** What the importer leaves for an issued, paid PlusMinus sale. */
const paid = (orgId: any, contactId: any, number: string, overrides: Record<string, unknown> = {}) =>
  createTestInvoice(orgId, contactId, {
    invoiceNumber: `INV-${number}`,
    reference: number,
    status: 'paid',
    total: 75.24,
    amountPaid: 75.24,
    amountDue: 0,
    payments: [{ method: 'cash', amount: 75.24, date: new Date('2026-07-29') }] as any,
    ...overrides,
  })

describe('void-annulled: planVoid / applyVoid', () => {
  it('voids a paid invoice: status, history and audit change; stock, movement and payments do not', async () => {
    const { org, contact } = await world()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 7, availableQuantity: 7 })
    const inv = await paid(org._id, contact._id, '3000200001')
    const mv = await createTestStockMovement(org._id, {
      type: 'dispatch', status: 'completed', invoiceId: inv._id, fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 3, unitCost: 10, totalCost: 30 }] as any,
    })

    const plan = await planVoid(org._id, '3000200001')
    expect(plan.ok).toBe(true)
    expect(plan.movements).toEqual([{ number: mv.movementNumber, type: 'dispatch', status: 'completed', quantity: 3 }])

    const by = org.ownerId
    expect(await applyVoid(org._id, plan, by, 'annulled in PlusMinus')).toBe(true)

    const after: any = await Invoice.findById(inv._id).lean()
    expect(after.status).toBe('voided')
    expect(after.voidedAt).toBeInstanceOf(Date) // not in the schema: strict:false keeps it, as the API's void writes it
    expect(after.amountPaid).toBe(75.24)
    expect(after.payments).toHaveLength(1)
    const last = after.statusHistory[after.statusHistory.length - 1]
    expect(last).toMatchObject({ status: 'voided', fromStatus: 'paid', reason: 'annulled in PlusMinus' })
    expect(String(last.changedBy)).toBe(String(by))

    // Stock is not this tool's business: the true-up settled it.
    const level: any = await StockLevel.findOne({ orgId: org._id, productId: product._id }).lean()
    expect(level.quantity).toBe(7)
    expect((await StockMovement.findById(mv._id).lean() as any).status).toBe('completed')

    const audit: any[] = await AuditLog.find({ orgId: org._id, entityType: 'invoice' }).lean()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'void', module: 'invoicing', entityName: 'INV-3000200001' })
    expect(audit[0].changes.map((c: any) => [c.field, c.oldValue, c.newValue])).toEqual([['status', 'paid', 'voided'], ['reason', null, 'annulled in PlusMinus']])
  })

  it('a plan alone writes nothing', async () => {
    const { org, contact } = await world()
    const inv = await paid(org._id, contact._id, '3000200001')
    await planVoid(org._id, '3000200001')
    expect((await Invoice.findById(inv._id).lean() as any).status).toBe('paid')
    expect(await AuditLog.countDocuments({ orgId: org._id })).toBe(0)
  })

  it('is conditional on the status it planned: a second apply changes nothing and audits nothing', async () => {
    const { org, contact } = await world()
    await paid(org._id, contact._id, '3000200001')
    const plan = await planVoid(org._id, '3000200001')
    expect(await applyVoid(org._id, plan, org.ownerId, 'r')).toBe(true)
    expect(await applyVoid(org._id, plan, org.ownerId, 'r')).toBe(false)
    expect(await AuditLog.countDocuments({ orgId: org._id })).toBe(1)
    const again = await planVoid(org._id, '3000200001')
    expect(again).toMatchObject({ ok: false, already: true })
  })

  it('refuses what is not an annulled outgoing invoice, and says why', async () => {
    const { org, contact } = await world()
    const mk = (n: string, o: Record<string, unknown>) => createTestInvoice(org._id, contact._id, { invoiceNumber: `INV-${n}`, ...o })
    await mk('3000200004', { type: 'credit_note', status: 'sent' })
    await mk('3000200005', { status: 'sent' })
    await mk('3000200006', { status: 'draft' })
    await mk('3000200007', { status: 'cancelled' })
    await mk('3000200008', { status: 'paid', direction: 'incoming' })

    const why = async (n: string) => planVoid(org._id, n)
    const credit = await why('3000200004')
    expect(credit.ok).toBe(false)
    expect(credit.reason).toMatch(/credit_note/)
    expect((await why('3000200005')).reason).toMatch(/POST \/invoices\/:id\/void/) // the API does these, stock included
    expect((await why('3000200006')).reason).toMatch(/POST \/invoices\/:id\/void/)
    expect((await why('3000200007')).reason).toMatch(/not one this handles/)
    expect((await why('3000200008')).reason).toMatch(/outgoing/)
    expect((await why('3000200099')).reason).toMatch(/holds no INV-3000200099/)
    expect((await why('abc')).reason).toMatch(/digits only/)
    for (const n of ['3000200004', '3000200005', '3000200006', '3000200007', '3000200008', '3000200099', 'abc']) {
      expect((await why(n)).ok).toBe(false)
    }
  })

  it('refuses an invoice a live credit note already cancels; a voided credit note does not block it', async () => {
    const { org, contact } = await world()
    const inv = await paid(org._id, contact._id, '3000200003')
    const cn = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-3000200004', type: 'credit_note', status: 'sent', relatedInvoiceId: inv._id })

    const blocked = await planVoid(org._id, '3000200003')
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toMatch(/INV-3000200004.*twice/)

    await Invoice.updateOne({ _id: cn._id }, { $set: { status: 'voided' } })
    expect((await planVoid(org._id, '3000200003')).ok).toBe(true)
  })

  it("never reaches another org's invoice of the same number", async () => {
    const a = await world()
    const b = await world()
    await paid(b.org._id, b.contact._id, '3000200001')
    expect((await planVoid(a.org._id, '3000200001')).reason).toMatch(/holds no INV-3000200001/)
  })
})

async function cli(...args: string[]) {
  const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'void-annulled-invoices.ts'), ...args], {
    cwd: REPO,
    env: { ...process.env, MONGODB_URI: testDbUri() },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: out + err }
}

describe('void-annulled-invoices.ts', () => {
  it('a dry run shows the plan and writes nothing', async () => {
    const { org, contact } = await world()
    const inv = await paid(org._id, contact._id, '3000200001')
    const res = await cli('--org', org.slug, '--only', '3000200001')
    expect(res.code).toBe(0)
    expect(res.out).toContain('DRY-RUN')
    expect(res.out).toContain('Would void: 1')
    expect(res.out).toContain('--execute --expect 1')
    expect((await Invoice.findById(inv._id).lean() as any).status).toBe('paid')
  }, 60_000)

  it('--execute needs --expect to match the dry run, and one refused number stops the whole run', async () => {
    const { org, contact } = await world()
    const ok = await paid(org._id, contact._id, '3000200001')
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-3000200005', status: 'sent' })

    const noExpect = await cli('--org', org.slug, '--only', '3000200001', '--execute')
    expect(noExpect.code).toBe(2)
    expect(noExpect.out).toContain('--expect must be 1')

    const wrong = await cli('--org', org.slug, '--only', '3000200001', '--execute', '--expect', '2')
    expect(wrong.code).toBe(2)

    // One of the two named numbers is refused (the API voids a `sent` one): NOTHING is written.
    const mixed = await cli('--org', org.slug, '--only', '3000200001,3000200005', '--execute', '--expect', '1')
    expect(mixed.code).toBe(2)
    expect(mixed.out).toContain('nothing was written')
    expect((await Invoice.findById(ok._id).lean() as any).status).toBe('paid')
    expect(await AuditLog.countDocuments({ orgId: org._id })).toBe(0)
  }, 120_000)

  it('--execute --expect N voids exactly the named invoices, backs them up first, and leaves the rest', async () => {
    const { org, contact } = await world()
    const a = await paid(org._id, contact._id, '3000200001')
    const b = await paid(org._id, contact._id, '3000200003')
    const other = await paid(org._id, contact._id, '3000200002')
    const dir = mkdtempSync(join(tmpdir(), 'void-annulled-test-'))
    const backup = join(dir, 'backup.ndjson')
    try {
      const res = await cli('--org', org.slug, '--only', '3000200001,3000200003', '--execute', '--expect', '2', '--backup', backup)
      expect(res.code).toBe(0)
      expect(res.out).toContain('Voided: 2 | failed: 0')
      expect((await Invoice.findById(a._id).lean() as any).status).toBe('voided')
      expect((await Invoice.findById(b._id).lean() as any).status).toBe('voided')
      expect((await Invoice.findById(other._id).lean() as any).status).toBe('paid')
      expect(await AuditLog.countDocuments({ orgId: org._id, action: 'void' })).toBe(2)

      expect(existsSync(backup)).toBe(true)
      const lines = readFileSync(backup, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(lines[0].kind).toBe('header')
      expect(lines.slice(1).map(l => l.doc.invoiceNumber).sort()).toEqual(['INV-3000200001', 'INV-3000200003'])
      expect(lines.slice(1).every(l => l.doc.status === 'paid')).toBe(true) // the state BEFORE the change

      // Running it again reports them as already voided and is not an error.
      const again = await cli('--org', org.slug, '--only', '3000200001,3000200003')
      expect(again.code).toBe(0)
      expect(again.out).toContain('already voided: 2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
