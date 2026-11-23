/**
 * FR-20.16 (plan step P1-3) — the API behind the supervisor.
 *
 * On a master the API listens on 127.0.0.1 only, and only the supervisor talks to it: every way in
 * (the LAN, the tunnel from lgrai.app, the setup console) is the supervisor's. It strips whatever
 * `X-LGR-*` the client sent, then stamps the request with its per-boot front secret, where the
 * request came from and the client's address. This module is the API's half of that contract. It
 * runs before routing on every request, WebSocket upgrades included: Elysia's `onRequest` sees an
 * upgrade like any other GET, and can refuse it (measured on 1.4.30).
 *
 * In order:
 * 1. **The front secret**, compared in constant time. Without it the request comes from some other
 *    process on this machine: 403.
 * 2. **`Host` on the allow-list** (`LGR_FRONT_HOSTS`, `localhost` and any IP literal), against DNS
 *    rebinding: a page that points its own name at this machine still sends that name. 403.
 * 3. **The source stamp**, `lan`, `tunnel` or `console`, or 403. Its absence is a supervisor bug,
 *    never a client: the client cannot get here without the secret.
 * 4. **`/internal/*` and `/api/setup/*` answer 404 on HTTP**, whatever the source (AC 47).
 *    Replication pages, status, stop and setup belong on the control socket, which no ingress
 *    reaches.
 * 5. **The routes that create an org answer 404 outside setup** on a master, i.e. unless the request
 *    came through the setup console (FR-20.18).
 * 6. **A `lan` request carries a paired desktop's credential** (FR-20.32), checked against its row
 *    like every desktop token, except on the three routes a desktop calls before it has one. 401.
 *
 * ⚠ With no front secret (global, a developer's machine, the tests) steps 1–3 and 6 are off, and the
 * accessors below answer `undefined`: an `X-LGR-*` header from a client is then just a header that
 * nothing reads as a stamp. Steps 4 and 5 hold on every master, with a front or without one.
 *
 * ⚠ The desktop credential is the one `X-LGR-*` header the LAN ingress carries over from the client.
 * It is a credential the API verifies, never a stamp it trusts: the ingress copies it across after
 * stripping the rest, and nothing written there is believed until its signature and its row agree.
 */
import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { config, nodeRole } from 'config'
import { DesktopError, loadActiveDesktop, verifyDesktopToken } from 'services/biz/desktop/desktop.service'

export type FrontSource = 'lan' | 'tunnel' | 'console'
const SOURCES = new Set<string>(['lan', 'tunnel', 'console'])

export const FRONT_HEADER = 'x-lgr-front'
export const SOURCE_HEADER = 'x-lgr-source'
export const CLIENT_IP_HEADER = 'x-lgr-client-ip'
export const DESKTOP_TOKEN_HEADER = 'x-lgr-desktop-token'

type HeaderBag = Headers | Record<string, string | undefined>
const read = (h: HeaderBag, name: string): string | undefined =>
  h instanceof Headers ? h.get(name) ?? undefined : h[name]

/** Where a request came in, as the supervisor stamped it. `undefined` with no front. */
export function frontSource(headers: HeaderBag): FrontSource | undefined {
  if (!config.front.secret) return undefined
  const s = read(headers, SOURCE_HEADER)
  return s && SOURCES.has(s) ? (s as FrontSource) : undefined
}

/**
 * FR-20.48: where a request came from, for its audit entries. `lan:<desktopId>` (a till on the shop's
 * network, by its credential), `lan` (one before it holds one), `tunnel` (the org's address) or
 * `loopback` (the server's own console). `undefined` with no front: lgrai.app, development.
 * The front guard has checked the stamps and the credential by the time anything reads this.
 */
export function requestVia(request: Request | null | undefined): string | undefined {
  if (!request) return undefined
  const source = frontSource(request.headers)
  if (source === 'tunnel') return 'tunnel'
  if (source === 'console') return 'loopback'
  if (source !== 'lan') return undefined
  const claims = verifyDesktopToken(request.headers.get(DESKTOP_TOKEN_HEADER) ?? undefined)
  return claims ? `lan:${claims.desktopId}` : 'lan'
}

/** The client's address as the supervisor's ingress saw it. `undefined` with no front. */
export function frontClientIp(headers: HeaderBag): string | undefined {
  if (!config.front.secret) return undefined
  return read(headers, CLIENT_IP_HEADER)?.trim().slice(0, 64) || undefined
}

/** `given` is the secret, compared in constant time. */
export function secretMatches(given: string | null | undefined, secret: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A `Host` value (or an allow-list entry) as a bare lowercase name: no port, no trailing dot. */
function hostName(host: string): string {
  let name = host.trim().toLowerCase()
  if (name.startsWith('[')) {
    const end = name.indexOf(']')
    return end > 0 ? name.slice(0, end + 1) : ''
  }
  const colon = name.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(name.slice(colon + 1))) name = name.slice(0, colon)
  return name.endsWith('.') ? name.slice(0, -1) : name
}

/**
 * Whether `host` may reach the API. An IP literal always may: DNS rebinding always arrives under
 * the attacker's own NAME, never an address. So may `localhost`, which no attacker resolves.
 */
export function hostAllowed(host: string | null | undefined, names: readonly string[]): boolean {
  if (!host) return false
  const name = hostName(host)
  if (!name) return false
  if (name.startsWith('[')) return isIP(name.slice(1, -1)) === 6
  if (isIP(name)) return true
  if (name === 'localhost') return true
  return names.some(n => hostName(n) === name)
}

/**
 * FR-20.72 (P3-4c): an org's address on lgrai.app, `<label>.<ORG_ADDRESS_APEX>`, as the tunnel brings
 * it. Allowed for the `tunnel` source only: global routes an address to the org's home alone, over
 * this server's authenticated uplink, so the name is lgrai.app's, never a rebinding attacker's.
 */
export function isOrgAddressHost(host: string | null | undefined, apex = config.idp.addressApex): boolean {
  if (!host) return false
  const name = hostName(host)
  if (!name.endsWith(`.${apex}`)) return false
  const label = name.slice(0, -(apex.length + 1))
  return label.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)
}

/** The path as a router might read it, for the refusals: decoded, lowercase, single slashes. */
export function normalizedPath(pathname: string): string {
  let p = pathname
  try {
    p = decodeURIComponent(p)
  } catch {
    /* a malformed escape stays as it is, and matches nothing below */
  }
  p = p.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** Never served over HTTP, from any source (AC 47). */
const HTTP_REFUSED = ['/internal', '/api/setup']
export function refusedOnHttp(path: string): boolean {
  return HTTP_REFUSED.some(p => path === p || path.startsWith(p + '/'))
}

/** On a master, only during setup (FR-20.18). Matched on the normalized path: fails closed. */
const ORG_CREATING = new Set(['POST /api/auth/register', 'POST /api/auth/orgs', 'POST /api/oauth/pending/register'])

/**
 * What a desktop calls before it holds a credential: the reachability probe (FR-14.17) and the two
 * exchanges that produce one. ⚠ Matched on the EXACT path, so a variant the router might still
 * route (`/enroll/`, an escaped letter) is gated, not exempt: an exemption fails closed.
 */
const LAN_WITHOUT_DESKTOP = new Set(['GET /api/health', 'GET /api/ready', 'POST /api/desktop/v1/enroll', 'POST /api/desktop/v1/token'])

const refuse = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message }), { status, headers: { 'content-type': 'application/json' } })
const notFound = () => refuse(404, 'not_found', 'Not found.')

async function lanRefusal(request: Request, exactPath: string): Promise<Response | undefined> {
  if (LAN_WITHOUT_DESKTOP.has(`${request.method} ${exactPath}`)) return undefined
  const claims = verifyDesktopToken(request.headers.get(DESKTOP_TOKEN_HEADER) ?? undefined)
  if (!claims) return refuse(401, 'desktop_required', 'This server answers the desktops paired with it.')
  try {
    // The row is the revocation list, here as on every desktop route.
    await loadActiveDesktop(claims)
    return undefined
  } catch (e) {
    if (e instanceof DesktopError) return refuse(e.statusCode, e.code, e.message)
    throw e
  }
}

/** The answer to give instead of serving `request`, or `undefined` to serve it. */
export async function frontRefusal(request: Request): Promise<Response | undefined> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return refuse(400, 'bad_request', 'The request URL cannot be read.')
  }
  const path = normalizedPath(url.pathname)

  let source: FrontSource | undefined
  const secret = config.front.secret
  if (secret) {
    if (!secretMatches(request.headers.get(FRONT_HEADER), secret)) {
      return refuse(403, 'front_required', 'This listener answers the LGR Server supervisor only.')
    }
    const s = request.headers.get(SOURCE_HEADER)
    const host = request.headers.get('host')
    // Only the supervisor can stamp `tunnel` (the front secret says it is the supervisor).
    if (!hostAllowed(host, config.front.hosts) && !(s === 'tunnel' && isOrgAddressHost(host))) {
      return refuse(403, 'host_not_allowed', 'This server does not answer to that name.')
    }
    if (!s || !SOURCES.has(s)) return refuse(403, 'source_required', 'The request carries no source stamp.')
    source = s as FrontSource
  }

  if (nodeRole() === 'master') {
    if (refusedOnHttp(path)) return notFound()
    if (ORG_CREATING.has(`${request.method} ${path}`) && source !== 'console') return notFound()
  }

  if (source === 'lan') return lanRefusal(request, url.pathname)
  return undefined
}
