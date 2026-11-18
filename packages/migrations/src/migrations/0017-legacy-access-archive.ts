import type { Migration, MigrationContext } from '../types.js'

type Db = MigrationContext['db']

/**
 * FR-27 Phase 3, P3-7 (#529): the data contract. The legacy access fields leave the live documents.
 *
 * Roles decide (P3-2), and nothing has written the legacy fields since P3-5. In every org of this node:
 *   - `users`: `role`, `permissions` and `permissionSetIds` move into `legacyArchive`, with `archivedAt`, and are
 *     unset;
 *   - `invites`: `assignRole` moves into `legacyArchive` the same way;
 *   - `permissionsets`: every set is copied, as it is, into `permissionsets_archive`, with `archivedAt`. The sets
 *     themselves stay (the conservative reading of the plan): dropping them is 0018's, one release later.
 *
 * The archive holds exactly what was there: a field that was missing is missing from it too, and an empty list stays
 * an empty list. Each document moves in one atomic pipeline update, so a run cut short leaves every document either
 * as it was or archived, never half.
 *
 * ⚠ One-way (FR-27 §5): the previous release reads these fields. A rollback after this has run serves people by
 * their roles only, and the fields come back only by hand, from the archive, within the one-release window.
 *
 * Idempotent: a document is taken only while it still has one of the fields, and one archived already keeps its
 * first archive (a field written back since, a schema default, is unset again and not archived over it). A set is
 * copied once, by its `_id`, and never replaced. Scoped by `orgFilter`: a node archives only its own orgs.
 */

export const USER_FIELDS = ['role', 'permissions', 'permissionSetIds'] as const
export const INVITE_FIELDS = ['assignRole'] as const
export const SETS_ARCHIVE = 'permissionsets_archive'

const hasAny = (fields: readonly string[]) => ({ $or: fields.map(f => ({ [f]: { $exists: true } })) })

/** One moment for the whole run, people, invites and sets alike (`$$NOW` is one per command, and a run is three). */
function archivePipeline(fields: readonly string[], at: Date) {
  // A field that is missing evaluates to missing, and an object expression leaves such a key out.
  const archive = Object.fromEntries([...fields.map(f => [f, `$${f}`]), ['archivedAt', { $literal: at }]])
  return [
    { $set: { legacyArchive: { $ifNull: ['$legacyArchive', archive] } } },
    { $unset: [...fields] },
  ]
}

async function present(db: Db): Promise<Set<string>> {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name))
}

interface Counts { users: number; invites: number; sets: number }

async function pending(db: Db, orgFilter: Record<string, unknown>): Promise<Counts> {
  const here = await present(db)
  const count = (name: string, filter: Record<string, unknown>) => (here.has(name) ? db.collection(name).countDocuments(filter) : Promise.resolve(0))
  const sets = here.has('permissionsets')
    ? (await db.collection('permissionsets').find(orgFilter, { projection: { _id: 1 } }).toArray()).map((s: { _id: unknown }) => s._id)
    : []
  const copied = sets.length && here.has(SETS_ARCHIVE) ? await db.collection(SETS_ARCHIVE).countDocuments({ _id: { $in: sets } }) : 0
  return {
    users: await count('users', { ...orgFilter, ...hasAny(USER_FIELDS) }),
    invites: await count('invites', { ...orgFilter, ...hasAny(INVITE_FIELDS) }),
    sets: sets.length - copied,
  }
}

export const legacyAccessArchive: Migration = {
  id: '0017-legacy-access-archive',
  description: 'The legacy access fields (User role/permissions/permissionSetIds, Invite assignRole) move into legacyArchive and are unset; permission sets are copied to permissionsets_archive (FR-27 P3-7)',
  async preview({ db, orgFilter }: MigrationContext) {
    const c = await pending(db, orgFilter)
    if (!c.users && !c.invites && !c.sets) return ['nothing to change']
    return [
      `users: ${c.users} to archive (${USER_FIELDS.join(', ')}) and unset`,
      `invites: ${c.invites} to archive (${INVITE_FIELDS.join(', ')}) and unset`,
      `permissionsets: ${c.sets} to copy into ${SETS_ARCHIVE} (the sets stay)`,
    ]
  },
  async up({ db, log, orgFilter }) {
    const here = await present(db)
    const at = new Date()

    // The sets first: a run cut short after this leaves the people as they were, with their sets archived too.
    if (here.has('permissionsets')) {
      await db.collection('permissionsets').aggregate([
        { $match: orgFilter },
        { $set: { archivedAt: { $literal: at } } },
        { $merge: { into: SETS_ARCHIVE, on: '_id', whenMatched: 'keepExisting', whenNotMatched: 'insert' } },
      ]).toArray()
    }
    const copied = here.has('permissionsets') ? await db.collection(SETS_ARCHIVE).countDocuments({ ...orgFilter, archivedAt: at }) : 0

    let users = 0
    if (here.has('users')) {
      users = (await db.collection('users').updateMany({ ...orgFilter, ...hasAny(USER_FIELDS) }, archivePipeline(USER_FIELDS, at))).modifiedCount
    }
    let invites = 0
    if (here.has('invites')) {
      invites = (await db.collection('invites').updateMany({ ...orgFilter, ...hasAny(INVITE_FIELDS) }, archivePipeline(INVITE_FIELDS, at))).modifiedCount
    }
    log(`legacy access archived: ${users} user(s), ${invites} invite(s); ${copied} permission set(s) copied to ${SETS_ARCHIVE}`)
  },
}
