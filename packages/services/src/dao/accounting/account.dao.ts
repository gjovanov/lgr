import { Account, type IAccount } from 'db/models'
import { BaseDao } from '../base.dao.js'

class AccountDaoClass extends BaseDao<IAccount> {
  constructor() {
    super(Account)
  }

  async findByCode(orgId: string, code: string): Promise<IAccount | null> {
    return this.model.findOne({ orgId, code }).exec()
  }

  async findByType(orgId: string, type: string): Promise<IAccount[]> {
    return this.model.find({ orgId, type }).exec()
  }

  async findChildren(orgId: string, parentId: string): Promise<IAccount[]> {
    return this.model.find({ orgId, parentId }).exec()
  }

  async findTree(orgId: string): Promise<IAccount[]> {
    return this.model.find({ orgId }).sort({ code: 1 }).exec()
  }
}

export const accountDao = new AccountDaoClass()
