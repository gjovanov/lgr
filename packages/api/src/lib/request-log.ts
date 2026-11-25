import { Elysia, StatusMap } from 'elysia'
import { logger } from 'services/logger'

/**
 * A line per request, for finding which routes cost more (#785). **Off by default**: on with
 * `LGR_LOG_REQUESTS=1` (or `true`), read once at start. On a master it goes in `config/api.env`.
 *
 * Each line is `{ method, route, status, ms }` at `info`, the level the API logs at by default:
 * - `route` is the matched route's PATTERN (`/api/org/:orgId/invoicing/invoices/:id`), never the
 *   URL, so no id or query reaches the log and lines count per route;
 * - a request no route matched (a 404, the SPA's shell, a static file) is `UNMATCHED`;
 * - a request an `onRequest` hook answered itself (the tunnel, the front's refusals) logs nothing:
 *   Elysia runs no later hook for it.
 *
 * Off, no hook is registered at all, so a request pays nothing for it.
 */
export const UNMATCHED = '(unmatched)'

/** What the lines are written to: the API's logger, or a test's. */
export type RequestLogSink = { info: (fields: Record<string, unknown>, msg: string) => void }

export function requestLogEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.LGR_LOG_REQUESTS?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

/** When the request came in, kept on Elysia's context: the same object from `onRequest` to `onAfterResponse`. */
type Timed = { lgrRequestStartedAt?: number }

export function requestLog(enabled = requestLogEnabled(), sink: RequestLogSink = logger) {
  const plugin = new Elysia({ name: 'request-log', seed: enabled })
  if (!enabled) return plugin
  return plugin
    // ⚠ Request hooks are always global and take a handler only (an options object would be registered AS the hook).
    .onRequest(ctx => { (ctx as unknown as Timed).lgrRequestStartedAt = performance.now() })
    .onAfterResponse({ as: 'global' }, ctx => {
      const started = (ctx as unknown as Timed).lgrRequestStartedAt
      const answer = (ctx as unknown as { responseValue?: unknown }).responseValue
      // A handler that returns its own Response sets its status there, not in `set`.
      const status = answer instanceof Response ? answer.status : ctx.set.status
      sink.info({
        method: ctx.request.method,
        route: ctx.route || UNMATCHED,
        status: typeof status === 'number' ? status : (StatusMap as Record<string, number>)[String(status)] ?? status,
        ms: started === undefined ? null : Math.round((performance.now() - started) * 10) / 10,
      }, 'request')
    })
}
