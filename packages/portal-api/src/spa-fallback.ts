import staticPlugin from '@elysiajs/static'
import { APP_IDS } from 'config/constants'
import { logger } from 'services/logger'
import { posRedirect } from './lib/pos-redirect.js'

/**
 * Serving the built SPAs from the API process: their files, and their shell for every browser
 * route no server route answers (`/login`, `/inventory/products/…`).
 *
 * Lives here, not inline in `unified.ts`, so `spa-fallback.flow.test.ts` can drive this exact
 * handler with the real static and CORS plugins. `unified.ts` connects to Mongo and listens at
 * import, so nothing can mount it, and the only check on this path used to be the deploy
 * script's smoke request to `/`.
 */

/**
 * lgrai.app's analytics tag. ⚠ It is added to the portal's shell by the SERVER, and only on
 * `global` (FR-20 AC 66: a master serves no third-party script and no analytics beacon). It used
 * to sit in `portal-ui/index.html`, so every build carried it, including the package a master runs
 * on a shop's LAN, where it would report that shop's visits to another origin.
 */
export const GLOBAL_ANALYTICS_TAG = '<script defer data-domain="lgrai.app" src="https://purestat.ai/js/purestat.js"></script>'

/**
 * What a master's portal shell says about itself (gjovanov/lgr#384): read once by the portal's
 * router (`ui-shared/nav/node-role.ts`, which holds the same string), so that a visitor nobody
 * signed in lands on the server's own sign-in page. lgrai.app's landing page is its marketing
 * (pricing, a free sign-up), and on a shop's LAN it was the first screen a till showed of its
 * own server, with no sign-in form on it.
 */
export const MASTER_NODE_TAG = '<meta name="lgr-node" content="master">'

/**
 * The portal's shell as this node serves it: with the analytics tag on `global`, and on a
 * master the tag above instead.
 */
export function portalShellFor(html: string, role: 'global' | 'master'): string {
  const tag = role === 'global' ? GLOBAL_ANALYTICS_TAG : MASTER_NODE_TAG
  if (html.includes(tag)) return html
  return html.replace('</head>', `  ${tag}\n  </head>`)
}

/**
 * FR-24.13 let a browser choose the one SPA or the eight with the `lgr_ui` cookie (`/__ui/one`,
 * `/__ui/split`). FR-24.21 deleted the eight, so those addresses now only send the browser home and
 * drop the cookie.
 */
export const UI_COOKIE = 'lgr_ui'

/** The one SPA's shell as this node serves it, in its two variants (FR-24.18). */
export interface OneSpaShell {
  /** For a module's page: no analytics tag, ever (module URLs carry document ids). */
  module: string
  /** For a portal page: as `portalShellFor` serves the portal's own shell. */
  portal: string
}

/** Both variants from the built `index.html`. The master tag goes on both: the router reads it once. */
export function oneSpaShell(html: string, role: 'global' | 'master'): OneSpaShell {
  return { module: role === 'master' ? portalShellFor(html, 'master') : html, portal: portalShellFor(html, role) }
}

/** The build id the one SPA's `index.html` carries (`<meta name="lgr-build">`), or null. */
export function webBuildId(html: string | undefined): string | null {
  return html?.match(/<meta name="lgr-build" content="([^"]+)"/)?.[1] ?? null
}

/** A module's page, rather than the portal's: its path is under a module's prefix. */
export function isModulePath(pathname: string): boolean {
  return APP_IDS.some(m => pathname === `/${m}` || pathname.startsWith(`/${m}/`))
}

/** The SPA's built files, mounted under a prefix. */
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
 * The app's `onError`: 422 for validation, a 302 for one of the POS app's old addresses, the SPA
 * shell for a browser route nothing else answered, 404 for anything else unknown, 500 for the rest.
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
export function spaErrorHandler(given?: OneSpaShell | Record<string, never> | null) {
  // The API-only harnesses pass `{}` (as they passed an empty index map before FR-24.21): no shell.
  const shell = given && typeof (given as OneSpaShell).portal === 'string' ? (given as OneSpaShell) : null
  return ({ code, error: err, set, request }: { code: unknown; error: any; set: any; request: Request }) => {
    // A status THROWN on purpose (`throw status(403, …)`): an answer, not a failure. The
    // write-permission guard throws one, because it runs before validation in a transform hook,
    // which cannot return a response (S-28). Elysia hands it over with a numeric `code`;
    // left to the branches below it became a 500.
    if (typeof code === 'number' && err && 'response' in err) {
      set.status = code
      return err.response
    }
    // A refusal from the DAL (`dal`'s `ValidationError`, e.g. an update operator in a PUT body,
    // FR-20.7). It carries its own message; Elysia's schema errors always carry `valueError`.
    if (err?.name === 'ValidationError' && err?.code === 'VALIDATION' && !err?.valueError) {
      set.status = 422
      return { message: err.message }
    }
    if (code === 'VALIDATION') {
      set.status = 422
      return { message: validationMessage(err) }
    }
    // FR-20.4: a write the home guard refused below the routes, on a route with no `:orgId` for the
    // home gate to see (a desktop's own `PUT /desktop/v1/self` for an org that moved): the gate's
    // answer, never a 500.
    if (err?.name === 'HomeElsewhereError') {
      set.status = 409
      return { code: 'org_home_elsewhere', message: err.message, home: { kind: err.info?.home === 'global' ? 'global' : 'master', state: err.info?.state } }
    }
    // FR-20.81 (P3-6d): a legal number asked for while the series wait for the site's last numbers.
    if (err?.name === 'SeriesFrozenError') {
      set.status = 409
      return { code: 'series_frozen', message: err.message }
    }
    if (code === 'NOT_FOUND') {
      const url = new URL(request.url)
      const pathname = url.pathname
      // No SPA claims `/pos` any more: without this the portal's shell would answer a till's stored
      // start path.
      const moved = request.method === 'GET' || request.method === 'HEAD' ? posRedirect(pathname, url.search) : null
      if (moved) {
        // Both, as the shell below: each alone keeps the error's 404 in one of the static plugin's modes.
        set.status = 302
        set.headers['location'] = moved
        return new Response(null, { status: 302, headers: { location: moved, 'cache-control': 'no-store' } })
      }
      // FR-24.21: the addresses that used to choose a shell send the browser home, dropping the choice.
      if ((pathname === '/__ui/one' || pathname === '/__ui/split') && (request.method === 'GET' || request.method === 'HEAD')) {
        const cookie = `${UI_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`
        set.status = 302
        set.headers['location'] = '/'
        set.headers['set-cookie'] = cookie
        return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store' } })
      }
      if (shell && !pathname.startsWith('/api/') && !pathname.match(/\.\w{2,}$/)) {
        // One shell for every page (FR-24.21); a module's page never carries the analytics tag (FR-24.18).
        const html = isModulePath(pathname) ? shell.module : shell.portal
        set.status = 200
        return new Response(html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // index.html must NOT be cached: it references the per-build hashed bundles, so a
            // stale copy pins users to old JS after a deploy (the cause of the "hard refresh
            // needed to see changes" issue). The hashed assets under /ui/* are
            // content-addressed and stay cacheable.
            'cache-control': 'no-cache, no-store, must-revalidate',
          },
        })
      }
      set.status = 404
      return { message: 'Not found' }
    }
    logger.error(err)
    set.status = 500
    return { message: err?.message || 'Internal server error' }
  }
}
