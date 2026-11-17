import type { ClientSession, Model } from 'mongoose'
import type { BaseEntity, Filter, SortSpec, PageRequest, PageResult, AggregateStage, Projection, ReadOptions, SessionOptions } from 'dal'
import type { IBatchRepository } from 'dal'
import { DuplicateError, ValidationError } from 'dal'
import { toEntity, toDocument } from './entity-mapper.js'
import { translateFilter } from './filter-translator.js'
import { pageUnderCeiling } from 'config/list-rows'

/**
 * A DAL projection as Mongoose takes it. `id` is the document's `_id`, which Mongo returns unless it
 * is excluded by name, so `['name']` still answers with the entity's `id`.
 */
export function toProjection(select: Projection | undefined): Record<string, 0 | 1> | undefined {
  if (!select) return undefined
  const entries: [string, 0 | 1][] = Array.isArray(select)
    ? (select as readonly string[]).map(f => [f, 1])
    : Object.entries(select as Record<string, 0 | 1>)
  if (!entries.length) return undefined
  return Object.fromEntries(entries.map(([f, v]) => [f === 'id' ? '_id' : f, v]))
}

/** FR-30.11: up to this many matches, a hinted read fetches them through its index; above, the planner's plan does. */
const HINTED_PAGE_MAX = 300

/**
 * Run a read through `hint`, or without one when the store has no such index (a database whose index is still being
 * built as the server starts): the same read, served as the planner chooses.
 */
type IndexHint = Record<string, 1 | -1> | string

async function withHint<R>(hint: IndexHint | undefined, run: (h?: IndexHint) => Promise<R>): Promise<R> {
  if (!hint) return run()
  try {
    return await run(hint)
  } catch (err: any) {
    if (/hint/i.test(String(err?.message ?? ''))) return run()
    throw err
  }
}

/** The caller's session as the driver takes it, or none. */
export function sessionOf(opts: SessionOptions | undefined): ClientSession | undefined {
  return (opts?.session as ClientSession | undefined) ?? undefined
}

/** Options for a Mongoose call, with the session only when there is one: a call without is unchanged. */
export function withSession<O extends Record<string, unknown>>(opts: SessionOptions | undefined, rest?: O): O & { session?: ClientSession } {
  const session = sessionOf(opts)
  const base = (rest ?? {}) as O
  return session ? { ...base, session } : base
}

/**
 * MongoDB/Mongoose implementation of IBatchRepository.
 * Wraps a Mongoose Model and translates between DAL entities and Mongoose documents.
 *
 * FR-32.14: every method takes `session` and hands it to EVERY operation it makes (a page's count
 * included), and the reads that return documents take `select`.
 */
export class MongoRepository<T extends BaseEntity> implements IBatchRepository<T> {
  constructor(protected model: Model<any>) {}

  async findById(id: string, opts?: ReadOptions): Promise<T | null> {
    try {
      const doc = await this.model.findById(id, toProjection(opts?.select), withSession(opts)).lean().exec()
      return doc ? toEntity<T>(doc) : null
    } catch (err: any) {
      if (err.name === 'CastError') return null
      throw err
    }
  }

  async findOne(filter: Filter<T>, opts?: ReadOptions): Promise<T | null> {
    const mongoFilter = translateFilter(filter)
    const doc = await this.model.findOne(mongoFilter, toProjection(opts?.select), withSession(opts)).lean().exec()
    return doc ? toEntity<T>(doc) : null
  }

  async findAll(filter: Filter<T>, page?: PageRequest, opts?: ReadOptions): Promise<PageResult<T>> {
    const mongoFilter = translateFilter(filter)
    const projection = toProjection(opts?.select)
    const sort = page?.sort ?? { createdAt: -1 }
    const pageNum = page?.page ?? 0
    // FR-30.8: "All" (`size <= 0`) and any size above the ceiling are the ceiling, unless the caller reads every row on
    // purpose. It used to be up to 100 000 whole documents: 81.6 MB for the Products list.
    const { take, asked } = pageUnderCeiling(page?.size ?? 10, page?.unbounded)

    if (asked === Infinity) {
      const q = this.model.find(mongoFilter, projection, withSession(opts)).sort(sort)
      const docs = await (take === Infinity ? q : q.limit(take)).lean().exec()
      // Cut only when the ceiling was reached: then the real total is counted, and the answer says it was cut.
      const total = docs.length < take ? docs.length : await this.model.countDocuments(mongoFilter, withSession(opts)).exec()
      return {
        items: docs.map(d => toEntity<T>(d)),
        total,
        page: 0,
        size: docs.length,
        totalPages: 1,
        ...(total > docs.length ? { truncated: true as const } : {}),
      }
    }

    const size = take
    const skip = pageNum * size
    const hint = opts?.hint
    // FR-30.2: the page through the index the list declares for its sort (by name), when the caller names it; the
    // count stays the planner's.
    const pageIndex: IndexHint | undefined = hint ?? opts?.index
    const find = (h?: IndexHint, extra = 0) => {
      const q = this.model.find(mongoFilter, projection, withSession(opts)).sort(sort).skip(skip).limit(size + extra)
      return (h ? q.hint(h) : q).lean().exec()
    }
    const count = (h?: IndexHint) => this.model.countDocuments(mongoFilter, withSession(opts, h ? { hint: h } : undefined)).exec()

    /*
     * FR-30.11: a read through an index named for it (the product search) first reads the matches' ids from that
     * index's keys alone (a search's filter is on the index's fields, and the index ends with `_id`), up to
     * `HINTED_PAGE_MAX` of them. Few: they are the count, and the page is read by id. None: nothing is fetched. Many:
     * they are counted from the keys, and the page is the planner's own plan (the sort's index, stopping at the page's
     * last row). Through the search index alone a common word fetched every match to sort them: 125 ms for `болт` on
     * a shop's catalogue.
     */
    if (hint) {
      const matched = await withHint(hint, (h) => {
        const q = this.model.find(mongoFilter, { _id: 1 }, withSession(opts)).limit(HINTED_PAGE_MAX + 1)
        return (h ? q.hint(h) : q).lean().exec()
      })
      const few = matched.length <= HINTED_PAGE_MAX
      const total = few ? matched.length : await withHint(hint, count)
      const docs = total <= skip
        ? []
        : few
          ? await this.model.find({ _id: { $in: matched.map((d: any) => d._id) } }, projection, withSession(opts)).sort(sort).skip(skip).limit(size).lean().exec()
          : await find()
      const hasMore = total > skip + docs.length
      return {
        items: docs.map(d => toEntity<T>(d)),
        total,
        page: pageNum,
        size,
        totalPages: Math.ceil(total / size),
        ...(page?.count !== undefined ? { hasMore } : {}),
        ...(asked > size && total - skip > size ? { truncated: true as const } : {}),
      }
    }

    // FR-30.12: a type-ahead's page: one row more than it holds tells whether more follow, and nothing is counted.
    if (page?.count === false || page?.count === 'when-more') {
      const rows = await withHint(pageIndex, (h) => find(h, 1))
      const hasMore = rows.length > size
      const docs = hasMore ? rows.slice(0, size) : rows
      const seen = skip + docs.length + (hasMore ? 1 : 0)
      const total = hasMore && page.count === 'when-more' ? await withHint(hint, count) : seen
      return { items: docs.map(d => toEntity<T>(d)), total, page: pageNum, size, totalPages: Math.ceil(total / size), hasMore }
    }

    const [docs, total] = await Promise.all([withHint(pageIndex, (h) => find(h)), withHint(hint, count)])

    return {
      items: docs.map(d => toEntity<T>(d)),
      total,
      page: pageNum,
      size,
      totalPages: Math.ceil(total / size),
      ...(asked > size && total - skip > size ? { truncated: true as const } : {}),
    }
  }

  async findMany(filter: Filter<T>, sort: SortSpec = { createdAt: -1 }, opts?: ReadOptions): Promise<T[]> {
    const mongoFilter = translateFilter(filter)
    const docs = await this.model.find(mongoFilter, toProjection(opts?.select), withSession(opts)).sort(sort).lean().exec()
    return docs.map(d => toEntity<T>(d))
  }

  async create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>, opts?: SessionOptions): Promise<T> {
    try {
      const mongoData = toDocument(data)
      const session = sessionOf(opts)
      // ⚠ `Model.create` reads options only after an ARRAY of documents: `create(doc, { session })`
      // would take the options for a second document.
      const doc = session ? (await this.model.create([mongoData], { session }))[0] : await this.model.create(mongoData)
      return toEntity<T>(doc.toObject())
    } catch (err: any) {
      if (err.code === 11000) {
        // Surface every field in the violated compound index so diagnostics don't hide behind orgId.
        const fields = err.keyValue && Object.keys(err.keyValue).length
          ? err.keyValue
          : { unknown: 'unknown' }
        throw new DuplicateError(this.model.modelName, fields)
      }
      throw err
    }
  }

  async update(id: string, data: Partial<T>, opts?: SessionOptions): Promise<T | null> {
    try {
      const mongoData = toDocument(data)
      const doc = await this.model.findByIdAndUpdate(id, mongoData, withSession(opts, { new: true })).lean().exec()
      return doc ? toEntity<T>(doc) : null
    } catch (err: any) {
      if (err.name === 'CastError') return null
      throw err
    }
  }

  async delete(id: string, opts?: SessionOptions): Promise<boolean> {
    try {
      const result = await this.model.findByIdAndDelete(id, withSession(opts)).exec()
      return result !== null
    } catch (err: any) {
      if (err.name === 'CastError') return false
      throw err
    }
  }

  // ── Org-scoped by-id operations (FR-20.7) ──
  //
  // ⚠ The filter is {_id, orgId}, never "load by id, then compare orgId": the write must not be
  // able to land on another org's document even between a check and the write.

  async findByIdInOrg(id: string, orgId: string, opts?: ReadOptions): Promise<T | null> {
    if (!orgId) return null
    try {
      const doc = await this.model.findOne({ _id: id, orgId }, toProjection(opts?.select), withSession(opts)).lean().exec()
      return doc ? toEntity<T>(doc) : null
    } catch (err: any) {
      if (err.name === 'CastError') return null
      throw err
    }
  }

  async updateInOrg(id: string, orgId: string, data: Partial<T>, where: Record<string, unknown> = {}, opts: { validate?: boolean; unset?: string[] } & SessionOptions = {}): Promise<T | null> {
    if (!orgId) return null
    // ⚠ The body is DATA, never an update document. Passed through as one, `{"$set": {"orgId": B}}`
    // re-parents the document past the `orgId` strip below (and `$unset` / `$rename` likewise),
    // because most PUT schemas allow additional properties. Refused rather than dropped: the
    // caller sent an operator, so it did not get what it asked for.
    const operators = Object.keys(data ?? {}).filter(k => k.startsWith('$'))
    if (operators.length) {
      throw new ValidationError(`Update operators are not accepted in a document body: ${operators.join(', ')}`)
    }
    try {
      // Never re-parent: an `orgId` (or `_id`) in the body is dropped, whatever the route's schema.
      const { orgId: _o, _id: _i, ...rest } = (data ?? {}) as any
      // A removed field is never set in the same write (Mongo refuses the conflict), and never a structural one.
      const unset = (opts.unset ?? []).filter(k => k && !k.startsWith('$') && !['orgId', '_id', 'id'].includes(k))
      for (const k of unset) delete rest[k]
      const mongoData: Record<string, unknown> = { $set: toDocument(rest) }
      if (unset.length) mongoData.$unset = Object.fromEntries(unset.map(k => [k, 1]))
      const doc = await this.model.findOneAndUpdate({ ...where, _id: id, orgId }, mongoData, withSession(opts, { new: true, ...(opts.validate ? { runValidators: true } : {}) })).lean().exec()
      return doc ? toEntity<T>(doc) : null
    } catch (err: any) {
      if (err.name === 'CastError') return null
      throw err
    }
  }

  async deleteInOrg(id: string, orgId: string, where: Record<string, unknown> = {}, opts?: SessionOptions): Promise<boolean> {
    if (!orgId) return false
    try {
      const result = await this.model.findOneAndDelete({ ...where, _id: id, orgId }, withSession(opts)).exec()
      return result !== null
    } catch (err: any) {
      if (err.name === 'CastError') return false
      throw err
    }
  }

  async findOneAndUpdate(filter: Filter<T>, data: Partial<T>, opts?: SessionOptions): Promise<T | null> {
    const mongoFilter = translateFilter(filter)
    const mongoData = toDocument(data)
    const doc = await this.model.findOneAndUpdate(mongoFilter, mongoData, withSession(opts, { new: true })).lean().exec()
    return doc ? toEntity<T>(doc) : null
  }

  async count(filter: Filter<T>, opts?: SessionOptions): Promise<number> {
    const mongoFilter = translateFilter(filter)
    return this.model.countDocuments(mongoFilter, withSession(opts)).exec()
  }

  async aggregate<R = any>(pipeline: AggregateStage[], opts?: SessionOptions): Promise<R[]> {
    // Pass through to Mongoose aggregate — the pipeline format is compatible
    // with MongoDB's native pipeline format for basic stages
    const mongoPipeline = pipeline.map(stage => {
      if ('$match' in stage) {
        return { $match: translateFilter(stage.$match) }
      }
      return stage
    })
    return this.model.aggregate(mongoPipeline).session(sessionOf(opts) ?? null).exec()
  }

  // ── Batch operations ──

  async createMany(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>[], opts?: SessionOptions): Promise<T[]> {
    const mongoDocs = data.map(d => toDocument(d))
    const docs = await this.model.insertMany(mongoDocs, withSession(opts))
    return docs.map(d => toEntity<T>(d.toObject()))
  }

  async updateMany(filter: Filter<T>, data: Partial<T>, opts?: SessionOptions): Promise<number> {
    const mongoFilter = translateFilter(filter)
    const mongoData = toDocument(data)
    const result = await this.model.updateMany(mongoFilter, mongoData, withSession(opts)).exec()
    return result.modifiedCount
  }

  async deleteMany(filter: Filter<T>, opts?: SessionOptions): Promise<number> {
    const mongoFilter = translateFilter(filter)
    const result = await this.model.deleteMany(mongoFilter, withSession(opts)).exec()
    return result.deletedCount
  }
}
