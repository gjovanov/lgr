/** Base entity — all DAL entities extend this */
export interface BaseEntity {
  id: string
  createdAt: Date
  updatedAt: Date
}

/** Tenant-scoped entity — most entities have orgId */
export interface TenantEntity extends BaseEntity {
  orgId: string
}

// ── Filter types ──

export type FilterValue<V> = V | FilterOperator<V>

export interface FilterOperator<V> {
  $eq?: V
  $ne?: V
  $gt?: V
  $gte?: V
  $lt?: V
  $lte?: V
  $in?: V[]
  $nin?: V[]
  $regex?: string
  $exists?: boolean
  $text?: { $search: string }
}

/** Type-safe filter for entity queries */
export type Filter<T> = {
  [K in keyof T]?: FilterValue<T[K]>
} & {
  /** Dot-notation paths for nested field queries (e.g., 'lines.productId') */
  [path: string]: any
  /** Logical OR — at least one sub-filter must match */
  $or?: Filter<T>[]
}

// ── Sort & Pagination ──

export interface SortSpec {
  [field: string]: 1 | -1
}

export interface PageRequest {
  page: number
  size: number
  sort?: SortSpec
}

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  size: number
  totalPages: number
}

// ── Aggregate types ──

export type AggregateStage =
  | { $match: Filter<any> }
  | { $sort: SortSpec }
  | { $limit: number }
  | { $skip: number }
  | { $unwind: string }
  | { $lookup: { from: string; localField: string; foreignField: string; as: string } }
  | { $project: Record<string, 0 | 1 | AggregateExpression> }
  | { $group: Record<string, any> }

export type AggregateExpression = string | Record<string, any>
