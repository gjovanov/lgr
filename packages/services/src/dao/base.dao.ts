import type { Model, Document, FilterQuery, UpdateQuery, Types } from 'mongoose'

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  size: number
  totalPages: number
}

/**
 * The base of the four DAO classes still in use (org, user, invite, sign-in code). FR-32.9 (#797): the other 24,
 * which only tests imported, are gone, and these move onto repositories as their controllers are touched; the
 * class goes with the last of them.
 *
 * ⚠ Its READS are lean (FR-32.9, the open item "BaseDao read methods missing .lean()"): they return the stored
 * document as a plain object, with no `save()`, `toJSON()` or `id` virtual. Typed as `T` for the callers that read
 * fields; a caller that needs a document asks the model itself. The writes are unchanged.
 *
 * ⚠ A lean read answers `undefined` for a key the model defaults and the document does not store. `OrgDao.findById`
 * is the one read here that is not lean, for that reason: see there.
 */
export class BaseDao<T extends Document> {
  constructor(protected model: Model<T>) {}

  async findById(id: string | Types.ObjectId): Promise<T | null> {
    return this.model.findById(id).lean<T>().exec()
  }

  async findOne(filter: FilterQuery<T>): Promise<T | null> {
    return this.model.findOne(filter).lean<T>().exec()
  }

  async findAll(
    filter: FilterQuery<T>,
    page = 0,
    size = 10,
    sort: Record<string, 1 | -1> = { createdAt: -1 },
  ): Promise<PaginatedResult<T>> {
    if (size === 0) {
      const items = await this.model.find(filter).sort(sort).lean<T[]>().exec()
      return { items, total: items.length, page: 0, size: 0, totalPages: 1 }
    }
    const skip = page * size
    const [items, total] = await Promise.all([
      this.model.find(filter).sort(sort).skip(skip).limit(size).lean<T[]>().exec(),
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
    return this.model.find({ orgId } as FilterQuery<T>).lean<T[]>().exec()
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
