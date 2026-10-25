import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestWarehouse, createTestAccount,
  createTestPOSSession, createTestPOSTransaction,
} from '../helpers/factories'
import { Journal, JournalEntry, Org, POSSession, StockMovement } from 'db/models'
import { createPOSSessionJournalEntry } from 'services/biz/auto-journal.service'
import { registerEventHandlers, resetEventHandlers } from 'services/events/handlers'
import { eventBus } from 'services/events/event-bus'
import type { Types } from 'mongoose'

/**
 * FR-21.2 — the POS session's journal entry, under test for the first time.
 *
 * It had four defects, none of them ever exercised: a stornoed sale went out twice (B-1), a
 * discount was added to revenue twice, change was debited as cash, and the over/short line had no
 * other side. Each case below is one of those, plus the rules that replaced them: revenue and VAT
 * from each row's own total, the money as what the drawer kept, and no POS-OUT batch (FR-21.4).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { resetEventHandlers(); await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

async function setup() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const user = await createTestUser(orgId)
  const wh = await createTestWarehouse(orgId)
  const receivable = await createTestAccount(orgId, { name: 'Receivable', type: 'asset' })
  const revenue = await createTestAccount(orgId, { name: 'Revenue', type: 'revenue', subType: 'operating_revenue' } as any)
  const overShort = await createTestAccount(orgId, { name: 'Cash over/short', type: 'expense', subType: 'operating_expense' } as any)
  const journal = await Journal.create({ orgId, name: 'Sales', code: `S${Date.now() % 100000}`, type: 'sale' })
  const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId, {
    sessionNumber: 'POS-2026-000001', status: 'closed',
  })
  return { orgId, user, wh, receivable, revenue, overShort, journal, session }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** A POS row as the controller stores it. */
function row(over: Record<string, any>) {
  return { type: 'sale', status: 'completed', changeDue: 0, ...over }
}

function je(s: Setup, transactions: any[], opts: { session?: any; overShort?: boolean } = {}) {
  return createPOSSessionJournalEntry(
    String(s.orgId),
    { ...(opts.session ?? s.session).toObject(), id: String((opts.session ?? s.session)._id) },
    transactions,
    {
      receivableAccountId: String(s.receivable._id),
      revenueAccountId: String(s.revenue._id),
      ...(opts.overShort ? { cashOverShortAccountId: String(s.overShort._id) } : {}),
    },
    { journalId: String(s.journal._id) },
    false,
  )
}

/** The entry's lines as `{ description: [debit, credit] }`, and its totals. */
function view(entry: any) {
  const lines: Record<string, [number, number]> = {}
  for (const l of entry.lines) lines[l.description.split(':')[0]] = [l.debit, l.credit]
  return { lines, totalDebit: entry.totalDebit, totalCredit: entry.totalCredit }
}

describe('POS session journal entry (FR-21.2)', () => {
  it('a cash sale: cash debited, revenue and VAT credited, balanced', async () => {
    const s = await setup()
    const res = await je(s, [row({ total: 120, taxTotal: 20, subtotal: 100, payments: [{ method: 'cash', amount: 120 }] })])
    const v = view(res!.journalEntry)
    expect(v.lines['POS Cash']).toEqual([120, 0])
    expect(v.lines['POS Revenue']).toEqual([0, 100])
    expect(v.lines['POS Tax']).toEqual([0, 20])
    expect(v.totalDebit).toBe(120)
    expect(v.totalCredit).toBe(120)
    // Linked back to its session.
    expect(String((await POSSession.findById(s.session._id).lean())!.journalEntryId)).toBe(String(res!.journalEntry.id))
  })

  it('change is not cash: tendered 50 for 37.20 debits 37.20', async () => {
    const s = await setup()
    const res = await je(s, [row({ total: 37.2, taxTotal: 6.2, subtotal: 31, payments: [{ method: 'cash', amount: 50 }], changeDue: 12.8 })])
    const v = view(res!.journalEntry)
    expect(v.lines['POS Cash']).toEqual([37.2, 0])
    expect(v.totalDebit).toBe(v.totalCredit)
  })

  it('a discount is not added twice: revenue is the net after it', async () => {
    const s = await setup()
    // computePosTotals: subtotal is BEFORE the discount, total and VAT after it.
    const res = await je(s, [row({ subtotal: 100, discountTotal: 10, taxTotal: 18, total: 108, payments: [{ method: 'card', amount: 108 }] })])
    const v = view(res!.journalEntry)
    expect(v.lines['POS Revenue']).toEqual([0, 90])
    expect(v.lines['POS Tax']).toEqual([0, 18])
    expect(v.lines['POS Card']).toEqual([108, 0])
    expect(v.totalDebit).toBe(108)
    expect(v.totalCredit).toBe(108)
  })

  it('splits the money by method: card as paid, cash the rest', async () => {
    const s = await setup()
    const res = await je(s, [row({ total: 120, taxTotal: 20, payments: [{ method: 'card', amount: 70 }, { method: 'cash', amount: 60 }], changeDue: 10 })])
    const v = view(res!.journalEntry)
    expect(v.lines['POS Card']).toEqual([70, 0])
    expect(v.lines['POS Cash']).toEqual([50, 0])
    expect(v.totalDebit).toBe(120)
  })

  it('B-1: a sale stornoed in the same session nets to nothing — no entry', async () => {
    const s = await setup()
    // The state the storno route leaves: the sale `cancelled`, the storno `completed`.
    const res = await je(s, [
      row({ status: 'cancelled', total: 120, taxTotal: 20, payments: [{ method: 'cash', amount: 120 }] }),
      row({ type: 'storno', total: 120, taxTotal: 20, payments: [{ method: 'cash', amount: 120 }] }),
    ])
    expect(res).toBeNull()
    expect(await JournalEntry.countDocuments({ orgId: s.orgId })).toBe(0)
  })

  it('B-1: a storno in a later session — the sale session still counts the sale, the later one reverses it', async () => {
    const s = await setup()
    const sold = await je(s, [row({ status: 'cancelled', total: 120, taxTotal: 20, payments: [{ method: 'cash', amount: 120 }] })])
    expect(view(sold!.journalEntry).lines['POS Revenue']).toEqual([0, 100])

    const later = await createTestPOSSession(s.orgId, s.wh._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      sessionNumber: 'POS-2026-000002', status: 'closed',
    })
    const reversed = await je(s, [row({ type: 'storno', total: 120, taxTotal: 20, payments: [{ method: 'cash', amount: 120 }] })], { session: later })
    const v = view(reversed!.journalEntry)
    expect(v.lines['POS Cash']).toEqual([0, 120])
    expect(v.lines['POS Revenue']).toEqual([100, 0])
    expect(v.lines['POS Tax']).toEqual([20, 0])
    expect(v.totalDebit).toBe(v.totalCredit)
  })

  it('a storno whose receipt failed (cancelled) reverses nothing', async () => {
    const s = await setup()
    const res = await je(s, [
      row({ total: 120, taxTotal: 20, payments: [{ method: 'cash', amount: 120 }] }),
      row({ type: 'storno', status: 'cancelled', total: 120, taxTotal: 20, payments: [{ method: 'cash', amount: 120 }] }),
    ])
    expect(view(res!.journalEntry).lines['POS Revenue']).toEqual([0, 100])
  })

  it('over/short posts as a balanced pair against the configured account', async () => {
    const s = await setup()
    const short = await POSSession.findByIdAndUpdate(s.session._id, { difference: -2 }, { new: true })
    const res = await je(s, [row({ total: 120, taxTotal: 20, payments: [{ method: 'cash', amount: 120 }] })], { session: short, overShort: true })
    const entry = res!.journalEntry
    const overShortLine = entry.lines.find((l: any) => String(l.accountId) === String(s.overShort._id))
    expect(overShortLine).toMatchObject({ debit: 2, credit: 0 })
    expect(entry.lines.some((l: any) => l.description.startsWith('Cash over/short') && l.credit === 2)).toBe(true)
    expect(entry.totalDebit).toBe(122)
    expect(entry.totalCredit).toBe(122)
  })

  it('without an over/short account the difference is not posted, and the entry still balances', async () => {
    const s = await setup()
    const over = await POSSession.findByIdAndUpdate(s.session._id, { difference: 3 }, { new: true })
    const res = await je(s, [row({ total: 120, taxTotal: 20, payments: [{ method: 'cash', amount: 120 }] })], { session: over })
    const entry = res!.journalEntry
    expect(entry.lines.some((l: any) => /over|short/i.test(l.description))).toBe(false)
    expect(entry.totalDebit).toBe(120)
    expect(entry.totalCredit).toBe(120)
  })
})

describe('the pos.session.closed handler', () => {
  it('posts the entry with the org\'s over/short account, and creates no POS-OUT batch (FR-21.4)', async () => {
    const s = await setup()
    await Org.updateOne({ _id: s.orgId }, {
      $set: {
        'settings.accounting.defaultSaleJournalId': s.journal._id,
        'settings.accounting.defaultReceivableAccountId': s.receivable._id,
        'settings.accounting.defaultRevenueAccountId': s.revenue._id,
        'settings.accounting.cashOverShortAccountId': s.overShort._id,
        // With an inventory account the old handler wrote a POS-OUT dispatch.
        'settings.inventory.defaultInventoryAccountId': s.receivable._id,
      },
    })
    await POSSession.updateOne({ _id: s.session._id }, { difference: -1 })
    await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
      total: 60, taxTotal: 10, subtotal: 50, payments: [{ method: 'cash', amount: 60 }],
      lines: [{ productId: s.wh._id, name: 'x', quantity: 1, unitPrice: 50, discount: 0, taxRate: 20, taxAmount: 10, lineTotal: 50 }] as any,
    })

    registerEventHandlers()
    eventBus.emit('pos.session.closed', { sessionId: String(s.session._id), orgId: String(s.orgId), userId: String(s.user._id) })

    let session: any = null
    for (let i = 0; i < 50 && !session?.journalEntryId; i++) {
      await new Promise(r => setTimeout(r, 100))
      session = await POSSession.findById(s.session._id).lean()
    }
    expect(session?.journalEntryId).toBeTruthy()
    const entry = await JournalEntry.findById(session.journalEntryId).lean() as any
    expect(entry.totalDebit).toBe(61)
    expect(entry.totalCredit).toBe(61)
    expect(entry.lines.some((l: any) => String(l.accountId) === String(s.overShort._id) && l.debit === 1)).toBe(true)
    expect(session.batchMovementId).toBeUndefined()
    expect(await StockMovement.countDocuments({ orgId: s.orgId, movementNumber: /^POS-OUT-/ })).toBe(0)
  })
})
