/**
 * What lgrai.app lets through to an org's address (FR-20.78, plan step P3-4b). Global checks only that
 * a credential is THERE: a master signs its sessions with its own secret, which global never holds,
 * and the master validates it.
 *
 * - **With a credential** (a `__Host-` session cookie, or a bearer token): anything.
 * - **Without one:** only what signing in needs: the app's static UI (GETs outside `/api/`), "Sign in
 *   with LGR" (`/api/auth/idp/*`), and WebSocket upgrades (they authenticate in their first message,
 *   as `/ws/desktop` does). Everything else is 401 here, and never reaches the shop.
 * - **Anonymous requests are rate-limited** per address and per client: a stranger cannot make the
 *   shop's link serve them. Counted per process: with several pods the limit is per pod.
 */

/** A session credential is present: a non-empty bearer token, or a non-empty `__Host-` session cookie. */
export function hasCredential(headers: Headers): boolean {
  const auth = headers.get('authorization') ?? ''
  if (/^bearer\s+\S+/i.test(auth)) return true
  const cookie = headers.get('cookie') ?? ''
  return cookie.split(';').some(c => {
    const [name, ...rest] = c.trim().split('=')
    return name.startsWith('__Host-') && rest.join('=').trim().length > 0
  })
}

/** What may reach the shop without a credential. */
export function anonymousAllowed(method: string, path: string, upgrade: boolean): boolean {
  if (upgrade) return true
  if (path === '/api/auth/idp' || path.startsWith('/api/auth/idp/')) return true
  if ((method === 'GET' || method === 'HEAD') && path !== '/api' && !path.startsWith('/api/')) return true
  return false
}

export const ANON_PER_ADDRESS = 600
export const ANON_PER_CLIENT = 120
const WINDOW_MS = 60_000
const counts = new Map<string, { start: number; n: number }>()

function bump(key: string, limit: number, now: number): boolean {
  const c = counts.get(key)
  if (!c || now - c.start >= WINDOW_MS) {
    counts.set(key, { start: now, n: 1 })
    return true
  }
  c.n++
  return c.n <= limit
}

/** Whether one more anonymous request to `label` from `ip` is within the limits (a fixed minute window). */
export function anonymousWithinLimit(label: string, ip: string | null, now = Date.now()): boolean {
  if (counts.size > 50_000) {
    for (const [k, c] of counts) if (now - c.start >= WINDOW_MS) counts.delete(k)
  }
  const perAddress = bump(`a|${label}`, ANON_PER_ADDRESS, now)
  const perClient = bump(`c|${label}|${ip ?? '-'}`, ANON_PER_CLIENT, now)
  return perAddress && perClient
}

/** Tests only. */
export function resetEdgeLimits(): void {
  counts.clear()
}
