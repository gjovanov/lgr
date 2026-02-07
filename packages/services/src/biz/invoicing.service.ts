import { Invoice, JournalEntry, Account, type IInvoice } from 'db/models'
import { logger } from '../logger/logger.js'

export async function recordPayment(
  invoiceId: string,
  payment: {
    date: Date
    amount: number
    method: string
    reference?: string
    bankAccountId?: string
  },
): Promise<IInvoice> {
  const invoice = await Invoice.findById(invoiceId)
  if (!invoice) throw new Error('Invoice not found')
  if (['paid', 'voided', 'cancelled'].includes(invoice.status)) {
    throw new Error(`Cannot record payment on ${invoice.status} invoice`)
  }

  if (payment.amount > invoice.amountDue) {
    throw new Error('Payment amount exceeds amount due')
  }

  invoice.payments.push(payment as any)
  invoice.amountPaid += payment.amount
  invoice.amountDue = invoice.total - invoice.amountPaid

  if (invoice.amountDue <= 0.01) {
    invoice.status = 'paid'
    invoice.paidAt = new Date()
  } else {
    invoice.status = 'partially_paid'
  }

  await invoice.save()
  logger.info({ invoiceId, amount: payment.amount }, 'Payment recorded')
  return invoice
}

export async function sendInvoice(invoiceId: string): Promise<IInvoice> {
  const invoice = await Invoice.findById(invoiceId)
  if (!invoice) throw new Error('Invoice not found')
  if (invoice.status !== 'draft') throw new Error('Only draft invoices can be sent')

  invoice.status = 'sent'
  invoice.sentAt = new Date()
  await invoice.save()

  logger.info({ invoiceId, invoiceNumber: invoice.invoiceNumber }, 'Invoice sent')
  return invoice
}

export async function checkOverdueInvoices(orgId: string): Promise<number> {
  const result = await Invoice.updateMany(
    {
      orgId,
      status: { $in: ['sent', 'partially_paid'] },
      dueDate: { $lt: new Date() },
    },
    { status: 'overdue' },
  )
  return result.modifiedCount
}

export function calculateInvoiceTotals(
  lines: { quantity: number; unitPrice: number; discount: number; taxRate: number }[],
): { subtotal: number; discountTotal: number; taxTotal: number; total: number } {
  let subtotal = 0
  let discountTotal = 0
  let taxTotal = 0

  for (const line of lines) {
    const lineTotal = line.quantity * line.unitPrice
    const lineDiscount = lineTotal * (line.discount / 100)
    const taxableAmount = lineTotal - lineDiscount
    const lineTax = taxableAmount * (line.taxRate / 100)

    subtotal += lineTotal
    discountTotal += lineDiscount
    taxTotal += lineTax
  }

  return {
    subtotal,
    discountTotal,
    taxTotal,
    total: subtotal - discountTotal + taxTotal,
  }
}
