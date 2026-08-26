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
  createTestStockMovement,
} from '../helpers/factories'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { renderDigestHtml, digestSubject, DIGEST_I18N } from 'services/biz/digest/daily-digest.render'
import { isSectionError, DIGEST_CAPS } from 'services/biz/digest/daily-digest.types'
import { runDigestForOrg, resolveRecipients, STALE_CLAIM_MS } from 'services/biz/digest/digest-runner.service'
import { DigestRun, Org, User } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'
import type { Types } from 'mongoose'

/**
 * FR-11 (#21) — the daily digest end to end, minus the mail provider.
 *
 * NOTE: no `.rejects` / `.resolves` anywhere — those matchers deadlock under Bun on Windows
 * when the rejection follows driver I/O (see Known Issues).
 *
 * The scheduler itself is inert here: `DIGEST_CHECK_INTERVAL_MS=0` in `.env.test` means
 * `unified.ts` never starts an interval, so these tests drive the runner directly.
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const DAY = '2026-08-25'
const dayDate = (h = 10) => new Date(`${DAY}T${String(h).padStart(2, '0')}:00:00.000`)

/** A day with something of everything the digest is supposed to notice. */
async function seedDay() {
  const org = await createTestOrg({ settings: { locale: 'bg', timezone: 'Europe/Sofia' } } as any)
  const orgId = org._id as Types.ObjectId
  const customer = await createTestContact(orgId, { companyName: 'Buyer Ltd' })
  const wh = await createTestWarehouse(orgId, { name: 'Main' })
  const bolt = await createTestProduct(orgId, { sku: 'BOLT-1', name: 'Bolt' })
  const nut = await createTestProduct(orgId, { sku: 'NUT-1', name: 'Nut' })

  // Two sales + one cash sale on the day.
  await createTestInvoice(orgId, customer._id as Types.ObjectId, {
    invoiceNumber: 'INV-2026-00010', type: 'invoice', direction: 'outgoing', status: 'paid',
    issueDate: dayDate(), subtotal: 100, taxTotal: 20, total: 120, amountPaid: 120, amountDue: 0,
    paymentMethod: 'cash',
    lines: [{ productId: bolt._id, warehouseId: wh._id, description: 'Bolt', quantity: 2, unit: 'pcs', unitPrice: 50, taxRate: 20, taxAmount: 20, lineTotal: 120 }] as any,
  })
  await createTestInvoice(orgId, customer._id as Types.ObjectId, {
    invoiceNumber: 'INV-2026-00012', type: 'invoice', direction: 'outgoing', status: 'sent',
    issueDate: dayDate(11), subtotal: 50, taxTotal: 10, total: 60, amountDue: 60,
    paymentMethod: 'card',
    lines: [{ productId: nut._id, warehouseId: wh._id, description: 'Nut', quantity: 1, unit: 'pcs', unitPrice: 50, taxRate: 20, taxAmount: 10, lineTotal: 60 }] as any,
  })
  await createTestInvoice(orgId, customer._id as Types.ObjectId, {
    invoiceNumber: 'CS-2026-00003', type: 'cash_sale', direction: 'outgoing', status: 'paid',
    issueDate: dayDate(12), subtotal: 30, taxTotal: 6, total: 36, amountPaid: 36, amountDue: 0,
    lines: [] as any,
  })
  // A draft must not appear anywhere — it is not a document yet.
  await createTestInvoice(orgId, customer._id as Types.ObjectId, {
    invoiceNumber: 'DRF-INV-2026-00099', type: 'invoice', direction: 'outgoing', status: 'draft',
    issueDate: dayDate(13), total: 999,
  })

  // A correction (write-off) out of the warehouse — the signed row.
  await createTestStockMovement(orgId, {
    movementNumber: 'ADJ-1', type: 'adjustment', status: 'completed', date: dayDate(9),
    fromWarehouseId: wh._id, notes: 'sklisk: 2026-08-25 write-off',
    lines: [{ productId: bolt._id, quantity: 3, unitCost: 2, totalCost: 6 }] as any,
  })
  // A dispatch and a receipt, for the materials section.
  await createTestStockMovement(orgId, {
    movementNumber: 'SM-OUT', type: 'dispatch', status: 'completed', date: dayDate(10),
    fromWarehouseId: wh._id,
    lines: [{ productId: bolt._id, quantity: 2, unitCost: 50, totalCost: 100 }] as any,
  })
  await createTestStockMovement(orgId, {
    movementNumber: 'SM-IN', type: 'receipt', status: 'completed', date: dayDate(8),
    toWarehouseId: wh._id,
    lines: [{ productId: nut._id, quantity: 10, unitCost: 3, totalCost: 30 }] as any,
  })
  // A transfer — the block FR-07 deliberately excludes, which is why the digest re-derives it.
  await createTestStockMovement(orgId, {
    movementNumber: 'SM-TR', type: 'transfer', status: 'completed', date: dayDate(14),
    fromWarehouseId: wh._id,
    lines: [{ productId: bolt._id, quantity: 5, unitCost: 2, totalCost: 10 }] as any,
  })

  // One product sitting at zero and one gone negative — stock CAN go negative here.
  await createTestStockLevel(orgId, bolt._id as Types.ObjectId, wh._id as Types.ObjectId, { quantity: 0, avgCost: 2 })
  await createTestStockLevel(orgId, nut._id as Types.ObjectId, wh._id as Types.ObjectId, { quantity: -4, avgCost: 3 })

  return { orgId: String(orgId), org, wh, bolt, nut, customer }
}

describe('digest content (FR-11.7 …)', () => {
  it('reports the day\'s KPIs, and the register totals equal them', async () => {
    const { orgId } = await seedDay()
    const d = await buildDailyDigest(orgId, DAY)

    const k: any = d.kpis
    const docs: any = d.documents
    expect(isSectionError(k)).toBe(false)
    expect(isSectionError(docs)).toBe(false)

    expect(k.salesCount).toBe(2)
    expect(k.salesTotal).toBe(180)
    expect(k.cashCount).toBe(1)
    expect(k.cashTotal).toBe(36)

    // FR-11.7a: family totals MUST equal the KPI totals.
    expect(docs.sales.total).toBe(k.salesTotal)
    expect(docs.cash.total).toBe(k.cashTotal)
    expect(docs.sales.count).toBe(k.salesCount)
  })

  it('splits the register by effective payment method', async () => {
    const { orgId } = await seedDay()
    const k: any = (await buildDailyDigest(orgId, DAY)).kpis
    const methods = Object.fromEntries(k.byMethod.map((m: any) => [m.method, m.amount]))
    expect(methods.cash).toBeGreaterThan(0)
    expect(methods.card).toBe(60)
  })

  it('ignores drafts entirely — they are outside the issued sequence', async () => {
    const { orgId } = await seedDay()
    const docs: any = (await buildDailyDigest(orgId, DAY)).documents
    const numbers = docs.sales.rows.map((r: any) => r.number)
    expect(numbers).not.toContain('DRF-INV-2026-00099')
    expect(docs.sales.sequence.count).toBe(2)
  })

  it('flags a number absent from the day\'s range (the „липсваща разписка" class)', async () => {
    const { orgId } = await seedDay()
    const seq: any = ((await buildDailyDigest(orgId, DAY)).documents as any).sales.sequence
    // Seeded 00010 and 00012 — 00011 was never issued.
    expect(seq.min).toBe('INV-2026-00010')
    expect(seq.max).toBe('INV-2026-00012')
    expect(seq.missing).toContain('11')
  })

  it('summarises materials as sold / transferred / loaded', async () => {
    const { orgId } = await seedDay()
    const m: any = (await buildDailyDigest(orgId, DAY)).materials

    expect(m.sold.rowCount).toBe(1)
    expect(m.sold.rows[0].sku).toBe('BOLT-1')
    expect(m.sold.totalValue).toBe(100)

    // The transfer block exists precisely because FR-07 excludes transfers by design.
    expect(m.transferred.rowCount).toBe(1)
    expect(m.loaded.rowCount).toBe(1)
    expect(m.loaded.rows[0].sku).toBe('NUT-1')
  })

  it('lists stock at or below zero, negatives included', async () => {
    const { orgId } = await seedDay()
    const s: any = (await buildDailyDigest(orgId, DAY)).stock
    expect(s.count).toBe(2)
    // Sorted most-negative first — the worst case is the one you want to see.
    expect(s.rows[0].quantity).toBe(-4)
  })

  it('signs a write-off negative (fromWarehouseId ⇒ −|qty|)', async () => {
    const { orgId } = await seedDay()
    const c: any = (await buildDailyDigest(orgId, DAY)).corrections
    expect(c.count).toBe(1)
    expect(c.rows[0].movementNumber).toBe('ADJ-1')
    expect(c.rows[0].kind).toBe('writeOff')
    expect(c.rows[0].quantity).toBe(-3)
    expect(c.rows[0].value).toBe(-6)
  })

  it('finds a sale whose lines name a product and warehouse but moved no stock', async () => {
    const { orgId } = await seedDay()
    const u: any = (await buildDailyDigest(orgId, DAY)).undocumentedSales
    // Both seeded invoices have product+warehouse lines and no movement linked by invoiceId.
    expect(u.count).toBe(2)
    expect(u.rows.map((r: any) => r.number)).toContain('INV-2026-00010')
  })

  it('mutes import-born rows instead of alarming about them', async () => {
    const { orgId, customer } = await seedDay()
    const org = await Org.findById(orgId).lean() as any
    await createTestInvoice(org._id, customer._id as Types.ObjectId, {
      invoiceNumber: 'CSR-2026-00001', type: 'cash_sale', direction: 'outgoing', status: 'paid',
      issueDate: dayDate(15), total: 10, tags: ['cash-register-import'],
      lines: [{ productId: (await createTestProduct(org._id, {}))._id, warehouseId: (await createTestWarehouse(org._id, {}))._id, description: 'x', quantity: 1, unit: 'pcs', unitPrice: 10, taxRate: 0, taxAmount: 0, lineTotal: 10 }] as any,
    })

    const u: any = (await buildDailyDigest(orgId, DAY)).undocumentedSales
    const row = u.rows.find((r: any) => r.number === 'CSR-2026-00001')
    expect(row?.imported).toBe(true)
    expect(u.importedCount).toBe(1)
  })

  it('is org-scoped', async () => {
    const { orgId } = await seedDay()
    const other = await createTestOrg({ slug: `other-${Date.now()}` } as any)
    const c = await createTestContact(other._id as Types.ObjectId)
    await createTestInvoice(other._id as Types.ObjectId, c._id as Types.ObjectId, {
      invoiceNumber: 'FOREIGN-1', issueDate: dayDate(), total: 5000, status: 'paid',
    })

    const k: any = (await buildDailyDigest(orgId, DAY)).kpis
    expect(k.salesTotal).toBe(180)
  })

  it('still produces a digest for a day with nothing in it', async () => {
    const org = await createTestOrg()
    const d = await buildDailyDigest(String(org._id), '2020-01-01')
    expect(d.allClear).toBe(true)
    const html = renderDigestHtml(d)
    expect(html).toContain(DIGEST_I18N.en.allClear)
  })
})

describe('digest rendering (FR-11.14)', () => {
  it('renders the org locale, not the server default', async () => {
    const { orgId } = await seedDay()
    const d = await buildDailyDigest(orgId, DAY)
    expect(d.locale).toBe('bg')
    const html = renderDigestHtml(d)
    expect(html).toContain(DIGEST_I18N.bg.kpis)
    expect(digestSubject(d)).toContain('25.08.2026')
  })

  it('escapes counterparty names — a digest is HTML mailed to people', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const evil = await createTestContact(orgId, { companyName: '<script>alert(1)</script>' })
    await createTestInvoice(orgId, evil._id as Types.ObjectId, {
      invoiceNumber: 'INV-X', issueDate: dayDate(), total: 10, status: 'paid',
    })

    const html = renderDigestHtml(await buildDailyDigest(String(orgId), DAY))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders a failed section inline instead of losing the whole mail', async () => {
    const html = renderDigestHtml({
      orgId: 'x', orgName: 'Acme', date: DAY, locale: 'en', timezone: 'UTC',
      generatedAt: new Date().toISOString(), allClear: false,
      kpis: { failed: true, message: 'kpis: boom' } as any,
    })
    expect(html).toContain('boom')
    expect(html).toContain(DIGEST_I18N.en.sectionFailed)
  })
})

describe('run claiming and idempotency (FR-11.4/11.6)', () => {
  async function enableDigest(orgId: string, userIds: string[]) {
    await Org.updateOne(
      { _id: orgId },
      { $set: { 'settings.dailyDigest': { enabled: true, hour: 7, recipients: userIds.map(id => ({ userId: id })) } } },
    ).exec()
  }

  it('claims a day once — a second run finds it taken', async () => {
    const { orgId } = await seedDay()
    const user = await createTestUser(orgId as any, { email: 'a@test.local' })
    await enableDigest(orgId, [String(user._id)])

    const first = await runDigestForOrg(orgId, '2026-08-26')
    const second = await runDigestForOrg(orgId, '2026-08-26')

    expect(first).not.toBeNull()
    expect(second).toBeNull() // claim held — not an error, just not ours
    expect(await DigestRun.countDocuments({ orgId, date: '2026-08-26' })).toBe(1)
  })

  it('records `skipped` with a reason when nobody is configured to receive it', async () => {
    const { orgId } = await seedDay()
    await enableDigest(orgId, [])

    const outcome = await runDigestForOrg(orgId, '2026-08-26')
    expect(outcome?.status).toBe('skipped')
    expect(outcome?.reason).toBe('no_recipients')

    const run = await DigestRun.findOne({ orgId, date: '2026-08-26' }).lean() as any
    expect(run.status).toBe('skipped')
    expect(run.completedAt).toBeTruthy()
  })

  it('records `skipped: email_not_configured` — the run doc is the only trace of that', async () => {
    // With no SENDGRID_API_KEY (the test env has none) sendEmail early-returns and writes NO
    // EmailLog row, so if the run document did not record this, nothing would.
    const { orgId } = await seedDay()
    const user = await createTestUser(orgId as any, { email: 'b@test.local' })
    await enableDigest(orgId, [String(user._id)])

    const outcome = await runDigestForOrg(orgId, '2026-08-26')
    expect(outcome?.status).toBe('skipped')
    expect(outcome?.reason).toBe('email_not_configured')
    expect(outcome?.recipients).toHaveLength(1)
    expect(outcome?.recipients[0].ok).toBe(false)
  })

  it('takes over a claim that died mid-send, but only once it is stale', async () => {
    const { orgId } = await seedDay()
    const user = await createTestUser(orgId as any, { email: 'c@test.local' })
    await enableDigest(orgId, [String(user._id)])

    // A crashed runner: claimed, never completed.
    await DigestRun.create({
      orgId, date: '2026-08-26', status: 'running', startedAt: new Date(),
    })
    expect(await runDigestForOrg(orgId, '2026-08-26')).toBeNull() // fresh claim — hands off

    await DigestRun.updateOne(
      { orgId, date: '2026-08-26' },
      { $set: { startedAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000) } },
    ).exec()

    const outcome = await runDigestForOrg(orgId, '2026-08-26')
    expect(outcome).not.toBeNull()
    expect(await DigestRun.countDocuments({ orgId, date: '2026-08-26' })).toBe(1)
  })

  it('resolves recipients at send time and drops deactivated users', async () => {
    const { orgId } = await seedDay()
    const active = await createTestUser(orgId as any, { email: 'active@test.local' })
    const gone = await createTestUser(orgId as any, { email: 'gone@test.local', isActive: false })

    const list = await resolveRecipients(orgId, {
      recipients: [{ userId: String(active._id) }, { userId: String(gone._id) }],
    })
    expect(list.map(r => r.email)).toEqual(['active@test.local'])
  })

  it('ignores a recipient id that no longer resolves to a user', async () => {
    const { orgId } = await seedDay()
    const real = await createTestUser(orgId as any, { email: 'real@test.local' })
    const list = await resolveRecipients(orgId, {
      recipients: [{ userId: String(real._id) }, { userId: '6a8ee04f6355248b5bfbe4c1' }],
    })
    expect(list.map(r => r.email)).toEqual(['real@test.local'])
  })
})

describe('FR-11.3 — the user list must not ship password hashes', () => {
  it('omits `password` from the list endpoint projection', async () => {
    const org = await createTestOrg()
    await createTestUser(org._id as any, { email: 'x@test.local' })

    // Exactly what the controller does.
    const result = await paginateQuery(User as any, { orgId: org._id }, {}, { select: '-password' })
    expect(result.items.length).toBeGreaterThan(0)
    for (const u of result.items as any[]) {
      expect(u.password).toBeUndefined()
      expect(u.email).toBeTruthy() // …while still returning what the picker needs
    }
  })

  it('would otherwise have returned one — the regression this guards', async () => {
    const org = await createTestOrg()
    await createTestUser(org._id as any, { email: 'y@test.local' })
    const unprojected = await paginateQuery(User as any, { orgId: org._id }, {})
    expect((unprojected.items[0] as any).password).toBeTruthy()
  })
})

describe('caps (edge case 6)', () => {
  it('caps the stock list and reports the remainder', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    for (let i = 0; i < DIGEST_CAPS.stock + 5; i++) {
      const p = await createTestProduct(orgId, { sku: `Z-${i}`, name: `Zero ${i}` })
      await createTestStockLevel(orgId, p._id as Types.ObjectId, wh._id as Types.ObjectId, { quantity: 0, avgCost: 1 })
    }

    const s: any = (await buildDailyDigest(String(orgId), DAY)).stock
    expect(s.rows).toHaveLength(DIGEST_CAPS.stock)
    expect(s.count).toBe(DIGEST_CAPS.stock + 5)
    expect(s.more).toBe(5)
  })
})
