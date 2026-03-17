import type { Model } from 'mongoose'
import type { BaseEntity, Filter, SortSpec, PageRequest, PageResult, AggregateStage } from 'dal'
import type { IBatchRepository } from 'dal'
import { DuplicateError } from 'dal'
import { toEntity, toDocument } from './entity-mapper.js'
import { translateFilter } from './filter-translator.js'

/**
 * MongoDB/Mongoose implementation of IBatchRepository.
 * Wraps a Mongoose Model and translates between DAL entities and Mongoose documents.
 */
export class MongoRepository<T extends BaseEntity> implements IBatchRepository<T> {
  constructor(protected model: Model<any>) {}

  async findById(id: string): Promise<T | null> {
    try {
      const doc = await this.model.findById(id).lean().exec()
      return doc ? toEntity<T>(doc) : null
    } catch (err: any) {
      if (err.name === 'CastError') return null
      throw err
    }
  }

  async findOne(filter: Filter<T>): Promise<T | null> {
    const mongoFilter = translateFilter(filter)
    const doc = await this.model.findOne(mongoFilter).lean().exec()
    return doc ? toEntity<T>(doc) : null
  }

  async findAll(filter: Filter<T>, page?: PageRequest): Promise<PageResult<T>> {
    const mongoFilter = translateFilter(filter)
    const sort = page?.sort ?? { createdAt: -1 }
    const size = page?.size ?? 10
    const pageNum = page?.page ?? 0

    if (size === 0) {
      // size=0 means "all items, no pagination" — cap at 1000 for safety
      const docs = await this.model.find(mongoFilter).sort(sort).limit(1000).lean().exec()
      return {
        items: docs.map(d => toEntity<T>(d)),
        total: docs.length,
        page: 0,
        size: 0,
        totalPages: 1,
      }
    }

    const skip = pageNum * size
    const [docs, total] = await Promise.all([
      this.model.find(mongoFilter).sort(sort).skip(skip).limit(size).lean().exec(),
      this.model.countDocuments(mongoFilter).exec(),
    ])

    return {
      items: docs.map(d => toEntity<T>(d)),
      total,
      page: pageNum,
      size,
      totalPages: Math.ceil(total / size),
    }
  }

  async findMany(filter: Filter<T>, sort: SortSpec = { createdAt: -1 }): Promise<T[]> {
    const mongoFilter = translateFilter(filter)
    const docs = await this.model.find(mongoFilter).sort(sort).lean().exec()
    return docs.map(d => toEntity<T>(d))
  }

  async create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T> {
    try {
      const mongoData = toDocument(data)
      const doc = await this.model.create(mongoData)
      return toEntity<T>(doc.toObject())
    } catch (err: any) {
      if (err.code === 11000) {
        const field = Object.keys(err.keyPattern || {})[0] || 'unknown'
        const value = Object.values(err.keyValue || {})[0] as string || 'unknown'
        throw new DuplicateError(this.model.modelName, field, value)
      }
      throw err
    }
  }

  async update(id: string, data: Partial<T>): Promise<T | null> {
    try {
      const mongoData = toDocument(data)
      const doc = await this.model.findByIdAndUpdate(id, mongoData, { new: true }).lean().exec()
      return doc ? toEntity<T>(doc) : null
    } catch (err: any) {
      if (err.name === 'CastError') return null
      throw err
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const result = await this.model.findByIdAndDelete(id).exec()
      return result !== null
    } catch (err: any) {
      if (err.name === 'CastError') return false
      throw err
    }
  }

  async findOneAndUpdate(filter: Filter<T>, data: Partial<T>): Promise<T | null> {
    const mongoFilter = translateFilter(filter)
    const mongoData = toDocument(data)
    const doc = await this.model.findOneAndUpdate(mongoFilter, mongoData, { new: true }).lean().exec()
    return doc ? toEntity<T>(doc) : null
  }

  async count(filter: Filter<T>): Promise<number> {
    const mongoFilter = translateFilter(filter)
    return this.model.countDocuments(mongoFilter).exec()
  }

  async aggregate<R = any>(pipeline: AggregateStage[]): Promise<R[]> {
    // Pass through to Mongoose aggregate — the pipeline format is compatible
    // with MongoDB's native pipeline format for basic stages
    const mongoPipeline = pipeline.map(stage => {
      if ('$match' in stage) {
        return { $match: translateFilter(stage.$match) }
      }
      return stage
    })
    return this.model.aggregate(mongoPipeline).exec()
  }

  // ── Batch operations ──

  async createMany(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>[]): Promise<T[]> {
    const mongoDocs = data.map(d => toDocument(d))
    const docs = await this.model.insertMany(mongoDocs)
    return docs.map(d => toEntity<T>(d.toObject()))
  }

  async updateMany(filter: Filter<T>, data: Partial<T>): Promise<number> {
    const mongoFilter = translateFilter(filter)
    const mongoData = toDocument(data)
    const result = await this.model.updateMany(mongoFilter, mongoData).exec()
    return result.modifiedCount
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    const mongoFilter = translateFilter(filter)
    const result = await this.model.deleteMany(mongoFilter).exec()
    return result.deletedCount
  }
}
