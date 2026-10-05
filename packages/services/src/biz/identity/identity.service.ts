import { Identity, User, type IIdentity, type IUser, type PasswordSetBy } from 'db/models'
import type { Types } from 'mongoose'
import { logger } from '../../logger/logger.js'

/**
 * The person behind every org membership (multi-org sign-in, Phase 1B).
 *
 * Phase 1A gave every existing `User` an `Identity` by migration. This module keeps them in step:
 * every path that creates a user either creates the person's identity with it or, where the person
 * has proven who they are, attaches the new membership to the identity they already have; every
 * path that edits a credential or a name edits the identity.
 *
 * **An org admin never controls the credentials of someone who also works in another org.** An
 * admin of org A who could set the password of a person also in org B would have org B. So:
 *   - creating a user at an address that is already someone's is refused (`identity_exists`);
 *     the person is invited instead, and joins by proving it is them;
 *   - the password, email and name of a person with an active membership elsewhere are refused
 *     to an org admin (`identity_shared`). Role, permissions, position and username stay per org.
 *
 * **Before the migration has run** a person may still be unlinked `User` rows. An address counts
 * as taken when ANY user has it, and a consented join that finds such rows leaves the new
 * membership unlinked for the migration to group: an identity made now would split the person in
 * two (the migration never links users to an identity that already exists).
 */

export function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase()
}

export type IdentityRefusal = 'identity_exists' | 'account_exists' | 'identity_shared' | 'email_taken' | 'unverified_email'

const REFUSALS: Record<IdentityRefusal, { status: number; message: string }> = {
  identity_exists: {
    status: 409,
    message: 'This person already has an LGR account. Invite them to this organization instead.',
  },
  account_exists: { status: 409, message: 'This email already has an LGR account. Sign in with it instead.' },
  identity_shared: {
    status: 403,
    message: 'This person also works in another organization, so only they can change their password, email or name.',
  },
  email_taken: { status: 409, message: 'This email address is already in use.' },
  unverified_email: {
    status: 403,
    message: 'Your sign-in provider did not confirm this email address. Sign up with a password instead.',
  },
}

/** A refusal the HTTP layer answers with `status` and `{ code, message }`. */
export class IdentityError extends Error {
  readonly status: number
  constructor(readonly code: IdentityRefusal, message = REFUSALS[code].message) {
    super(message)
    this.status = REFUSALS[code].status
  }
}

/** User emails are stored as typed (older rows) or normalised (newer): compare without case. */
const ANY_CASE = { locale: 'en', strength: 2 } as const

/**
 * Is this address already someone's: an identity, or (until the migration has run) any user in
 * any org? `except` leaves out the person being edited.
 */
export async function emailInUse(email: string, except: { userId?: unknown; identityId?: unknown } = {}): Promise<boolean> {
  const address = normalizeEmail(email)
  if (!address) return false
  const identityFilter: Record<string, unknown> = { email: address }
  if (except.identityId) identityFilter._id = { $ne: except.identityId }
  if (await Identity.exists(identityFilter).exec()) return true

  const userFilter: Record<string, unknown> = { email: address }
  if (except.userId) userFilter._id = { $ne: except.userId }
  if (except.identityId) userFilter.identityId = { $ne: except.identityId }
  return !!(await User.exists(userFilter).collation(ANY_CASE).exec())
}

/** Users of this address that the migration has not linked yet. */
async function hasUnlinkedUsers(email: string): Promise<boolean> {
  return !!(await User.exists({ email: normalizeEmail(email), identityId: { $exists: false } }).collation(ANY_CASE).exec())
}

export interface NewIdentity {
  email: string
  /** A hash, never the password. */
  password?: string
  passwordSetBy?: PasswordSetBy
  /** For `passwordSetBy: 'admin'`: the org whose admin chose it. */
  passwordSetByOrgId?: Types.ObjectId | string
  firstName: string
  middleName?: string
  lastName: string
  avatar?: string
  isActive: boolean
  emailVerified?: boolean
  /** The provider account the person signed up with: trusted, since it IS how they proved it. */
  oauthProvider?: { provider: string; providerId: string }
}

/** Create a person. An address or provider account that is already someone's is `refusal`. */
export async function createIdentity(fields: NewIdentity, refusal: IdentityRefusal): Promise<IIdentity> {
  const now = new Date()
  try {
    return await Identity.create({
      email: normalizeEmail(fields.email),
      emailVerified: !!fields.emailVerified,
      emailVerifiedAt: fields.emailVerified ? now : undefined,
      password: fields.password,
      passwordSetBy: fields.password ? fields.passwordSetBy : undefined,
      passwordSetByOrgId: fields.password && fields.passwordSetBy === 'admin' ? fields.passwordSetByOrgId : undefined,
      passwordChangedAt: fields.password ? now : undefined,
      tokenVersion: 0,
      oauthProviders: fields.oauthProvider ? [{ ...fields.oauthProvider, verified: true, linkedAt: now }] : [],
      firstName: fields.firstName,
      middleName: fields.middleName,
      lastName: fields.lastName,
      avatar: fields.avatar,
      isActive: fields.isActive,
    })
  } catch (err: any) {
    if (err?.code === 11000) throw new IdentityError(refusal)
    throw err
  }
}

/** Undo `createIdentity` when what it was for failed. Never throws: it runs on an error path. */
export async function discardIdentity(identityId: unknown): Promise<void> {
  await Identity.deleteOne({ _id: identityId })
    .exec()
    .catch(err => logger.warn({ err, identityId }, 'Could not remove an identity after a failed sign-up'))
}

/** Active memberships this person holds outside `orgId`. */
export async function activeMembershipsElsewhere(identityId: unknown, orgId: unknown): Promise<number> {
  return User.countDocuments({ identityId, orgId: { $ne: orgId }, isActive: true }).exec()
}

/** An org admin may set a person's password, email or name only while they work nowhere else. */
export async function canOrgAdminManageCredentials(identityId: unknown, orgId: unknown): Promise<boolean> {
  return (await activeMembershipsElsewhere(identityId, orgId)) === 0
}

/**
 * Add a provider account to a person, or mark one they already have as confirmed. A provider
 * account that already belongs to someone else stays with them (the unique index refuses it).
 */
export async function linkProviderToIdentity(identityId: unknown, link: { provider: string; providerId: string }): Promise<void> {
  const confirmed = await Identity.updateOne(
    { _id: identityId, oauthProviders: { $elemMatch: { provider: link.provider, providerId: link.providerId } } },
    { $set: { 'oauthProviders.$.verified': true } },
  ).exec()
  if (confirmed.matchedCount) return
  try {
    await Identity.updateOne(
      { _id: identityId },
      { $push: { oauthProviders: { provider: link.provider, providerId: link.providerId, verified: true, linkedAt: new Date() } } },
    ).exec()
  } catch (err: any) {
    if (err?.code !== 11000) throw err
    logger.warn({ identityId, provider: link.provider }, 'Provider account already belongs to another identity; not linked')
  }
}

export type OAuthJoin =
  | { kind: 'existing'; identity: IIdentity }
  | { kind: 'new' }
  | { kind: 'unlinked' }

/**
 * Who a CONSENTED OAuth join (an invite, accepted by signing in with a provider) is. Decided
 * before anything is consumed, so a refusal costs the invite nothing:
 *   - the provider account itself already belongs to a person: that person;
 *   - otherwise only an email the PROVIDER verified identifies anyone. An unverified one is
 *     refused outright: it would found a person on an address nobody proved, who could then
 *     claim it through a password reset while the provider link stayed attached (pre-hijacking);
 *   - a person with that address: them;
 *   - unlinked users of the address (before the migration): no identity yet;
 *   - else a new person.
 */
export async function resolveOAuthJoin(info: { provider: string; providerId: string; email: string; emailVerified: boolean }): Promise<OAuthJoin> {
  const byLink = await Identity.findOne({
    oauthProviders: { $elemMatch: { provider: info.provider, providerId: info.providerId } },
  }).exec()
  if (byLink) return { kind: 'existing', identity: byLink }
  if (!info.emailVerified) throw new IdentityError('unverified_email')

  const byEmail = await Identity.findOne({ email: normalizeEmail(info.email) }).exec()
  if (byEmail) return { kind: 'existing', identity: byEmail }
  if (await hasUnlinkedUsers(info.email)) return { kind: 'unlinked' }
  return { kind: 'new' }
}

/**
 * The identity an operator script's new membership belongs to (`scripts/seed-user.ts`,
 * `scripts/import-regal-pz.ts`): the operator is trusted, so an existing person is linked as they
 * are (credentials untouched); `null` while unlinked users of the address await the migration.
 */
export async function identityForOperatorJoin(fields: NewIdentity): Promise<IIdentity | null> {
  const existing = await Identity.findOne({ email: normalizeEmail(fields.email) }).exec()
  if (existing) return existing
  if (await hasUnlinkedUsers(fields.email)) return null
  return createIdentity(fields, 'identity_exists')
}

export interface AdminIdentityEdit {
  password?: string
  email?: string
  firstName?: string
  middleName?: string
  lastName?: string
}

/** What the caller writes onto the membership itself (the identity is already updated). */
export interface AppliedAdminEdit {
  /** The new hash, the same on the identity and every membership (the legacy copy). */
  passwordHash?: string
  email?: string
}

const changed = (next: string | undefined, current: string | undefined) =>
  next !== undefined && (next || undefined) !== (current || undefined)

/**
 * An org admin's edit of a member's password, email or name: refused for a person active in
 * another org, refused for an address that is someone else's, and otherwise applied to the
 * identity, which also bumps `tokenVersion` on a password change (ending the person's other
 * sessions) and mirrors onto every membership. An unlinked user (before the migration) is edited
 * as before: the caller writes the returned values onto the user alone.
 */
export async function applyAdminIdentityEdit(member: IUser, orgId: string, edit: AdminIdentityEdit): Promise<AppliedAdminEdit> {
  const emailChange = edit.email !== undefined && normalizeEmail(edit.email) !== normalizeEmail(member.email)
  const nameChange =
    changed(edit.firstName, member.firstName) || changed(edit.middleName, member.middleName) || changed(edit.lastName, member.lastName)
  if (!edit.password && !emailChange && !nameChange) return {}

  if (emailChange && (await emailInUse(edit.email!, { userId: member._id, identityId: member.identityId }))) {
    throw new IdentityError('email_taken')
  }
  if (member.identityId && !(await canOrgAdminManageCredentials(member.identityId, orgId))) {
    throw new IdentityError('identity_shared')
  }

  const passwordHash = edit.password ? await Bun.password.hash(edit.password) : undefined
  if (!member.identityId) return { passwordHash, email: emailChange ? edit.email : undefined }

  const now = new Date()
  const set: Record<string, unknown> = {}
  const mirror: Record<string, unknown> = {}
  const update: Record<string, unknown> = { $set: set }
  if (passwordHash) {
    Object.assign(set, { password: passwordHash, passwordSetBy: 'admin', passwordSetByOrgId: orgId, passwordChangedAt: now })
    update.$inc = { tokenVersion: 1 }
    mirror.password = passwordHash
  }
  const email = emailChange ? normalizeEmail(edit.email!) : undefined
  if (email) {
    // An admin-typed address is a claim, not a proof: it is unverified until the person confirms it.
    Object.assign(set, { email, emailVerified: false })
    update.$unset = { emailVerifiedAt: 1 }
    mirror.email = email
  }
  for (const field of ['firstName', 'middleName', 'lastName'] as const) {
    if (edit[field] !== undefined) {
      set[field] = edit[field]
      mirror[field] = edit[field]
    }
  }
  try {
    await Identity.updateOne({ _id: member.identityId }, update).exec()
  } catch (err: any) {
    if (err?.code === 11000) throw new IdentityError('email_taken')
    throw err
  }
  // The person's other memberships (deactivated ones, or none): the copies stay in step.
  await User.updateMany({ identityId: member.identityId, _id: { $ne: member._id } }, { $set: mirror }).exec()
  return { passwordHash, email }
}

/** The activation link proved the address: the person is live and their email verified. */
export async function completeActivation(member: IUser): Promise<void> {
  if (!member.identityId) return
  await Identity.updateOne(
    { _id: member.identityId },
    { $set: { isActive: true, emailVerified: true, emailVerifiedAt: new Date() } },
  ).exec()
}

/**
 * An org admin switched on a membership whose person never activated. Today that is how an
 * admin vouches for an invited member, so the person goes live too, but only while this org is
 * all they have: activating someone else's pending account elsewhere is not this admin's call.
 */
export async function adminActivated(member: IUser, orgId: string): Promise<void> {
  if (!member.identityId) return
  if (!(await canOrgAdminManageCredentials(member.identityId, orgId))) return
  await Identity.updateOne({ _id: member.identityId, isActive: false }, { $set: { isActive: true } }).exec()
}
