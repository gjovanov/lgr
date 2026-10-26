import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestWarehouse, createTestContact, createTestInvoice,
  createTestPOSSession, createTestPOSTransaction,
} from '../helpers/factories'
import { exportSummarizedSales, exportPaymentDetails, suptoPeriod } from 'services/biz/supto-export.service'
import type { Types } from 'mongoose'

/**
 * FR-21 B-7 — a SUPTO export covers whole Bulgarian days.
 *
 * The controller read `dateTo=2026-10-21` as `new Date('2026-10-21')`: 00:00 UTC, the START of the
 * day. The POS tables window on `createdAt`, so a one-day export of them was empty and every
 * longer one lost its last day. Cash sales window on a date-only `issueDate` and were unaffected.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

async function seed() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const user = await createTestUser(orgId)
  const wh = await createTestWarehouse(orgId)
  const contact = await createTestContact(orgId)
  const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId)
  const txn = (number: string, at: string) => createTestPOSTransaction(orgId, session._id as Types.ObjectId, user._id as Types.ObjectId, {
    transactionNumber: number, createdAt: new Date(at), status: 'completed',
  } as any)
  // 14:00 in Sofia on the 21st, and 23:30 in Sofia on the 20th (still the 20th there).
  await txn('TXN-AFTERNOON', '2026-10-21T11:00:00.000Z')
  await txn('TXN-LATE-20TH', '2026-10-20T20:30:00.000Z')
  // 00:30 in Sofia on the 22nd: the next Bulgarian day.
  await txn('TXN-22ND', '2026-10-21T21:30:00.000Z')
  await createTestInvoice(orgId, contact._id as Types.ObjectId, {
    type: 'cash_sale', direction: 'outgoing', status: 'paid', invoiceNumber: 'CS-21', issueDate: new Date('2026-10-21'),
  } as any)
  return { orgId: String(orgId) }
}

describe('SUPTO export period (B-7)', () => {
  it('a one-day export lists the day\'s POS sales and cash sales, and only that day\'s', async () => {
    const s = await seed()
    const { transactions, cashSales } = await exportSummarizedSales({ orgId: s.orgId, ...suptoPeriod('2026-10-21', '2026-10-21') })
    expect(transactions.map((t: any) => t.transactionNumber)).toEqual(['TXN-AFTERNOON'])
    expect(cashSales.map((c: any) => c.invoiceNumber)).toEqual(['CS-21'])
  })

  it('the old reading of the same dates found no POS sale at all', async () => {
    const s = await seed()
    const old = { dateFrom: new Date('2026-10-21'), dateTo: new Date('2026-10-21') }
    const { transactions } = await exportSummarizedSales({ orgId: s.orgId, ...old })
    expect(transactions).toHaveLength(0)
  })

  it('a two-day export runs from Bulgarian midnight to the end of its last day', async () => {
    const s = await seed()
    const rows = await exportPaymentDetails({ orgId: s.orgId, ...suptoPeriod('2026-10-20', '2026-10-21') })
    expect(rows.map((t: any) => t.transactionNumber).sort()).toEqual(['TXN-AFTERNOON', 'TXN-LATE-20TH'])
  })
})
