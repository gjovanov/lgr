import { SESSION_COOKIE } from 'services/biz/session-token'

/** How long a session token — and the session cookie carrying it — lives. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60

/** An Elysia cookie jar, as far as these helpers need it. */
type CookieJar = Record<string, { set: (options: Record<string, unknown>) => unknown }>

/**
 * The `__Host-auth` cookie for a freshly signed session token: one set of flags for every place
 * that signs one (password login, OAuth callback, OAuth and desktop redeems, OAuth sign-up, an org
 * switch).
 *
 * ⚠ Its lifetime is the TOKEN's. The OAuth callback used to set `maxAge: 7 days` on a 24-hour token,
 * so the cookie outlived the session it carried; five hand-copied blocks are how such a thing drifts.
 *
 * ⚠ `Secure` ALWAYS, `Path=/` and no `Domain`: the `__Host-` prefix requires all three, and a
 * browser silently drops a `__Host-` cookie that lacks one. Browsers treat `http://localhost` as
 * secure, so development and the e2e suite are unaffected (FR-20.72, plan step P0a-8).
 *
 * The SPAs authenticate with the bearer token they store, and the auth plugins prefer it
 * (`services/biz/session-token.ts`); this cookie serves only requests that carry no header.
 */
export function sessionCookie(token: string, ttlSeconds: number = SESSION_TTL_SECONDS) {
  return {
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    maxAge: ttlSeconds,
    path: '/',
  }
}

/**
 * Put a session in the browser: `__Host-auth` alone. The plain `auth` name, written beside it for
 * one release (P0a-8 release N), is neither written nor read since release N+1.
 */
export function setSessionCookie(cookie: CookieJar, token: string, ttlSeconds: number = SESSION_TTL_SECONDS): void {
  cookie[SESSION_COOKIE].set(sessionCookie(token, ttlSeconds))
}

/**
 * Sign the browser out of its session, with the attributes the cookie was set with.
 *
 * ⚠ Never `cookie.x.remove()`. Elysia's `remove()` sends no `Path` and no `Secure`, and a browser
 * ignores a `__Host-` cookie without them, so the removal of one is silently dropped.
 */
export function clearSessionCookie(cookie: CookieJar): void {
  cookie[SESSION_COOKIE].set({ ...sessionCookie('', 0), expires: new Date(0) })
}
