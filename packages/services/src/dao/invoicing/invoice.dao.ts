import { Invoice, type IInvoice } from 'db/models'
import { BaseDao } from '../base.dao.js'

const TYPE_PREFIX_MAP: Record<string, string> = {
  invoice: 'INV',
  proforma: 'PRF',
  credit_note: 'CRN',
  debit_note: 'DBN',
}

class InvoiceDaoClass extends BaseDao<IInvoice> {
  constructor() {
    super(Invoice)
  }

  async findByContact(orgId: string, contactId: string): Promise<IInvoice[]> {
    return this.model.find({ orgId, contactId }).sort({ issueDate: -1 }).exec()
  }

  async findByStatus(orgId: string, status: string): Promise<IInvoice[]> {
    return this.model.find({ orgId, status }).sort({ issueDate: -1 }).exec()
  }

  async findByDirection(orgId: string, direction: string): Promise<IInvoice[]> {
    return this.model.find({ orgId, direction }).sort({ issueDate: -1 }).exec()
  }

  async findOverdue(orgId: string): Promise<IInvoice[]> {
    const now = new Date()
    return this.model
      .find({
        orgId,
        dueDate: { $lt: now },
        status: { $nin: ['paid', 'voided', 'cancelled'] },
      })
      .sort({ dueDate: 1 })
      .exec()
  }

  async findByDateRange(orgId: string, startDate: Date, endDate: Date): Promise<IInvoice[]> {
    return this.model
      .find({ orgId, issueDate: { $gte: startDate, $lte: endDate } })
      .sort({ issueDate: -1 })
      .exec()
  }

  async getNextInvoiceNumber(orgId: string, type: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `${TYPE_PREFIX_MAP[type] || 'INV'}-${year}-`
    const latest = await this.model
      .findOne({ orgId, invoiceNumber: { $regex: `^${prefix}` } })
      .sort({ invoiceNumber: -1 })
      .exec()
    if (!latest) {
      return `${prefix}00001`
    }
    const currentNum = parseInt(latest.invoiceNumber.replace(prefix, ''), 10)
    return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
  }
}

export const invoiceDao = new InvoiceDaoClass()
