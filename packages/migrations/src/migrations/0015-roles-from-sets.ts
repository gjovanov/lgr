import type { Db } from 'mongodb'
import {
  ROLE_TEMPLATES, compileLegacy, grantOfRole, legacyClaimsOf, legacyKeyOf, sameGrant, templateOf, type LegacySet,
} from 'config/access'
import type { Migration, MigrationContext } from '../types.js'

/**
 * FR-27 §4 (#529) — every person gets one role, with exactly the access their token gives them today.
 *
 * In every org of this node:
 *   - the ten built-in roles (`config/access/templates.ts`), the Administrator among them;
 *   - for each person, today's claims, read as `tokenize()` reads them (`legacyClaimsOf`: their sets in this org,
 *     else their role's defaults plus their own list);
 *   - a person whose claims are their role's defaults gets that built-in role (an `admin` the Administrator,
 *     whatever their sets say, as every rule today lets an admin through);
 *   - anyone else gets an imported role, one per distinct access (`legacyKey`), named after their sets ("A + B")
 *     or "Role + extras". Its capabilities are those claims compiled (`compileLegacy`), and its `legacy` is the
 *     claims themselves, which a release that reads no roles keeps serving them.
 *
 * ⚠ Unlike the other migrations it reads live code on purpose: `legacyClaimsOf` and `compileLegacy` ARE today's
 * answer, the oracle the differential test holds the evaluator to. A frozen copy would be a second, drifting
 * oracle. Each person's role is checked against their claims before it is assigned (`sameGrant`); a difference is
 * reported and the person keeps no role, never a different access.
 *
 * Nothing reads `roleId` yet: the access model stays `legacy` until an org is switched (`scripts/access-model.ts`).
 * Expand only: the previous release ignores `roles` and `roleId`. Idempotent: built-in roles are found by their
 * template, imported ones by their `legacyKey`, and a person who has a role keeps it.
 */

interface Person { _id: unknown; role: string; permissions?: string[]; permissionSetIds?: unknown[]; roleId?: unknown; username?: string }
type Target = { kind: 'builtin'; key: string } | { kind: 'imported'; legacyKey: string }

interface Imported {
  legacyKey: string
  base: string
  claims: { role: string; permissions: string[]; areas?: string[] }
  people: number
}

interface OrgPlan {
  orgId: unknown
  slug: string
  builtinsToCreate: string[]
  imported: Map<string, Imported & { name: string; exists: boolean }>
  assign: Array<{ userId: unknown; target: Target }>
  alreadyAssigned: number
  differences: string[]
}

/** `orgFilter` names the org in `orgId`, for tenant data. On `orgs` it is the document's own id. */
const homeOrgs = (orgFilter: Record<string, unknown>): Record<string, unknown> => ('orgId' in orgFilter ? { _id: orgFilter.orgId } : {})

const sorted = (a: readonly string[] | undefined) => (a ? [...a].sort().join(',') : undefined)
const sameClaims = (a: { role: string; permissions: string[]; areas?: string[] }, b: { role: string; permissions: string[]; areas?: string[] }) =>
  a.role === b.role && sorted(a.permissions) === sorted(b.permissions) && sorted(a.areas) === sorted(b.areas)

async function planOrg(db: Db, org: any): Promise<OrgPlan> {
  const orgId = org._id
  const people = (await db.collection('users').find({ orgId }, { projection: { role: 1, permissions: 1, permissionSetIds: 1, roleId: 1, username: 1 } }).toArray()) as unknown as Person[]
  const sets = await db.collection('permissionsets').find({ orgId }).toArray()
  const setById = new Map(sets.map(s => [String(s._id), s]))
  const roles = await db.collection('roles').find({ orgId }, { projection: { name: 1, templateKey: 1, isBuiltin: 1, legacyKey: 1 } }).toArray()
  const builtinHere = new Set(roles.filter(r => r.isBuiltin).map(r => String(r.templateKey)))
  const importedHere = new Map(roles.filter(r => typeof r.legacyKey === 'string').map(r => [r.legacyKey as string, r]))
  const takenNames = new Set(roles.map(r => String(r.name)))

  const plan: OrgPlan = {
    orgId, slug: String(org.slug ?? orgId),
    builtinsToCreate: ROLE_TEMPLATES.filter(t => !builtinHere.has(t.key)).map(t => t.key),
    imported: new Map(), assign: [], alreadyAssigned: 0, differences: [],
  }
  for (const t of ROLE_TEMPLATES) takenNames.add(t.name)

  const groups = new Map<string, Imported>()
  for (const person of people) {
    if (person.roleId) {
      plan.alreadyAssigned++
      continue
    }
    const resolved = (person.permissionSetIds ?? []).map(id => setById.get(String(id))).filter(Boolean) as unknown as Array<LegacySet & { name: string }>
    const c = legacyClaimsOf({ role: person.role, permissions: person.permissions }, resolved)
    const claims = { role: c.role, permissions: c.permissions, ...(c.areas ? { areas: c.areas } : {}) }
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
    // Zero difference, person by person (FR-27 §4): the role must grant what the token grants.
    const grant = target.kind === 'builtin'
      ? grantOfRole({ isBuiltin: true, edited: false, templateKey: target.key, all: target.key === 'admin' })
      : compileLegacy(claims)
    if (!sameGrant(grant, compileLegacy(claims))) {
      plan.differences.push(`${person.username ?? String(person._id)}: role ${target.kind === 'builtin' ? target.key : target.legacyKey} would not grant what the token does`)
      continue
    }
    plan.assign.push({ userId: person._id, target })
  }

  // Names: the sets' (or "Role + extras"), told apart by the role where two accesses share them.
  const byBase = new Map<string, Imported[]>()
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
  return plan
}

async function plans(db: Db, orgFilter: Record<string, unknown>): Promise<OrgPlan[]> {
  const orgs = await db.collection('orgs').find(homeOrgs(orgFilter), { projection: { slug: 1 } }).toArray()
  const out: OrgPlan[] = []
  for (const org of orgs) out.push(await planOrg(db, org))
  return out
}

export const rolesFromSets: Migration = {
  id: '0015-roles-from-sets',
  description: 'One role per person with exactly the access their token gives today: the ten built-in roles, and an imported role per other access (FR-27 §4)',
  async preview({ db, orgFilter }: MigrationContext) {
    const lines: string[] = []
    for (const p of await plans(db, orgFilter)) {
      const toBuiltin = p.assign.filter(a => a.target.kind === 'builtin').length
      const toImported = p.assign.length - toBuiltin
      if (!p.builtinsToCreate.length && !p.assign.length && !p.differences.length) continue
      lines.push(`${p.slug}: ${p.builtinsToCreate.length} built-in role(s) to create; ${toBuiltin} person(s) to a built-in role, ${toImported} to an imported one; ${p.alreadyAssigned} already have a role`)
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
              caps: grant.all ? [] : [...grant.caps].sort(), legacy: t.legacy, version: 1, createdAt: now, updatedAt: now,
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
        // A person given a role in the meantime keeps it.
        const r = await db.collection('users').updateOne({ _id: a.userId as any, roleId: { $exists: false } }, { $set: { roleId } })
        assigned += r.modifiedCount
      }
      for (const d of p.differences) log(`${p.slug}: left without a role: ${d}`, { orgId: String(p.orgId) })
    }
    log(`roles: ${builtins} built-in and ${imported} imported role(s) created, ${assigned} person(s) given a role`)
  },
}
