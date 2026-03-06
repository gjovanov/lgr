import type { BaseEntity, Filter, SortSpec, PageRequest, PageResult, AggregateStage } from './types.js'

/**
 * Storage-agnostic repository interface.
 * Implemented by both MongoRepository and SQLiteRepository.
 */
export interface IRepository<T extends BaseEntity> {
  /** Find a single entity by ID */
  findById(id: string): Promise<T | null>

  /** Find a single entity matching the filter */
  findOne(filter: Filter<T>): Promise<T | null>

  /** Find entities with pagination (size=0 returns all) */
  findAll(filter: Filter<T>, page?: PageRequest): Promise<PageResult<T>>

  /** Find all entities matching the filter (no pagination) */
  findMany(filter: Filter<T>, sort?: SortSpec): Promise<T[]>

  /** Create a new entity (id, createdAt, updatedAt are auto-generated) */
  create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T>

  /** Update an entity by ID. Returns the updated entity or null if not found. */
  update(id: string, data: Partial<T>): Promise<T | null>

  /** Delete an entity by ID. Returns true if deleted, false if not found. */
  delete(id: string): Promise<boolean>

  /** Count entities matching the filter */
  count(filter: Filter<T>): Promise<number>

  /** Run an aggregation pipeline (for complex reporting queries) */
  aggregate<R = any>(pipeline: AggregateStage[]): Promise<R[]>
}

/**
 * Extended repository with batch operations.
 */
export interface IBatchRepository<T extends BaseEntity> extends IRepository<T> {
  /** Create multiple entities at once */
  createMany(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>[]): Promise<T[]>

  /** Update multiple entities matching the filter */
  updateMany(filter: Filter<T>, data: Partial<T>): Promise<number>

  /** Delete multiple entities matching the filter */
  deleteMany(filter: Filter<T>): Promise<number>
}
