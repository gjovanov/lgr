import { shallowRef } from 'vue'
import { isCapability, type CapabilityId, type Grant } from 'config/access'
import { claims } from '../session/session'

/**
 * FR-27.5 (#529) — the session's grant, live, in an org on `roles`.
 *
 * `/auth/me` answers `access` (`{ all, caps, role: { id, name, version } }`) when the person's role decides, and null
 * when the token's claims do. Every org response then carries `x-access-version` (`<roleId>:<version>`), and a new
 * value means the role was edited or another one given: `useHttpClient` asks `/auth/me` again (`followAccessVersion`),
 * so menus, ★ and „+ Нов" follow within a request, with no sign-out.
 *
 * Reactive: `sessionViewer()` carries this grant, so a computed menu re-evaluates when it changes. It belongs to one
 * membership (the claims' `id` + `orgId`): a tab that signs in elsewhere never reads another session's grant.
 */
export interface LiveAccess {
  all: boolean
  caps: readonly string[]
  role: { id: string; name: string; version: string } | null
  /** FR-27.4: the page the role starts its people on, or null. */
  landing?: string | null
}

interface Held {
  who: string
  grant: Grant
  version: string | null
  landing: string | null
}

const held = shallowRef<Held | null>(null)
/** The membership `/auth/me` last answered for (with a grant or with null), or failed to. */
const answered = shallowRef<string | null>(null)

function membership(): string | null {
  const c = claims()
  return c?.id && c?.orgId ? `${c.id}@${c.orgId}` : null
}

/** What `/auth/me` said about the session's access; null puts the token's claims back in charge. */
export function setLiveAccess(access: LiveAccess | null | undefined): void {
  const who = membership()
  answered.value = who
  if (!access || !who) {
    held.value = null
    return
  }
  const grant: Grant = access.all ? { all: true } : { caps: new Set(access.caps.filter(isCapability) as CapabilityId[]) }
  held.value = { who, grant, version: access.role?.version ?? null, landing: access.landing ?? null }
}

/** FR-27.4: the role's landing page id, live, or null (no role decides, or it names none). */
export function liveLanding(): string | null {
  const h = held.value
  return h && h.who === membership() ? h.landing : null
}

/**
 * Whether the session's grant is known: its token's claims decide (no `rid`: an org not on `roles`), or `/auth/me`
 * has answered for this membership. Until then a page the claims would not open waits rather than says no: the
 * claims are the role's projection, never more than the role, and may be less.
 */
export function accessSettled(): boolean {
  const c = claims()
  if (!c?.rid) return true
  return answered.value === membership()
}

/** Ask `/auth/me` for the grant now, once, when it is not known yet (a page waits on it). */
export function settleAccess(): void {
  if (accessSettled() || !refetch || inFlight) {
    if (!refetch && !accessSettled()) answered.value = membership()
    return
  }
  const who = membership()
  inFlight = refetch()
    .then(access => setLiveAccess(access))
    .catch(() => { answered.value = who })
    .finally(() => { inFlight = null })
}

/** The live grant of this tab's session, or null when its claims decide. */
export function liveGrant(): Grant | null {
  const h = held.value
  return h && h.who === membership() ? h.grant : null
}

/** The access version the live grant was read at. */
export function liveAccessVersion(): string | null {
  const h = held.value
  return h && h.who === membership() ? h.version : null
}

let refetch: (() => Promise<LiveAccess | null | undefined>) | null = null
let inFlight: Promise<void> | null = null
/** When a response without a version last asked: a route outside the auth plugins never sends one, so at most a minute. */
let askedWithout = 0

/** How to ask `/auth/me` again; the app store registers it (the HTTP client cannot import the store). */
export function setAccessRefetch(fn: () => Promise<LiveAccess | null | undefined>): void {
  refetch = fn
}

/**
 * A response's `x-access-version` (absent: undefined). A version that is not the one held asks `/auth/me` once, however
 * many responses arrive meanwhile. An org response with none while a live grant is held means the org left `roles`:
 * asked once too, and `/auth/me` then answers null.
 */
export function followAccessVersion(version: string | undefined, orgResponse: boolean): void {
  const current = liveAccessVersion()
  const left = !version && orgResponse && liveGrant() !== null && Date.now() - askedWithout > 60_000
  const stale = version ? version !== current : left
  if (!stale || !refetch || inFlight) return
  if (left) askedWithout = Date.now()
  inFlight = refetch()
    .then(access => setLiveAccess(access))
    .catch(() => { /* the next response asks again */ })
    .finally(() => { inFlight = null })
}
