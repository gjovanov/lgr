import type { Model, Document, FilterQuery, UpdateQuery, Types } from 'mongoose'

export interface PaginatedResult<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export class BaseDao<T extends Document> {
  constructor(protected model: Model<T>) {}

  async findById(id: string | Types.ObjectId): Promise<T | null> {
    return this.model.findById(id).exec()
  }

  async findOne(filter: FilterQuery<T>): Promise<T | null> {
    return this.model.findOne(filter).exec()
  }

  async findAll(
    filter: FilterQuery<T>,
    page = 1,
    pageSize = 50,
    sort: Record<string, 1 | -1> = { createdAt: -1 },
  ): Promise<PaginatedResult<T>> {
    const skip = (page - 1) * pageSize
    const [data, total] = await Promise.all([
      this.model.find(filter).sort(sort).skip(skip).limit(pageSize).exec(),
      this.model.countDocuments(filter).exec(),
    ])
    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  async findByOrgId(
    orgId: string | Types.ObjectId,
    page = 1,
    pageSize = 50,
    sort: Record<string, 1 | -1> = { createdAt: -1 },
  ): Promise<PaginatedResult<T>> {
    return this.findAll({ orgId } as FilterQuery<T>, page, pageSize, sort)
  }

  async findAllByOrgId(orgId: string | Types.ObjectId): Promise<T[]> {
    return this.model.find({ orgId } as FilterQuery<T>).exec()
  }

  async create(data: Partial<T>): Promise<T> {
    return this.model.create(data) as Promise<T>
  }

  async update(id: string | Types.ObjectId, data: UpdateQuery<T>): Promise<T | null> {
    return this.model.findByIdAndUpdate(id, data, { new: true }).exec()
  }

  async delete(id: string | Types.ObjectId): Promise<T | null> {
    return this.model.findByIdAndDelete(id).exec()
  }

  async count(filter: FilterQuery<T>): Promise<number> {
    return this.model.countDocuments(filter).exec()
  }
}
