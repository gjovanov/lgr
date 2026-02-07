import { Department, type IDepartment } from 'db/models'
import { BaseDao } from '../base.dao.js'

class DepartmentDaoClass extends BaseDao<IDepartment> {
  constructor() {
    super(Department)
  }

  async findByCode(orgId: string, code: string): Promise<IDepartment | null> {
    return this.model.findOne({ orgId, code }).exec()
  }

  async findChildren(orgId: string, parentId: string): Promise<IDepartment[]> {
    return this.model.find({ orgId, parentId }).exec()
  }
}

export const departmentDao = new DepartmentDaoClass()
