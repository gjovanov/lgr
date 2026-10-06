/**
 * Who is signed in, for THIS browser tab (multi-org sign-in, Phase 3).
 *
 * Every SPA reads and writes its session here and nowhere else. `unit/session-keys.test.ts` fails
 * the build if any other UI source touches the storage keys below.
 *
 * Each tab keeps its own org. A person can have regal open in one tab and regal-pz in the next,
 * and a switch in one never moves the other: a POS till holding the fiscal printer, or a
 * half-filled form, stays where it was.
 *
 * Storage:
 *   - sessionStorage `lgr_token` / `lgr_org`: this tab's session. Private to the tab, and it
 *     survives a reload.
 *   - localStorage `lgr_token` / `lgr_org`: the session a NEW tab starts in. That is the tab that
 *     last signed in or had focus, so a link opened in a new tab lands in the org it came from.
 *   - localStorage `lgr_last_org`: the org this browser was last in. It survives sign-out; the
 *     login page asks the server to land there (`preferredOrgId`, OAuth `prefer`).
 *
 * ⚠ The new-tab default is ADOPTED, copied into the tab once on its first read, and never read
 * live after that. A tab that kept reading localStorage would act in whichever org another tab
 * switched to last, with a perfectly valid token. That is the whole hazard this module exists to
 * close (plan rule 6).
 */

export interface SessionOrg {
  id: string
  name: string
  slug: string
  [key: string]: unknown
}

/** What a session token says. An identity-only token has `type: 'identity'` and no org. */
export interface SessionClaims {
  id?: string
  _id?: string
  orgId?: string
  role?: string
  permissions?: string[]
  iid?: string
  tv?: number
  type?: string
  email?: string
  exp?: number
  [key: string]: unknown
}

/** The parts of `Storage` this module uses, so tests can hand it two tabs and one localStorage. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SessionChannel {
  postMessage(message: unknown): void
  /** Called with every message another tab posts. */
  subscribe(listener: (message: unknown) => void): void
}

export interface SessionDeps {
  tab: KeyValueStore | null
  shared: KeyValueStore | null
  now?: () => number
  channel?: SessionChannel | null
}

const TOKEN_KEY = 'lgr_token'
const ORG_KEY = 'lgr_org'
const LAST_ORG_KEY = 'lgr_last_org'
/**
 * Set in a tab that was signed out, by a 401 or a sign-out. Such a tab must not silently adopt
 * another tab's session on its next read; that would move it to a different org (or a different
 * person, on a shared machine) without anyone asking. Signing in clears it.
 */
const SIGNED_OUT_KEY = 'lgr_signed_out'

/** Decode a JWT's payload. Names may be Cyrillic, so the bytes are read as UTF-8. */
export function decodeClaims(token: string): SessionClaims | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
    const json = JSON.parse(new TextDecoder().decode(bytes))
    return json && typeof json === 'object' ? (json as SessionClaims) : null
  } catch {
    return null
  }
}

/** Whose session this is: the person when the token names one, else the membership. */
export function personKey(claims: SessionClaims | null): string {
  if (!claims) return ''
  if (claims.iid) return `iid:${claims.iid}`
  const id = claims.id ?? claims._id
  return id ? `user:${id}` : ''
}

function parseOrg(raw: string | null): SessionOrg | null {
  if (!raw) return null
  try {
    const org = JSON.parse(raw)
    return org && typeof org === 'object' && typeof org.id === 'string' ? (org as SessionOrg) : null
  } catch {
    return null
  }
}

export type SessionApi = ReturnType<typeof createSession>

export function createSession(deps: SessionDeps) {
  const now = deps.now ?? (() => Date.now())

  const read = (store: KeyValueStore | null, key: string): string => {
    try {
      return store?.getItem(key) ?? ''
    } catch {
      return ''
    }
  }
  const write = (store: KeyValueStore | null, key: string, value: string | null) => {
    try {
      if (!store) return
      if (value === null) store.removeItem(key)
      else store.setItem(key, value)
    } catch {
      // Storage refused (quota, privacy mode): the tab simply has no session to keep.
    }
  }

  const expired = (token: string) => {
    const exp = decodeClaims(token)?.exp
    return typeof exp === 'number' && exp * 1000 <= now()
  }

  /** This tab's token, adopting the new-tab default on first use. '' when signed out. */
  function getToken(): string {
    const own = read(deps.tab, TOKEN_KEY)
    if (own) return own
    if (read(deps.tab, SIGNED_OUT_KEY)) return ''
    const fallback = read(deps.shared, TOKEN_KEY)
    if (!fallback || expired(fallback)) return ''
    // Adopt the token and its org together; from here on this tab is on its own.
    write(deps.tab, TOKEN_KEY, fallback)
    write(deps.tab, ORG_KEY, read(deps.shared, ORG_KEY) || null)
    return fallback
  }

  /** This tab's org, or null when signed out or signed in as a person who has not chosen one. */
  function getOrg(): SessionOrg | null {
    if (!getToken()) return null
    return parseOrg(read(deps.tab, ORG_KEY))
  }

  function claims(): SessionClaims | null {
    const token = getToken()
    return token ? decodeClaims(token) : null
  }

  /** Signed in as a person who has not entered an org: the token reaches only the identity routes. */
  function isPersonOnly(): boolean {
    return claims()?.type === 'identity'
  }

  /** An org session: what every screen except the org picker needs. */
  function hasOrgSession(): boolean {
    const c = claims()
    return !!c && c.type !== 'identity' && !!c.orgId
  }

  /**
   * Start a session in this tab: a sign-in, a switch, a join or a new org. It also becomes what
   * a new tab starts in, written now rather than on the next focus event (a headless browser may
   * never fire one). `org` is null for an identity-only token.
   */
  function setSession(token: string, org: SessionOrg | null): void {
    const orgJson = org ? JSON.stringify(org) : null
    write(deps.tab, SIGNED_OUT_KEY, null)
    write(deps.tab, TOKEN_KEY, token)
    write(deps.tab, ORG_KEY, orgJson)
    write(deps.shared, TOKEN_KEY, token)
    write(deps.shared, ORG_KEY, orgJson)
    if (org?.id) write(deps.shared, LAST_ORG_KEY, org.id)
  }

  /** A fresher copy of this tab's org (from `/auth/me`). Ignored unless it is the token's org. */
  function updateOrg(org: SessionOrg): void {
    const token = getToken()
    if (!token || decodeClaims(token)?.orgId !== org.id) return
    const orgJson = JSON.stringify(org)
    write(deps.tab, ORG_KEY, orgJson)
    if (read(deps.shared, TOKEN_KEY) === token) write(deps.shared, ORG_KEY, orgJson)
  }

  /** The org this browser was last in ('' if none): where the login page asks to land. */
  function lastOrgId(): string {
    return read(deps.shared, LAST_ORG_KEY)
  }

  function forgetTab(): void {
    const token = read(deps.tab, TOKEN_KEY)
    write(deps.tab, TOKEN_KEY, null)
    write(deps.tab, ORG_KEY, null)
    write(deps.tab, SIGNED_OUT_KEY, '1')
    // The new-tab default goes too when it is this very token: it is no better than ours.
    if (token && read(deps.shared, TOKEN_KEY) === token) {
      write(deps.shared, TOKEN_KEY, null)
      write(deps.shared, ORG_KEY, null)
    }
  }

  /**
   * The server refused `failedToken` (a 401). Returns true when this tab is still signed in
   * afterwards and should reload, false when it must go to the login page.
   *
   * Only this tab is signed out. It takes over the new-tab default only when that is a DIFFERENT
   * token for the SAME org, typically because the person signed in again in another tab. A token
   * for another org is never adopted here: the tab would land in an org nobody chose for it.
   */
  function recoverFrom401(failedToken: string): boolean {
    const own = read(deps.tab, TOKEN_KEY)
    // Another request already replaced this tab's token (a switch, a password change): the
    // refusal was about a token we no longer hold.
    if (own && failedToken && own !== failedToken) return true
    const orgId = decodeClaims(own || failedToken)?.orgId
    forgetTab()
    const fallback = read(deps.shared, TOKEN_KEY)
    if (!fallback || fallback === failedToken || expired(fallback)) return false
    const fallbackClaims = decodeClaims(fallback)
    if (!orgId || fallbackClaims?.type === 'identity' || fallbackClaims?.orgId !== orgId) return false
    write(deps.tab, SIGNED_OUT_KEY, null)
    write(deps.tab, TOKEN_KEY, fallback)
    write(deps.tab, ORG_KEY, read(deps.shared, ORG_KEY) || null)
    return true
  }

  /**
   * Sign out here, and in every other tab of this browser where the same person is signed in.
   * `notifyServer` runs first, while this tab still holds its token (the server clears the
   * `auth` cookie and records the sign-out); its failure does not stop the sign-out.
   */
  async function logoutEverywhere(notifyServer?: () => Promise<unknown>): Promise<void> {
    const who = personKey(claims())
    if (notifyServer) await notifyServer().catch(() => undefined)
    const shared = read(deps.shared, TOKEN_KEY)
    forgetTab()
    if (shared && who && personKey(decodeClaims(shared)) === who) {
      write(deps.shared, TOKEN_KEY, null)
      write(deps.shared, ORG_KEY, null)
    }
    if (who) deps.channel?.postMessage({ type: 'logout', person: who })
  }

  /** Make this tab the one a new tab starts in (it has focus, so it is where the person is). */
  function publish(): void {
    const token = read(deps.tab, TOKEN_KEY)
    if (!token || expired(token)) return
    write(deps.shared, TOKEN_KEY, token)
    write(deps.shared, ORG_KEY, read(deps.tab, ORG_KEY) || null)
    const orgId = parseOrg(read(deps.tab, ORG_KEY))?.id
    if (orgId) write(deps.shared, LAST_ORG_KEY, orgId)
  }

  /**
   * Another tab signed out. Returns true when that was this tab's person, whose session is now
   * gone from this tab as well.
   */
  function receive(message: unknown): boolean {
    const m = message as { type?: unknown; person?: unknown } | null
    if (!m || m.type !== 'logout' || typeof m.person !== 'string' || !m.person) return false
    const own = read(deps.tab, TOKEN_KEY)
    if (!own || personKey(decodeClaims(own)) !== m.person) return false
    forgetTab()
    return true
  }

  return {
    getToken,
    getOrg,
    claims,
    isPersonOnly,
    hasOrgSession,
    setSession,
    updateOrg,
    lastOrgId,
    recoverFrom401,
    logoutEverywhere,
    publish,
    receive,
  }
}

// ── The browser binding ──────────────────────────────────────────────────────────────────────

function browserStore(kind: 'session' | 'local'): KeyValueStore | null {
  try {
    if (typeof window === 'undefined') return null
    return kind === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    return null
  }
}

function browserChannel(): SessionChannel | null {
  try {
    if (typeof BroadcastChannel === 'undefined') return null
    const channel = new BroadcastChannel('lgr-session')
    return {
      postMessage: message => channel.postMessage(message),
      subscribe: listener => channel.addEventListener('message', event => listener(event.data)),
    }
  } catch {
    return null
  }
}

let browser: SessionApi | null = null
// `nav/navigate` replaces this with the portal's sign-in page as seen from this origin.
let signedOutHandler: () => void = () => {
  window.location.href = '/auth/login'
}

/**
 * The session of the tab this code runs in. The first use installs the listeners: focus makes
 * this tab the new-tab default, and a sign-out in another tab of the same person signs this one
 * out too. Doing it here rather than in each app's `main.ts` means no app can forget it.
 */
function session(): SessionApi {
  if (browser) return browser
  const channel = browserChannel()
  browser = createSession({ tab: browserStore('session'), shared: browserStore('local'), channel })
  if (typeof window !== 'undefined') {
    const api = browser
    window.addEventListener('focus', () => api.publish())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') api.publish()
    })
    channel?.subscribe(message => {
      if (api.receive(message)) signedOutHandler()
    })
  }
  return browser
}

/** Where a tab goes when a sign-out elsewhere ended its session (the login page by default). */
export function onSignedOutElsewhere(handler: () => void): void {
  signedOutHandler = handler
}

export const getToken = () => session().getToken()
export const getOrg = <T extends SessionOrg = SessionOrg>() => session().getOrg() as T | null
export const claims = () => session().claims()
export const isPersonOnly = () => session().isPersonOnly()
export const hasOrgSession = () => session().hasOrgSession()
export const setSession = (token: string, org: SessionOrg | null) => session().setSession(token, org)
export const updateOrg = (org: SessionOrg) => session().updateOrg(org)
export const lastOrgId = () => session().lastOrgId()
export const recoverFrom401 = (failedToken: string) => session().recoverFrom401(failedToken)
export const logoutEverywhere = (notifyServer?: () => Promise<unknown>) => session().logoutEverywhere(notifyServer)
