/**
 * Where an inspector reaches the org's server (FR-20.47, plan step P3-8e). Н-18 чл. 52и(1): every
 * device of the СУПТО, servers included, must be reachable by an inspector "незабавно".
 *
 * - **A server in the shop** is inspected there, at a till or at the server.
 * - **A server off the premises** (a company server room, a data centre) needs a declared remote
 *   path, which the trader declares in Прил. 32. It is one of:
 *   - the tunnel: the org's address on lgrai.app. It needs the Full link and an issued address;
 *   - the roomler overlay;
 *   - the company's own VPN.
 *
 *   Control and Air-gapped servers off the premises can only use the last two.
 *
 * Kept on the server, per org (`NodeState`, `inspection:<orgId>`): it describes this machine, and
 * never travels in a bundle or to the mirror.
 */
import { NodeState } from 'db/models'

export type Premises = 'shop' | 'offsite'
export type InspectionPath = 'tunnel' | 'overlay' | 'vpn'
export type InspectionProblem = 'undeclared' | 'path_missing' | 'link_not_full' | 'no_address'

export interface Inspection {
  premises: Premises
  path: InspectionPath | null
  /** How an inspector gets in by the overlay or the VPN: an address, as the trader declares it. */
  detail: string | null
  setAt: Date
  setBy: string
}

/** What the server offers for the tunnel now: its link level, and the org's address as lgrai.app last said. */
export interface TunnelReach {
  linkLevel: string | null
  address: string | null
}

export class InspectionError extends Error {
  constructor(readonly statusCode: 409 | 422, readonly code: string, message: string) {
    super(message)
  }
}

const DETAIL_MAX = 200
const key = (orgId: string) => `inspection:${orgId}`

export async function inspectionOf(orgId: string): Promise<Inspection | null> {
  const row: any = await NodeState.findById(key(orgId)).lean()
  const v = row?.value
  if (!v || (v.premises !== 'shop' && v.premises !== 'offsite')) return null
  return {
    premises: v.premises,
    path: v.path === 'tunnel' || v.path === 'overlay' || v.path === 'vpn' ? v.path : null,
    detail: typeof v.detail === 'string' ? v.detail : null,
    setAt: v.setAt ? new Date(v.setAt) : row.updatedAt,
    setBy: String(v.setBy ?? ''),
  }
}

/** Why the tunnel cannot be the path now, or null when it can. */
export function tunnelProblem(reach: TunnelReach): 'link_not_full' | 'no_address' | null {
  if (reach.linkLevel !== 'full') return 'link_not_full'
  if (!reach.address) return 'no_address'
  return null
}

/** The org's admin declares where the server stands and, off the premises, how an inspector gets in. */
export async function setInspection(
  orgId: string,
  by: string,
  body: { premises?: unknown; path?: unknown; detail?: unknown },
  reach: TunnelReach,
  now = new Date(),
): Promise<Inspection> {
  const premises = body.premises
  if (premises !== 'shop' && premises !== 'offsite') {
    throw new InspectionError(422, 'premises_required', 'Say where the server stands: in the shop, or off the premises.')
  }
  let path: InspectionPath | null = null
  let detail: string | null = null
  if (premises === 'offsite') {
    if (body.path !== 'tunnel' && body.path !== 'overlay' && body.path !== 'vpn') {
      throw new InspectionError(422, 'path_required', 'A server off the premises needs a remote inspection path (Н-18 чл. 52и(1)).')
    }
    path = body.path
    if (path === 'tunnel') {
      const problem = tunnelProblem(reach)
      if (problem === 'link_not_full') throw new InspectionError(409, problem, 'The tunnel needs the Full link to lgrai.app. Declare the roomler overlay or the company\'s VPN instead.')
      if (problem === 'no_address') throw new InspectionError(409, problem, 'The tunnel needs the organization\'s address on lgrai.app. Ask for it on the Servers page there first.')
    } else {
      detail = typeof body.detail === 'string' ? body.detail.trim() : ''
      if (!detail || detail.length > DETAIL_MAX) {
        throw new InspectionError(422, 'detail_required', `Say how an inspector reaches the server that way: an address, at most ${DETAIL_MAX} characters.`)
      }
    }
  }
  const value = { premises, path, detail, setAt: now, setBy: by }
  await NodeState.updateOne({ _id: key(orgId) }, { $set: { value } }, { upsert: true })
  return { ...value }
}

/** The declaration as Прил. 32 needs it, the tunnel's address when that is the path, and what is wrong now. */
export function inspectionView(i: Inspection | null, reach: TunnelReach) {
  // What the tunnel would be now, for the page that declares it.
  const tunnel = { address: reach.address, problem: tunnelProblem(reach) }
  if (!i) return { declared: false, premises: null, path: null, detail: null, address: null, problem: 'undeclared' as InspectionProblem, setAt: null, tunnel }
  let problem: InspectionProblem | null = null
  if (i.premises === 'offsite') {
    if (!i.path) problem = 'path_missing'
    else if (i.path === 'tunnel') problem = tunnelProblem(reach)
  }
  return {
    declared: true,
    premises: i.premises,
    path: i.path,
    detail: i.detail,
    address: i.path === 'tunnel' ? reach.address : null,
    problem,
    setAt: i.setAt,
    tunnel,
  }
}
