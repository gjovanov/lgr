/** How long a session token — and the `auth` cookie carrying it — lives. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60

/**
 * The `auth` cookie for a freshly signed session token: one set of flags for every place that
 * signs one (password login, OAuth callback, OAuth and desktop redeems, OAuth sign-up).
 *
 * ⚠ Its lifetime is the TOKEN's. The OAuth callback used to set `maxAge: 7 days` on a 24-hour token,
 * so the cookie outlived the session it carried; five hand-copied blocks are how such a thing drifts.
 *
 * The SPAs authenticate with the bearer token they store, and the auth plugins prefer it
 * (`services/biz/session-token.ts`); this cookie serves only requests that carry no header.
 */
export function sessionCookie(token: string, ttlSeconds: number = SESSION_TTL_SECONDS) {
  return {
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: ttlSeconds,
    path: '/',
  }
}
