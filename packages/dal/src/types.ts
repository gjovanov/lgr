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
  /** Regex flags for `$regex` (e.g. 'i'). */
  $options?: string
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
  /** Rows a page holds. `<= 0` is "All": up to `LIST_CEILING` rows (`config/list-rows`, FR-30.8). */
  size: number
  sort?: SortSpec
  /**
   * The caller reads every row on purpose, past the ceiling: server code that needs the whole set (the chart of
   * accounts' tree), or an endpoint's declared lean "all" (FR-30.8). Never a list's ordinary page.
   */
  unbounded?: boolean
}

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  size: number
  totalPages: number
  /** FR-30.8: the answer was cut at the ceiling; `total` is the real count. Absent when it was not. */
  truncated?: true
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

// ── Projection & session (FR-32.14) ──

/**
 * What a read returns: the fields named (`['name', 'sku']`), or a projection (`{ name: 1 }`,
 * `{ lines: 0 }`). `id` is always there. A field left out is absent from the entity, whatever its
 * type says.
 */
export type Projection = readonly string[] | Readonly<Record<string, 0 | 1>>

/**
 * A store transaction, as the backend hands it out (a Mongoose `ClientSession`). Opaque here: the
 * DAL only carries it from the caller to every operation the method makes.
 */
export type DalSession = object

/** For a method that writes, or that reads without returning documents. */
export interface SessionOptions {
  /** Run inside this transaction: every operation the method makes carries it. */
  session?: DalSession
}

/** For a method that returns documents. */
export interface ReadOptions extends SessionOptions {
  /** Return only these fields (`id` always). */
  select?: Projection
}
