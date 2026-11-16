import type { IBatchRepository, BaseEntity, Filter, PageRequest, PageResult, SortSpec, AggregateStage, ReadOptions, SessionOptions } from 'dal'

/**
 * A lightweight repository wrapper that auto-injects record scope filters
 * into all query methods. Used when a user has ownRecordsOnly=true.
 *
 * The wrapper merges the scope filter with the caller's filter using $and
 * to avoid key conflicts (e.g., both using $or).
 *
 * Every method forwards its options (FR-32.14): the session to each call it makes, its own scope
 * checks included, and the projection to the read that returns the documents.
 */
export class ScopedRepository<T extends BaseEntity> implements IBatchRepository<T> {
  constructor(
    private inner: IBatchRepository<T>,
    private scopeFilter: Record<string, any>,
  ) {}

  private mergeFilter(filter: any): any {
    if (!this.scopeFilter || Object.keys(this.scopeFilter).length === 0) return filter
    // Use $and to safely combine without key conflicts
    return { $and: [filter || {}, this.scopeFilter] }
  }

  /** The session alone, for the scope checks a method makes before its own call. */
  private only(opts?: SessionOptions): SessionOptions | undefined {
    return opts?.session ? { session: opts.session } : undefined
  }

  async findById(id: string, opts?: ReadOptions): Promise<T | null> {
    // findById then verify scope — cannot inject filter into ID lookup
    const entity = await this.inner.findById(id, this.only(opts))
    if (!entity) return null
    // Verify the entity matches scope by re-querying with scope filter
    const check = await this.inner.findOne(this.mergeFilter({ id }) as any, opts)
    return check
  }

  async findOne(filter: Filter<T>, opts?: ReadOptions): Promise<T | null> {
    return this.inner.findOne(this.mergeFilter(filter), opts)
  }

  async findAll(filter: Filter<T>, page?: PageRequest, opts?: ReadOptions): Promise<PageResult<T>> {
    return this.inner.findAll(this.mergeFilter(filter), page, opts)
  }

  async findMany(filter: Filter<T>, sort?: SortSpec, opts?: ReadOptions): Promise<T[]> {
    return this.inner.findMany(this.mergeFilter(filter), sort, opts)
  }

  async count(filter: Filter<T>, opts?: SessionOptions): Promise<number> {
    return this.inner.count(this.mergeFilter(filter), opts)
  }

  async create(data: any, opts?: SessionOptions): Promise<T> {
    // Create is not scoped — anyone with create permission can create
    return this.inner.create(data, opts)
  }

  async update(id: string, data: any, opts?: SessionOptions): Promise<T | null> {
    // Verify user can access this record before updating
    const check = await this.findById(id, this.only(opts))
    if (!check) return null
    return this.inner.update(id, data, opts)
  }

  async delete(id: string, opts?: SessionOptions): Promise<boolean> {
    // Verify user can access this record before deleting
    const check = await this.findById(id, this.only(opts))
    if (!check) return false
    return this.inner.delete(id, opts)
  }

  async findByIdInOrg(id: string, orgId: string, opts?: ReadOptions): Promise<T | null> {
    // Org first (the inner repo filters on it), then the user's own-records scope on top.
    const entity = await this.inner.findByIdInOrg(id, orgId, this.only(opts))
    if (!entity) return null
    return this.inner.findOne(this.mergeFilter({ id, orgId }) as any, opts)
  }

  async updateInOrg(id: string, orgId: string, data: any, where?: Record<string, unknown>, opts?: { validate?: boolean; unset?: string[] } & SessionOptions): Promise<T | null> {
    const check = await this.findByIdInOrg(id, orgId, this.only(opts))
    if (!check) return null
    // Both forwarded (#675): a caller's guard (`where`) and the validators it asked for. The guard was dropped here.
    return this.inner.updateInOrg(id, orgId, data, where, opts)
  }

  async deleteInOrg(id: string, orgId: string, where?: Record<string, unknown>, opts?: SessionOptions): Promise<boolean> {
    const check = await this.findByIdInOrg(id, orgId, this.only(opts))
    if (!check) return false
    // A caller's guard (`where`) is forwarded, as `updateInOrg`'s is (#675): the fixed-asset route names one (FR-25a §3.4).
    return this.inner.deleteInOrg(id, orgId, where, opts)
  }

  // Batch operations — delegate with scope
  async createMany(data: any[], opts?: SessionOptions): Promise<T[]> {
    return this.inner.createMany(data, opts)
  }

  async updateMany(filter: any, data: any, opts?: SessionOptions): Promise<number> {
    return this.inner.updateMany(this.mergeFilter(filter), data, opts)
  }

  async deleteMany(filter: any, opts?: SessionOptions): Promise<number> {
    return this.inner.deleteMany(this.mergeFilter(filter), opts)
  }

  async findOneAndUpdate(filter: any, data: any, opts?: SessionOptions): Promise<T | null> {
    return this.inner.findOneAndUpdate(this.mergeFilter(filter), data, opts)
  }

  async aggregate<R = any>(pipeline: AggregateStage[], opts?: SessionOptions): Promise<R[]> {
    // Inject $match at the start of the pipeline
    const scopedPipeline = [{ $match: this.scopeFilter }, ...pipeline]
    return this.inner.aggregate(scopedPipeline, opts)
  }
}
