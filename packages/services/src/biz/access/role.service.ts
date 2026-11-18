import {
  CAPABILITIES, PAGE_ACCESS, ROLE_TEMPLATES, TEMPLATE_WITHHOLDS, canOpen, grantOfRole, isCapability, templateDefaults,
  templateOf, unknownCaps, withImplied, type CapabilityId, type Grant,
} from 'config/access'
import { Org, Role, User, type IRoleHistoryEntry } from 'db/models'
import { mongoose } from 'db/connection'
import { createAuditEntry, recordAuditEntry } from '../audit-log.service'
import { logger } from '../../logger/logger.js'
import { grantOf, type AccessCaller } from './evaluate'
import { forgetMember, forgetRole } from './live'

/**
 * FR-27.3, FR-27.8 (#529) — roles: create, copy, edit, delete, and give one to a person. The one place that writes
 * them, so the safety rules hold whichever route asks.
 *
 * Safety (FR-27.8):
 *   - managing roles takes `roles.edit`;
 *   - nobody edits their own role, nor changes their own;
 *   - nobody makes, edits or gives a role that holds a capability they do not hold;
 *   - only an Administrator gives the Administrator role, or `roles.edit` / `roles.view`;
 *   - the Administrator role cannot be edited or deleted, and the last active Administrator cannot lose it;
 *   - roles are the org's own: another org's role id is not found;
 *   - every create, edit, delete and assignment is audited with what it grants before and after.
 *
 * FR-27 P3-5: only the role model is written. Until then a role kept a legacy projection (`legacy`, `needsRelease`) and
 * a permission set that carried it ("Role · <name>"), and a person given a role was put on that set with the role's
 * legacy key. None of that is written any more: every node reads roles (G3). What a role or a person from before
 * holds stays as it was, frozen, for a rollback (P3-7 archives it).
 */

export class RoleRefusal extends Error {
  constructor(public status: number, public body: { code: string; message: string; [k: string]: unknown }) {
    super(body.message)
    this.name = 'RoleRefusal'
  }
}

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): never => {
  throw new RoleRefusal(status, { code, message, ...extra })
}

const ROLE_CAPS: readonly CapabilityId[] = ['roles.edit', 'roles.view']

interface Actor extends AccessCaller {
  id: string
}

function assertManages(actor: Actor): void {
  if (!grantOf(actor).all && !grantOf(actor).caps.has('roles.edit')) refuse(403, 'roles_required', 'Managing roles is not part of your role.')
}

/** FR-27.8: what this actor may give: nothing beyond their own grant; `*` and the roles capabilities an Administrator's only. */
function assertWithin(actor: Actor, grant: Grant): void {
  const mine = grantOf(actor)
  if (mine.all) return
  if (grant.all) refuse(403, 'administrator_only', 'Only an Administrator gives the Administrator role.')
  for (const cap of grant.all ? [] : grant.caps) {
    if (ROLE_CAPS.includes(cap)) refuse(403, 'administrator_only', 'Only an Administrator gives the right to manage roles.', { capability: cap })
    if (!mine.caps.has(cap)) refuse(403, 'beyond_your_role', `You cannot give what your own role does not hold: ${cap}.`, { capability: cap })
  }
}

const capsOf = (grant: Grant): string[] => (grant.all ? [] : [...grant.caps].sort())

/** The stored ids a body names: unknown ones are kept out (FR-27.8), and listed back. */
function cleanCaps(caps: readonly string[] | undefined): { caps: CapabilityId[]; unknown: string[] } {
  const all = [...new Set(caps ?? [])]
  return { caps: all.filter(isCapability) as CapabilityId[], unknown: all.filter(c => !isCapability(c)) }
}

async function roleInOrg(orgId: string, roleId: string): Promise<any> {
  const role = await Role.findOne({ _id: roleId, orgId }).lean().exec().catch(() => null)
  if (!role) refuse(404, 'role_not_found', 'Role not found')
  return role
}

/** Whether a stored role is an Administrator's: every capability. */
const isAdministratorRole = (role: any) => !!role?.all

async function administratorRoleIds(orgId: string): Promise<string[]> {
  return (await Role.find({ orgId, all: true }, { _id: 1 }).lean().exec()).map(r => String(r._id))
}

/**
 * The filter for an org's Administrators: their role is (`all`). Scripts that act as "the org's first admin" use this.
 * FR-27 P3-6: a person without a role is no Administrator (the legacy key `admin` counted for one until then).
 */
export async function administratorFilter(orgId: unknown): Promise<Record<string, unknown>> {
  const adminRoles = await administratorRoleIds(String(orgId))
  return { orgId, roleId: { $in: adminRoles } }
}

/** The active people of an org who are an Administrator (`administratorFilter`). */
async function activeAdministrators(orgId: string): Promise<string[]> {
  const people = await User.find({ ...(await administratorFilter(orgId)), isActive: { $ne: false } }, { _id: 1 }).lean().exec()
  return people.map(p => String(p._id))
}

/** FR-27.8: the last active Administrator keeps the role and stays active. */
export async function assertNotLastAdministrator(orgId: string, userId: string): Promise<void> {
  const admins = await activeAdministrators(orgId)
  if (admins.length === 1 && admins[0] === String(userId)) {
    refuse(409, 'last_administrator', 'This is the last active Administrator of the organization: give another person the Administrator role first.')
  }
}

/**
 * FR-27 P3-5: a role history entry (Appendix 29) names the role by id and by its name at the time. The legacy key
 * (`role`) is no longer written; entries from before keep it.
 */
export function roleHistoryEntry(role: { _id: unknown; name: string }, at: Date, assignedBy?: unknown): IRoleHistoryEntry {
  const id = (v: unknown) => new mongoose.Types.ObjectId(String(v))
  return { roleId: id(role._id), roleName: role.name, startDate: at, assignedAt: at, ...(assignedBy ? { assignedBy: id(assignedBy) } : {}) }
}

/** The history with its open period closed at `at` and the new role's opened. */
function historyWith(history: readonly IRoleHistoryEntry[] | undefined, role: { _id: unknown; name: string }, at: Date, assignedBy?: unknown): IRoleHistoryEntry[] {
  const next = [...(history ?? [])].map((h: any) => (h.endDate ? h : { ...h, endDate: at }))
  next.push(roleHistoryEntry(role, at, assignedBy))
  return next
}

export interface RoleView {
  id: string
  name: string
  description?: string
  isBuiltin: boolean
  templateKey?: string
  edited: boolean
  all: boolean
  caps: string[]
  unknownCaps: string[]
  version: number
  people: number
  /** FR-27.4: the page the role's people start on (a page id it opens), or null: the App Hub's default. */
  landing: string | null
}

function view(role: any, people: number): RoleView {
  const grant = grantOfRole(role)
  return {
    id: String(role._id), name: role.name, description: role.description, isBuiltin: !!role.isBuiltin, templateKey: role.templateKey,
    edited: !!role.edited, all: !!role.all, caps: capsOf(grant), unknownCaps: unknownCaps(role),
    version: role.version ?? 1, people, landing: role.landing ?? null,
  }
}

/**
 * FR-27.4: a landing is a page the role opens (`config/access/pages.ts`), never a variant with a query: where the
 * person starts after signing in, entering the org, or a page their role does not open. Empty clears it.
 */
function cleanLanding(landing: string | null | undefined, grant: Grant): string | null {
  if (landing == null || landing === '') return null
  if (landing.includes('?') || !PAGE_ACCESS[landing]) refuse(422, 'landing_unknown', `No page „${landing}".`)
  if (!canOpen(landing, grant)) refuse(422, 'landing_not_open', 'The landing page must be one the role opens.')
  return landing
}

export async function listRoles(orgId: string): Promise<RoleView[]> {
  const roles = await Role.find({ orgId }).sort({ isBuiltin: -1, name: 1 }).lean().exec()
  const counts = await User.aggregate([{ $match: { orgId: roles[0]?.orgId ?? null, isActive: { $ne: false }, roleId: { $exists: true } } }, { $group: { _id: '$roleId', n: { $sum: 1 } } }])
  const byRole = new Map(counts.map((c: any) => [String(c._id), c.n]))
  return roles.map(r => view(r, byRole.get(String(r._id)) ?? 0))
}

export async function getRole(orgId: string, roleId: string): Promise<{ role: RoleView; people: Array<{ id: string; username: string; name: string }> }> {
  const role = await roleInOrg(orgId, roleId)
  const people = await User.find({ orgId, roleId: role._id, isActive: { $ne: false } }, { username: 1, firstName: 1, lastName: 1 }).lean().exec()
  return {
    role: view(role, people.length),
    people: people.map((p: any) => ({ id: String(p._id), username: p.username, name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() })),
  }
}

export interface RoleInput {
  name?: string
  description?: string
  caps?: string[]
  /** FR-27.4: where the role's people start; null or empty clears it. */
  landing?: string | null
  /** Copy a template's or another role's access (FR-27.4). */
  from?: { templateKey?: string; roleId?: string }
}

export async function createRole(actor: Actor, orgId: string, input: RoleInput): Promise<RoleView> {
  assertManages(actor)
  const name = input.name?.trim()
  if (!name) refuse(422, 'role_name_required', 'A role needs a name.')
  if (await Role.exists({ orgId, name }).exec()) refuse(409, 'role_name_taken', `A role named „${name}" exists.`)
  let grant: Grant
  if (input.from?.templateKey) {
    if (!ROLE_TEMPLATES.some(t => t.key === input.from!.templateKey)) refuse(422, 'template_unknown', 'No such template.')
    // FR-27.11.B: a role made from a template starts with what the template ships with (D-11, D-12).
    grant = templateDefaults(input.from.templateKey)
  } else if (input.from?.roleId) {
    grant = grantOfRole(await roleInOrg(orgId, input.from.roleId))
  } else {
    grant = { caps: new Set(withImplied(cleanCaps(input.caps).caps)) }
  }
  // A copy of the Administrator is a role with every capability there is today, not `*`.
  if (grant.all) grant = { caps: new Set([...CAPABILITIES] as CapabilityId[]) }
  assertWithin(actor, grant)
  const landing = cleanLanding(input.landing, grant)
  const role = await Role.create({ orgId, name, description: input.description, isBuiltin: false, edited: false, all: false, caps: capsOf(grant), version: 1, ...(landing ? { landing } : {}) })
  createAuditEntry({ orgId, userId: actor.id, action: 'create', module: 'admin', entityType: 'role', entityId: String(role._id), entityName: name, changes: [{ field: 'caps', oldValue: [], newValue: capsOf(grant) }] })
  return view(role.toObject(), 0)
}

export async function updateRole(actor: Actor, orgId: string, roleId: string, input: RoleInput): Promise<RoleView> {
  assertManages(actor)
  const role = await roleInOrg(orgId, roleId)
  if (isAdministratorRole(role)) refuse(409, 'administrator_role_fixed', 'The Administrator role cannot be edited.')
  const me = await User.findOne({ _id: actor.id, orgId }, { roleId: 1 }).lean().exec()
  if (me && String((me as any).roleId) === String(role._id)) refuse(403, 'own_role', 'You cannot edit your own role.')

  return applyRoleUpdate(orgId, role, input, { userId: actor.id }, (before, after) => {
    assertWithin(actor, after)
    // Taking a capability away is the actor's to do only within their own reach too: what they do not hold, they
    // neither give nor remove.
    assertWithin(actor, { caps: new Set([...(before.all ? [] : before.caps)].filter(c => !(after as any).caps.has(c))) })
  })
}

/**
 * #529 — the same edit as the role editor's save, made by a sys-admin's script rather than a person: no actor, so no
 * actor checks, and the audit row says where it came from (`via`). The Administrator role is still refused. Used by
 * `scripts/role-price-levels.ts`.
 */
export async function setRoleCapsBySystem(
  orgId: string,
  roleId: string,
  caps: readonly string[],
  via: string,
): Promise<{ before: CapabilityId[]; after: CapabilityId[]; role: RoleView }> {
  const role = await roleInOrg(orgId, roleId)
  if (isAdministratorRole(role)) refuse(409, 'administrator_role_fixed', 'The Administrator role cannot be edited.')
  const before = capsOf(grantOfRole(role))
  const view = await applyRoleUpdate(orgId, role, { caps: [...caps] }, { userId: '', via })
  return { before, after: view.caps as CapabilityId[], role: view }
}

/**
 * What an edit writes, whoever asked (`updateRole`, `setRoleCapsBySystem`): the capabilities with their implied
 * helpers, a new version, and the audit row. `check` sees the grant before and after, before anything is written.
 * The people on the role follow it live (`access/live.ts`).
 */
async function applyRoleUpdate(
  orgId: string,
  role: any,
  input: RoleInput,
  audit: { userId: string; via?: string },
  check?: (before: Grant, after: Grant) => void,
): Promise<RoleView> {
  const before = grantOfRole(role)
  const set: Record<string, unknown> = {}
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) refuse(422, 'role_name_required', 'A role needs a name.')
    if (name !== role.name && (await Role.exists({ orgId, name }).exec())) refuse(409, 'role_name_taken', `A role named „${name}" exists.`)
    set.name = name
  }
  if (input.description !== undefined) set.description = input.description
  let after = before
  if (input.caps !== undefined) {
    after = { caps: new Set(withImplied(cleanCaps(input.caps).caps)) }
    check?.(before, after)
    set.caps = capsOf(after)
    set.edited = true
  }
  // FR-27.4: a landing the role opens. One the new capabilities no longer open is dropped, unless it was just named.
  const stored = (role as any).landing ?? null
  let landing = stored
  if (input.landing !== undefined) landing = cleanLanding(input.landing, after)
  else if (stored && !canOpen(stored, after)) landing = null
  const unset: Record<string, ''> = {}
  if (landing !== stored) {
    if (landing) set.landing = landing
    else unset.landing = ''
  }
  // A new version: the people's tabs ask `/auth/me` again (`x-access-version`), and a landing is part of the answer.
  const changed = input.caps !== undefined || set.name !== undefined || landing !== stored
  const updated = await Role.findOneAndUpdate(
    { _id: role._id, orgId },
    { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}), ...(changed ? { $inc: { version: 1 } } : {}) },
    { new: true },
  ).lean().exec()
  forgetRole(role._id)
  const entry = { orgId, userId: audit.userId, action: 'update', module: 'admin', entityType: 'role', entityId: String(role._id), entityName: String(updated!.name), changes: [{ field: 'caps', oldValue: capsOf(before), newValue: capsOf(after) }] }
  // A script exits once this returns: its row is written before, and says where it came from.
  if (audit.via) await recordAuditEntry({ ...entry, via: audit.via })
  else createAuditEntry(entry)
  return view(updated, await User.countDocuments({ orgId, roleId: role._id, isActive: { $ne: false } }))
}

/** FR-27.3: the role an invite that names none starts a person with (null: the built-in role of its legacy one). */
export async function setDefaultRole(actor: Actor, orgId: string, roleId: string | null): Promise<void> {
  assertManages(actor)
  if (roleId) {
    // Naming the default is giving it to whoever joins: within the actor's reach, as an assignment is.
    assertWithin(actor, grantOfRole(await roleInOrg(orgId, roleId)))
  }
  const before: any = await Org.findById(orgId, { 'settings.access.defaultRoleId': 1 }).lean().exec()
  await Org.updateOne({ _id: orgId }, roleId ? { $set: { 'settings.access.defaultRoleId': roleId } } : { $unset: { 'settings.access.defaultRoleId': 1 } }).exec()
  createAuditEntry({ orgId, userId: actor.id, action: 'update', module: 'admin', entityType: 'org', entityId: orgId, entityName: 'default role', changes: [{ field: 'settings.access.defaultRoleId', oldValue: before?.settings?.access?.defaultRoleId ? String(before.settings.access.defaultRoleId) : null, newValue: roleId }] })
}

/** The org's default role, for the roles page. */
export async function defaultRoleOf(orgId: string): Promise<string | null> {
  const org: any = await Org.findById(orgId, { 'settings.access.defaultRoleId': 1 }).lean().exec()
  return org?.settings?.access?.defaultRoleId ? String(org.settings.access.defaultRoleId) : null
}

export async function deleteRole(actor: Actor, orgId: string, roleId: string): Promise<void> {
  assertManages(actor)
  const role = await roleInOrg(orgId, roleId)
  if (role.isBuiltin) refuse(409, 'builtin_role', 'A built-in role cannot be deleted.')
  if (await User.exists({ orgId, roleId: role._id }).exec()) refuse(409, 'role_in_use', 'Give its people another role first.')
  await Role.deleteOne({ _id: role._id, orgId }).exec()
  // A role from before FR-27 P3-5 may name the system set of its projection: nothing reads sets since P3-6, and
  // migration 0017 archives them with the rest (#820).
  forgetRole(role._id)
  createAuditEntry({ orgId, userId: actor.id, action: 'delete', module: 'admin', entityType: 'role', entityId: roleId, entityName: role.name, changes: [{ field: 'caps', oldValue: capsOf(grantOfRole(role)), newValue: [] }] })
}

/** FR-27.3: the ten built-in roles of an org, made where missing (a new org; migration 0015 made them for the rest). */
export async function seedBuiltinRoles(orgId: unknown): Promise<void> {
  // The schema's timestamps fill createdAt/updatedAt: naming them here too is a conflicting update.
  for (const t of ROLE_TEMPLATES) {
    // FR-27.11.B (D-11, D-12): a NEW organization's Seller and Sales Consultant start without the cost figures,
    // Цена на едро and Цена 0. Stored, as an edited role's are (so they no longer follow the template). An existing
    // organization's built-ins are never touched (`$setOnInsert`). FR-27 P3-5: no legacy projection.
    const withholds = !!TEMPLATE_WITHHOLDS[t.key]?.length
    const grant = withholds ? templateDefaults(t.key) : grantOfRole({ isBuiltin: true, templateKey: t.key, all: t.key === 'admin' })
    await Role.updateOne(
      { orgId, isBuiltin: true, templateKey: t.key },
      { $setOnInsert: { orgId, name: t.name, templateKey: t.key, isBuiltin: true, edited: withholds, all: t.key === 'admin', caps: capsOf(grant), version: 1 } },
      { upsert: true },
    ).exec()
  }
}

/** Where a person's first role came from: chosen (named, or the org's default) or the built-in role of a legacy key. */
export interface StartingRole {
  role: any
  /** Chosen: named, or the org's default. Otherwise the built-in role of a legacy key (an invite from before P3-5). */
  chosen: boolean
}

/**
 * The role a person joining the org starts with (FR-27.3): the one named (an invite's, a create's), else, when no
 * legacy key was named either, the org's default role, else the built-in role of the legacy key (an invite stored
 * before FR-27 P3-5 that names only `assignRole`, a script's `--role`), else the built-in Member. Null in an org that
 * has no roles.
 */
export async function startingRoleOf(orgId: unknown, opts: { roleId?: unknown; legacyRole?: string }): Promise<StartingRole | null> {
  if (opts.roleId) {
    const named = await Role.findOne({ _id: opts.roleId, orgId }).lean().exec()
    if (named) return { role: named, chosen: true }
  }
  if (!opts.legacyRole) {
    const fallback = await defaultRoleOf(String(orgId))
    const role = fallback ? await Role.findOne({ _id: fallback, orgId }).lean().exec() : null
    if (role) return { role, chosen: true }
  }
  const builtin = await Role.findOne({ orgId, isBuiltin: true, templateKey: opts.legacyRole || 'member' }).lean().exec()
  return builtin ? { role: builtin, chosen: false } : null
}

/**
 * A person's first role, given by the org itself (an invite accepted, a member created, an org founded): no actor to
 * hold to FR-27.8, which was asked of whoever made the invite or the member. FR-27 P3-2 (#529): sign-in refuses a
 * membership without one. FR-27 P3-5: the role alone is written, with its history entry (id and name); never the
 * legacy key, sets or permissions.
 */
export async function giveStartingRole(orgId: unknown, userId: unknown, start: StartingRole | null, assignedBy?: unknown): Promise<void> {
  if (!start) return
  const person: any = await User.findOne({ _id: userId, orgId }, { roleId: 1, roleHistory: 1 }).lean().exec()
  if (!person || person.roleId) return
  await User.updateOne(
    { _id: userId, orgId, roleId: { $exists: false } },
    { $set: { roleId: start.role._id, roleHistory: historyWith(person.roleHistory, start.role, new Date(), assignedBy) } },
  ).exec()
  forgetMember(userId)
}

/** Whether this actor may give this role (FR-27.8), before anything that would carry it is created. */
export async function assertAssignable(actor: Actor, orgId: string, roleId: string): Promise<void> {
  assertWithin(actor, grantOfRole(await roleInOrg(orgId, roleId)))
}

/**
 * FR-27.3 (#529): what a `POST`/`PUT /user` body names as the person's role: `roleId` (the org's role), `roleKey` (the
 * org's built-in role of that template key, which scripts and API callers can name in every org, since a role id
 * differs per org), or a legacy `role` key. Undefined when none is named. One of the three, never two (422).
 *
 * The legacy `role` is still the built-in role of that key for this release, and each use is logged (warn: the route,
 * the org, the key; nothing about the person), so the release shows whether anything besides our tests still sends it.
 * ⚠ The next release refuses it, 422 `legacy_role_field`, as invitations already refuse `assignRole`.
 */
export async function namedRoleId(
  orgId: string,
  body: { roleId?: string; roleKey?: string; role?: string },
  route: string,
): Promise<string | undefined> {
  const { roleId, roleKey, role: legacyKey } = body
  if (roleId && roleKey) refuse(422, 'role_id_and_key', 'Name the role once: by its id (roleId) or by its key (roleKey), not both.')
  if (legacyKey && (roleId || roleKey)) refuse(422, 'role_and_legacy', 'Name the role once (roleId or roleKey): not with the legacy role.')
  if (roleId) return roleId
  const key = roleKey ?? legacyKey
  if (!key) return undefined
  if (!templateOf(key)) {
    refuse(422, 'unknown_role_key', `No built-in role has the key "${key}".`, { keys: ROLE_TEMPLATES.map(t => t.key) })
  }
  if (legacyKey) logger.warn({ route, orgId, key: legacyKey }, 'legacy role field on a user route: send roleKey (FR-27, #529)')
  const builtin = await Role.findOne({ orgId, isBuiltin: true, templateKey: key }, { _id: 1 }).lean().exec()
  if (!builtin) refuse(422, 'role_not_found', 'This organization has no built-in role of that key.')
  return String(builtin!._id)
}

/** FR-27.3: give a person their one role. */
export async function assignRole(actor: Actor, orgId: string, userId: string, roleId: string): Promise<void> {
  if (String(actor.id) === String(userId)) refuse(403, 'own_role', 'You cannot change your own role.')
  const role = await roleInOrg(orgId, roleId)
  assertWithin(actor, grantOfRole(role))
  const person: any = await User.findOne({ _id: userId, orgId }).lean().exec()
  if (!person) refuse(404, 'user_not_found', 'User not found')
  if (String(person.roleId ?? '') === String(role._id)) return
  if (!isAdministratorRole(role)) await assertNotLastAdministrator(orgId, userId)
  const previous = person.roleId ? await Role.findOne({ _id: person.roleId, orgId }).lean().exec() : null

  // Appendix 29: the role history keeps the role's id and its name at the time.
  const history = historyWith(person.roleHistory, role, new Date(), actor.id)
  await User.updateOne({ _id: person._id, orgId }, { $set: { roleId: role._id, roleHistory: history } }).exec()
  forgetMember(person._id)
  createAuditEntry({
    orgId, userId: actor.id, action: 'update', module: 'admin', entityType: 'user', entityId: String(person._id), entityName: person.username,
    changes: [
      { field: 'role', oldValue: previous?.name ?? person.role, newValue: role.name },
      { field: 'caps', oldValue: previous ? capsOf(grantOfRole(previous)) : null, newValue: capsOf(grantOfRole(role)) },
    ],
  })
}
