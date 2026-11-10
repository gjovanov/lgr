import {
  CAPABILITIES, PAGE_ACCESS, ROLE_TEMPLATES, TEMPLATE_WITHHOLDS, canOpen, compileLegacy, grantOfRole, isCapability, legacyClaimsOf,
  projectGrant, sameGrant, templateDefaults, templateGrant, unknownCaps, withImplied, type CapabilityId, type Grant, type LegacySet,
} from 'config/access'
import { Org, PermissionSet, Role, User } from 'db/models'
import { createAuditEntry } from '../audit-log.service'
import { endSessionsOf } from '../permission-set.service'
import { grantOf, type AccessCaller } from './evaluate'
import { forgetMember, forgetRole } from './live'
import { accessModelOf } from './shadow'

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
 * Both models are written until Phase 3 (FR-27 §4 step 3): a role keeps its legacy projection (`projectGrant`)
 * and a permission set that carries it (`legacy.setId`), and a person given a role is put on that set with the
 * role's legacy key. So an org on the legacy model, and a master on an older release, serve each person their
 * role, or less where the projection cannot say it all (`needsRelease`), never more.
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

/** The active people of an org who are an Administrator: their role is, or (no role yet) their legacy role is `admin`. */
async function activeAdministrators(orgId: string): Promise<string[]> {
  const adminRoles = await administratorRoleIds(orgId)
  const people = await User.find({
    orgId, isActive: { $ne: false },
    $or: [{ roleId: { $in: adminRoles } }, { roleId: { $exists: false }, role: 'admin' }],
  }, { _id: 1 }).lean().exec()
  return people.map(p => String(p._id))
}

/** FR-27.8: the last active Administrator keeps the role and stays active. */
export async function assertNotLastAdministrator(orgId: string, userId: string): Promise<void> {
  const admins = await activeAdministrators(orgId)
  if (admins.length === 1 && admins[0] === String(userId)) {
    refuse(409, 'last_administrator', 'This is the last active Administrator of the organization: give another person the Administrator role first.')
  }
}

/** The role's projection and the set that carries it, written so the legacy model serves it (see the header). */
async function writeProjection(orgId: string, role: any, grant: Grant): Promise<{ legacy: any; needsRelease: boolean }> {
  const { legacy, exact } = projectGrant(grant)
  let setId = role?.legacy?.setId
  if (!grant.all) {
    const name = `Role · ${role.name}`
    const fields = { name, description: `What the role „${role.name}" gives, for the legacy model (FR-27)`, permissions: legacy.permissions, areas: legacy.areas, isAdmin: false, isSystem: true, isDefault: false, ownRecordsOnly: {} }
    const set = setId
      ? await PermissionSet.findOneAndUpdate({ _id: setId, orgId }, { $set: fields }, { new: true }).exec()
      : null
    setId = set ? set._id : (await PermissionSet.create({ orgId, ...fields }))._id
  }
  return { legacy: { ...legacy, ...(setId ? { setId } : {}) }, needsRelease: !exact }
}

/** Every person on the role, given its projection: their legacy key and its set. */
async function projectOntoPeople(orgId: string, role: any): Promise<void> {
  await User.updateMany({ orgId, roleId: role._id }, { $set: legacyFieldsOf(role) }).exec()
}

/** On the legacy model a person's claims are their token's: the sessions of the people on the role end (FR-26.9.4). */
async function endSessionsOnLegacy(orgId: string, userIds: unknown[]): Promise<void> {
  if ((await accessModelOf(orgId)) === 'roles') return
  const people = await User.find({ orgId, _id: { $in: userIds } }, { identityId: 1 }).lean().exec()
  for (const p of people) await endSessionsOf((p as any).identityId)
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
  needsRelease: boolean
  version: number
  people: number
  /** FR-27.4: the page the role's people start on (a page id it opens), or null: the App Hub's default. */
  landing: string | null
}

function view(role: any, people: number): RoleView {
  const grant = grantOfRole(role)
  return {
    id: String(role._id), name: role.name, description: role.description, isBuiltin: !!role.isBuiltin, templateKey: role.templateKey,
    edited: !!role.edited, all: !!role.all, caps: capsOf(grant), unknownCaps: unknownCaps(role), needsRelease: !!role.needsRelease,
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
  const draft: any = { orgId, name, description: input.description, isBuiltin: false, edited: false, all: false, caps: capsOf(grant), version: 1, ...(landing ? { landing } : {}) }
  const { legacy, needsRelease } = await writeProjection(orgId, draft, grant)
  const role = await Role.create({ ...draft, legacy, needsRelease })
  createAuditEntry({ orgId, userId: actor.id, action: 'create', module: 'admin', entityType: 'role', entityId: String(role._id), entityName: name, changes: [{ field: 'caps', oldValue: [], newValue: capsOf(grant) }] })
  return view(role.toObject(), 0)
}

export async function updateRole(actor: Actor, orgId: string, roleId: string, input: RoleInput): Promise<RoleView> {
  assertManages(actor)
  const role = await roleInOrg(orgId, roleId)
  if (isAdministratorRole(role)) refuse(409, 'administrator_role_fixed', 'The Administrator role cannot be edited.')
  const me = await User.findOne({ _id: actor.id, orgId }, { roleId: 1 }).lean().exec()
  if (me && String((me as any).roleId) === String(role._id)) refuse(403, 'own_role', 'You cannot edit your own role.')

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
    assertWithin(actor, after)
    // Taking a capability away is the actor's to do only within their own reach too: what they do not hold, they
    // neither give nor remove.
    assertWithin(actor, { caps: new Set([...(before.all ? [] : before.caps)].filter(c => !(after as any).caps.has(c))) })
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
  const next = { ...role, ...set }
  const { legacy, needsRelease } = await writeProjection(orgId, next, after)
  // A new version: the people's tabs ask `/auth/me` again (`x-access-version`), and a landing is part of the answer.
  const changed = input.caps !== undefined || set.name !== undefined || landing !== stored
  const updated = await Role.findOneAndUpdate(
    { _id: role._id, orgId },
    { $set: { ...set, legacy, needsRelease }, ...(Object.keys(unset).length ? { $unset: unset } : {}), ...(changed ? { $inc: { version: 1 } } : {}) },
    { new: true },
  ).lean().exec()
  forgetRole(role._id)
  await projectOntoPeople(orgId, updated)
  if (input.caps !== undefined) {
    const people = (await User.find({ orgId, roleId: role._id }, { _id: 1 }).lean().exec()).map(p => p._id)
    await endSessionsOnLegacy(orgId, people)
  }
  createAuditEntry({ orgId, userId: actor.id, action: 'update', module: 'admin', entityType: 'role', entityId: roleId, entityName: String(updated!.name), changes: [{ field: 'caps', oldValue: capsOf(before), newValue: capsOf(after) }] })
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
  if (role.legacy?.setId) await PermissionSet.deleteOne({ _id: role.legacy.setId, orgId }).exec()
  forgetRole(role._id)
  createAuditEntry({ orgId, userId: actor.id, action: 'delete', module: 'admin', entityType: 'role', entityId: roleId, entityName: role.name, changes: [{ field: 'caps', oldValue: capsOf(grantOfRole(role)), newValue: [] }] })
}

/**
 * The set that carries a role's projection, made on demand. A built-in role never edited needs none: its legacy key's
 * defaults are its access exactly. A role migration 0015 imported has its claims but no set, and without one a person
 * given it would be read as the bare role key's defaults, which could be more than the role.
 */
async function ensureProjection(orgId: string, role: any): Promise<any> {
  if (role.all || (role.isBuiltin && !role.edited) || role.legacy?.setId) return role
  const { legacy, needsRelease } = await writeProjection(orgId, role, grantOfRole(role))
  return Role.findOneAndUpdate({ _id: role._id, orgId }, { $set: { legacy, needsRelease } }, { new: true }).lean().exec()
}

/** The fields a person's role writes for a release that reads no roles. */
function legacyFieldsOf(role: any) {
  return role.all
    ? { role: 'admin', permissionSetIds: [], permissions: [] }
    : { role: role.legacy?.role ?? 'member', permissionSetIds: role.legacy?.setId ? [role.legacy.setId] : [], permissions: [] }
}

/** FR-27.3: the ten built-in roles of an org, made where missing (a new org; migration 0015 made them for the rest). */
export async function seedBuiltinRoles(orgId: unknown): Promise<void> {
  // The schema's timestamps fill createdAt/updatedAt: naming them here too is a conflicting update.
  for (const t of ROLE_TEMPLATES) {
    // FR-27.11.B (D-11, D-12): a NEW organization's Seller and Sales Consultant start without the cost figures,
    // Цена на едро and Цена 0. Stored, as an edited role's are (so they no longer follow the template), with the
    // projection a release that reads no roles serves (which cannot withhold them: `needsRelease`). An existing
    // organization's built-ins are never touched (`$setOnInsert`).
    if (TEMPLATE_WITHHOLDS[t.key]?.length) {
      const grant = templateDefaults(t.key)
      const p = projectGrant(grant)
      await Role.updateOne(
        { orgId, isBuiltin: true, templateKey: t.key },
        { $setOnInsert: { orgId, name: t.name, templateKey: t.key, isBuiltin: true, edited: true, all: false, caps: capsOf(grant), legacy: p.legacy, version: 1, needsRelease: !p.exact } },
        { upsert: true },
      ).exec()
      continue
    }
    const grant = grantOfRole({ isBuiltin: true, templateKey: t.key, all: t.key === 'admin' })
    await Role.updateOne(
      { orgId, isBuiltin: true, templateKey: t.key },
      { $setOnInsert: { orgId, name: t.name, templateKey: t.key, isBuiltin: true, edited: false, all: t.key === 'admin', caps: capsOf(grant), legacy: t.legacy, version: 1, needsRelease: false } },
      { upsert: true },
    ).exec()
  }
}

/** Where a person's first role came from: chosen (named, or the org's default) or read off their legacy role. */
export interface StartingRole {
  role: any
  /** Chosen by an admin: it is written onto the person. Otherwise it is theirs only when it grants what they hold. */
  chosen: boolean
}

/**
 * The role a person joining the org starts with (FR-27.3): the one named (an invite's, a create's), else, when no
 * legacy role was named either, the org's default role, else the built-in role of their legacy role. Null in an org
 * that has no roles yet.
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

/** Today's grant of a person, as `tokenize()` reads it: their sets in this org, else their role's defaults. */
async function legacyGrantOf(orgId: unknown, person: any): Promise<Grant> {
  const sets = person.permissionSetIds?.length
    ? ((await PermissionSet.find({ _id: { $in: person.permissionSetIds }, orgId }).lean().exec()) as unknown as LegacySet[])
    : []
  return compileLegacy(legacyClaimsOf({ role: person.role, permissions: person.permissions }, sets))
}

/**
 * A person's first role, given by the org itself (an invite accepted, a member created, an org founded): no actor to
 * hold to FR-27.8, which was asked of whoever made the invite or the member.
 *
 * - A chosen role is written onto both models, as `assignRole` does.
 * - A role read off the legacy role is recorded only when it grants exactly what the person's legacy fields do, and
 *   those are left as they are. So a member joining an org whose Seller set was edited keeps that set's access, and
 *   no org changes anyone's access before it moves to `roles` (Phase 1). Otherwise they have no role yet, and their
 *   claims decide, as for anyone the migration left without one.
 */
export async function giveStartingRole(orgId: unknown, userId: unknown, start: StartingRole | null): Promise<void> {
  if (!start) return
  const person: any = await User.findOne({ _id: userId, orgId }).lean().exec()
  if (!person || person.roleId) return
  if (!start.chosen) {
    if (!sameGrant(grantOfRole(start.role), await legacyGrantOf(orgId, person))) return
    await User.updateOne({ _id: userId, orgId, roleId: { $exists: false } }, { $set: { roleId: start.role._id, 'roleHistory.0.roleName': start.role.name } }).exec()
  } else {
    const ready = await ensureProjection(String(orgId), start.role)
    await User.updateOne(
      { _id: userId, orgId, roleId: { $exists: false } },
      { $set: { roleId: ready._id, ...legacyFieldsOf(ready), 'roleHistory.0.roleName': ready.name } },
    ).exec()
  }
  forgetMember(userId)
}

/** Whether this actor may give this role (FR-27.8), before anything that would carry it is created. */
export async function assertAssignable(actor: Actor, orgId: string, roleId: string): Promise<void> {
  assertWithin(actor, grantOfRole(await roleInOrg(orgId, roleId)))
}

/** FR-27.3: give a person their one role, and write its projection onto them (see the header). */
export async function assignRole(actor: Actor, orgId: string, userId: string, roleId: string): Promise<void> {
  if (String(actor.id) === String(userId)) refuse(403, 'own_role', 'You cannot change your own role.')
  const role = await roleInOrg(orgId, roleId)
  assertWithin(actor, grantOfRole(role))
  const person: any = await User.findOne({ _id: userId, orgId }).lean().exec()
  if (!person) refuse(404, 'user_not_found', 'User not found')
  if (String(person.roleId ?? '') === String(role._id)) return
  if (!isAdministratorRole(role)) await assertNotLastAdministrator(orgId, userId)
  const previous = person.roleId ? await Role.findOne({ _id: person.roleId, orgId }).lean().exec() : null
  const ready = await ensureProjection(orgId, role)

  // Appendix 29: the role history keeps the role's key and name at the time.
  const now = new Date()
  const history = [...(person.roleHistory ?? [])]
  const open = history.find((h: any) => !h.endDate)
  if (open) open.endDate = now
  history.push({ role: role.all ? 'admin' : role.legacy?.role ?? 'member', roleName: role.name, startDate: now, assignedBy: actor.id, assignedAt: now })

  await User.updateOne({ _id: person._id, orgId }, { $set: { roleId: role._id, roleHistory: history, ...legacyFieldsOf(ready) } }).exec()
  forgetMember(person._id)
  await endSessionsOnLegacy(orgId, [person._id])
  createAuditEntry({
    orgId, userId: actor.id, action: 'update', module: 'admin', entityType: 'user', entityId: String(person._id), entityName: person.username,
    changes: [
      { field: 'role', oldValue: previous?.name ?? person.role, newValue: role.name },
      { field: 'caps', oldValue: previous ? capsOf(grantOfRole(previous)) : null, newValue: capsOf(grantOfRole(role)) },
    ],
  })
}
