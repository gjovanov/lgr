import {
  ROLE_TEMPLATES, compileLegacy, grantOfRole, legacyClaimsOf, legacyKeyOf, sameGrant, templateOf, type LegacySet,
} from 'config/access'
import type { Migration, MigrationContext } from '../types.js'
import { INVITE_FIELDS, USER_FIELDS } from './0017-legacy-access-archive.js'

type Db = MigrationContext['db']

/**
 * FR-27 (#529), FR-20.20: the last moment a person's legacy access can be read, so nobody reaches 0017 without a role.
 *
 * 0015 gave a role to every person there was when it ran. 0017 then archives the legacy fields of everyone, and 0020
 * drops the archive, and neither checks that the person has a role first. On lgrai.app that held: every person made
 * after 0015 got a role from the code (363e7619) long before 0017 ran there. A master skips releases. Server 0.1.12
 * (4a473278) was cut just before 363e7619, so it ran 0015 once, at its first start, and every org founded and every
 * person added on it since has no role (and those orgs no roles at all). Its update to the next release ran 0017 and
 * 0020 in that one start, and every one of those orgs signed in to `no_role`, its administrators too.
 *
 * In every org of this node (`orgFilter`), before 0017:
 *   - each person 0017 is about to archive (a legacy field present) who has no role gets the role 0015 would have
 *     given them, read by 0015's own rules (`legacyClaimsOf`, `compileLegacy`, `sameGrant`): the built-in role of
 *     their legacy role where their claims are its defaults (an `admin` the Administrator), else an imported role per
 *     distinct access, named as 0015 names them. The ten built-in roles are 0015's (the template defaults: these
 *     people's access is), never a new org's withholding Seller and Sales Consultant;
 *   - each invitation 0017 is about to archive with no role id gets the id of the built-in role its `assignRole`
 *     names. That is exact: 0.1.12 gave an accepted invitation that role's default permissions and nothing else. One
 *     whose key names no template is left alone: without a role id, it starts with the org's default role.
 *   - an org with neither is not touched at all, not even by the built-ins.
 *
 * ⚠ Not by 0015's own `up`. It reads every person without a role, and a person with no legacy field as the role
 * `undefined` with a member's permissions (an imported role named "undefined + extras"). Someone left without a role
 * on purpose (0015 left them so, on a difference, on the node they came from) must stay without one.
 * ⚠ Registered between 0016 and 0017, against the registry's append-only rule: after 0020 the legacy access is
 * nowhere, and this is the last point it can be read. A node that ran 0017 already (lgrai.app) runs this after it, and
 * finds nothing to do: 0020 left no legacy field on any person or invitation.
 *
 * A person 0015's rules cannot give an exact role (a difference) is logged and keeps no role, as in 0015; an
 * administrator never is one. Idempotent: built-in roles are found by their template, imported ones by their
 * `legacyKey`, and a person or invitation that has a role keeps it. Raw driver, like 0017.
 */

interface Person { _id: unknown; role?: string; permissions?: string[]; permissionSetIds?: unknown[]; username?: string }
interface Claims { role: string; permissions: string[]; areas?: string[] }
type Target = { kind: 'builtin'; key: string } | { kind: 'imported'; legacyKey: string }

interface Group { legacyKey: string; base: string; claims: Claims; people: number }

interface OrgPlan {
  orgId: unknown
  slug: string
  builtinsToCreate: string[]
  imported: Map<string, Group & { name: string; exists: boolean }>
  assign: Array<{ userId: unknown; target: Target }>
  invites: Array<{ inviteId: unknown; key: string }>
  invitesUnknown: number
  differences: string[]
}

const hasAny = (fields: readonly string[]) => ({ $or: fields.map(f => ({ [f]: { $exists: true } })) })

/** The people 0017 archives (any legacy field) who have no role. */
const PEOPLE = { roleId: { $exists: false }, ...hasAny(USER_FIELDS) }
/** The invitations 0017 archives (`assignRole`) that name no role by id. */
const INVITES = { assignRoleId: { $exists: false }, ...hasAny(INVITE_FIELDS) }

/** `orgFilter` names the org in `orgId`, for tenant data. On `orgs` it is the document's own id. */
const homeOrgs = (orgFilter: Record<string, unknown>): Record<string, unknown> => ('orgId' in orgFilter ? { _id: orgFilter.orgId } : {})

const sorted = (a: readonly string[] | undefined) => (a ? [...a].sort().join(',') : undefined)
const sameClaims = (a: Claims, b: Claims) =>
  a.role === b.role && sorted(a.permissions) === sorted(b.permissions) && sorted(a.areas) === sorted(b.areas)

async function present(db: Db): Promise<Set<string>> {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name))
}

async function planOrg(db: Db, here: Set<string>, org: any): Promise<OrgPlan | null> {
  const orgId = org._id
  const people = (here.has('users')
    ? await db.collection('users').find({ orgId, ...PEOPLE }, { projection: { role: 1, permissions: 1, permissionSetIds: 1, username: 1 } }).toArray()
    : []) as Person[]
  const invites = here.has('invites') ? await db.collection('invites').find({ orgId, ...INVITES }, { projection: { assignRole: 1 } }).toArray() : []
  if (!people.length && !invites.length) return null

  const sets = here.has('permissionsets') ? await db.collection('permissionsets').find({ orgId }).toArray() : []
  const setById = new Map(sets.map((s: any) => [String(s._id), s]))
  const roles = here.has('roles')
    ? await db.collection('roles').find({ orgId }, { projection: { name: 1, templateKey: 1, isBuiltin: 1, legacyKey: 1 } }).toArray()
    : []
  const builtinHere = new Set(roles.filter((r: any) => r.isBuiltin).map((r: any) => String(r.templateKey)))
  const importedHere = new Map<string, { name?: unknown }>(roles.filter((r: any) => typeof r.legacyKey === 'string').map((r: any) => [r.legacyKey as string, r]))
  const takenNames = new Set<string>(roles.map((r: any) => String(r.name)))
  for (const t of ROLE_TEMPLATES) takenNames.add(t.name)

  const plan: OrgPlan = {
    orgId, slug: String(org.slug ?? orgId),
    builtinsToCreate: ROLE_TEMPLATES.filter(t => !builtinHere.has(t.key)).map(t => t.key),
    imported: new Map(), assign: [], invites: [], invitesUnknown: 0, differences: [],
  }

  const groups = new Map<string, Group>()
  for (const person of people) {
    const resolved = (person.permissionSetIds ?? []).map(id => setById.get(String(id))).filter(Boolean) as unknown as Array<LegacySet & { name: string }>
    // The role the person's token carried on the node they are on: a document without one read as its schema's default.
    const c = legacyClaimsOf({ role: typeof person.role === 'string' ? person.role : 'member', permissions: person.permissions }, resolved)
    const claims: Claims = { role: c.role, permissions: c.permissions, ...(c.areas ? { areas: c.areas } : {}) }
    const template = templateOf(c.role)
    let target: Target
    if (template && (c.role === 'admin' || sameClaims(claims, template.legacy))) {
      target = { kind: 'builtin', key: template.key }
    } else {
      const legacyKey = legacyKeyOf(claims)
      const base = resolved.length
        ? [...new Set(resolved.map(s => s.name))].sort().join(' + ')
        : `${templateOf(c.role)?.name ?? c.role} + extras`
      const g = groups.get(legacyKey) ?? { legacyKey, base, claims, people: 0 }
      g.people++
      groups.set(legacyKey, g)
      target = { kind: 'imported', legacyKey }
    }
    // Zero difference, person by person (FR-27 §4): the role must grant what the token granted.
    const grant = target.kind === 'builtin'
      ? grantOfRole({ isBuiltin: true, edited: false, templateKey: target.key, all: target.key === 'admin' })
      : compileLegacy(claims)
    if (!sameGrant(grant, compileLegacy(claims))) {
      plan.differences.push(`${person.username ?? String(person._id)}: role ${target.kind === 'builtin' ? target.key : target.legacyKey} would not grant what the token did`)
      continue
    }
    plan.assign.push({ userId: person._id, target })
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

  for (const invite of invites as any[]) {
    const template = typeof invite.assignRole === 'string' ? templateOf(invite.assignRole) : undefined
    if (template) plan.invites.push({ inviteId: invite._id, key: template.key })
    else plan.invitesUnknown++
  }
  return plan
}

async function plans(db: Db, orgFilter: Record<string, unknown>): Promise<OrgPlan[]> {
  const here = await present(db)
  if (!here.has('orgs')) return []
  const orgs = await db.collection('orgs').find(homeOrgs(orgFilter), { projection: { slug: 1 } }).toArray()
  const out: OrgPlan[] = []
  for (const org of orgs) {
    const plan = await planOrg(db, here, org)
    if (plan) out.push(plan)
  }
  return out
}

export const rolesBeforeTheArchive: Migration = {
  id: '0016-roles-before-the-archive',
  description: 'Each person and invitation 0017 is about to archive without a role gets the role 0015 would have given them: a master updating from 0.1.12, where people made after 0015 have none (FR-27, FR-20.20)',
  async preview({ db, orgFilter }: MigrationContext) {
    const lines: string[] = []
    for (const p of await plans(db, orgFilter)) {
      const toBuiltin = p.assign.filter(a => a.target.kind === 'builtin').length
      lines.push(`${p.slug}: ${p.builtinsToCreate.length} built-in role(s) to create; ${toBuiltin} person(s) to a built-in role, ${p.assign.length - toBuiltin} to an imported one; ${p.invites.length} invitation(s) to a built-in role, ${p.invitesUnknown} naming no template`)
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
    let assigned = 0
    let invited = 0
    for (const p of await plans(db, orgFilter)) {
      const now = new Date()
      const builtinIds = new Map<string, unknown>()
      for (const t of ROLE_TEMPLATES) {
        const grant = grantOfRole({ isBuiltin: true, templateKey: t.key, all: t.key === 'admin' })
        const r = await db.collection('roles').findOneAndUpdate(
          { orgId: p.orgId, isBuiltin: true, templateKey: t.key },
          {
            $setOnInsert: {
              orgId: p.orgId, name: t.name, templateKey: t.key, isBuiltin: true, edited: false, all: t.key === 'admin',
              caps: grant.all ? [] : [...grant.caps].sort(), version: 1, createdAt: now, updatedAt: now,
            },
          },
          { upsert: true, returnDocument: 'after', includeResultMetadata: true },
        )
        if (r?.lastErrorObject?.upserted) builtins++
        builtinIds.set(t.key, r?.value?._id)
      }
      const importedIds = new Map<string, unknown>()
      for (const g of p.imported.values()) {
        const grant = compileLegacy(g.claims)
        const r = await db.collection('roles').findOneAndUpdate(
          { orgId: p.orgId, legacyKey: g.legacyKey },
          {
            $setOnInsert: {
              orgId: p.orgId, name: g.name, isBuiltin: false, edited: false, all: false,
              caps: grant.all ? [] : [...grant.caps].sort(), legacyKey: g.legacyKey, version: 1, createdAt: now, updatedAt: now,
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
        // A person given a role in the meantime keeps it.
        const r = await db.collection('users').updateOne({ _id: a.userId as any, roleId: { $exists: false } }, { $set: { roleId } })
        assigned += r.modifiedCount
      }
      for (const i of p.invites) {
        const roleId = builtinIds.get(i.key)
        if (!roleId) continue
        const r = await db.collection('invites').updateOne({ _id: i.inviteId as any, assignRoleId: { $exists: false } }, { $set: { assignRoleId: roleId } })
        invited += r.modifiedCount
      }
      for (const d of p.differences) log(`${p.slug}: left without a role: ${d}`, { orgId: String(p.orgId) })
      if (p.invitesUnknown) log(`${p.slug}: ${p.invitesUnknown} invitation(s) name no template; they start with the org's default role`, { orgId: String(p.orgId) })
    }
    log(`roles before the archive: ${builtins} built-in and ${imported} imported role(s) created, ${assigned} person(s) and ${invited} invitation(s) given a role`)
  },
}
