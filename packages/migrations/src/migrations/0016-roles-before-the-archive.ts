import {
  ROLE_TEMPLATES, compileLegacy, grantOfRole, legacyClaimsOf, legacyKeyOf, sameGrant, templateOf, type LegacySet,
} from 'config/access'
import type { Migration, MigrationContext } from '../types.js'
import { INVITE_FIELDS, USER_FIELDS } from './0017-legacy-access-archive.js'

type Db = MigrationContext['db']

/**
 * FR-27 (#529), FR-20.20: the last moment a person's legacy access can be read. Before 0017 archives it, each person gets
 * the role that access amounts to, and the release before can still serve them by it if the update goes back.
 *
 * 0015 gave a role to every person there was when it ran. 0017 then archives the legacy fields of everyone, and 0020
 * drops the archive; neither looks at the roles first. On lgrai.app that held: its orgs were switched to `roles` long
 * before 0017 ran there, so the roles had decided for a while, and everyone made since 0015 got one from the code
 * (363e7619). A master skips releases. Server 0.1.12 (4a473278) was cut just before 363e7619. It ran 0015 once, at its
 * first start, left its orgs on the legacy model (`settings.access.model` unset) and served them by the legacy fields:
 *   - every org founded and every person added on it since has no role (those orgs no roles at all);
 *   - its Users screen changes a person's legacy `role` and sets, never their `roleId`, so whoever was given another role
 *     since the first start still holds the one 0015 gave them then. An administrator demoted since still holds the
 *     Administrator role.
 * Its update to the next release ran 0017 and 0020 in one start, and every one of those orgs signed in to `no_role`.
 * Where it did not, the stale roles decided: a promotion undone, a demoted administrator an Administrator again.
 *
 * In every org of this node (`orgFilter`) with people 0017 is about to archive (a legacy field present):
 *   - where the legacy model decided (`settings.access.model` anything but `roles`), each of those people gets the role
 *     0015's own rules give their legacy access as it is now (`legacyClaimsOf`, `compileLegacy`, `sameGrant`): the
 *     built-in role of their legacy role where their claims are its defaults (an `admin` the Administrator), else an
 *     imported role per distinct access, named as 0015 names them. A person whose role is that one, or grants exactly
 *     the same, keeps it; anyone else is moved to it, and each move is logged. The ten built-in roles are 0015's (the
 *     template defaults: these people's access is), never a new org's withholding Seller and Sales Consultant;
 *   - where roles decided (`roles`), a person's role is what they had: only one without a role gets one, by those rules;
 *   - each invitation 0017 is about to archive with no role id gets the id of the built-in role its `assignRole` names.
 *     That is exact: 0.1.12 gave an accepted invitation that role's default permissions and nothing else. One whose key
 *     names no template is left alone: without a role id, it starts with the org's default role;
 *   - the org goes to `roles` (`settings.access.model`, which nothing reads since FR-27 P3-2), and every role created
 *     here carries the legacy projection 0015 writes (`legacy`). 0.1.12 serves an org by its roles only on `roles`, and
 *     takes a session's role key and permissions from `Role.legacy` (`liveRoleOf`, `tokenize`, `attachAccess`). An
 *     update that fails its confirmation goes back to 0.1.12 with 0017 and 0020 run (#980): this keeps its people at
 *     their access there, and its administrators administrators (the backup guard reads `role === 'admin'`).
 * An org with no such person and no such invitation is not touched; the built-ins are made only where someone needs one.
 *
 * ⚠ Not by 0015's own `up`. It reads every person without a role, and a person with no legacy field as the role
 * `undefined` with a member's permissions (an imported role named "undefined + extras"). Someone left without a role
 * on purpose (0015 left them so, on a difference, on the node they came from) must stay without one.
 * ⚠ Registered between 0016 and 0017, against the registry's append-only rule: after 0020 the legacy access is
 * nowhere, and this is the last point it can be read. A node that ran 0017 already (lgrai.app) runs this after it, and
 * finds nothing to do: 0020 left no legacy field on any person or invitation.
 *
 * A person 0015's rules cannot give an exact role (a difference) is logged and left as they are, as in 0015; an
 * administrator never is one, and while no template drifts from its legacy claims nobody is
 * (`roles-before-archive.migration.test` asserts both). Idempotent: built-in roles are found by their template,
 * imported ones by their `legacyKey`, an org already on `roles` keeps its people's roles, and a second run finds
 * nothing to do. People move one by one, each only from the role this run read. Raw driver, like 0017.
 */

interface Person { _id: unknown; role?: string; permissions?: string[]; permissionSetIds?: unknown[]; roleId?: unknown; username?: string }
interface Claims { role: string; permissions: string[]; areas?: string[] }
type Target = { kind: 'builtin'; key: string } | { kind: 'imported'; legacyKey: string }

interface Group { legacyKey: string; base: string; claims: Claims; people: number }

/** A person given a role (`from` null) or moved to the one their access gives (`from` the role they hold now). */
interface Assignment { userId: unknown; username: string; from: unknown; fromName: string; target: Target }

interface OrgPlan {
  orgId: unknown
  slug: string
  builtinsToCreate: string[]
  imported: Map<string, Group & { name: string; exists: boolean }>
  assign: Assignment[]
  invites: Array<{ inviteId: unknown; key: string }>
  invitesUnknown: number
  differences: string[]
  /** The legacy model decided here: the org goes to `roles`. */
  switchModel: boolean
}

const hasAny = (fields: readonly string[]) => ({ $or: fields.map(f => ({ [f]: { $exists: true } })) })

/** The people 0017 archives: any legacy field. */
const PEOPLE = hasAny(USER_FIELDS)
/** The invitations 0017 archives (`assignRole`) that name no role by id. */
const INVITES = { assignRoleId: { $exists: false }, ...hasAny(INVITE_FIELDS) }
/** A path a `$set` can write below: an object, or nothing yet. */
const writableBelow = (path: string) => ({ $or: [{ [path]: { $type: 'object' } }, { [path]: { $exists: false } }] })

/** `orgFilter` names the org in `orgId`, for tenant data. On `orgs` it is the document's own id. */
const homeOrgs = (orgFilter: Record<string, unknown>): Record<string, unknown> => ('orgId' in orgFilter ? { _id: orgFilter.orgId } : {})

const sorted = (a: readonly string[] | undefined) => (a ? [...a].sort().join(',') : undefined)
const sameClaims = (a: Claims, b: Claims) =>
  a.role === b.role && sorted(a.permissions) === sorted(b.permissions) && sorted(a.areas) === sorted(b.areas)

/** The role their access gives, found among the org's: its built-in by template, an imported one by its access. */
const isTarget = (role: any, target: Target) =>
  target.kind === 'builtin' ? role.isBuiltin === true && role.templateKey === target.key : role.legacyKey === target.legacyKey

async function present(db: Db): Promise<Set<string>> {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name))
}

async function planOrg(db: Db, here: Set<string>, org: any): Promise<OrgPlan | null> {
  const orgId = org._id
  const people: Person[] = here.has('users')
    ? await db.collection('users').find({ orgId, ...PEOPLE }, { projection: { role: 1, permissions: 1, permissionSetIds: 1, roleId: 1, username: 1 } }).toArray()
    : []
  const invites = here.has('invites') ? await db.collection('invites').find({ orgId, ...INVITES }, { projection: { assignRole: 1 } }).toArray() : []
  if (!people.length && !invites.length) return null

  // What decided this org's access on the release that wrote its legacy fields: 0.1.12's `accessModelOf`.
  const legacyDecided = org.settings?.access?.model !== 'roles'
  const sets = here.has('permissionsets') ? await db.collection('permissionsets').find({ orgId }).toArray() : []
  const setById = new Map(sets.map((s: any) => [String(s._id), s]))
  const roles: any[] = here.has('roles') ? await db.collection('roles').find({ orgId }).toArray() : []
  const roleById = new Map(roles.map(r => [String(r._id), r]))
  const builtinHere = new Set(roles.filter(r => r.isBuiltin).map(r => String(r.templateKey)))
  const importedHere = new Map<string, { name?: unknown }>(roles.filter(r => typeof r.legacyKey === 'string').map(r => [r.legacyKey as string, r]))
  const takenNames = new Set<string>(roles.map(r => String(r.name)))
  for (const t of ROLE_TEMPLATES) takenNames.add(t.name)

  const plan: OrgPlan = {
    orgId, slug: String(org.slug ?? orgId),
    builtinsToCreate: ROLE_TEMPLATES.filter(t => !builtinHere.has(t.key)).map(t => t.key),
    imported: new Map(), assign: [], invites: [], invitesUnknown: 0, differences: [],
    switchModel: legacyDecided && people.length > 0,
  }

  const groups = new Map<string, Group>()
  for (const person of people) {
    // Where roles decided, the role is what the person had.
    if (person.roleId && !legacyDecided) continue
    const current = person.roleId ? roleById.get(String(person.roleId)) : undefined
    const resolved = (person.permissionSetIds ?? []).map(id => setById.get(String(id))).filter(Boolean) as unknown as Array<LegacySet & { name: string }>
    // The role the person's token carried on the node they are on: a document without one read as its schema's default.
    const c = legacyClaimsOf({ role: typeof person.role === 'string' ? person.role : 'member', permissions: person.permissions }, resolved)
    const claims: Claims = { role: c.role, permissions: c.permissions, ...(c.areas ? { areas: c.areas } : {}) }
    const template = templateOf(c.role)
    const target: Target = template && (c.role === 'admin' || sameClaims(claims, template.legacy))
      ? { kind: 'builtin', key: template.key }
      : { kind: 'imported', legacyKey: legacyKeyOf(claims) }
    const who = person.username ?? String(person._id)
    // The role they hold is the one their access gives, or grants exactly what it does: it stays.
    if (current && (isTarget(current, target) || sameGrant(grantOfRole(current), compileLegacy(claims)))) continue
    // Zero difference, person by person (FR-27 §4): the role must grant what the token granted.
    const grant = target.kind === 'builtin'
      ? grantOfRole({ isBuiltin: true, edited: false, templateKey: target.key, all: target.key === 'admin' })
      : compileLegacy(claims)
    if (!sameGrant(grant, compileLegacy(claims))) {
      const left = person.roleId ? `left on ${current ? String(current.name) : 'a role that is gone'}` : 'left without a role'
      plan.differences.push(`${who}: ${left}: role ${target.kind === 'builtin' ? target.key : target.legacyKey} would not grant what the token did`)
      continue
    }
    if (target.kind === 'imported') {
      const base = resolved.length
        ? [...new Set(resolved.map(s => s.name))].sort().join(' + ')
        : `${templateOf(c.role)?.name ?? c.role} + extras`
      const g = groups.get(target.legacyKey) ?? { legacyKey: target.legacyKey, base, claims, people: 0 }
      g.people++
      groups.set(target.legacyKey, g)
    }
    plan.assign.push({
      userId: person._id, username: who, target,
      from: person.roleId ?? null, fromName: person.roleId ? (current ? String(current.name) : 'a role that is gone') : '',
    })
  }

  // Names: the sets' (or "Role + extras"), told apart by the role where two accesses share them. As 0015 names them.
  const byBase = new Map<string, Group[]>()
  for (const g of groups.values()) byBase.set(g.base, [...(byBase.get(g.base) ?? []), g])
  for (const g of groups.values()) {
    const found = importedHere.get(g.legacyKey)
    if (found) {
      plan.imported.set(g.legacyKey, { ...g, name: String(found.name), exists: true })
      continue
    }
    let name = byBase.get(g.base)!.length > 1 ? `${g.base} (${templateOf(g.claims.role)?.name ?? g.claims.role})` : g.base
    if (takenNames.has(name)) name = `${name} (imported)`
    for (let n = 2; takenNames.has(name); n++) name = `${g.base} (imported ${n})`
    takenNames.add(name)
    plan.imported.set(g.legacyKey, { ...g, name, exists: false })
  }

  for (const invite of invites) {
    const template = typeof invite.assignRole === 'string' ? templateOf(invite.assignRole) : undefined
    if (template) plan.invites.push({ inviteId: invite._id, key: template.key })
    else plan.invitesUnknown++
  }
  if (!plan.assign.length && !plan.invites.length && !plan.invitesUnknown && !plan.differences.length && !plan.switchModel) return null
  return plan
}

async function plans(db: Db, orgFilter: Record<string, unknown>): Promise<OrgPlan[]> {
  const here = await present(db)
  if (!here.has('orgs')) return []
  const orgs = await db.collection('orgs').find(homeOrgs(orgFilter), { projection: { slug: 1, 'settings.access.model': 1 } }).toArray()
  const out: OrgPlan[] = []
  for (const org of orgs) {
    const plan = await planOrg(db, here, org)
    if (plan) out.push(plan)
  }
  return out
}

/** A role named in a line: the template's name, or the imported role's. */
const targetName = (p: OrgPlan, target: Target) =>
  target.kind === 'builtin' ? (templateOf(target.key)?.name ?? target.key) : (p.imported.get(target.legacyKey)?.name ?? target.legacyKey)

const givesRoles = (p: OrgPlan) => p.assign.length > 0 || p.invites.length > 0

export const rolesBeforeTheArchive: Migration = {
  id: '0016-roles-before-the-archive',
  description: 'Before 0017 archives the legacy access, each person gets the role it amounts to (none, or a stale one, on a master updating from 0.1.12), and their org goes to roles so 0.1.12 serves them by it after a go-back (FR-27, FR-20.20)',
  async preview({ db, orgFilter }: MigrationContext) {
    const lines: string[] = []
    for (const p of await plans(db, orgFilter)) {
      const given = p.assign.filter(a => a.from === null)
      const moved = p.assign.filter(a => a.from !== null)
      const toBuiltin = given.filter(a => a.target.kind === 'builtin').length
      lines.push(`${p.slug}: ${givesRoles(p) ? p.builtinsToCreate.length : 0} built-in role(s) to create; ${toBuiltin} person(s) to a built-in role, ${given.length - toBuiltin} to an imported one; ${moved.length} to move; ${p.invites.length} invitation(s) to a built-in role, ${p.invitesUnknown} naming no template${p.switchModel ? '; the org to roles' : ''}`)
      for (const a of moved) lines.push(`${p.slug}:   ${a.username}: from ${a.fromName} to ${targetName(p, a.target)}`)
      for (const g of p.imported.values()) {
        lines.push(`${p.slug}:   ${g.exists ? 'existing' : 'new'} role "${g.name}" (${g.people} person(s)): ${g.claims.role}, ${g.claims.permissions.length} permission(s), areas ${g.claims.areas ? `[${g.claims.areas.join(', ')}]` : 'all'}`)
      }
      lines.push(`${p.slug}: differences: ${p.differences.length}`)
      for (const d of p.differences) lines.push(`${p.slug}:   ${d}`)
    }
    return lines.length ? lines : ['nothing to change']
  },
  async up({ db, log, orgFilter }) {
    let builtins = 0
    let imported = 0
    let given = 0
    let moved = 0
    let invited = 0
    let switched = 0
    for (const p of await plans(db, orgFilter)) {
      const now = new Date()
      const builtinIds = new Map<string, unknown>()
      // Where someone is given a role. An org whose people all keep theirs has 0015's built-ins already.
      if (givesRoles(p)) {
        for (const t of ROLE_TEMPLATES) {
          const grant = grantOfRole({ isBuiltin: true, templateKey: t.key, all: t.key === 'admin' })
          const r = await db.collection('roles').findOneAndUpdate(
            { orgId: p.orgId, isBuiltin: true, templateKey: t.key },
            {
              $setOnInsert: {
                orgId: p.orgId, name: t.name, templateKey: t.key, isBuiltin: true, edited: false, all: t.key === 'admin',
                caps: grant.all ? [] : [...grant.caps].sort(), legacy: t.legacy, version: 1, createdAt: now, updatedAt: now,
              },
            },
            { upsert: true, returnDocument: 'after', includeResultMetadata: true },
          )
          if (r?.lastErrorObject?.upserted) builtins++
          builtinIds.set(t.key, r?.value?._id)
        }
      }
      const importedIds = new Map<string, unknown>()
      for (const g of p.imported.values()) {
        const grant = compileLegacy(g.claims)
        const r = await db.collection('roles').findOneAndUpdate(
          { orgId: p.orgId, legacyKey: g.legacyKey },
          {
            $setOnInsert: {
              orgId: p.orgId, name: g.name, isBuiltin: false, edited: false, all: false,
              caps: grant.all ? [] : [...grant.caps].sort(), legacy: g.claims, legacyKey: g.legacyKey, version: 1, createdAt: now, updatedAt: now,
            },
          },
          { upsert: true, returnDocument: 'after', includeResultMetadata: true },
        )
        if (r?.lastErrorObject?.upserted) imported++
        importedIds.set(g.legacyKey, r?.value?._id)
      }
      for (const a of p.assign) {
        const roleId = a.target.kind === 'builtin' ? builtinIds.get(a.target.key) : importedIds.get(a.target.legacyKey)
        if (!roleId) continue
        // Given only while they still have none; moved only from the role this run read. A change since wins.
        const r = await db.collection('users').updateOne({ _id: a.userId, roleId: a.from === null ? { $exists: false } : a.from }, { $set: { roleId } })
        if (!r.modifiedCount) continue
        if (a.from === null) {
          given++
          continue
        }
        moved++
        log(`${p.slug}: ${a.username} moved from ${a.fromName} to ${targetName(p, a.target)}: the role their legacy access gives`, { orgId: String(p.orgId) })
      }
      for (const i of p.invites) {
        const roleId = builtinIds.get(i.key)
        if (!roleId) continue
        const r = await db.collection('invites').updateOne({ _id: i.inviteId, assignRoleId: { $exists: false } }, { $set: { assignRoleId: roleId } })
        invited += r.modifiedCount
      }
      // Last, once its people have their roles: a run cut short never leaves an org on roles its people do not hold.
      if (p.switchModel) {
        const r = await db.collection('orgs').updateOne(
          { _id: p.orgId, 'settings.access.model': { $ne: 'roles' }, $and: [writableBelow('settings'), writableBelow('settings.access')] },
          { $set: { 'settings.access.model': 'roles' } },
        )
        if (r.modifiedCount) switched++
        else if ((await db.collection('orgs').findOne({ _id: p.orgId }, { projection: { 'settings.access.model': 1 } }))?.settings?.access?.model !== 'roles') {
          log(`${p.slug}: its settings cannot take settings.access.model, so it stays off roles: 0.1.12 would serve it by the legacy model after a go-back`, { orgId: String(p.orgId) })
        }
      }
      for (const d of p.differences) log(`${p.slug}: ${d}`, { orgId: String(p.orgId) })
      if (p.invitesUnknown) log(`${p.slug}: ${p.invitesUnknown} invitation(s) name no template; they start with the org's default role`, { orgId: String(p.orgId) })
    }
    log(`roles before the archive: ${builtins} built-in and ${imported} imported role(s) created; ${given} person(s) given a role and ${moved} moved to the one their access gives; ${invited} invitation(s) given a role; ${switched} org(s) to roles`)
  },
}
