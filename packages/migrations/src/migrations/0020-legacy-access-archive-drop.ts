import type { Migration, MigrationContext } from '../types.js'
import { INVITE_FIELDS, SETS_ARCHIVE, USER_FIELDS } from './0017-legacy-access-archive.js'

type Db = MigrationContext['db']

/**
 * FR-27 Phase 3, P3-9 (#529): the legacy access archive goes, one release after 0017 made it. The plan named this
 * migration "0018"; 0018 and 0019 went to FR-30 first.
 *
 * In every org of this node (`orgFilter`):
 *   - `users`: `legacyArchive` is unset, and with it any legacy field (`role`, `permissions`, `permissionSetIds`) a
 *     person carries again since 0017. Nothing has written those since P3-5 and no schema names them since this
 *     release, so one found now is a leftover nothing reads: it is unset, not archived;
 *   - `invites`: `legacyArchive` is unset, and a leftover `assignRole` the same way;
 *   - `permissionsets_archive` and `permissionsets`: the org's documents are deleted. Every org of a node shares the
 *     two collections, so a collection is dropped only once it is empty: never while another org's documents are in
 *     it, which a node that does not take every org leaves to that org's home.
 *
 * The people and invitations go first, the sets last: a run cut short never leaves an archive that names sets which
 * are gone. Roles are not touched: a role from before P3-5 may still carry `legacy` / `needsRelease`, which 0017 did
 * not archive and nothing reads.
 *
 * ⚠ One-way (FR-27 §5): after this the legacy access is nowhere in the database, and no release reads it. Run on
 * global by hand, one release after 0017, with a backup first (a mongodump of users, invites, permissionsets and
 * permissionsets_archive). The rollback is that backup, or failing it the one taken before 0017: the archive, or the
 * fields themselves, put back by hand. A master runs it on update, after the backup its supervisor takes.
 *
 * Idempotent: a second run finds no archive, no leftover field and no set, and a collection that is not there is
 * skipped. Raw driver, like 0017: no model names any of this any more.
 */

const SET_COLLECTIONS = [SETS_ARCHIVE, 'permissionsets'] as const

const hasAny = (fields: readonly string[]) => ({ $or: fields.map(f => ({ [f]: { $exists: true } })) })
const ARCHIVED = { legacyArchive: { $exists: true } }

async function present(db: Db): Promise<Set<string>> {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name))
}

interface Holders { archived: number; leftover: number }
interface Sets { name: string; present: boolean; mine: number; others: number }

async function holders(db: Db, here: Set<string>, name: string, fields: readonly string[], orgFilter: Record<string, unknown>): Promise<Holders> {
  if (!here.has(name)) return { archived: 0, leftover: 0 }
  return {
    archived: await db.collection(name).countDocuments({ ...orgFilter, ...ARCHIVED }),
    leftover: await db.collection(name).countDocuments({ ...orgFilter, ...hasAny(fields) }),
  }
}

async function sets(db: Db, here: Set<string>, name: string, orgFilter: Record<string, unknown>): Promise<Sets> {
  if (!here.has(name)) return { name, present: false, mine: 0, others: 0 }
  const mine = await db.collection(name).countDocuments(orgFilter)
  return { name, present: true, mine, others: (await db.collection(name).countDocuments({})) - mine }
}

/** One update per collection: the archive and every leftover field, unset together. */
async function unsetLegacy(db: Db, name: string, fields: readonly string[], orgFilter: Record<string, unknown>): Promise<number> {
  const unset: Record<string, ''> = {}
  for (const f of ['legacyArchive', ...fields]) unset[f] = ''
  const filter = { ...orgFilter, $or: [ARCHIVED, ...hasAny(fields).$or] }
  return (await db.collection(name).updateMany(filter, { $unset: unset })).modifiedCount
}

export const legacyAccessArchiveDrop: Migration = {
  id: '0020-legacy-access-archive-drop',
  description: 'The legacy access archive goes: legacyArchive and any leftover legacy field on users and invites are unset; permissionsets_archive and permissionsets lose the orgs of this node, and are dropped once empty (FR-27 P3-9)',
  async preview({ db, orgFilter }: MigrationContext) {
    const here = await present(db)
    const users = await holders(db, here, 'users', USER_FIELDS, orgFilter)
    const invites = await holders(db, here, 'invites', INVITE_FIELDS, orgFilter)
    const collections = [await sets(db, here, SETS_ARCHIVE, orgFilter), await sets(db, here, 'permissionsets', orgFilter)]
    const changes = users.archived + users.leftover + invites.archived + invites.leftover
      + collections.filter(c => c.present && (c.mine || !c.others)).length
    if (!changes) return ['nothing to change']
    return [
      `users: ${users.archived} with legacyArchive to unset; ${users.leftover} with a leftover legacy field (${USER_FIELDS.join(', ')}) to unset`,
      `invites: ${invites.archived} with legacyArchive to unset; ${invites.leftover} with a leftover legacy field (${INVITE_FIELDS.join(', ')}) to unset`,
      ...collections.map(c => (!c.present
        ? `${c.name}: not there`
        : `${c.name}: ${c.mine} to delete; ${c.others ? `kept, ${c.others} of other orgs left in it` : 'then empty, dropped'}`)),
    ]
  },
  async up({ db, log, orgFilter }) {
    const here = await present(db)
    const users = here.has('users') ? await unsetLegacy(db, 'users', USER_FIELDS, orgFilter) : 0
    const invites = here.has('invites') ? await unsetLegacy(db, 'invites', INVITE_FIELDS, orgFilter) : 0

    const deleted: string[] = []
    const dropped: string[] = []
    for (const name of SET_COLLECTIONS) {
      if (!here.has(name)) continue
      deleted.push(`${(await db.collection(name).deleteMany(orgFilter)).deletedCount} from ${name}`)
      // Shared by every org of the node: dropped only when no other org's documents are left in it.
      if (!(await db.collection(name).countDocuments({}, { limit: 1 }))) {
        await db.collection(name).drop()
        dropped.push(name)
      }
    }
    log(`legacy access archive dropped: ${users} user(s), ${invites} invite(s); deleted ${deleted.join(', ') || 'no set'}; dropped ${dropped.join(', ') || 'no collection'}`)
  },
}
