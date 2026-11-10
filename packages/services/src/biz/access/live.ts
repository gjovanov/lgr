import { grantOfRole, type Grant } from 'config/access'
import { mongoose } from 'db/connection'
import { Role, User } from 'db/models'
import { accessModelOf } from './shadow'

/**
 * FR-27.5 (#529) — an org on `roles`: each request's grant comes from the person's role, read live.
 *
 * The membership's role and the role itself are cached per process for a minute, as `identityStillValid` caches a
 * person: a role edit, or a change of a person's role, reaches every pod within the minute, and nobody is signed
 * out. A change made in this process is seen at once (`forgetMember`, `forgetRole`).
 *
 * The session's legacy claims are replaced by the role's projection (`Role.legacy`), so what still reads claims
 * (FR-26's area checks, the report registry, a PIN session's role) follows the role too, until Phase 3 retires them.
 * A person in such an org with no role (one migration 0015 could not match) keeps their token's claims.
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
  legacy?: { role: string; permissions: string[]; areas?: string[] }
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
  role?: string
  permissions?: string[]
  areas?: string[]
  amr?: readonly string[]
}

/**
 * The person's role in an org on `roles`, or null: an org on another model, no role, or a role that is gone.
 */
export async function liveRoleOf(user: LiveSession): Promise<LiveRole | null> {
  if (!user?.orgId || !user.id || mongoose.connection.readyState !== 1) return null
  if ((await accessModelOf(user.orgId)) !== 'roles') return null
  const roleId = await roleIdOf(user.id, user.orgId)
  return roleId ? roleById(roleId, user.orgId) : null
}

/**
 * Called by both auth plugins after `liveSessionUser`: for an org on `roles`, the session's grant from its role
 * (`access`, never serialised) and its claims from the role's projection. Returns the access version for the
 * `x-access-version` header, or null when the token's claims decide.
 */
export async function attachAccess(user: LiveSession | null | undefined): Promise<string | null> {
  if (!user) return null
  const role = await liveRoleOf(user)
  if (!role) return null
  const grant: Grant = grantOfRole(role)
  const version = `${String(role._id)}:${role.version ?? 1}`
  Object.defineProperty(user, 'access', { value: grant, enumerable: false, configurable: true })
  // For `/auth/me`: what the SPA follows (FR-27.5). Never serialised with the session either.
  Object.defineProperty(user, 'accessRole', { value: { id: String(role._id), name: (role as any).name, version }, enumerable: false, configurable: true })
  if (role.legacy) {
    user.role = role.legacy.role
    user.permissions = [...role.legacy.permissions]
    if (Array.isArray(role.legacy.areas)) user.areas = [...role.legacy.areas]
    else delete user.areas
  }
  return version
}
