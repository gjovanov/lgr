import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { config, nodeRole } from 'config'
import { Org } from 'db/models'
import { licensedAction } from './licence-gate.js'
import { licenceStatus, type LicenceProblem, type LicenceStatus } from './licence-state.js'
import { acceptedKeys, verifyLicence, type LicenceClaims } from './licence-token.js'

/**
 * FR-20.55, a master's side (plan step P2-3b): which licence it holds for an org, and what that stops.
 *
 * The supervisor keeps one `<orgId>.jws` per org in `LGR_LICENCE_DIR`, as global sent it over the
 * uplink or an operator imported it (`lgr-server licence import`). ⚠ The file is not trusted for
 * being there: it is verified here, against the keys built into the package, on every change, and
 * it must name this org and this master.
 *
 * Off a master nothing here applies: global's orgs are licensed by their cloud subscription.
 */

const OBJECT_ID = /^[0-9a-f]{24}$/
const STARTED = new Date()

interface Read {
  claims: LicenceClaims | null
  problem?: LicenceProblem
}

const files = new Map<string, { mtimeMs: number; size: number; read: Read }>()
const zones = new Map<string, { at: number; tz: string | undefined }>()
const ZONE_CACHE_MS = 60_000

/** Forget what was read: tests, and an operator's import (the file's mtime would tell anyway). */
export function forgetLicences(): void {
  files.clear()
  zones.clear()
}

function readLicence(orgId: string): Read {
  const dir = config.licence.dir
  if (!dir || !OBJECT_ID.test(orgId)) return { claims: null }
  const file = join(dir, `${orgId}.jws`)
  let st
  try {
    st = statSync(file)
  } catch {
    files.delete(orgId)
    return { claims: null }
  }
  const hit = files.get(orgId)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.read
  let read: Read
  try {
    const v = verifyLicence(readFileSync(file, 'utf8').trim(), acceptedKeys())
    read = !v.ok ? { claims: null, problem: v.reason }
      : v.claims.sub !== orgId ? { claims: null, problem: 'other_org' }
        : config.node.id && v.claims.node !== config.node.id ? { claims: null, problem: 'other_node' }
          : { claims: v.claims }
  } catch {
    read = { claims: null, problem: 'malformed' }
  }
  files.set(orgId, { mtimeMs: st.mtimeMs, size: st.size, read })
  return read
}

/** The org's zone, else this machine's: a shop's server keeps the shop's time. */
async function zoneOf(orgId: string): Promise<string | undefined> {
  const hit = zones.get(orgId)
  if (hit && Date.now() - hit.at < ZONE_CACHE_MS) return hit.tz
  const org: any = await Org.findById(orgId).select('settings.timezone').lean()
  const tz = org?.settings?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  zones.set(orgId, { at: Date.now(), tz })
  return tz
}

function evaluationStart(): Date {
  const created = config.licence.nodeCreatedAt
  return created ? new Date(created * 1000) : STARTED
}

export type LicenceAnswer = LicenceStatus | { applies: false }

/** Where this master's licence for the org stands. `{applies: false}` off a master. */
export async function licenceOf(orgId: string, now = new Date()): Promise<LicenceAnswer> {
  if (nodeRole() !== 'master') return { applies: false }
  const { claims, problem } = readLicence(String(orgId))
  return licenceStatus({ claims, problem, now, timezone: await zoneOf(String(orgId)), evaluationStart: evaluationStart() })
}

export interface LicenceRefusal {
  code: 'licence_expired'
  message: string
  /** What was stopped, in words. */
  action: string
  restrictedFrom: string
}

/**
 * Registered by the auth plugins right after the home gate: on a master, a request that would open
 * a till session or start a sales document (`licence-gate.ts`) is answered **402** once the org's
 * licence is restricted. Every other request goes through, whatever the licence says. A route that
 * decides on its body calls this from its handler, with the body.
 */
export async function licenceGate(method: string, route: string, orgId: string | undefined, body?: unknown): Promise<LicenceRefusal | null> {
  if (nodeRole() !== 'master' || !orgId) return null
  const action = licensedAction(method, route, body)
  if (!action) return null
  const status = await licenceOf(orgId)
  if (!status.applies || status.state !== 'restricted') return null
  const why = status.basis === 'evaluation'
    ? 'This server holds no licence for the organisation and its 30-day evaluation has ended'
    : "This server's licence for the organisation has run out"
  return {
    code: 'licence_expired',
    action: action.what,
    restrictedFrom: status.restrictedFrom,
    message: `${why}, so ${action.what} is paused. Reading, exports, closing the day, credit notes and payments still work. An administrator renews the licence on lgrai.app.`,
  }
}
