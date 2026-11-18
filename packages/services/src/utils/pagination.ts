import type { Model, Document, FilterQuery } from 'mongoose'
import { pageUnderCeiling } from 'config/list-rows'

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  size: number
  totalPages: number
  /** FR-30.8: cut at the ceiling (`config/list-rows`); `total` is the real count. Absent when it was not. */
  truncated?: true
}

export interface PaginationDefaults {
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  size?: number
  /**
   * Mongoose projection, e.g. `'-password'`. Optional and additive: every existing caller
   * keeps its current behaviour. Added for FR-11.3 (#21), where the user list was shipping
   * bcrypt hashes to the browser.
   */
  select?: string
}

/**
 * Shared pagination utility for all list endpoints.
 *
 * @param model     Mongoose model
 * @param filter    Query filter (e.g. { orgId })
 * @param query     Request query params (page, size, sortBy, sortOrder)
 * @param defaults  Default sort field/order and page size
 */
export async function paginateQuery<T extends Document>(
  model: Model<T>,
  filter: FilterQuery<T>,
  query: Record<string, any>,
  defaults: PaginationDefaults = {},
): Promise<PaginatedResult<T>> {
  const page = Math.max(0, Number(query.page) || 0)
  // FR-30.8: "All" (`size <= 0`) and any size above the ceiling read at most `LIST_CEILING` rows. "All" had no limit.
  const { take, asked } = pageUnderCeiling(query.size !== undefined ? Number(query.size) : (defaults.size ?? 10))
  const sortBy = (query.sortBy as string) || defaults.sortBy || 'createdAt'
  const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : ((query.sortOrder as string) === 'desc' ? -1 : (defaults.sortOrder === 'asc' ? 1 : -1))

  const sort: Record<string, 1 | -1> = { [sortBy]: sortOrder }
  const select = defaults.select

  if (asked === Infinity) {
    const q = model.find(filter).sort(sort).limit(take)
    if (select) q.select(select)
    const items = await q.lean().exec() as T[]
    const total = items.length < take ? items.length : await model.countDocuments(filter).exec()
    return { items, total, page: 0, size: items.length, totalPages: 1, ...(total > items.length ? { truncated: true as const } : {}) }
  }

  const size = take
  const skip = page * size
  const pageQuery = model.find(filter).sort(sort).skip(skip).limit(size)
  if (select) pageQuery.select(select)
  const [items, total] = await Promise.all([
    pageQuery.lean().exec() as Promise<T[]>,
    model.countDocuments(filter).exec(),
  ])

  return {
    items,
    total,
    page,
    size,
    totalPages: Math.ceil(total / size),
    ...(asked > size && total - skip > size ? { truncated: true as const } : {}),
  }
}
