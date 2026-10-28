import { createHash, randomBytes } from 'crypto'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS, type Role } from 'config/constants'
import { AuthToken, Identity, Org, PermissionSet, User, type IIdentity, type IOrg, type IUser } from 'db/models'
import { homeNewOrg, homeScope, isHomeHere, unhomeNewOrg } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { inviteDao } from '../../dao/invite.dao.js'
import { sendEmail } from '../email.service.js'
import { allocateOperatorCode } from '../sequence.service.js'
import { defaultOrgSettings, provisionNewOrg } from '../auth.service.js'
import { IdentityError } from './identity.service.js'
import { normalizeEmail } from './email.js'
import { forgetIdentity, verifyPassword } from './session.service.js'
import { isLinkedMaster } from '../node/link.js'

/**
 * The person's own account (multi-org sign-in, Phase 4): their password, and the orgs they join or
 * found themselves.
 *
 * Rule 3 runs through all of it: **joining or founding another org needs a credential the person
 * owns.** A password an admin set, or one the migration carried over, may be known to someone else;
 * carrying it into a new org would extend that someone's reach. So those paths refuse with
 * `own_password_required` until the person changes the password (or resets it by email). A person
 * who signs in with a provider only (no password, a confirmed link) owns their credential already.
 */

/** Rule 3: the person's password is their own choice, or they sign in by a confirmed provider only. */
export function hasOwnCredential(identity: Pick<IIdentity, 'password' | 'passwordSetBy' | 'oauthProviders'>): boolean {
  if (identity.password) return identity.passwordSetBy === 'self'
  return (identity.oauthProviders ?? []).some(l => l.verified)
}

/**
 * Set a password the person chose (a change or a reset): it becomes theirs (`passwordSetBy: self`),
 * every session they hold ends (`tokenVersion`), and the legacy per-org copy follows on every
 * membership so a rollback still signs them in.
 */
async function setOwnPassword(identityId: unknown, hash: string, extra: Record<string, unknown> = {}): Promise<void> {
  await Identity.updateOne(
    { _id: identityId },
    {
      $set: { password: hash, passwordSetBy: 'self', passwordChangedAt: new Date(), ...extra },
      $unset: { passwordSetByOrgId: 1 },
      $inc: { tokenVersion: 1 },
    },
  ).exec()
  // FR-20.5: only the memberships of orgs whose home is here; a master updates its own copies from
  // the identity feed. Without the scope the write guard would refuse the whole fan-out, AFTER the
  // identity above was already changed.
  await User.updateMany({ identityId, ...(await homeScope()) }, { $set: { password: hash } }).exec()
  forgetIdentity(identityId)
}

// ── Change ──────────────────────────────────────────────────────────────────────────────────

/** Change the password, proving the current one. Returns the person as they are now (new `tokenVersion`). */
export async function changePassword(identityId: unknown, current: string, next: string): Promise<IIdentity> {
  // FR-20.42: on a linked master the password is lgrai.app's (and a local one is set there too).
  if (isLinkedMaster()) throw new IdentityError('edit_on_lgrai')
  const identity = await Identity.findById(identityId).select('+password').exec()
  if (!identity) throw new IdentityError('wrong_password')
  if (!identity.password) throw new IdentityError('no_password')
  if (!(await verifyPassword(current, identity.password))) throw new IdentityError('wrong_password')
  await setOwnPassword(identityId, await Bun.password.hash(next))
  return (await Identity.findById(identityId).exec())!
}

// ── Forgot and reset ────────────────────────────────────────────────────────────────────────

const RESET_TTL_MS = 60 * 60_000
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** The link a reset email carries. The token rides in the FRAGMENT: never sent to a server or logged. */
export function resetUrl(token: string): string {
  return `${config.email.appUrl}/auth/reset-password#token=${encodeURIComponent(token)}`
}

/**
 * Mail a reset link to the person with this address, if there is one. The caller answers the same
 * whatever happens here, so it cannot be used to learn who has an account; that is also why this
 * resolves to nothing and never throws for an unknown address.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  // FR-20.42: on a linked master a reset is lgrai.app's; the route says so before it gets here.
  if (isLinkedMaster()) return
  const identity = await Identity.findOne({ email: normalizeEmail(email) }).exec()
  if (!identity) return

  const token = randomBytes(32).toString('base64url')
  await AuthToken.create({
    purpose: 'password_reset',
    identityId: identity._id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  })

  const locale = await localeOf(identity)
  const text = RESET_EMAIL[locale] ?? RESET_EMAIL.en
  const url = resetUrl(token)
  const result = await sendEmail({
    to: identity.email,
    subject: text.subject,
    html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
<p>${esc(text.intro.replace('{email}', identity.email))}</p>
<p style="margin: 32px 0;">
  <a href="${url}" style="background:#1976d2;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">${esc(text.button)}</a>
</p>
<p style="color:#666;font-size:13px;">${esc(text.ignore)}</p>
</div>`,
  }).catch(err => {
    logger.warn({ err, identityId: identity._id }, 'Failed to send a password reset email')
    return null
  })
  // With no SendGrid key (local dev) the link would exist nowhere a developer can reach. Never in
  // production: there a missing key is a misconfiguration, and a log is no place for a credential.
  if (result && !result.ok && result.reason === 'not_configured' && process.env.NODE_ENV !== 'production') {
    logger.warn({ to: identity.email, resetUrl: url }, 'Email not configured — reset link for local use')
  }
}

/**
 * Use a reset link: the password becomes the person's own, and the address is proven (they read
 * the mail), so a person still waiting for activation is live, with the memberships that waited
 * with them. Every other session and every other open link of theirs ends.
 */
export async function resetPassword(token: string, next: string): Promise<void> {
  if (isLinkedMaster()) throw new IdentityError('edit_on_lgrai')
  const now = new Date()
  const row = await AuthToken.findOneAndUpdate(
    { tokenHash: hashToken(token), purpose: 'password_reset', usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true },
  ).exec()
  if (!row) throw new IdentityError('reset_invalid')

  await setOwnPassword(row.identityId, await Bun.password.hash(next), { isActive: true, emailVerified: true, emailVerifiedAt: now })
  await User.updateMany({ identityId: row.identityId, isActive: false, deactivatedAt: null, ...(await homeScope()) }, { $set: { isActive: true } }).exec()
  await AuthToken.updateMany({ identityId: row.identityId, purpose: 'password_reset', usedAt: null }, { $set: { usedAt: now } }).exec()
}

// ── Joining and founding ────────────────────────────────────────────────────────────────────

/**
 * Accept an invitation as the signed-in person: a new membership in the invite's org, with the
 * invite's role. The invite is consumed BEFORE the membership is created (`incrementUseCount` is
 * the atomic check that the last use is ours, the S-17 pattern) and given back if creating fails.
 */
export async function joinOrgByInvite(identityId: unknown, code: string): Promise<{ member: IUser; org: IOrg }> {
  const identity = await Identity.findById(identityId).select('+password').exec()
  const invite = await inviteDao.findByCode(code)
  if (!identity || !invite) throw new IdentityError('invite_invalid')
  if (!inviteDao.validate(invite).valid) throw new IdentityError('invite_invalid')
  if (invite.targetEmail && normalizeEmail(invite.targetEmail) !== identity.email) throw new IdentityError('invite_for_other_email')
  if (!hasOwnCredential(identity)) throw new IdentityError('own_password_required')

  const org = await Org.findById(invite.orgId).exec()
  if (!org) throw new IdentityError('invite_invalid')
  // FR-20.5: never a membership in an org whose home is elsewhere; joining it is carried to its master.
  if (!(await isHomeHere(org._id))) throw new IdentityError('org_home_elsewhere')
  const existing = await User.findOne({ identityId: identity._id, orgId: org._id }).exec()
  if (existing) throw new IdentityError(existing.isActive ? 'already_member' : 'membership_deactivated')
  // Before the migration, the person may still be an unlinked user of that org.
  if (await User.exists({ orgId: org._id, email: identity.email }).collation({ locale: 'en', strength: 2 }).exec()) {
    throw new IdentityError('already_member')
  }

  const claimed = await inviteDao.incrementUseCount(String(invite._id))
  if (!claimed) throw new IdentityError('invite_invalid')
  try {
    const member = await createMembership(identity, org, (invite.assignRole || 'member') as Role)
    return { member, org }
  } catch (err) {
    await inviteDao.releaseUse(String(invite._id)).catch(() => undefined)
    throw err
  }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Found an org as the signed-in person, who becomes its admin. */
export async function createOrgForPerson(
  identityId: unknown,
  input: { name: string; slug: string; baseCurrency?: string; locale?: string },
): Promise<{ member: IUser; org: IOrg }> {
  const identity = await Identity.findById(identityId).select('+password').exec()
  if (!identity) throw new IdentityError('own_password_required')
  if (!hasOwnCredential(identity)) throw new IdentityError('own_password_required')
  const slug = input.slug.trim().toLowerCase()
  if (!SLUG.test(slug)) throw new IdentityError('slug_taken', 'An organization address uses lowercase letters, digits and dashes.')
  if (await Org.exists({ slug }).exec()) throw new IdentityError('slug_taken')

  let org: IOrg
  try {
    org = await Org.create({
      name: input.name.trim(),
      slug,
      settings: defaultOrgSettings({ baseCurrency: input.baseCurrency, locale: input.locale }),
      subscription: { plan: 'free', maxUsers: 5 },
    })
  } catch (err: any) {
    if (err?.code === 11000) throw new IdentityError('slug_taken')
    throw err
  }
  let member: IUser | undefined
  try {
    // FR-20.18: on a master the new org is the master's, before any write for it.
    await homeNewOrg(org._id)
    member = await createMembership(identity, org, 'admin')
    await provisionNewOrg(org, member)
    return { member, org }
  } catch (err) {
    if (member) await User.deleteOne({ _id: member._id }).catch(() => undefined)
    await Org.deleteOne({ _id: org._id }).catch(() => undefined)
    await unhomeNewOrg(org._id).catch(() => undefined)
    throw err
  }
}

/**
 * A membership for an existing person: their address and names, the operator code a POS receipt
 * is printed under, the start of their role history (Н-18), the org's default permission set, and
 * a username free in that org. Its legacy password copy is the person's own hash.
 */
async function createMembership(identity: IIdentity, org: IOrg, role: Role): Promise<IUser> {
  const operatorCode = await allocateOperatorCode(String(org._id))
  const hash = identity.password // the legacy per-org copy is the person's own hash
  const member = await User.create({
    email: identity.email,
    username: await freeUsername(org._id, await preferredUsername(identity)),
    password: hash,
    identityId: identity._id,
    firstName: identity.firstName,
    middleName: identity.middleName,
    lastName: identity.lastName,
    avatar: identity.avatar,
    role,
    operatorCode,
    orgId: org._id,
    isActive: true,
    permissions: DEFAULT_ROLE_PERMISSIONS[role] || DEFAULT_ROLE_PERMISSIONS.member,
    roleHistory: [{ role, startDate: new Date(), assignedAt: new Date() }],
  })
  if (role !== 'admin') {
    const defaultSet = await PermissionSet.findOne({ orgId: org._id, isDefault: true }).exec()
    if (defaultSet) {
      member.permissionSetIds = [defaultSet._id]
      await member.save()
    }
  }
  return member
}

/** The name the person already goes by in another org, else their address's local part. */
async function preferredUsername(identity: IIdentity): Promise<string> {
  const other = await User.findOne({ identityId: identity._id }, { username: 1 }).sort({ createdAt: 1 }).lean().exec()
  const base = other?.username || identity.email.split('@')[0]
  return base.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'user'
}

/** `base`, or `base2`, `base3`… whichever is free in this org (usernames are unique per org). */
async function freeUsername(orgId: unknown, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}${n}`
    if (!(await User.exists({ orgId, username: candidate }).exec())) return candidate
  }
  return `${base}-${randomBytes(3).toString('hex')}`
}

// ── The reset email ─────────────────────────────────────────────────────────────────────────

type Locale = 'en' | 'bg' | 'de' | 'mk'

/** The language of the org the person was last in, else their first org's, else English. */
async function localeOf(identity: IIdentity): Promise<Locale> {
  const orgId = identity.lastOrgId ?? (await User.findOne({ identityId: identity._id }, { orgId: 1 }).lean().exec())?.orgId
  const org = orgId ? await Org.findById(orgId, { 'settings.locale': 1 }).lean().exec() : null
  const locale = (org as any)?.settings?.locale
  return locale && locale in RESET_EMAIL ? (locale as Locale) : 'en'
}

const RESET_EMAIL: Record<Locale, { subject: string; intro: string; button: string; ignore: string }> = {
  en: {
    subject: 'Reset your LGR password',
    intro: 'Someone (hopefully you) asked to reset the password of your LGR account {email}. The link works once, for 60 minutes:',
    button: 'Choose a new password',
    ignore: 'If you did not ask for this, ignore this email. Your password stays as it is.',
  },
  bg: {
    subject: 'Нулиране на паролата за LGR',
    intro: 'Някой (надяваме се вие) поиска нулиране на паролата за вашия LGR акаунт {email}. Връзката работи веднъж, в рамките на 60 минути:',
    button: 'Изберете нова парола',
    ignore: 'Ако не сте поискали това, игнорирайте този имейл. Паролата ви остава непроменена.',
  },
  de: {
    subject: 'LGR-Passwort zurücksetzen',
    intro: 'Jemand (hoffentlich Sie) hat angefordert, das Passwort Ihres LGR-Kontos {email} zurückzusetzen. Der Link funktioniert einmal, 60 Minuten lang:',
    button: 'Neues Passwort wählen',
    ignore: 'Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail. Ihr Passwort bleibt unverändert.',
  },
  mk: {
    subject: 'Ресетирање на лозинката за LGR',
    intro: 'Некој (се надеваме вие) побара ресетирање на лозинката за вашата LGR сметка {email}. Врската работи еднаш, 60 минути:',
    button: 'Изберете нова лозинка',
    ignore: 'Ако не сте го побарале ова, игнорирајте ја оваа порака. Лозинката останува иста.',
  },
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
