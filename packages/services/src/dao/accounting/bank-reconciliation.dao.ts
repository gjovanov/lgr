import { BankReconciliation, type IBankReconciliation } from 'db/models'
import { BaseDao } from '../base.dao.js'

class BankReconciliationDaoClass extends BaseDao<IBankReconciliation> {
  constructor() {
    super(BankReconciliation)
  }

  async findByBankAccount(orgId: string, bankAccountId: string): Promise<IBankReconciliation[]> {
    return this.model.find({ orgId, bankAccountId }).sort({ statementDate: -1 }).exec()
  }

  async findLatest(orgId: string, bankAccountId: string): Promise<IBankReconciliation | null> {
    return this.model.findOne({ orgId, bankAccountId }).sort({ statementDate: -1 }).exec()
  }
}

export const bankReconciliationDao = new BankReconciliationDaoClass()
