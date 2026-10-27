/**
 * An org's address on lgrai.app (FR-20.72–20.74, FR-20.78, plan step P3-4b): every request whose
 * `Host` is `<label>.<ORG_ADDRESS_APEX>` is the org's server's, never lgrai.app's. It runs first, for
 * HTTP and for WebSocket upgrades, and nothing of lgrai.app's own app, headers or cookies touches it.
 *
 * - **An active address of an org homed on a master** registered for it: tunnelled to that master
 *   (`streams.ts`), behind the edge filter (`edge.ts`).
 * - **Anything else answers like an unknown label** (404): no such address, a requested or refused
 *   one, an org that lives on lgrai.app. A retired address answers that it was retired (410), for
 *   12 months.
 * - **The server is not connected:** a static notice (503), never a sign-in page (FR-20.75).
 * - A reserved label (`www`, …) is lgrai.app's own name: not an address, and passed on.
 *
 * - **The server's socket on another pod** (P3-4d): the request is forwarded there as a hop
 *   (`forward.ts`, `hop.ts`). A hop has passed the edge already, keeps the browser's address, and is
 *   never forwarded again.
 */
import { config, nodeRole } from 'config'
import { homeOf } from 'db/home/home'
import { ServerNode } from 'db/models'
import { addressRoute, reservedLabels } from 'services/biz/address/org-address.service'
import { clientIp } from '../auth/client-ip.js'
import { anonymousAllowed, anonymousWithinLimit, hasCredential } from './edge.js'
import { forwardHttp, forwardWebSocket, holderOf } from './forward.js'
import { verifyHop } from './hop.js'
import { noticeResponse } from './notice.js'
import { tunnelSocketOf } from './sockets.js'
import { TunnelError, tunnelHttp, tunnelWebSocket } from './streams.js'

/**
 * The label of the org address this `Host` names: the label; `''` for a deeper name under the apex
 * (no address, answered as unknown); null when it is not under the apex, or is lgrai.app's own name.
 */
export function addressLabel(host: string | null | undefined, apex = config.idp.addressApex): string | null {
  if (!host) return null
  const h = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  if (!h.endsWith(`.${apex}`)) return null
  const label = h.slice(0, -(apex.length + 1))
  if (!label) return null
  if (label.includes('.')) return ''
  return reservedLabels().has(label) ? null : label
}

type Route = { kind: 'unknown' } | { kind: 'retired' } | { kind: 'node'; nodeId: string; orgId: string }

const ROUTE_TTL_MS = 10_000
const routes = new Map<string, { at: number; route: Route }>()

/** Tests only. */
export function forgetAddressRoutes(): void {
  routes.clear()
}

async function routeOf(label: string, now = Date.now()): Promise<Route> {
  const hit = routes.get(label)
  if (hit && now - hit.at < ROUTE_TTL_MS) return hit.route
  const a = await addressRoute(label)
  let route: Route = { kind: 'unknown' }
  if (a?.state === 'retired' && a.noticeUntil && a.noticeUntil.getTime() > now) {
    route = { kind: 'retired' }
  } else if (a?.state === 'active') {
    // An org that lives on lgrai.app has no address: its label answers like an unknown one.
    const home = await homeOf(a.orgId)
    if (home.home !== 'global' && (await ServerNode.exists({ _id: home.home, status: 'active', orgIds: a.orgId }))) {
      route = { kind: 'node', nodeId: home.home, orgId: a.orgId }
    }
  }
  if (routes.size > 10_000) routes.clear()
  routes.set(label, { at: now, route })
  return route
}

/** The `onRequest` hook: a `Response` for an org address, nothing for every other request. */
export function tunnelRouter() {
  return async ({ request, server }: { request: Request; server: any }): Promise<Response | undefined> => {
    if (nodeRole() !== 'global') return
    const label = addressLabel(request.headers.get('host'))
    if (label === null) return
    const accept = request.headers.get('accept')
    if (!label) return noticeResponse('unknown', accept)
    const route = await routeOf(label)
    if (route.kind !== 'node') return noticeResponse(route.kind === 'retired' ? 'retired' : 'unknown', accept)

    const url = new URL(request.url)
    const upgrade = (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket'
    // A hop from another pod (P3-4d) passed the edge there, and names the browser's address.
    const hop = verifyHop(request)
    const ip = hop ? hop.clientIp : (clientIp(Object.fromEntries(request.headers as any)) ?? null)
    if (!hop && !hasCredential(request.headers)) {
      if (!anonymousAllowed(request.method, url.pathname, upgrade)) {
        return Response.json({ code: 'unauthenticated', message: 'Sign in to the organization first.' }, { status: 401, headers: { 'cache-control': 'no-store' } })
      }
      if (!anonymousWithinLimit(label, ip)) return noticeResponse('busy', accept)
    }

    const req = { nodeId: route.nodeId, request, clientIp: ip }
    if (upgrade) {
      if (tunnelWebSocket(req, server)) return new Response(null, { status: 101 })
      const here = !!tunnelSocketOf(route.nodeId)
      if (!here && !hop) {
        const there = await holderOf(route.nodeId)
        if (there && forwardWebSocket(there, request, ip, server)) return new Response(null, { status: 101 })
      }
      return noticeResponse(here ? 'busy' : 'offline', accept)
    }
    try {
      return await tunnelHttp(req)
    } catch (e) {
      if (!(e instanceof TunnelError)) throw e
      // Not here: nothing of the request was sent, so it may go to the pod that holds the socket.
      if (e.code === 'offline' && !hop) {
        const there = await holderOf(route.nodeId)
        const answer = there ? await forwardHttp(there, request, ip) : null
        if (answer) return answer
      }
      if (e.code === 'offline' || e.code === 'link_lost') return noticeResponse('offline', accept)
      if (e.code === 'busy') return noticeResponse('busy', accept)
      return Response.json({ code: e.code, message: e.message }, { status: e.code === 'idle' ? 504 : 502, headers: { 'cache-control': 'no-store' } })
    }
  }
}
