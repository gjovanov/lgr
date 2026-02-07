import { EmployeeDocument, type IEmployeeDocument } from 'db/models'
import { BaseDao } from '../base.dao.js'

class EmployeeDocumentDaoClass extends BaseDao<IEmployeeDocument> {
  constructor() {
    super(EmployeeDocument)
  }

  async findByEmployee(orgId: string, employeeId: string): Promise<IEmployeeDocument[]> {
    return this.model.find({ orgId, employeeId }).sort({ createdAt: -1 }).exec()
  }

  async findByType(orgId: string, employeeId: string, type: string): Promise<IEmployeeDocument[]> {
    return this.model.find({ orgId, employeeId, type }).sort({ createdAt: -1 }).exec()
  }
}

export const employeeDocumentDao = new EmployeeDocumentDaoClass()
