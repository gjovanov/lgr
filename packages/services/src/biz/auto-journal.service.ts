/**
 * Auto-Journal Service
 * Creates properly balanced journal entries for cross-module events:
 * - Invoice posting → revenue/receivable entries
 * - Payment recording → cash/bank entries
 * - Stock movement confirmation → inventory/COGS entries
 * - POS session close → the session's revenue, VAT and money (FR-21.2)
 */
import { getRepos } from '../context.js'
import { ensureFiscalPeriod } from './accounting.service.js'
import { getNextNumber } from './sequence.service.js'
import { keptByMethod, posRowSign, type MethodTotals } from './cash-register/counting.js'
import { logger } from '../logger/logger.js'
import type { RepositoryRegistry } from 'dal'

interface DefaultAccounts {
  receivableAccountId?: string
  payableAccountId?: string
  revenueAccountId?: string
  expenseAccountId?: string
  inventoryAccountId?: string
  cogsAccountId?: string
  /**
   * #362: where VAT goes — output VAT (sales) and input VAT (purchases). Unset, the tax line falls
   * back to the revenue / expense account, as every entry did before these existed.
   */
  outputVatAccountId?: string
  inputVatAccountId?: string
}

interface JournalRef {
  journalId?: string
}

interface JELine {
  accountId: string
  description: string
  debit: number
  credit: number
  currency: string
  exchangeRate: number
  baseDebit: number
  baseCredit: number
  contactId?: string
}

function buildLine(accountId: string, description: string, debit: number, credit: number, currency: string, exchangeRate: number, contactId?: string): JELine {
  return {
    accountId,
    description,
    debit,
    credit,
    currency,
    exchangeRate,
    baseDebit: Math.round(debit * exchangeRate * 100) / 100,
    baseCredit: Math.round(credit * exchangeRate * 100) / 100,
    contactId,
  }
}

/**
 * Fix floating-point rounding so totalDebit === totalCredit.
 * Adjusts the largest line by the difference (max 0.01).
 */
function balanceLines(lines: JELine[]): { lines: JELine[]; totalDebit: number; totalCredit: number } {
  let totalDebit = lines.reduce((s, l) => s + l.baseDebit, 0)
  let totalCredit = lines.reduce((s, l) => s + l.baseCredit, 0)
  totalDebit = Math.round(totalDebit * 100) / 100
  totalCredit = Math.round(totalCredit * 100) / 100

  const diff = Math.round((totalDebit - totalCredit) * 100) / 100
  if (diff !== 0 && Math.abs(diff) <= 0.01) {
    // Adjust the largest debit or credit line
    if (diff > 0) {
      const largest = lines.reduce((max, l) => l.baseDebit > max.baseDebit ? l : max, lines[0])
      largest.baseDebit = Math.round((largest.baseDebit - diff) * 100) / 100
      largest.debit = Math.round((largest.debit - diff / (largest.exchangeRate || 1)) * 100) / 100
    } else {
      const largest = lines.reduce((max, l) => l.baseCredit > max.baseCredit ? l : max, lines[0])
      largest.baseCredit = Math.round((largest.baseCredit + diff) * 100) / 100
      largest.credit = Math.round((largest.credit + diff / (largest.exchangeRate || 1)) * 100) / 100
    }
    totalDebit = Math.round(lines.reduce((s, l) => s + l.baseDebit, 0) * 100) / 100
    totalCredit = Math.round(lines.reduce((s, l) => s + l.baseCredit, 0) * 100) / 100
  }

  return { lines, totalDebit, totalCredit }
}

// ── Invoice Posted ──

export async function createInvoiceJournalEntry(
  orgId: string,
  invoice: any,
  accounts: DefaultAccounts,
  journal: JournalRef,
  autoPost: boolean,
  r?: RepositoryRegistry,
): Promise<any | null> {
  const repos = r ?? getRepos()

  const isOutgoing = invoice.direction === 'outgoing'
  const isCreditNote = invoice.type === 'credit_note'

  // Determine accounts
  const counterpartAccountId = isOutgoing ? accounts.receivableAccountId : accounts.payableAccountId
  const revenueAccountId = isOutgoing ? accounts.revenueAccountId : accounts.expenseAccountId
  if (!counterpartAccountId || !revenueAccountId) {
    logger.warn({ orgId, invoiceId: invoice.id }, 'Auto-journal skipped: missing default accounts')
    return null
  }

  const taxAccountId = (isOutgoing ? accounts.outputVatAccountId : accounts.inputVatAccountId) || revenueAccountId

  const currency = invoice.currency || 'EUR'
  const rate = invoice.exchangeRate || 1
  const lines: JELine[] = []

  // Revenue/expense lines from invoice lines
  let totalRevenue = 0
  let totalTax = 0
  for (const line of (invoice.lines || [])) {
    const lineAmount = (line.lineTotal || 0) - (line.taxAmount || 0)
    totalRevenue += lineAmount
    totalTax += (line.taxAmount || 0)
  }

  // For credit notes, reverse the direction
  const sign = isCreditNote ? -1 : 1

  if (isOutgoing) {
    // Outgoing: DR Receivable / CR Revenue + CR Tax
    lines.push(buildLine(counterpartAccountId, `Receivable: ${invoice.invoiceNumber}`, sign * invoice.total, 0, currency, rate, invoice.contactId))
    lines.push(buildLine(revenueAccountId, `Revenue: ${invoice.invoiceNumber}`, 0, sign * totalRevenue, currency, rate))
    if (totalTax > 0) {
      lines.push(buildLine(taxAccountId, `Tax: ${invoice.invoiceNumber}`, 0, sign * totalTax, currency, rate))
    }
  } else {
    // Incoming: DR Expense / CR Payable + DR Tax
    lines.push(buildLine(revenueAccountId, `Expense: ${invoice.invoiceNumber}`, sign * totalRevenue, 0, currency, rate))
    if (totalTax > 0) {
      lines.push(buildLine(taxAccountId, `Tax: ${invoice.invoiceNumber}`, sign * totalTax, 0, currency, rate))
    }
    lines.push(buildLine(counterpartAccountId, `Payable: ${invoice.invoiceNumber}`, 0, sign * invoice.total, currency, rate, invoice.contactId))
  }

  // Handle negative amounts from credit notes by swapping DR/CR
  for (const line of lines) {
    if (line.debit < 0) { line.credit = -line.debit; line.debit = 0; line.baseCredit = -line.baseDebit; line.baseDebit = 0 }
    if (line.credit < 0) { line.debit = -line.credit; line.credit = 0; line.baseDebit = -line.baseCredit; line.baseCredit = 0 }
  }

  const { lines: balanced, totalDebit, totalCredit } = balanceLines(lines)

  try {
    const fiscalPeriodId = await ensureFiscalPeriod(orgId, invoice.issueDate || new Date(), repos)
    const entryNumber = await getNextNumber(orgId, 'JE', 5)

    const je = await repos.journalEntries.create({
      orgId,
      journalId: journal.journalId,
      entryNumber,
      date: invoice.issueDate || new Date(),
      fiscalPeriodId,
      description: `${isOutgoing ? 'Sales' : 'Purchase'} ${isCreditNote ? 'credit note' : 'invoice'}: ${invoice.invoiceNumber}`,
      type: 'standard',
      status: autoPost ? 'posted' : 'draft',
      lines: balanced,
      totalDebit,
      totalCredit,
      sourceModule: 'invoicing',
      sourceId: invoice.id,
      createdBy: invoice.createdBy || orgId,
      ...(autoPost ? { postedBy: invoice.createdBy || orgId, postedAt: new Date() } : {}),
    } as any)

    return je
  } catch (err: any) {
    logger.error({ orgId, invoiceId: invoice.id, error: err.message }, 'Failed to create invoice journal entry')
    return null
  }
}

// ── Payment Recorded ──

export async function createPaymentJournalEntry(
  orgId: string,
  invoice: any,
  payment: { amount: number; method: string; date?: Date },
  accounts: DefaultAccounts,
  journal: JournalRef,
  autoPost: boolean,
  r?: RepositoryRegistry,
): Promise<any | null> {
  const repos = r ?? getRepos()

  const isOutgoing = invoice.direction === 'outgoing'
  // FR-23 §2.5: a credit note's payment goes the other way. Ours is money OUT: it clears what we owe
  // the customer, which its posting put against the receivable. A supplier's is money IN.
  const moneyIn = isOutgoing !== (invoice.type === 'credit_note')
  const counterpartAccountId = isOutgoing ? accounts.receivableAccountId : accounts.payableAccountId
  // Cash/bank account from journal defaults
  const cashAccountId = journal.journalId
    ? (await repos.journals.findById(journal.journalId) as any)?.defaultDebitAccountId
    : null

  if (!counterpartAccountId || !cashAccountId) {
    logger.warn({ orgId, invoiceId: invoice.id }, 'Auto-journal skipped for payment: missing accounts')
    return null
  }

  const currency = invoice.currency || 'EUR'
  const rate = invoice.exchangeRate || 1
  const payDate = payment.date ? new Date(payment.date) : new Date()
  const lines: JELine[] = []

  const counterpart = isOutgoing ? 'receivable' : 'payable'
  if (moneyIn) {
    // DR Cash/Bank / CR Receivable (a sale's payment), or CR Payable (a supplier's refund)
    lines.push(buildLine(cashAccountId, `Payment received: ${invoice.invoiceNumber}`, payment.amount, 0, currency, rate))
    lines.push(buildLine(counterpartAccountId, `Clear ${counterpart}: ${invoice.invoiceNumber}`, 0, payment.amount, currency, rate, invoice.contactId))
  } else {
    // DR Payable / CR Cash/Bank (a bill's payment), or DR Receivable (a refund to a customer)
    lines.push(buildLine(counterpartAccountId, `Clear ${counterpart}: ${invoice.invoiceNumber}`, payment.amount, 0, currency, rate, invoice.contactId))
    lines.push(buildLine(cashAccountId, `Payment sent: ${invoice.invoiceNumber}`, 0, payment.amount, currency, rate))
  }

  const { lines: balanced, totalDebit, totalCredit } = balanceLines(lines)

  try {
    const fiscalPeriodId = await ensureFiscalPeriod(orgId, payDate, repos)
    const entryNumber = await getNextNumber(orgId, 'JE', 5)

    const je = await repos.journalEntries.create({
      orgId,
      journalId: journal.journalId,
      entryNumber,
      date: payDate,
      fiscalPeriodId,
      description: `Payment ${moneyIn ? 'received' : 'sent'}: ${invoice.invoiceNumber} (${payment.method})`,
      type: 'standard',
      status: autoPost ? 'posted' : 'draft',
      lines: balanced,
      totalDebit,
      totalCredit,
      sourceModule: 'invoicing',
      sourceId: invoice.id,
      createdBy: invoice.createdBy || orgId,
      ...(autoPost ? { postedBy: invoice.createdBy || orgId, postedAt: new Date() } : {}),
    } as any)

    return je
  } catch (err: any) {
    logger.error({ orgId, invoiceId: invoice.id, error: err.message }, 'Failed to create payment journal entry')
    return null
  }
}

// ── Stock Movement Valuation ──

export async function createMovementValuationEntry(
  orgId: string,
  movement: any,
  lines: any[],
  date: Date,
  r?: RepositoryRegistry,
): Promise<any | null> {
  const repos = r ?? getRepos()

  const org = await repos.orgs.findOne({ id: orgId } as any)
  const inventorySettings = (org as any)?.settings?.inventory
  const accountingSettings = (org as any)?.settings?.accounting

  if (!inventorySettings?.defaultInventoryAccountId || !inventorySettings?.defaultCOGSAccountId) {
    logger.warn({ orgId, movementId: movement.id }, 'Auto-journal skipped: missing inventory accounts')
    return null
  }

  const inventoryAccountId = inventorySettings.defaultInventoryAccountId
  const cogsAccountId = inventorySettings.defaultCOGSAccountId

  let totalCost = 0
  for (const line of lines) {
    totalCost += (line.resolvedUnitCost || line.unitCost || 0) * (line.quantity || 0)
  }
  totalCost = Math.round(totalCost * 100) / 100
  if (totalCost <= 0) return null

  const isDispatch = ['dispatch', 'production_out'].includes(movement.type)
  const isReceipt = ['receipt', 'production_in', 'return'].includes(movement.type)
  if (!isDispatch && !isReceipt) return null

  const jeLines: JELine[] = isDispatch
    ? [
        buildLine(cogsAccountId, `COGS: ${movement.movementNumber}`, totalCost, 0, 'EUR', 1),
        buildLine(inventoryAccountId, `Inventory out: ${movement.movementNumber}`, 0, totalCost, 'EUR', 1),
      ]
    : [
        buildLine(inventoryAccountId, `Inventory in: ${movement.movementNumber}`, totalCost, 0, 'EUR', 1),
        buildLine(cogsAccountId, `Purchase: ${movement.movementNumber}`, 0, totalCost, 'EUR', 1),
      ]

  const { lines: balanced, totalDebit, totalCredit } = balanceLines(jeLines)
  const autoPost = inventorySettings.autoPostJournalEntries ?? false

  try {
    const fiscalPeriodId = await ensureFiscalPeriod(orgId, date, repos)
    const entryNumber = await getNextNumber(orgId, 'JE', 5)

    const je = await repos.journalEntries.create({
      orgId,
      journalId: accountingSettings?.defaultSaleJournalId,
      entryNumber,
      date,
      fiscalPeriodId,
      description: `Inventory ${isDispatch ? 'COGS' : 'receipt'}: ${movement.movementNumber}`,
      type: 'standard',
      status: autoPost ? 'posted' : 'draft',
      lines: balanced,
      totalDebit,
      totalCredit,
      sourceModule: 'warehouse',
      sourceId: movement.id,
      createdBy: movement.createdBy,
      ...(autoPost ? { postedBy: movement.createdBy, postedAt: new Date() } : {}),
    } as any)

    // Link JE back to movement
    await repos.stockMovements.update(movement.id, { journalEntryId: je.id } as any)

    return je
  } catch (err: any) {
    logger.error({ orgId, movementId: movement.id, error: err.message }, 'Failed to create movement valuation entry')
    return null
  }
}

// ── POS Session Close ──

/**
 * The session's one journal entry (FR-21.2): everything its sales and stornos took and gave back.
 *
 * Built from each row's own figures, so it balances by construction:
 * - revenue is `total − taxTotal` and VAT is `taxTotal`, with the sign of FR-21.1; the VAT goes to
 *   `outputVatAccountId` (#362), else to the revenue account as before;
 * - the money is what each row left in the drawer per method (`keptByMethod`): card and other as
 *   paid, cash as the rest of the total. Σ money = Σ total = revenue + VAT, line for line.
 *
 * Until FR-21 this entry had four defects, none of them ever under test:
 * - a stornoed sale was skipped as `cancelled` AND its storno was subtracted, so the sale went out
 *   twice (B-1, now `posRowSign`);
 * - revenue was `subtotal + discountTotal`, but a POS subtotal is already before the discount, so
 *   a discount was added twice;
 * - the money was the amount TENDERED, so change the till handed back was debited as cash;
 * - the cash over/short line had no other side.
 *
 * Over/short posts only against `cashOverShortAccountId`, as a balanced pair. Without that account
 * nothing is posted for it, and the difference stays on the session (`difference`), where the
 * close screen recorded it.
 *
 * ⚠ It no longer creates the `POS-OUT` batch dispatch (FR-21.4). Every sale already took its goods
 * out with its own movement; the batch, written `completed` without `confirmMovement`, moved no
 * stock and only made SUPTO 18.8, FR-07 and FR-11.7c count every POS sale twice. `batchMovement`
 * stays in the result, always null, for callers that read it.
 */
export async function createPOSSessionJournalEntry(
  orgId: string,
  session: any,
  transactions: any[],
  accounts: DefaultAccounts & { cashOverShortAccountId?: string },
  journal: JournalRef,
  autoPost: boolean,
  r?: RepositoryRegistry,
): Promise<{ journalEntry: any; batchMovement: null } | null> {
  const repos = r ?? getRepos()

  if (!accounts.revenueAccountId || !accounts.receivableAccountId) {
    logger.warn({ orgId, sessionId: session.id }, 'Auto-journal skipped for POS session: missing accounts')
    return null
  }

  // Idempotency: skip if already created
  if (session.journalEntryId) {
    logger.warn({ orgId, sessionId: session.id }, 'POS session already has journal entry, skipping')
    return null
  }

  let revenue = 0
  let tax = 0
  const money: MethodTotals = { cash: 0, card: 0, other: 0 }
  for (const tx of transactions) {
    const sign = posRowSign(tx)
    if (!sign) continue
    const total = Number(tx.total) || 0
    const taxTotal = Number(tx.taxTotal) || 0
    revenue += sign * (total - taxTotal)
    tax += sign * taxTotal
    const kept = keptByMethod(tx)
    money.cash += sign * kept.cash
    money.card += sign * kept.card
    money.other += sign * kept.other
  }

  const currency = session.currency || 'EUR'
  const jeLines: JELine[] = []
  const round = (n: number) => Math.round(n * 100) / 100
  /** A line on its natural side, or on the other one when a session gave back more than it took. */
  const signed = (accountId: string, description: string, amount: number, side: 'debit' | 'credit') => {
    const value = round(amount)
    if (!value) return
    const debit = (side === 'debit') === (value > 0)
    jeLines.push(buildLine(accountId, description, debit ? Math.abs(value) : 0, debit ? 0 : Math.abs(value), currency, 1))
  }

  // The receivable account stays the catch-all for what the drawer took, as it always was.
  signed(accounts.receivableAccountId, `POS Cash: ${session.sessionNumber}`, money.cash, 'debit')
  signed(accounts.receivableAccountId, `POS Card: ${session.sessionNumber}`, money.card, 'debit')
  signed(accounts.receivableAccountId, `POS Other: ${session.sessionNumber}`, money.other, 'debit')
  signed(accounts.revenueAccountId, `POS Revenue: ${session.sessionNumber}`, revenue, 'credit')
  signed(accounts.outputVatAccountId || accounts.revenueAccountId, `POS Tax: ${session.sessionNumber}`, tax, 'credit')

  // Counted minus expected cash: an overage is money the drawer has and the sales do not explain.
  const difference = round(Number(session.difference) || 0)
  if (difference && accounts.cashOverShortAccountId) {
    signed(accounts.receivableAccountId, `Cash over/short: ${session.sessionNumber}`, difference, 'debit')
    signed(accounts.cashOverShortAccountId, `Cash over/short: ${session.sessionNumber}`, difference, 'credit')
  }

  if (jeLines.length === 0) {
    logger.warn({ orgId, sessionId: session.id }, 'No journal lines to create for POS session')
    return null
  }

  const { lines: balanced, totalDebit, totalCredit } = balanceLines(jeLines)

  try {
    const fiscalPeriodId = await ensureFiscalPeriod(orgId, new Date(), repos)
    const entryNumber = await getNextNumber(orgId, 'JE', 5)

    const je = await repos.journalEntries.create({
      orgId,
      journalId: journal.journalId,
      entryNumber,
      date: new Date(),
      fiscalPeriodId,
      description: `POS session ${session.sessionNumber} closing`,
      type: 'standard',
      status: autoPost ? 'posted' : 'draft',
      lines: balanced,
      totalDebit,
      totalCredit,
      sourceModule: 'pos',
      sourceId: session.id,
      createdBy: session.cashierId,
      ...(autoPost ? { postedBy: session.cashierId, postedAt: new Date() } : {}),
    } as any)

    // Update session with references
    await repos.posSessions.update(session.id, { journalEntryId: je.id } as any)

    return { journalEntry: je, batchMovement: null }
  } catch (err: any) {
    logger.error({ orgId, sessionId: session.id, error: err.message }, 'Failed to create POS session journal entry')
    return null
  }
}
