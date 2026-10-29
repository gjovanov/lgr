/**
 * FR-20.18 (#350) — what a master's setup console needs to know from the API, asked over the
 * control socket (`GET /setup`), which only the supervisor reaches.
 *
 * - **The orgs homed here**, each with its owner and its admins: setup's last step makes them
 *   `BACKUP_SYS_ADMINS` ("the first admin, so restore works"), and refuses to finish while there is
 *   none (an Air-gapped master creates one on the console; a linked one has it moved here).
 * - **How many desktops are paired**: the page warns before finishing with none, since after setup
 *   only a paired till (or `lgr-server setup reset`) can pair another.
 *
 * ⚠ Addresses and an active flag only: never a password hash, a token, or anything a page could
 * replay. The console shows these to the person who holds the setup token, on the server itself.
 */
import { Desktop, Org, User } from 'db/models'
import { homeScope } from 'db/home/home'

export type SetupPerson = { email: string; active: boolean }
export type SetupOrg = { id: string; name: string; slug: string; owner: SetupPerson | null; admins: SetupPerson[] }
export type SetupFacts = { orgs: SetupOrg[]; desktops: number }

export async function setupFacts(): Promise<SetupFacts> {
  const orgs = await Org.find(await homeScope('_id'), { name: 1, slug: 1, ownerId: 1 }).lean().exec()
  if (!orgs.length) return { orgs: [], desktops: 0 }
  const ids = orgs.map(o => o._id)
  const owners = orgs.map(o => (o as any).ownerId).filter(Boolean)
  // The oldest first: when an org's owner is gone, its first admin stands in (`setup.rs`).
  const people = await User.find(
    { orgId: { $in: ids }, $or: [{ _id: { $in: owners } }, { role: 'admin' }] },
    { orgId: 1, email: 1, isActive: 1, role: 1, createdAt: 1 },
  )
    .sort({ createdAt: 1 })
    .lean()
    .exec()
  const desktops = await Desktop.countDocuments({ status: 'active', orgId: { $in: ids } }).exec()
  const person = (p: any): SetupPerson => ({ email: String(p.email ?? ''), active: !!p.isActive })
  return {
    orgs: orgs.map((o: any) => {
      const owner = o.ownerId ? people.find((p: any) => String(p._id) === String(o.ownerId)) : undefined
      return {
        id: String(o._id),
        name: o.name,
        slug: o.slug,
        owner: owner ? person(owner) : null,
        admins: people.filter((p: any) => String(p.orgId) === String(o._id) && p.role === 'admin').map(person),
      }
    }),
    desktops,
  }
}
