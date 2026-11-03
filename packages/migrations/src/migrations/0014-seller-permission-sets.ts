import type { Db } from 'mongodb'
import type { Migration, MigrationContext } from '../types.js'

/**
 * FR-26.4: the system sets of the two counter roles, „Seller" and „Sales Consultant", in every org
 * of this node. A new org gets them from `seedDefaultPermissionSets`; an org from before has the
 * other system sets only, and a role change or an invite into either role would find none.
 *
 * ⚠ The definitions are written out here, not read from `config/constants`: a released migration
 * is frozen, and what it seeds must not move when the role's defaults do later.
 *
 * ⚠ A set of that name already in the org (one somebody made) is reported and left alone. It is
 * neither adopted as the system set nor changed: `seedDefaultPermissionSets` matches by name and
 * would have taken it as it is, permissions, areas and all.
 *
 * Expand and contract both hold: the previous release ignores `areas` and `inventory.transfer`, and
 * the sets are assigned to nobody until an admin gives someone either role. Idempotent: a set this
 * wrote is found by its name the next time, and the insert is skipped.
 */
const SELLER_PERMISSIONS = ['invoicing.read', 'invoicing.write', 'invoicing.send', 'pos.read', 'pos.write', 'inventory.read', 'inventory.transfer']

const SETS = [
  {
    name: 'Seller',
    description: 'Sales documents, the till and stock transfers; no orders, bills, payments or prices',
    permissions: SELLER_PERMISSIONS,
    areas: [] as string[],
  },
  {
    name: 'Sales Consultant',
    description: 'What a Seller does, and orders and reservations',
    permissions: SELLER_PERMISSIONS,
    areas: ['orders'],
  },
]

/** `orgFilter` names the org in `orgId`, for tenant data. On `orgs` it is the document's own id. */
const homeOrgs = (orgFilter: Record<string, unknown>): Record<string, unknown> => ('orgId' in orgFilter ? { _id: orgFilter.orgId } : {})

interface Plan {
  orgId: unknown
  slug: string
  missing: typeof SETS
  /** A set of the name exists and is not a system set: somebody's own. */
  collisions: string[]
}

async function plan(db: Db, orgFilter: Record<string, unknown>): Promise<Plan[]> {
  const orgs = await db.collection('orgs').find(homeOrgs(orgFilter), { projection: { slug: 1 } }).toArray()
  const out: Plan[] = []
  for (const org of orgs) {
    const existing = await db.collection('permissionsets')
      .find({ orgId: org._id, name: { $in: SETS.map(s => s.name) } }, { projection: { name: 1, isSystem: 1 } })
      .toArray()
    const byName = new Map(existing.map(s => [s.name as string, s]))
    const missing = SETS.filter(s => !byName.has(s.name))
    const collisions = SETS.filter(s => byName.has(s.name) && byName.get(s.name)!.isSystem !== true).map(s => s.name)
    if (missing.length || collisions.length) out.push({ orgId: org._id, slug: String(org.slug ?? org._id), missing, collisions })
  }
  return out
}

export const sellerPermissionSets: Migration = {
  id: '0014-seller-permission-sets',
  description: 'The system sets „Seller" and „Sales Consultant" in every org; a set of either name somebody made is reported, not adopted (FR-26.4)',
  async preview({ db, orgFilter }: MigrationContext) {
    const lines: string[] = []
    for (const p of await plan(db, orgFilter)) {
      if (p.missing.length) lines.push(`${p.slug}: seed ${p.missing.map(s => s.name).join(', ')}`)
      for (const name of p.collisions) lines.push(`${p.slug}: "${name}" exists and is not a system set: left alone, assign the role's set by hand`)
    }
    return lines.length ? lines : ['nothing to change']
  },
  async up({ db, log, orgFilter }) {
    let seeded = 0
    for (const p of await plan(db, orgFilter)) {
      for (const name of p.collisions) {
        log(`${p.slug}: a permission set named "${name}" exists and is not a system set: left alone`, { orgId: String(p.orgId), name })
      }
      for (const def of p.missing) {
        const now = new Date()
        // The unique (orgId, name) index makes a concurrent run's insert fail, not double it.
        const r = await db.collection('permissionsets').updateOne(
          { orgId: p.orgId, name: def.name },
          {
            $setOnInsert: {
              orgId: p.orgId,
              name: def.name,
              description: def.description,
              permissions: def.permissions,
              areas: def.areas,
              ownRecordsOnly: {},
              isDefault: false,
              isAdmin: false,
              isSystem: true,
              createdAt: now,
              updatedAt: now,
            },
          },
          { upsert: true },
        )
        seeded += r.upsertedCount
      }
    }
    log(`seeded ${seeded} permission set(s)`)
  },
}
