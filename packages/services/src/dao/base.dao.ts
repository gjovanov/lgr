import type { Model, Document, FilterQuery, UpdateQuery, Types } from 'mongoose'

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  size: number
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
    page = 0,
    size = 10,
    sort: Record<string, 1 | -1> = { createdAt: -1 },
  ): Promise<PaginatedResult<T>> {
    if (size === 0) {
      const items = await this.model.find(filter).sort(sort).exec()
      return { items, total: items.length, page: 0, size: 0, totalPages: 1 }
    }
    const skip = page * size
    const [items, total] = await Promise.all([
      this.model.find(filter).sort(sort).skip(skip).limit(size).exec(),
      this.model.countDocuments(filter).exec(),
    ])
    return {
      items,
      total,
      page,
      size,
      totalPages: Math.ceil(total / size),
    }
  }

  async findByOrgId(
    orgId: string | Types.ObjectId,
    page = 0,
    size = 10,
    sort: Record<string, 1 | -1> = { createdAt: -1 },
  ): Promise<PaginatedResult<T>> {
    return this.findAll({ orgId } as FilterQuery<T>, page, size, sort)
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
