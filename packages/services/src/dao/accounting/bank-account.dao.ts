import { BankAccount, type IBankAccount } from 'db/models'
import { BaseDao } from '../base.dao.js'

class BankAccountDaoClass extends BaseDao<IBankAccount> {
  constructor() {
    super(BankAccount)
  }

  async findDefault(orgId: string): Promise<IBankAccount | null> {
    return this.model.findOne({ orgId, isDefault: true }).exec()
  }

  async findActive(orgId: string): Promise<IBankAccount[]> {
    return this.model.find({ orgId, isActive: true }).exec()
  }
}

export const bankAccountDao = new BankAccountDaoClass()
