import staticPlugin from '@elysiajs/static'
import { logger } from 'services/logger'

/**
 * Serving the built SPAs from the API process: their files, and their shell for every browser
 * route no server route answers (`/login`, `/inventory/products/…`).
 *
 * Lives here, not inline in `unified.ts`, so `spa-fallback.flow.test.ts` can drive this exact
 * handler with the real static and CORS plugins. `unified.ts` connects to Mongo and listens at
 * import, so nothing can mount it, and the only check on this path used to be the deploy
 * script's smoke request to `/`.
 */

/** The SPAs the unified server serves, by URL prefix. `portal` is the root and the default. */
export const UI_MODULES = ['portal', 'accounting', 'inventory', 'invoicing', 'pos', 'payroll', 'reports', 'files'] as const
export type UiModule = (typeof UI_MODULES)[number]

/** One SPA's built files, mounted under its prefix. */
export function uiStaticPlugin(ui: { assets: string; prefix: string }, opts: { alwaysStatic?: boolean } = {}) {
  return staticPlugin({
    assets: ui.assets,
    prefix: ui.prefix || '',
    // The shell is served by the fallback below, with no-store; a static `/` would let it be cached.
    indexHTML: false,
    ...opts,
  })
}

/**
 * A schema rejection said plainly: which field, and why.
 *
 * Elysia's own `message` is no use to a person. Under `NODE_ENV=production` it is
 * `{"type":"validation","on":"body","found":{…}}` — the whole request echoed back with no field
 * named — and it reached users verbatim in a snackbar: an empty email on a new contact read as
 * a wall of JSON, and nobody could tell the email was the problem. `valueError` (the first
 * failing check) is set in every mode, so the answer does not depend on NODE_ENV.
 */
export function validationMessage(err: any): string {
  const first = err?.valueError
  if (!first) return 'Invalid request'
  // `/addresses/0/street` → `addresses.0.street`; a missing body is reported at the root.
  const field = String(first.path ?? '').replace(/^\//, '').replace(/\//g, '.')
  const custom = first.schema?.error
  const reason = typeof custom === 'string' ? custom : String(first.message ?? 'invalid value')
  const where = err?.type && err.type !== 'body' ? `${err.type} parameter` : 'field'
  return field ? `Invalid ${where} "${field}": ${reason}` : `Invalid request: ${reason}`
}

/**
 * The app's `onError`: 422 for validation, the SPA shell for a browser route nothing else
 * answered, 404 for anything else unknown, 500 for the rest.
 *
 * ⚠ The shell answer sets `set.status = 200` AND returns a `Response` carrying 200. Each alone
 * is 200 in only one of `@elysiajs/static`'s two modes, and the mode follows `NODE_ENV`
 * (`alwaysStatic = NODE_ENV === 'production'`):
 *   - `set.status = 200` and a string: Elysia overwrites the 200 with the error's 404 after the
 *     handler (`if(set.status===200||!set.status)set.status=error.status`: an explicit 200 looks
 *     like the default). Production on 2026-10-04: setting `NODE_ENV=production` (S-24) turned
 *     every SPA route, `/` included, into its HTML with status 404, and every deploy's smoke
 *     check after it reported DEPLOY_FAILED on a rollout that had succeeded.
 *   - a `Response` alone: with `NODE_ENV` unset, the static plugin's catch-all route maps the
 *     handler's Response through `set`, whose status is that route's 404.
 */
export function spaErrorHandler(indexHtmlMap: Partial<Record<UiModule, string>>) {
  return ({ code, error: err, set, request }: { code: unknown; error: any; set: any; request: Request }) => {
    if (code === 'VALIDATION') {
      set.status = 422
      return { message: validationMessage(err) }
    }
    if (code === 'NOT_FOUND') {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith('/api/') && !pathname.match(/\.\w{2,}$/)) {
        // The module's own SPA, or the portal (app hub) for a path no module claims.
        const moduleName = UI_MODULES.find(m => m !== 'portal' && pathname.startsWith(`/${m}`))
        const html = indexHtmlMap[moduleName || 'portal'] || indexHtmlMap.portal
        if (html) {
          set.status = 200
          return new Response(html, {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              // index.html must NOT be cached: it references the per-build hashed bundles, so a
              // stale copy pins users to old JS after a deploy (the cause of the "hard refresh
              // needed to see changes" issue). The hashed assets under /assets/* are
              // content-addressed and stay cacheable.
              'cache-control': 'no-cache, no-store, must-revalidate',
            },
          })
        }
      }
      set.status = 404
      return { message: 'Not found' }
    }
    logger.error(err)
    set.status = 500
    return { message: err?.message || 'Internal server error' }
  }
}
