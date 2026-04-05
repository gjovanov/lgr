/**
 * Auto-Journal Service
 * Creates properly balanced journal entries for cross-module events:
 * - Invoice posting → revenue/receivable entries
 * - Payment recording → cash/bank entries
 * - Stock movement confirmation → inventory/COGS entries
 * - POS session close → batch revenue + inventory entries
 */
import { getRepos } from '../context.js'
import { ensureFiscalPeriod } from './accounting.service.js'
import { getNextNumber } from './sequence.service.js'
import { logger } from '../logger/logger.js'
import type { RepositoryRegistry } from 'dal'

interface DefaultAccounts {
  receivableAccountId?: string
  payableAccountId?: string
  revenueAccountId?: string
  expenseAccountId?: string
  inventoryAccountId?: string
  cogsAccountId?: string
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
      lines.push(buildLine(revenueAccountId, `Tax: ${invoice.invoiceNumber}`, 0, sign * totalTax, currency, rate))
    }
  } else {
    // Incoming: DR Expense / CR Payable + DR Tax
    lines.push(buildLine(revenueAccountId, `Expense: ${invoice.invoiceNumber}`, sign * totalRevenue, 0, currency, rate))
    if (totalTax > 0) {
      lines.push(buildLine(revenueAccountId, `Tax: ${invoice.invoiceNumber}`, sign * totalTax, 0, currency, rate))
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

  if (isOutgoing) {
    // DR Cash/Bank / CR Receivable
    lines.push(buildLine(cashAccountId, `Payment received: ${invoice.invoiceNumber}`, payment.amount, 0, currency, rate))
    lines.push(buildLine(counterpartAccountId, `Clear receivable: ${invoice.invoiceNumber}`, 0, payment.amount, currency, rate, invoice.contactId))
  } else {
    // DR Payable / CR Cash/Bank
    lines.push(buildLine(counterpartAccountId, `Clear payable: ${invoice.invoiceNumber}`, payment.amount, 0, currency, rate, invoice.contactId))
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
      description: `Payment ${isOutgoing ? 'received' : 'sent'}: ${invoice.invoiceNumber} (${payment.method})`,
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

// ── POS Session Close (Batch) ──

export async function createPOSSessionJournalEntry(
  orgId: string,
  session: any,
  transactions: any[],
  accounts: DefaultAccounts,
  journal: JournalRef,
  autoPost: boolean,
  r?: RepositoryRegistry,
): Promise<{ journalEntry: any; batchMovement: any } | null> {
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

  // Aggregate product lines across all transactions for batch movement
  const productAgg = new Map<string, { productId: string; name: string; totalQty: number; totalCost: number }>()
  let totalRevenue = 0
  let totalTax = 0

  // Aggregate payment amounts by method type
  const paymentsByType = new Map<string, number>()

  for (const tx of transactions) {
    if (tx.status === 'cancelled') continue

    const sign = tx.type === 'return' || tx.type === 'storno' ? -1 : 1
    totalRevenue += sign * ((tx.subtotal || 0) + (tx.discountTotal || 0))
    totalTax += sign * (tx.taxTotal || 0)

    for (const line of (tx.lines || [])) {
      const key = line.productId
      const existing = productAgg.get(key)
      if (existing) {
        existing.totalQty += sign * (line.quantity || 0)
        existing.totalCost += sign * (line.unitPrice || 0) * (line.quantity || 0)
      } else {
        productAgg.set(key, {
          productId: line.productId,
          name: line.name || line.productId,
          totalQty: sign * (line.quantity || 0),
          totalCost: sign * (line.unitPrice || 0) * (line.quantity || 0),
        })
      }
    }

    for (const pay of (tx.payments || [])) {
      const method = pay.method || 'cash'
      paymentsByType.set(method, (paymentsByType.get(method) || 0) + sign * (pay.amount || 0))
    }
  }

  let batchMovement: any = null

  // Create batch dispatch movement (if inventory accounts exist)
  if (accounts.inventoryAccountId && productAgg.size > 0) {
    try {
      const movementNumber = await getNextNumber(orgId, 'POS-OUT', 6)
      const movementLines = Array.from(productAgg.values())
        .filter(p => p.totalQty > 0)
        .map(p => ({
          productId: p.productId,
          quantity: p.totalQty,
          unitCost: Math.round((p.totalCost / p.totalQty) * 100) / 100,
          totalCost: Math.round(p.totalCost * 100) / 100,
        }))

      if (movementLines.length > 0) {
        batchMovement = await repos.stockMovements.create({
          orgId,
          movementNumber,
          type: 'dispatch',
          status: 'completed',
          date: new Date(),
          fromWarehouseId: session.warehouseId,
          lines: movementLines,
          totalAmount: movementLines.reduce((s, l) => s + l.totalCost, 0),
          notes: `POS session ${session.sessionNumber} batch dispatch`,
          createdBy: session.cashierId,
        } as any)
      }
    } catch (err: any) {
      logger.warn({ orgId, sessionId: session.id, error: err.message }, 'POS batch movement creation failed')
    }
  }

  // Create journal entry
  const currency = session.currency || 'EUR'
  const jeLines: JELine[] = []

  // DR Cash (from cash payments)
  const cashAmount = paymentsByType.get('cash') || 0
  const cardAmount = paymentsByType.get('card') || 0
  const otherAmount = Array.from(paymentsByType.entries())
    .filter(([k]) => k !== 'cash' && k !== 'card')
    .reduce((s, [, v]) => s + v, 0)

  // Use receivable account as catch-all for payment DR lines
  if (cashAmount > 0) {
    jeLines.push(buildLine(accounts.receivableAccountId!, `POS Cash: ${session.sessionNumber}`, cashAmount, 0, currency, 1))
  }
  if (cardAmount > 0) {
    jeLines.push(buildLine(accounts.receivableAccountId!, `POS Card: ${session.sessionNumber}`, cardAmount, 0, currency, 1))
  }
  if (otherAmount > 0) {
    jeLines.push(buildLine(accounts.receivableAccountId!, `POS Other: ${session.sessionNumber}`, otherAmount, 0, currency, 1))
  }

  // Cash count difference adjustment
  if (session.difference && session.difference !== 0) {
    const absDiff = Math.abs(session.difference)
    if (session.difference > 0) {
      jeLines.push(buildLine(accounts.receivableAccountId!, `Cash overage: ${session.sessionNumber}`, absDiff, 0, currency, 1))
    } else {
      jeLines.push(buildLine(accounts.receivableAccountId!, `Cash shortage: ${session.sessionNumber}`, 0, absDiff, currency, 1))
    }
  }

  // CR Revenue
  if (totalRevenue > 0) {
    jeLines.push(buildLine(accounts.revenueAccountId!, `POS Revenue: ${session.sessionNumber}`, 0, totalRevenue, currency, 1))
  }
  if (totalTax > 0) {
    jeLines.push(buildLine(accounts.revenueAccountId!, `POS Tax: ${session.sessionNumber}`, 0, totalTax, currency, 1))
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
    await repos.posSessions.update(session.id, {
      journalEntryId: je.id,
      ...(batchMovement ? { batchMovementId: batchMovement.id } : {}),
    } as any)

    return { journalEntry: je, batchMovement }
  } catch (err: any) {
    logger.error({ orgId, sessionId: session.id, error: err.message }, 'Failed to create POS session journal entry')
    return null
  }
}
