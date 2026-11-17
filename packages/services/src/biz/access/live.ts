import { grantOfRole, type Grant } from 'config/access'
import { mongoose } from 'db/connection'
import { Role, User } from 'db/models'

/**
 * FR-27.5 (#529) — an org on `roles`: each request's grant comes from the person's role, read live.
 *
 * The membership's role and the role itself are cached per process for a minute, as `identityStillValid` caches a
 * person: a role edit, or a change of a person's role, reaches every pod within the minute, and nobody is signed
 * out. A change made in this process is seen at once (`forgetMember`, `forgetRole`).
 *
 * FR-27 P3-5: the session carries the grant and nothing of the legacy model. Its token names no `role`, `permissions`
 * or `areas` any more, and what used to read them reads the grant (`evaluate.ts#grantOf`, `can`). A person with no
 * role gets no grant, and every org route refuses them (`decideAccess`, `no_role`).
 *
 * ⚠ Read through the driver: a request's own queries are what the query budgets count.
 */

const TTL_MS = 60_000
const MAX = 10_000

interface LiveRole {
  _id: unknown
  all?: boolean
  isBuiltin?: boolean
  edited?: boolean
  templateKey?: string
  caps?: string[]
  version?: number
  /** FR-27.4: the page the role's people start on. */
  landing?: string
  name?: string
}

const memberRoles = new Map<string, { at: number; roleId: string | null }>()
const roles = new Map<string, { at: number; role: LiveRole | null }>()

const fresh = (at: number) => Date.now() - at < TTL_MS
const collection = (name: string) => mongoose.connection.db!.collection(name)
const oid = (id: string) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null)

async function roleIdOf(userId: string, orgId: string): Promise<string | null> {
  const hit = memberRoles.get(userId)
  if (hit && fresh(hit.at)) return hit.roleId
  const id = oid(userId)
  const org = oid(orgId)
  const doc: any = id && org ? await collection(User.collection.collectionName).findOne({ _id: id, orgId: org }, { projection: { roleId: 1 } }) : null
  const roleId = doc?.roleId ? String(doc.roleId) : null
  if (memberRoles.size >= MAX) memberRoles.clear()
  memberRoles.set(userId, { at: Date.now(), roleId })
  return roleId
}

async function roleById(roleId: string, orgId: string): Promise<LiveRole | null> {
  const hit = roles.get(roleId)
  if (hit && fresh(hit.at)) return hit.role
  const id = oid(roleId)
  const org = oid(orgId)
  // Tenant-scoped (FR-27.8): another org's role id resolves to nothing, as a set does in tokenize().
  const role = (id && org ? await collection(Role.collection.collectionName).findOne({ _id: id, orgId: org }) : null) as LiveRole | null
  if (roles.size >= MAX) roles.clear()
  roles.set(roleId, { at: Date.now(), role })
  return role
}

/** Drop a person's cached role: their role just changed in this process. */
export function forgetMember(userId: unknown): void {
  memberRoles.delete(String(userId))
}

/** Drop a role's cache: it was just edited or deleted in this process. */
export function forgetRole(roleId: unknown): void {
  roles.delete(String(roleId))
}

export interface LiveSession {
  id: string
  orgId: string
  amr?: readonly string[]
}

/** What `/auth/me` and the sign-in answers say of a role (FR-27.5): its id, name, version and landing page. */
export function accessRoleOf(role: LiveRole): { id: string; name: string; version: string; landing: string | null } {
  return { id: String(role._id), name: role.name ?? '', version: `${String(role._id)}:${role.version ?? 1}`, landing: role.landing ?? null }
}

/**
 * The person's role, or null: no role, or a role that is gone. Every org since FR-27 P3-2 (`access.model` is no longer read).
 */
export async function liveRoleOf(user: LiveSession): Promise<LiveRole | null> {
  if (!user?.orgId || !user.id || mongoose.connection.readyState !== 1) return null
  const roleId = await roleIdOf(user.id, user.orgId)
  return roleId ? roleById(roleId, user.orgId) : null
}

/**
 * Called by both auth plugins after `liveSessionUser`: the session's grant from its role (`access`, never serialised).
 * Returns the access version for the `x-access-version` header, or null when the person has no role.
 */
export async function attachAccess(user: LiveSession | null | undefined): Promise<string | null> {
  if (!user) return null
  const role = await liveRoleOf(user)
  if (!role) return null
  const grant: Grant = grantOfRole(role)
  const version = `${String(role._id)}:${role.version ?? 1}`
  Object.defineProperty(user, 'access', { value: grant, enumerable: false, configurable: true })
  // For `/auth/me`: what the SPA follows (FR-27.5). Never serialised with the session either.
  Object.defineProperty(user, 'accessRole', { value: accessRoleOf(role), enumerable: false, configurable: true })
  return version
}

/** What `/auth/me` and the sign-in answers say of a session's access (FR-27.5): the role's grant, or null (no role). */
export interface AccessAnswer {
  all: boolean
  caps: string[]
  role: ReturnType<typeof accessRoleOf> | null
  /** FR-27.4: where the role starts its people (null: the App Hub's default). */
  landing: string | null
}

/** The access answer of a session `attachAccess` has seen. */
export function accessAnswerOf(user: object | null | undefined): AccessAnswer | null {
  const grant = (user as { access?: Grant } | null | undefined)?.access
  if (!grant) return null
  const role = (user as { accessRole?: ReturnType<typeof accessRoleOf> }).accessRole ?? null
  return { all: !!grant.all, caps: grant.all ? [] : [...grant.caps].sort(), role, landing: role?.landing ?? null }
}

/**
 * FR-27 P3-5 (#529): the access answer for a session being issued (a sign-in, a switch, a join). The token carries no
 * grant any more, so every answer that hands the SPA a session hands it the grant too.
 */
export async function accessAnswerFor(session: LiveSession): Promise<AccessAnswer | null> {
  const probe: LiveSession = { id: session.id, orgId: session.orgId }
  await attachAccess(probe)
  return accessAnswerOf(probe)
}
