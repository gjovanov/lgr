import type { BaseEntity, Filter, SortSpec, PageRequest, PageResult, AggregateStage } from './types.js'
import type { IAccount, IJournalEntry } from './entities/index.js'

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

  /**
   * Find an entity by ID **within one org**. Null when the id names no document of that org,
   * including one that exists in another org.
   *
   * ⚠ A route that takes an id from its URL uses this, never `findById`. The tenant guard checks
   * only that the URL's `:orgId` is the caller's; the id itself can name any org's document, and
   * `tenantPlugin` filters nothing (FR-20.7).
   */
  findByIdInOrg(id: string, orgId: string): Promise<T | null>

  /**
   * Update an entity by ID **within one org**; null when it is not that org's. `orgId` in
   * `data` is ignored: a document can never be moved to another org through an update.
   */
  /** `where`: what else must hold for the write to happen. A caller's condition, never a client's. */
  updateInOrg(id: string, orgId: string, data: Partial<T>, where?: Record<string, unknown>): Promise<T | null>

  /** Delete an entity by ID **within one org**; false when it is not that org's. */
  deleteInOrg(id: string, orgId: string, where?: Record<string, unknown>): Promise<boolean>

  /** Atomically find one entity matching the filter and update it. Returns null if no match. */
  findOneAndUpdate(filter: Filter<T>, data: Partial<T>): Promise<T | null>

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

/** Which of an org's posted journal lines to add up. */
export interface JournalLineTotalsQuery {
  orgId: string
  /** Only entries in one of these fiscal periods. An empty list matches nothing, never everything. */
  fiscalPeriodIds?: string[]
  /** Only entries dated on or after this. */
  from?: Date
  /** Only entries dated on or before this. */
  to?: Date
  /** One row per account and contact, rather than one per account. */
  byContact?: boolean
  /**
   * What stands before this moment: the last imported opening at or before it, dated that moment
   * included, and the lines since. Instead of `from`, `to` and `fiscalPeriodIds`.
   */
  before?: Date
  /** Leave imported openings out: they restate a balance, and nothing moved it. */
  turnoverOnly?: boolean
  /** The amounts as booked, in their lines' currency, not in base. For a reading inside one currency. */
  asBooked?: boolean
  /** Only these accounts (analytics, for `sumPostedAnalytics`). */
  only?: string[]
}

/** What the lines on one account add up to, in the org's base currency. */
export interface JournalLineTotals {
  accountId: string
  /** Only with `byContact`, and only for lines that name a contact. */
  contactId?: string
  debit: number
  credit: number
  /** Only where the lines carry any. */
  quantityDebit?: number
  quantityCredit?: number
}

/** The same for one analytic, on whatever accounts it is. */
export type JournalAnalyticTotals = Omit<JournalLineTotals, 'accountId' | 'contactId'> & { analyticId: string }

export interface IJournalEntryRepository extends IBatchRepository<IJournalEntry> {
  /**
   * The org's POSTED lines, summed per account by the store. The books only: never the shadow
   * ledger (FR-25 §3.4). With no `from`, a balance up to a moment, which starts at the last imported
   * opening: an opening restates the year before, and adding both counts it twice.
   *
   * ⚠ Statements read this and never `findMany`: a year of books is ~130k operations, and loading
   * them into a pod that holds 2 GiB beside the live service is how a report takes the API down.
   */
  sumPostedLines(query: JournalLineTotalsQuery): Promise<JournalLineTotals[]>

  /** The same reading per analytic, for the lines that name one. `byContact` means nothing here. */
  sumPostedAnalytics(query: JournalLineTotalsQuery): Promise<JournalAnalyticTotals[]>
}

export interface IAccountRepository extends IBatchRepository<IAccount> {
  /**
   * Add a signed amount to each account's cached `balance`, worked out by the store from the row
   * as it stands. Only that org's accounts are written, whatever ids are named.
   *
   * ⚠ Never read a balance and write back a sum: two entries landing on one account would lose one
   * (the stock level's lost update, #460). This is one write per account, in one round trip.
   */
  adjustBalances(orgId: string, amounts: Record<string, number>): Promise<void>
}
