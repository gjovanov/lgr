import { homeOf, thisNode } from 'db/home/home'
import { isReadOnlyRoute } from './route-class.js'

/**
 * FR-20.4 — only the home writes. Registered by the auth plugins right after `isForeignOrg`, with
 * the same rule: every route under `/org/:orgId/`, nothing to opt into, no exception list.
 *
 * On a node that is not the org's home, a route that writes answers **409
 * `{code: 'org_home_elsewhere', home: {kind}}`**; a route that reads goes through. With no home
 * records anywhere (global today), every org is home here and nothing changes.
 *
 * Returns the 409 body to send, or null to let the request through.
 */
export interface HomeGateRefusal {
  code: 'org_home_elsewhere'
  message: string
  home: { kind: 'global' | 'master'; state: string }
}

export async function homeGate(method: string, route: string, orgId: string | undefined): Promise<HomeGateRefusal | null> {
  if (!orgId) return null
  if (isReadOnlyRoute(method, route)) return null
  const info = await homeOf(orgId)
  if (info.home === thisNode() && info.state === 'active') return null
  const kind = info.home === 'global' ? 'global' : 'master'
  return {
    code: 'org_home_elsewhere',
    message: info.state !== 'active' && info.home === thisNode()
      ? `This organisation is read-only here while its home is ${info.state === 'hold' ? 'on hold' : info.state}.`
      : 'This organisation is written on another server; this one shows it read-only.',
    home: { kind, state: info.state },
  }
}
