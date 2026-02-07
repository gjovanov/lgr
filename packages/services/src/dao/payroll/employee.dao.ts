import { Employee, type IEmployee } from 'db/models'
import { BaseDao } from '../base.dao.js'

class EmployeeDaoClass extends BaseDao<IEmployee> {
  constructor() {
    super(Employee)
  }

  async findByDepartment(orgId: string, department: string): Promise<IEmployee[]> {
    return this.model.find({ orgId, department }).exec()
  }

  async findActive(orgId: string): Promise<IEmployee[]> {
    return this.model.find({ orgId, status: 'active' }).exec()
  }

  async findByManager(orgId: string, managerId: string): Promise<IEmployee[]> {
    return this.model.find({ orgId, managerId }).exec()
  }

  async findByNumber(orgId: string, employeeNumber: string): Promise<IEmployee | null> {
    return this.model.findOne({ orgId, employeeNumber }).exec()
  }
}

export const employeeDao = new EmployeeDaoClass()
