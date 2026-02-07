import { Contact, type IContact } from 'db/models'
import { BaseDao } from '../base.dao.js'

class ContactDaoClass extends BaseDao<IContact> {
  constructor() {
    super(Contact)
  }

  async findByType(orgId: string, type: string): Promise<IContact[]> {
    return this.model.find({ orgId, type }).exec()
  }

  async findByEmail(orgId: string, email: string): Promise<IContact | null> {
    return this.model.findOne({ orgId, email }).exec()
  }

  async findByTaxId(orgId: string, taxId: string): Promise<IContact | null> {
    return this.model.findOne({ orgId, taxId }).exec()
  }

  async search(orgId: string, query: string): Promise<IContact[]> {
    const regex = new RegExp(query, 'i')
    return this.model
      .find({
        orgId,
        $or: [
          { companyName: regex },
          { firstName: regex },
          { lastName: regex },
          { email: regex },
        ],
      })
      .exec()
  }
}

export const contactDao = new ContactDaoClass()
