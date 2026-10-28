import type { Types } from 'mongoose'
import { Identity, User } from 'db/models'
import { normalizeEmail } from './identity.service.js'

/**
 * Phase 1 of the multi-org sign-in: give every existing `User` an `Identity`.
 *
 * Today a person who works in two orgs has two unrelated `User` documents, often with different
 * usernames and, for password users, possibly different passwords. The migration groups users by
 * normalised email. That is the one key the data offers, and it is NOT proof that two rows are the
 * same human, which is why the rules below are what they are:
 *
 *   - **A user alone at their email** becomes an identity carrying their own password hash
 *     (`passwordSetBy: 'legacy'`). Nothing about who can sign in changes.
 *   - **Several users at one email** (the people this is for) become ONE identity with **no
 *     password**, unless the operator names the org whose password to keep (`keepPassword`). An
 *     email is not proof of a person. Had an admin of another org created an account with someone's
 *     address and a password that admin knows, carrying that password onto the merged identity
 *     would hand them the victim's other orgs. With no password, whoever controls the email
 *     (a reset link) or the verified provider account signs in.
 *   - **OAuth links are copied as `verified: false`.** Before S-20 an unverified provider email was
 *     enough to link, so an old link proves nothing until a sign-in re-confirms it.
 *     **Microsoft links are dropped**: its `/common` `mail`/UPN is settable by any tenant admin.
 *   - **A provider account linked under two different emails** is contested. It is dropped from
 *     both, rather than awarding one person's Google account to the other. An identity that
 *     already exists keeps a link it holds; the run only drops it from what it creates.
 *   - **A merged identity gets no `lastOrgId`**, so its first sign-in shows the org picker instead
 *     of landing in an org nobody chose (a planted membership must never be the default).
 *
 * Dropping links and passwords can leave someone with no way in at all; the plan flags each of
 * them (`no-sign-in-method`) so the operator decides before `--execute`, not after a lockout.
 *
 * The planner is pure; `loadMigrationInput`, `executeIdentityMigration` and
 * `rollbackIdentityMigration` do the I/O. Driven by `scripts/migrate-identities.ts`.
 */

// One definition of "the same address", shared with every write path.
export { normalizeEmail }

/** The fields of a `User` the planner reads. */
export interface MigrationUser {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  email: string
  username: string
  firstName: string
  middleName?: string
  lastName: string
  avatar?: string
  password?: string
  oauthProviders?: Array<{ provider: string; providerId: string }>
  isActive: boolean
  deactivatedAt?: Date
  lastLoginAt?: Date
  createdAt?: Date
  identityId?: Types.ObjectId
}

export type PlanFlag =
  | 'multi-org'
  | 'names-differ'
  | 'no-password'
  | 'kept-password'
  | 'pending-activation'
  | 'microsoft-link-dropped'
  | 'contested-link-dropped'
  /** No password and no provider link left: only a password reset gets them in. */
  | 'no-sign-in-method'

export interface PlannedIdentity {
  email: string
  userIds: Types.ObjectId[]
  orgIds: Types.ObjectId[]
  usernames: string[]
  /** The hash to carry, and whose it was. */
  password?: string
  passwordFromUserId?: Types.ObjectId
  oauthProviders: Array<{ provider: string; providerId: string; verified: false }>
  firstName: string
  middleName?: string
  lastName: string
  avatar?: string
  isActive: boolean
  lastOrgId?: Types.ObjectId
  lastLoginAt?: Date
  flags: PlanFlag[]
}

export interface MigrationPlan {
  identities: PlannedIdentity[]
  /** Users the planner refused to place, and why. Nothing is done with them. */
  conflicts: Array<{ email: string; reason: string; userIds: string[] }>
  /** One provider account linked under several emails; dropped from all of them. */
  contestedLinks: Array<{ provider: string; providerId: string; emails: string[] }>
  /** A username used by more than one future identity: those people sign in by email or org. */
  usernameCollisions: Array<{ username: string; emails: string[] }>
  /** Users that already have an identity (a previous run). */
  alreadyLinked: number
}

export interface PlanOptions {
  /** normalised email → the org whose user's password the merged identity keeps. */
  keepPassword?: Map<string, string>
  /** Emails that already have an identity: their unlinked users are a conflict, never auto-linked. */
  existingIdentityEmails?: Set<string>
  /** Provider links existing identities hold (`linkKey` → that identity's email). They stay there. */
  existingLinks?: Map<string, string>
}

const linkKey = (provider: string, providerId: string) => `${provider}\u0000${providerId}`

const isEmail = (e: string) => /^[^\s@]+@[^\s@]+$/.test(e)
/** An account that was never activated, as opposed to one an admin deactivated. */
const neverActivated = (u: MigrationUser) => u.isActive === false && !u.deactivatedAt
const time = (d?: Date) => (d ? new Date(d).getTime() : 0)

export function planIdentityMigration(users: MigrationUser[], opts: PlanOptions = {}): MigrationPlan {
  const plan: MigrationPlan = { identities: [], conflicts: [], contestedLinks: [], usernameCollisions: [], alreadyLinked: 0 }
  const keep = opts.keepPassword ?? new Map<string, string>()
  const existing = opts.existingIdentityEmails ?? new Set<string>()

  // Group the unlinked users by normalised email.
  const groups = new Map<string, MigrationUser[]>()
  for (const u of users) {
    if (u.identityId) {
      plan.alreadyLinked++
      continue
    }
    const email = normalizeEmail(u.email)
    if (!isEmail(email)) {
      plan.conflicts.push({ email: u.email, reason: 'not a usable email address', userIds: [String(u._id)] })
      continue
    }
    const list = groups.get(email) ?? []
    list.push(u)
    groups.set(email, list)
  }

  for (const [email, members] of [...groups]) {
    if (existing.has(email)) {
      plan.conflicts.push({
        email,
        reason: 'an identity already exists for this email; these unlinked users were left alone',
        userIds: members.map(m => String(m._id)),
      })
      groups.delete(email)
    }
  }

  // A provider account linked under more than one email is contested: nobody this run creates
  // gets it. An existing identity counts as an owner, so a link it holds is never planned twice.
  const linkOwners = new Map<string, Set<string>>()
  for (const [key, email] of opts.existingLinks ?? []) linkOwners.set(key, new Set([email]))
  for (const [email, members] of groups) {
    for (const m of members) {
      for (const p of m.oauthProviders ?? []) {
        if (!p?.provider || !p?.providerId || p.provider === 'microsoft') continue
        const key = linkKey(p.provider, p.providerId)
        const owners = linkOwners.get(key) ?? new Set<string>()
        owners.add(email)
        linkOwners.set(key, owners)
      }
    }
  }
  const contested = new Set<string>()
  for (const [key, owners] of linkOwners) {
    if (owners.size > 1) {
      contested.add(key)
      const [provider, providerId] = key.split('\u0000')
      plan.contestedLinks.push({ provider, providerId, emails: [...owners].sort() })
    }
  }

  for (const email of [...groups.keys()].sort()) {
    const members = groups.get(email)!
    const flags: PlanFlag[] = []
    const multi = members.length > 1
    if (multi) flags.push('multi-org')

    // The profile comes from the account used most recently.
    const latest = [...members].sort((a, b) => time(b.lastLoginAt) - time(a.lastLoginAt) || time(b.createdAt) - time(a.createdAt))[0]
    const names = new Set(members.map(m => `${m.firstName} ${m.lastName}`.trim().toLowerCase()))
    if (names.size > 1) flags.push('names-differ')

    // Provider links: copied unverified, Microsoft and contested ones dropped, duplicates merged.
    const links = new Map<string, { provider: string; providerId: string; verified: false }>()
    for (const m of members) {
      for (const p of m.oauthProviders ?? []) {
        if (!p?.provider || !p?.providerId) continue
        if (p.provider === 'microsoft') {
          if (!flags.includes('microsoft-link-dropped')) flags.push('microsoft-link-dropped')
          continue
        }
        const key = linkKey(p.provider, p.providerId)
        if (contested.has(key)) {
          if (!flags.includes('contested-link-dropped')) flags.push('contested-link-dropped')
          continue
        }
        links.set(key, { provider: p.provider, providerId: p.providerId, verified: false })
      }
    }

    // The password.
    let password: string | undefined
    let passwordFromUserId: Types.ObjectId | undefined
    if (!multi) {
      password = members[0].password || undefined
      passwordFromUserId = password ? members[0]._id : undefined
    } else {
      const keepOrg = keep.get(email)
      if (keepOrg) {
        const source = members.find(m => String(m.orgId) === keepOrg)
        if (!source || !source.password) {
          plan.conflicts.push({
            email,
            reason: source
              ? 'keep-password names a user with no password; merged without one'
              : 'keep-password names an org this email has no user in; merged without one',
            userIds: members.map(m => String(m._id)),
          })
        } else {
          password = source.password
          passwordFromUserId = source._id
          flags.push('kept-password')
        }
      }
    }
    if (!password) flags.push('no-password')
    if (!password && links.size === 0) flags.push('no-sign-in-method')

    // Pending activation only if nobody in the group ever activated.
    const isActive = members.some(m => !neverActivated(m))
    if (!isActive) flags.push('pending-activation')

    plan.identities.push({
      email,
      userIds: members.map(m => m._id),
      orgIds: members.map(m => m.orgId),
      usernames: [...new Set(members.map(m => m.username))].sort(),
      password,
      passwordFromUserId,
      oauthProviders: [...links.values()],
      firstName: latest.firstName,
      middleName: latest.middleName,
      lastName: latest.lastName,
      avatar: latest.avatar,
      isActive,
      // Only a single membership is a choice the person made; a merge waits for the picker.
      lastOrgId: multi ? undefined : members[0].orgId,
      lastLoginAt: members.map(m => m.lastLoginAt).filter(Boolean).sort((a, b) => time(b) - time(a))[0],
      flags,
    })
  }

  // Usernames shared by different future identities cannot sign anyone in on their own.
  const byUsername = new Map<string, Set<string>>()
  for (const id of plan.identities) {
    for (const name of id.usernames) {
      const set = byUsername.get(name) ?? new Set<string>()
      set.add(id.email)
      byUsername.set(name, set)
    }
  }
  for (const [username, emails] of byUsername) {
    if (emails.size > 1) plan.usernameCollisions.push({ username, emails: [...emails].sort() })
  }
  plan.usernameCollisions.sort((a, b) => a.username.localeCompare(b.username))

  return plan
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────

export async function loadMigrationInput(): Promise<{
  users: MigrationUser[]
  existingIdentityEmails: Set<string>
  existingLinks: Map<string, string>
}> {
  const users = (await User.find({})
    .select('+password orgId email username firstName middleName lastName avatar password oauthProviders isActive deactivatedAt lastLoginAt createdAt identityId')
    .lean()
    .exec()) as unknown as MigrationUser[]
  const existing = await Identity.find({}).select('email oauthProviders').lean().exec()
  const existingLinks = new Map<string, string>()
  for (const e of existing) for (const l of e.oauthProviders ?? []) existingLinks.set(linkKey(l.provider, l.providerId), e.email)
  return { users, existingIdentityEmails: new Set(existing.map(e => e.email)), existingLinks }
}

export interface ExecuteResult {
  runId: string
  created: number
  linked: number
  /** Users an identity was planned for but that another identity claimed first; left as they are. */
  skippedUsers: number
  failed: Array<{ email: string; error: string }>
}

/**
 * Create the planned identities and link their users. Each identity is its own unit: one that
 * fails (an email taken since the plan was made) is reported and the rest carry on. A user that
 * gained an identity in the meantime is never re-pointed (`identityId: { $exists: false }`), and
 * an identity that ends up linking nobody is removed again rather than left behind empty (its
 * email would otherwise block every later run).
 */
export async function executeIdentityMigration(plan: MigrationPlan, runId: string): Promise<ExecuteResult> {
  const result: ExecuteResult = { runId, created: 0, linked: 0, skippedUsers: 0, failed: [] }
  const discard = async (identityId: Types.ObjectId) => {
    await User.updateMany({ identityId }, { $unset: { identityId: 1 } }).exec()
    await Identity.deleteOne({ _id: identityId }).exec()
  }
  for (const p of plan.identities) {
    let identityId: Types.ObjectId | undefined
    try {
      const now = new Date()
      const identity = await Identity.create({
        email: p.email,
        emailVerified: false,
        password: p.password,
        passwordSetBy: p.password ? 'legacy' : undefined,
        tokenVersion: 0,
        oauthProviders: p.oauthProviders.map(l => ({ ...l, linkedAt: now })),
        firstName: p.firstName,
        middleName: p.middleName,
        lastName: p.lastName,
        avatar: p.avatar,
        isActive: p.isActive,
        lastOrgId: p.lastOrgId,
        lastLoginAt: p.lastLoginAt,
        migration: { runId, sourceUserIds: p.userIds },
      })
      identityId = identity._id
      const linked = await User.updateMany(
        { _id: { $in: p.userIds }, identityId: { $exists: false } },
        { $set: { identityId: identity._id } },
      ).exec()
      if (linked.modifiedCount === 0) {
        await discard(identity._id)
        result.failed.push({ email: p.email, error: 'every user was linked to another identity after the plan was made; nothing created' })
        continue
      }
      result.created++
      result.linked += linked.modifiedCount
      result.skippedUsers += p.userIds.length - linked.modifiedCount
    } catch (err: any) {
      // A half-done identity (created, linking failed part-way) is undone so a re-run can retry it.
      if (identityId) await discard(identityId).catch(() => undefined)
      result.failed.push({ email: p.email, error: err?.code === 11000 ? 'duplicate key (email or provider link taken)' : String(err?.message ?? err) })
    }
  }
  return result
}

/** Undo one run: unlink its users (only where it linked them) and delete its identities. */
export async function rollbackIdentityMigration(runId: string): Promise<{ removed: number; unlinked: number }> {
  const identities = await Identity.find({ 'migration.runId': runId }).select('_id migration').lean().exec()
  let unlinked = 0
  for (const id of identities) {
    const res = await User.updateMany(
      { _id: { $in: id.migration?.sourceUserIds ?? [] }, identityId: id._id },
      { $unset: { identityId: 1 } },
    ).exec()
    unlinked += res.modifiedCount
  }
  const removed = await Identity.deleteMany({ 'migration.runId': runId }).exec()
  return { removed: removed.deletedCount ?? 0, unlinked }
}
