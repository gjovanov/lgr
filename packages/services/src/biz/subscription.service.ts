import type { RepositoryRegistry } from 'dal'
import type { ISubscription } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { getNextNumber } from './sequence.service.js'

/**
 * Activate a subscription (draft → active).
 */
export async function activateSubscription(
  subId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<ISubscription> {
  const r = repos ?? getRepos()
  const sub = await r.subscriptions.findOne({ id: subId, orgId } as any)
  if (!sub) throw new Error('Subscription not found')
  if (sub.state !== 'draft') throw new Error('Only draft subscriptions can be activated')

  const updated = await r.subscriptions.findOneAndUpdate(
    { id: subId, orgId, state: 'draft' } as any,
    { state: 'active' } as any,
  )
  if (!updated) throw new Error('Concurrent modification: subscription state changed')

  logger.info({ subId, name: sub.name }, 'Subscription activated')
  return updated
}

/**
 * Pause a subscription (active → paused).
 */
export async function pauseSubscription(
  subId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<ISubscription> {
  const r = repos ?? getRepos()
  const sub = await r.subscriptions.findOne({ id: subId, orgId } as any)
  if (!sub) throw new Error('Subscription not found')
  if (sub.state !== 'active') throw new Error('Only active subscriptions can be paused')

  const updated = await r.subscriptions.findOneAndUpdate(
    { id: subId, orgId, state: 'active' } as any,
    { state: 'paused' } as any,
  )
  if (!updated) throw new Error('Concurrent modification: subscription state changed')

  logger.info({ subId, name: sub.name }, 'Subscription paused')
  return updated
}

/**
 * Resume a subscription (paused → active).
 */
export async function resumeSubscription(
  subId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<ISubscription> {
  const r = repos ?? getRepos()
  const sub = await r.subscriptions.findOne({ id: subId, orgId } as any)
  if (!sub) throw new Error('Subscription not found')
  if (sub.state !== 'paused') throw new Error('Only paused subscriptions can be resumed')

  const updated = await r.subscriptions.findOneAndUpdate(
    { id: subId, orgId, state: 'paused' } as any,
    { state: 'active' } as any,
  )
  if (!updated) throw new Error('Concurrent modification: subscription state changed')

  logger.info({ subId, name: sub.name }, 'Subscription resumed')
  return updated
}

/**
 * Cancel a subscription (active/paused → cancelled).
 */
export async function cancelSubscription(
  subId: string,
  orgId: string,
  reason: string,
  repos?: RepositoryRegistry,
): Promise<ISubscription> {
  const r = repos ?? getRepos()
  const sub = await r.subscriptions.findOne({ id: subId, orgId } as any)
  if (!sub) throw new Error('Subscription not found')
  if (sub.state !== 'active' && sub.state !== 'paused') {
    throw new Error('Only active or paused subscriptions can be cancelled')
  }

  const updated = await r.subscriptions.findOneAndUpdate(
    { id: subId, orgId, state: sub.state } as any,
    {
      state: 'cancelled',
      cancellationReason: reason,
      cancellationDate: new Date(),
    } as any,
  )
  if (!updated) throw new Error('Concurrent modification: subscription state changed')

  logger.info({ subId, name: sub.name, reason }, 'Subscription cancelled')
  return updated
}

/**
 * Advance nextInvoiceDate based on recurring interval/period.
 */
function advanceDate(date: Date, interval: number, period: string): Date {
  const d = new Date(date)
  switch (period) {
    case 'day':
      d.setDate(d.getDate() + interval)
      break
    case 'week':
      d.setDate(d.getDate() + interval * 7)
      break
    case 'month':
      d.setMonth(d.getMonth() + interval)
      break
    case 'year':
      d.setFullYear(d.getFullYear() + interval)
      break
  }
  return d
}

/**
 * Generate invoices for all active subscriptions where nextInvoiceDate <= now.
 * Returns the count of invoices created.
 */
export async function generateSubscriptionInvoices(
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<number> {
  const r = repos ?? getRepos()
  const now = new Date()

  // Find active subscriptions due for invoicing
  const result = await r.subscriptions.findMany({
    orgId,
    state: 'active',
    nextInvoiceDate: { $lte: now },
  } as any)

  let created = 0

  for (const sub of result) {
    try {
      // Generate invoice number
      const invoiceNumber = await getNextNumber(orgId, 'INV')

      // Lookup contact for billing address
      const contact = await r.contacts.findById(sub.partnerId)
      const addr = contact?.addresses?.find((a: any) => a.type === 'billing' || a.isDefault) || contact?.addresses?.[0]
      const billingAddress = addr
        ? { street: addr.street || '-', city: addr.city || '-', postalCode: addr.postalCode || '-', country: addr.country || '-' }
        : { street: '-', city: '-', postalCode: '-', country: '-' }

      // Compute line totals
      const lines = sub.lines.map((line) => {
        const priceSubtotal = line.quantity * line.priceUnit * (1 - (line.discount || 0) / 100)
        return {
          description: line.name,
          quantity: line.quantity,
          unit: 'pcs',
          unitPrice: line.priceUnit,
          discount: line.discount || 0,
          taxRate: 0,
          taxAmount: 0,
          lineTotal: Math.round(priceSubtotal * 100) / 100,
        }
      })

      const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0)
      const total = Math.round(subtotal * 100) / 100

      // Create invoice
      const invoice = await r.invoices.create({
        orgId,
        invoiceNumber,
        type: 'invoice',
        direction: 'outgoing',
        status: 'draft',
        contactId: sub.partnerId,
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        currency: sub.currency,
        exchangeRate: 1,
        lines,
        subtotal,
        discountTotal: 0,
        taxTotal: 0,
        total,
        totalBase: total,
        amountPaid: 0,
        amountDue: total,
        payments: [],
        billingAddress,
        attachments: [],
        createdBy: sub.createdBy,
        reference: sub.name,
      } as any)

      // Advance nextInvoiceDate and add invoice reference
      const nextDate = advanceDate(sub.nextInvoiceDate, sub.recurringInterval, sub.recurringPeriod)
      await r.subscriptions.update(sub.id, {
        nextInvoiceDate: nextDate,
        invoiceIds: [...(sub.invoiceIds || []), invoice.id],
      } as any)

      created++
      logger.info({ subId: sub.id, invoiceId: invoice.id, name: sub.name }, 'Subscription invoice generated')
    } catch (err: any) {
      logger.error({ subId: sub.id, error: err.message }, 'Failed to generate subscription invoice')
    }
  }

  return created
}
