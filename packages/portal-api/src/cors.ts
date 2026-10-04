import cors from '@elysiajs/cors'
import { config } from 'config'
import { APP_REGISTRY } from 'config/constants'

/**
 * S-07 — the origins CORS answers.
 *
 * ⚠ It was `cors({ origin: true, credentials: true })`: whatever `Origin` a caller sent was echoed
 * back with credentials allowed. Only the auth cookie's `sameSite: 'lax'` kept that from being
 * exploitable; the day someone needs a cross-site embed and flips it to `'none'`, every site on
 * the internet could make authenticated calls as a signed-in user.
 *
 * In production every SPA is served from the API's own origin, so the browser never asks.
 * The list exists for what is genuinely cross-origin:
 *   - the configured frontend and app URLs (the same origin in production, written down anyway);
 *   - `CORS_ORIGINS`, comma-separated, for a deliberate extra;
 *   - outside production, the per-app Vite dev ports. A domain SPA on :4021 calls the unified API
 *     on :4001 directly for `/auth/me`. They are never allowed in production: a page anyone runs
 *     on those ports must not be able to call lgrai.app with a user's credentials.
 *
 * ⚠ CORS is not an access control. A refused origin's request still reaches the server; the
 * browser just withholds the response from the page. The auth guards decide who may do what.
 */
export function allowedOrigins(): string[] {
  const origins = new Set<string>()
  const add = (url: string | undefined) => {
    if (!url) return
    try {
      origins.add(new URL(url.trim()).origin)
    } catch {
      /* a malformed entry is skipped, never widened into a wildcard */
    }
  }

  add(config.oauth.frontendUrl)
  add(config.email.appUrl)
  for (const extra of (process.env.CORS_ORIGINS || '').split(',')) add(extra)

  if (process.env.NODE_ENV !== 'production') {
    const ports = new Set<number>([4000, 4001, ...Object.values(APP_REGISTRY).map(a => a.devPort)])
    for (const port of ports) {
      origins.add(`http://localhost:${port}`)
      origins.add(`http://127.0.0.1:${port}`)
    }
  }
  return [...origins]
}

export function corsPlugin() {
  return cors({ origin: allowedOrigins(), credentials: true })
}
