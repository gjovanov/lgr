import type { Model, Document, FilterQuery } from 'mongoose'

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  size: number
  totalPages: number
}

export interface PaginationDefaults {
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  size?: number
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
  const size = query.size !== undefined ? Number(query.size) : (defaults.size ?? 10)
  const sortBy = (query.sortBy as string) || defaults.sortBy || 'createdAt'
  const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : ((query.sortOrder as string) === 'desc' ? -1 : (defaults.sortOrder === 'asc' ? 1 : -1))

  const sort: Record<string, 1 | -1> = { [sortBy]: sortOrder }

  if (size === 0) {
    const items = await model.find(filter).sort(sort).lean().exec() as T[]
    return { items, total: items.length, page: 0, size: 0, totalPages: 1 }
  }

  const skip = page * size
  const [items, total] = await Promise.all([
    model.find(filter).sort(sort).skip(skip).limit(size).lean().exec() as Promise<T[]>,
    model.countDocuments(filter).exec(),
  ])

  return {
    items,
    total,
    page,
    size,
    totalPages: Math.ceil(total / size),
  }
}
