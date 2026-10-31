import { APP_NAV_META } from './page-registry'

/**
 * FR-22.53: signing in returns the person to the page they were on — after a 401, or after
 * opening a bookmark in a tab whose session had expired.
 *
 * The page travels as `?next=` on the sign-in and org-picker URLs, and across an OAuth or
 * "Sign in with LGR" round trip in this tab's sessionStorage (the provider hands back no query).
 *
 * ⚠ `next` is whatever the link says: anyone can send a link to `/auth/login?next=…`. Following
 * it to another site after a genuine sign-in is the textbook phishing aid — the real LGR sign-in,
 * then a lookalike that asks for the password "again". So `safeReturnPath` follows only a path on
 * THIS origin under one of our own apps, and anything else lands where a sign-in always did.
 */

/** Where a return may go: an app (from the registry) or one of the portal's own pages. */
const RETURN_ROOTS: readonly string[] = [
  ...Object.values(APP_NAV_META).map((m) => m.base),
  // FR-24 Phase 0: the old POS root. The server answers it with a 302 to `/invoicing/pos/*`, and a
  // sign-in that began on an old link or a desktop's `startPath: /pos/` still returns there.
  '/pos',
  '/apps',
  '/dashboard',
  '/account',
  '/settings',
  '/admin',
]

// A backslash is a slash to a browser's URL parser, and it drops tabs and newlines anywhere in
// a URL: `/\t/evil.example` arrives as `//evil.example`. Neither belongs in a path of ours.
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/

const PROBE_ORIGIN = 'https://return-path.invalid'

/**
 * The path to return to, or null when `raw` is not one we would follow.
 *
 * Accepts only a relative path with exactly one leading `/` (`//host` and `/\host` name another
 * origin), free of backslashes and control characters, also once percent-decoded (`/%2F/host`,
 * `%5C`), that resolves to this origin under an app or a portal page. A `token` or `org` in its
 * query is dropped: those are the dev handoff's, which no return path has any business carrying.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 2 || raw.length > 2048) return null
  if (raw[0] !== '/' || raw[1] === '/' || UNSAFE_CHARS.test(raw)) return null

  let decoded = raw
  for (let i = 0; i < 3; i++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      break // a literal '%' (a search for "10%"): nothing further can decode into a trick
    }
    if (next === decoded) break
    decoded = next
    if (decoded.startsWith('//') || UNSAFE_CHARS.test(decoded)) return null
  }

  let url: URL
  try {
    url = new URL(raw, PROBE_ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== PROBE_ORIGIN) return null
  if (!RETURN_ROOTS.some((root) => url.pathname === root || url.pathname.startsWith(`${root}/`))) return null

  if (url.searchParams.has('token') || url.searchParams.has('org')) {
    url.searchParams.delete('token')
    url.searchParams.delete('org')
  }
  const path = url.pathname + url.search + url.hash
  // Unreachable past the roots check; kept so no later edit to it can open the hole again.
  return path.startsWith('//') ? null : path
}

/** The portal's sign-in page, coming back to `returnTo` when that is a path we would follow. */
export function signInPath(returnTo?: string | null): string {
  const next = safeReturnPath(returnTo)
  return next ? `/auth/login?next=${encodeURIComponent(next)}` : '/auth/login'
}

/** The org picker, for a person signed in without an org, coming back to `returnTo` the same way. */
export function orgPickerPath(returnTo?: string | null): string {
  const next = safeReturnPath(returnTo)
  return next ? `/orgs?next=${encodeURIComponent(next)}` : '/orgs'
}

/** Where this tab is now, as a return path candidate (validated by whoever follows it). */
export function currentReturnPath(): string {
  if (typeof window === 'undefined') return ''
  const { pathname, search, hash } = window.location
  return pathname + search + hash
}

/** The parts of `Storage` the round trip uses, so tests can hand it a plain map. */
export interface ReturnPathStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const RETURN_KEY = 'lgr_return_to'
/** A sign-in through a provider takes seconds; one found much later belongs to an abandoned attempt. */
const RETURN_TTL_MS = 30 * 60 * 1000

function tabStore(): ReturnPathStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Keep the return path in this tab while the sign-in leaves for a provider. Without one, whatever
 * an abandoned earlier attempt kept is cleared, so it cannot steer this sign-in.
 */
export function rememberReturnPath(
  path: string | null | undefined,
  store: ReturnPathStore | null = tabStore(),
  now: () => number = Date.now,
): void {
  const safe = safeReturnPath(path)
  try {
    if (safe) store?.setItem(RETURN_KEY, JSON.stringify({ path: safe, at: now() }))
    else store?.removeItem(RETURN_KEY)
  } catch {
    // Storage refused: the sign-in lands where it always has.
  }
}

/** The return path kept by `rememberReturnPath`, once, and only while it is fresh. */
export function takeReturnPath(
  store: ReturnPathStore | null = tabStore(),
  now: () => number = Date.now,
): string | null {
  try {
    const raw = store?.getItem(RETURN_KEY) ?? null
    store?.removeItem(RETURN_KEY)
    const kept = raw ? JSON.parse(raw) : null
    if (!kept || typeof kept.at !== 'number' || now() - kept.at > RETURN_TTL_MS || now() < kept.at) return null
    return safeReturnPath(kept.path)
  } catch {
    return null
  }
}
