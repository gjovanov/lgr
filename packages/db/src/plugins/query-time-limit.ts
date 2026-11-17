import type { Schema } from 'mongoose'
import { currentRequest } from '../home/request-context.js'

/**
 * FR-29.26 (D-8): the queries of a request have a time limit. A slow list or report used to run to its end on the single
 * database member after its caller had gone.
 *
 * - Only a request's reads (find, findOne, count, distinct, aggregate), and only while the request is open: a job, a
 *   backup, a migration and the work a request leaves running behind it (a background task) carry no limit of theirs
 *   from here; each names its own where it needs one. Exports and reports have a longer one (`LONG_ROUTE`).
 * - `QUERY_TIME_LIMIT_MODE`: `log` (the default, D-8's first week) only logs what would have been cut, with the route
 *   and the shape of the filter, never its values; `enforce` sets `maxTimeMS`, and a request that hits it answers 503
 *   `query_timeout` (`spaErrorHandler`); `off` does neither.
 * - ⚠ After FR-29.23: a session's lookup that fails is answered "try again", never remembered as a sign-out, so a
 *   limit hit under load costs a retry and not the session. The lookups (`Identity`, `Org`) carry no tenant plugin and
 *   so no limit here at all.
 * - Raw driver calls (`Model.collection.*`) are not seen by a Mongoose hook and carry no limit.
 */
export type QueryTimeLimitMode = 'off' | 'log' | 'enforce'

export function queryTimeLimitMode(): QueryTimeLimitMode {
  const m = String(process.env.QUERY_TIME_LIMIT_MODE ?? 'log').toLowerCase()
  return m === 'off' || m === 'enforce' ? m : 'log'
}

/** The limit of a request's queries, ms (D-8: 20 s), and the longer one of an export or a report. */
export const QUERY_TIME_LIMIT_MS = Number(process.env.QUERY_TIME_LIMIT_MS) || 20_000
export const QUERY_TIME_LIMIT_LONG_MS = Number(process.env.QUERY_TIME_LIMIT_LONG_MS) || 120_000

/** Routes that read a lot on purpose: an export, a report, a print. */
const LONG_ROUTE = /\/(export|exports|reports?|pdf|xlsx|print)(\/|$)/i

/** The limit for a query made now, or null outside an open request. */
export function queryTimeLimitNow(): number | null {
  const ctx = currentRequest()
  if (!ctx || ctx.done) return null
  return LONG_ROUTE.test(ctx.route) ? QUERY_TIME_LIMIT_LONG_MS : QUERY_TIME_LIMIT_MS
}

/** The database's "operation exceeded time limit" (`MaxTimeMSExpired`, code 50). */
export function isQueryTimeout(e: unknown): boolean {
  const err = e as { code?: unknown; codeName?: unknown } | null | undefined
  return err?.code === 50 || err?.codeName === 'MaxTimeMSExpired'
}

/** A filter's shape: its keys and operators, never a value. */
export function shapeOf(filter: unknown, depth = 0): unknown {
  if (depth > 4) return '…'
  if (Array.isArray(filter)) return filter.length ? [shapeOf(filter[0], depth + 1)] : []
  if (filter && typeof filter === 'object' && filter.constructor === Object) {
    return Object.fromEntries(Object.entries(filter).map(([k, v]) => [k, shapeOf(v, depth + 1)]))
  }
  return '?'
}

const READS = ['find', 'findOne', 'countDocuments', 'distinct'] as const
const STARTED = Symbol('lgrQueryStarted')

/** The hooks. Installed on every tenant model by `tenantPlugin`. */
export function queryTimeLimitPlugin(schema: Schema): void {
  for (const op of READS) schema.pre(op, function (this: any) {
    const mode = queryTimeLimitMode()
    const limit = mode === 'off' ? null : queryTimeLimitNow()
    if (limit === null) return
    if (mode === 'enforce') {
      if (this.getOptions?.().maxTimeMS === undefined) this.maxTimeMS(limit)
    } else {
      this[STARTED] = { at: Date.now(), limit }
    }
  })
  for (const op of READS) schema.post(op, function (this: any) {
    const started = this[STARTED]
    if (!started) return
    const ms = Date.now() - started.at
    if (ms > started.limit) {
      console.warn(JSON.stringify({
        msg: 'A query ran past the time limit it would have had (QUERY_TIME_LIMIT_MODE=log)',
        route: currentRequest()?.route, model: this.model?.modelName, op: this.op, ms, limit: started.limit, shape: shapeOf(this.getFilter?.()),
      }))
    }
  })
  // Enforced: the query that hit the limit says what it asked, by shape, for the request's log line (`spaErrorHandler`).
  for (const op of READS) schema.post(op, { errorHandler: true }, function (this: any, error: any, _res: unknown, next: (e?: any) => void) {
    if (isQueryTimeout(error)) error.queryShape = { model: this.model?.modelName, op: this.op, filter: shapeOf(this.getFilter?.()) }
    next(error)
  })
  schema.pre('aggregate', function (this: any) {
    const mode = queryTimeLimitMode()
    const limit = mode === 'off' ? null : queryTimeLimitNow()
    if (limit === null) return
    if (mode === 'enforce') {
      if (this.options?.maxTimeMS === undefined) this.option({ maxTimeMS: limit })
    } else {
      this[STARTED] = { at: Date.now(), limit }
    }
  })
  schema.post('aggregate', function (this: any) {
    const started = this[STARTED]
    if (!started) return
    const ms = Date.now() - started.at
    if (ms > started.limit) {
      console.warn(JSON.stringify({
        msg: 'An aggregation ran past the time limit it would have had (QUERY_TIME_LIMIT_MODE=log)',
        route: currentRequest()?.route, model: this._model?.modelName, ms, limit: started.limit,
        stages: (this.pipeline?.() ?? []).map((s: Record<string, unknown>) => Object.keys(s)[0]),
      }))
    }
  })
}
