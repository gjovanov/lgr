import type { IBatchRepository, BaseEntity, Filter, PageRequest, PageResult, SortSpec, AggregateStage } from 'dal'

/**
 * A lightweight repository wrapper that auto-injects record scope filters
 * into all query methods. Used when a user has ownRecordsOnly=true.
 *
 * The wrapper merges the scope filter with the caller's filter using $and
 * to avoid key conflicts (e.g., both using $or).
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

  async findById(id: string): Promise<T | null> {
    // findById then verify scope — cannot inject filter into ID lookup
    const entity = await this.inner.findById(id)
    if (!entity) return null
    // Verify the entity matches scope by re-querying with scope filter
    const check = await this.inner.findOne(this.mergeFilter({ id }) as any)
    return check
  }

  async findOne(filter: Filter<T>): Promise<T | null> {
    return this.inner.findOne(this.mergeFilter(filter))
  }

  async findAll(filter: Filter<T>, page?: PageRequest): Promise<PageResult<T>> {
    return this.inner.findAll(this.mergeFilter(filter), page)
  }

  async findMany(filter: Filter<T>, sort?: SortSpec): Promise<T[]> {
    return this.inner.findMany(this.mergeFilter(filter), sort)
  }

  async count(filter: Filter<T>): Promise<number> {
    return this.inner.count(this.mergeFilter(filter))
  }

  async create(data: any): Promise<T> {
    // Create is not scoped — anyone with create permission can create
    return this.inner.create(data)
  }

  async update(id: string, data: any): Promise<T | null> {
    // Verify user can access this record before updating
    const check = await this.findById(id)
    if (!check) return null
    return this.inner.update(id, data)
  }

  async delete(id: string): Promise<boolean> {
    // Verify user can access this record before deleting
    const check = await this.findById(id)
    if (!check) return false
    return this.inner.delete(id)
  }

  async findByIdInOrg(id: string, orgId: string): Promise<T | null> {
    // Org first (the inner repo filters on it), then the user's own-records scope on top.
    const entity = await this.inner.findByIdInOrg(id, orgId)
    if (!entity) return null
    return this.inner.findOne(this.mergeFilter({ id, orgId }) as any)
  }

  async updateInOrg(id: string, orgId: string, data: any): Promise<T | null> {
    const check = await this.findByIdInOrg(id, orgId)
    if (!check) return null
    return this.inner.updateInOrg(id, orgId, data)
  }

  async deleteInOrg(id: string, orgId: string): Promise<boolean> {
    const check = await this.findByIdInOrg(id, orgId)
    if (!check) return false
    return this.inner.deleteInOrg(id, orgId)
  }

  // Batch operations — delegate with scope
  async createMany(data: any[]): Promise<T[]> {
    return this.inner.createMany(data)
  }

  async updateMany(filter: any, data: any): Promise<number> {
    return this.inner.updateMany(this.mergeFilter(filter), data)
  }

  async deleteMany(filter: any): Promise<number> {
    return this.inner.deleteMany(this.mergeFilter(filter))
  }

  async findOneAndUpdate(filter: any, data: any): Promise<T | null> {
    return this.inner.findOneAndUpdate(this.mergeFilter(filter), data)
  }

  async aggregate<R = any>(pipeline: AggregateStage[]): Promise<R[]> {
    // Inject $match at the start of the pipeline
    const scopedPipeline = [{ $match: this.scopeFilter }, ...pipeline]
    return this.inner.aggregate(scopedPipeline)
  }
}
