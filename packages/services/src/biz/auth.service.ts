import { Code, Identity, Org, User, OrgApp, PermissionSet, type IIdentity, type IOrg, type IUser } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, MODULES, APP_IDS, type Role } from 'config/constants'
import { config } from 'config'
import { logger } from '../logger/logger.js'
import { inviteDao } from '../dao/invite.dao.js'
import { codeDao } from '../dao/code.dao.js'
import { sendEmail } from './email.service.js'
import { seedDefaultPermissionSets } from './permission-set.seed.js'
import { allocateOperatorCode } from './sequence.service.js'
import { IdentityError, createIdentity, discardIdentity, emailInUse, normalizeEmail } from './identity/identity.service.js'
import {
  chooseLanding,
  findLoginCandidates,
  membershipsOf,
  verifyPassword,
  type Membership,
} from './identity/session.service.js'

export interface RegisterInput {
  orgName?: string
  orgSlug?: string
  email: string
  username: string
  password: string
  firstName: string
  middleName?: string
  lastName: string
  baseCurrency?: string
  locale?: string
  inviteCode?: string
}

export interface LoginInput {
  /** A username or an email address. */
  username: string
  password: string
  /**
   * The legacy path: sign in to ONE org by its slug. Scripts, skills and the pre-identity UI send
   * it; the identity UI does not, and lets the person choose.
   */
  orgSlug?: string
  /** The org this browser was last in (plan rule 5). Honoured only if it is one of the person's. */
  preferredOrgId?: string
}

/** An org session's claims: `tokenize()` plus, for a linked membership, the person and `tv`. */
export type SessionUser = UserTokenized & { iid?: string; tv?: number }

/**
 * A sign-in either lands in one org (`session`) or proves who the person is without picking an
 * org for them (`choose`: several memberships and none to land in, or none at all).
 */
export type LoginResult =
  | { kind: 'session'; user: SessionUser; org: IOrg; memberships: Membership[] }
  | { kind: 'choose'; identity: IIdentity; memberships: Membership[] }

export interface UserTokenized {
  id: string
  email: string
  username: string
  firstName: string
  lastName: string
  role: string
  orgId: string
  permissions: string[]
  ownRecordsModules: string[]
  operatorCode?: string
}

/**
 * The settings a brand-new org starts with. One definition for every path that creates an org:
 * password registration and OAuth sign-up had drifted apart (the OAuth copy enabled no modules).
 */
export function defaultOrgSettings(opts: { baseCurrency?: string; locale?: string } = {}) {
  return {
    baseCurrency: opts.baseCurrency || 'EUR',
    fiscalYearStart: 1,
    dateFormat: 'DD.MM.YYYY',
    timezone: 'Europe/Berlin',
    locale: opts.locale || 'en',
    taxConfig: {
      vatEnabled: true,
      defaultVatRate: 20,
      vatRates: [
        { name: 'Standard', rate: 20 },
        { name: 'Reduced', rate: 5 },
        { name: 'Zero', rate: 0 },
      ],
      taxIdLabel: 'VAT ID',
    },
    payroll: {
      payFrequency: 'monthly',
      socialSecurityRate: 0,
      healthInsuranceRate: 0,
      pensionRate: 0,
    },
    modules: [...MODULES],
  }
}

/**
 * Everything a brand-new org needs once its first admin exists: ownership, every app switched on
 * (freemium), the default permission sets, and the admin in the Administrator set.
 *
 * ⚠ OAuth sign-up skipped all of it: its org had no permission sets and no app rows, so its admin
 * held the role's defaults instead of the Administrator set's every-permission (S-23).
 */
export async function provisionNewOrg(org: IOrg, admin: IUser): Promise<void> {
  org.ownerId = admin._id
  await org.save()

  await Promise.all(
    APP_IDS.map(appId =>
      OrgApp.create({ orgId: org._id, appId, enabled: true, activatedAt: new Date(), activatedBy: admin._id }),
    ),
  )

  await seedDefaultPermissionSets(String(org._id))

  const adminSet = await PermissionSet.findOne({ orgId: org._id, name: 'Administrator' })
  if (adminSet) {
    admin.permissionSetIds = [adminSet._id]
    await admin.save()
  }
}

export async function register(input: RegisterInput): Promise<{ org: IOrg; user: IUser; activationToken: string }> {
  // ⚠ Multi-org: registering is for someone new to LGR. A person who already has an account (an
  // identity, or before the migration any user) signs in instead, then joins or founds an org as
  // themselves: a second registration would make a second person with the same address.
  if (await emailInUse(input.email)) throw new IdentityError('account_exists')

  let existingOrg: IOrg | null = null
  let invite: Awaited<ReturnType<typeof inviteDao.findByCode>> = null
  let role = 'admin'
  let permissions = DEFAULT_ROLE_PERMISSIONS.admin

  // Everything that can refuse is checked before anything is written.
  if (input.inviteCode) {
    // Invite-based registration: join existing org
    invite = await inviteDao.findByCode(input.inviteCode)
    if (!invite) throw new Error('Invalid invite code')

    const validation = inviteDao.validate(invite)
    if (!validation.valid) throw new Error(validation.reason || 'Invite is not valid')

    if (invite.targetEmail && normalizeEmail(invite.targetEmail) !== normalizeEmail(input.email)) {
      throw new Error('This invite is for a different email address')
    }

    existingOrg = await Org.findById(invite.orgId)
    if (!existingOrg) throw new Error('Organization not found')
    if (await User.exists({ orgId: existingOrg._id, username: input.username })) {
      throw new Error('This username is already taken in this organization')
    }

    role = invite.assignRole || 'member'
    permissions = DEFAULT_ROLE_PERMISSIONS[role as Role] || DEFAULT_ROLE_PERMISSIONS.member
  } else {
    // Normal registration: create new org
    if (!input.orgName || !input.orgSlug) throw new Error('Organization name and slug are required')
    if (await Org.findOne({ slug: input.orgSlug })) throw new Error('Organization slug already taken')
  }

  const hashedPassword = await Bun.password.hash(input.password)

  // The person first: the unique address is the lock. A concurrent registration of the same email
  // loses here, before it has consumed an invite or founded an org.
  const identity = await createIdentity(
    {
      email: input.email,
      password: hashedPassword,
      passwordSetBy: 'self',
      firstName: input.firstName,
      middleName: input.middleName,
      lastName: input.lastName,
      isActive: false, // until the activation link proves the address
    },
    'account_exists',
  )

  let org: IOrg | undefined
  let createdOrg = false
  let inviteClaimed = false
  let user: IUser | undefined
  try {
    if (invite) {
      const updated = await inviteDao.incrementUseCount(String(invite._id))
      if (!updated) throw new Error('Invite could not be used')
      inviteClaimed = true
      org = existingOrg!
    } else {
      org = await Org.create({
        name: input.orgName,
        slug: input.orgSlug,
        settings: defaultOrgSettings({ baseCurrency: input.baseCurrency, locale: input.locale }),
        subscription: { plan: 'free', maxUsers: 5 },
      })
      createdOrg = true
    }

    // Assign operator code atomically (SUPTO compliance — every user needs one)
    const operatorCode = await allocateOperatorCode(String(org._id))

    user = await User.create({
      email: normalizeEmail(input.email),
      username: input.username,
      password: hashedPassword, // the legacy copy, kept in step until it is retired
      identityId: identity._id,
      firstName: input.firstName,
      middleName: input.middleName,
      lastName: input.lastName,
      role,
      operatorCode,
      orgId: org._id,
      isActive: false,
      permissions,
      roleHistory: [{ role, startDate: new Date(), assignedAt: new Date() }],
    })

    if (!invite) {
      await provisionNewOrg(org, user)
    } else {
      // For invite-based registration, assign default permission set
      const defaultSet = await PermissionSet.findOne({ orgId: org._id, isDefault: true })
      if (defaultSet) {
        user.permissionSetIds = [defaultSet._id]
        await user.save()
      }
    }
  } catch (err) {
    // Leave no half-registered person behind: they could not register again with this address.
    await discardIdentity(identity._id)
    if (user) await User.deleteOne({ _id: user._id }).catch(() => undefined)
    if (createdOrg && org) await Org.deleteOne({ _id: org._id }).catch(() => undefined)
    if (inviteClaimed) await inviteDao.releaseUse(String(invite!._id)).catch(() => undefined)
    throw err
  }

  logger.info({ orgId: org._id, userId: user._id }, 'New organization registered')

  // Generate activation code
  const { token: activationToken } = await codeDao.createActivationCode(String(user._id), String(org._id), config.email.activationTokenTtlMinutes)

  // Send activation email (non-fatal)
  await sendActivationEmail({
    to: input.email,
    firstName: input.firstName,
    orgName: org.name,
    orgId: String(org._id),
    userId: String(user._id),
    code: activationToken,
  })

  // ⚠ S-06: `activationToken` is returned to the CALLER of this function (tests read it), never
  // to an HTTP client. `POST /auth/register` used to echo it in its response, so whoever
  // registered could activate without ever seeing the email, and the check proved nothing.
  return { org, user, activationToken }
}

/**
 * The link an activation email carries.
 *
 * ⚠ The code rides in the URL FRAGMENT. A fragment is never sent to a server, so it cannot land
 * in an access log or a proxy, and the page clears it before posting it. It is also never called
 * `token`: every SPA router treats `?token=` as a session handoff (FR-14.24), which would strip
 * or reject the parameter before the page could read it. Same shape as `/auth/desktop-redeem`.
 */
export function activationUrl(userId: string, code: string): string {
  return `${config.email.appUrl}/auth/activate#userId=${encodeURIComponent(userId)}&code=${encodeURIComponent(code)}`
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Mail an activation link. Never throws: a failed send must not fail the registration that
 * triggered it, and the person can always ask for another (`resendActivation`).
 */
async function sendActivationEmail(opts: {
  to: string
  firstName: string
  orgName?: string
  orgId: string
  userId: string
  code: string
}): Promise<void> {
  const url = activationUrl(opts.userId, opts.code)
  const minutes = config.email.activationTokenTtlMinutes
  try {
    const result = await sendEmail({
      to: opts.to,
      subject: 'Activate your LGR account',
      html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
<h2>Welcome to LGR, ${esc(opts.firstName)}!</h2>
<p>Your account has been created for organization <strong>${esc(opts.orgName)}</strong>.</p>
<p>Please activate your account within <strong>${minutes} minutes</strong>:</p>
<p style="margin: 32px 0;">
  <a href="${url}" style="background:#1976d2;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
    Activate Account
  </a>
</p>
<p>Or copy: <a href="${url}">${url}</a></p>
<p>The link expired? Open ${esc(config.email.appUrl)}/auth/activate and ask for a new one.</p>
<p style="color:#999;font-size:12px;">If you did not create an account, please ignore this email.</p>
</div>`,
      orgId: opts.orgId,
    })
    // With no SendGrid key (local dev) the link would otherwise exist nowhere a developer can
    // reach, now that the register response no longer carries the code. Never in production:
    // there a missing key is a misconfiguration, and a log is no place for a credential.
    if (!result.ok && result.reason === 'not_configured' && process.env.NODE_ENV !== 'production') {
      logger.warn({ to: opts.to, activationUrl: url }, 'Email not configured — activation link for local use')
    }
  } catch (err) {
    logger.warn({ err, userId: opts.userId }, 'Failed to send activation email')
  }
}

/** A second resend while the previous link is still valid is ignored for this long. */
const RESEND_COOLDOWN_MS = 60_000

/**
 * Mail a new activation link to every account still waiting for activation under `email`.
 *
 * "Waiting" means `isActive: false` and never deactivated by an admin (`deactivatedAt` unset).
 * An admin-deactivated account must not be revivable by its owner asking for a link.
 *
 * Callers answer the HTTP request identically whatever this finds, so it cannot be used to
 * learn whether an address has an account. It resolves to nothing for the same reason.
 */
export async function resendActivation(email: string): Promise<void> {
  const typed = email.trim()
  if (!typed) return

  const pending = await User.find({
    email: { $in: [...new Set([typed, typed.toLowerCase()])] },
    isActive: false,
    deactivatedAt: null,
  })
    .limit(5)
    .exec()

  for (const user of pending) {
    const latest = await Code.findOne({ userId: user._id, type: 'user_activation' })
      .sort({ createdAt: -1 })
      .lean()
      .exec()
    // Cooldown only while the last link still works; an expired one may be replaced at once.
    if (
      latest &&
      latest.validTo.getTime() > Date.now() &&
      Date.now() - new Date(latest.createdAt).getTime() < RESEND_COOLDOWN_MS
    ) {
      continue
    }

    const org = await Org.findById(user.orgId, { name: 1 }).lean().exec()
    const { token } = await codeDao.createActivationCode(
      String(user._id),
      String(user.orgId),
      config.email.activationTokenTtlMinutes,
    )
    await sendActivationEmail({
      to: user.email,
      firstName: user.firstName,
      orgName: org?.name,
      orgId: String(user.orgId),
      userId: String(user._id),
      code: token,
    })
  }
}

/**
 * Why a sign-in was refused. `invalid_credentials` is the ONLY answer anyone gets without the
 * password; the other two are said only to someone who has just proven it.
 */
export type LoginRefusal = 'invalid_credentials' | 'not_activated' | 'disabled' | 'ambiguous_login'

/** Several people sign in with this username; the UI asks for an email or an org instead. */
export const AMBIGUOUS_LOGIN = 'Several accounts use this username. Sign in with your email address, or choose the organization.'

export class LoginRefusedError extends Error {
  constructor(readonly code: LoginRefusal, message: string) {
    super(message)
  }
}

export const INVALID_CREDENTIALS = 'Invalid credentials'

/**
 * A hash nobody knows the password to, verified when there is no real one to check.
 *
 * ⚠ S-08. `login()` returned before any hashing when the org or the user did not exist, so
 * response time alone said which usernames existed. Every path now costs exactly one argon2
 * verify. Hashed at first use with the runtime's own defaults, so the decoy costs what a real
 * hash costs.
 */
let decoyHash: Promise<string> | undefined
function decoy(): Promise<string> {
  decoyHash ??= Bun.password.hash(crypto.randomUUID())
  return decoyHash
}

/**
 * Sign in. EXACTLY ONE password verification per call, whatever the outcome (rule 1): response
 * time must not say whether an org, a username or an email exists.
 *
 * ⚠ S-08: nothing is said about the account until the password is proven. It used to answer
 * 'Organization not found', 'Account is disabled' and 'Please login with your OAuth provider'
 * before checking the password, which told anyone which orgs and accounts existed.
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  return input.orgSlug ? loginToOrg({ ...input, orgSlug: input.orgSlug }) : loginAsPerson(input)
}

const notActivated = () =>
  new LoginRefusedError('not_activated', 'Account not activated. Check your email for the activation link.')
const invalid = () => new LoginRefusedError('invalid_credentials', INVALID_CREDENTIALS)

/** The legacy path: one org, by slug, and a username (or the address) in it. */
async function loginToOrg(input: LoginInput & { orgSlug: string }): Promise<LoginResult> {
  const org = await Org.findOne({ slug: input.orgSlug.toLowerCase() })
  let user = org ? await User.findOne({ username: input.username, orgId: org._id }) : null
  if (!user && org && input.username.includes('@')) {
    user = await User.findOne({ email: normalizeEmail(input.username), orgId: org._id }).collation({ locale: 'en', strength: 2 })
  }

  // ⚠ A linked membership signs in with its PERSON's password, never with its legacy per-org copy.
  // A merged person has no password until they choose one, and a stale copy (possibly set by an
  // admin of this org) must not be a way around that. A membership whose person is missing (a
  // per-org restore without `identities`) falls back to its own copy, so a restore never locks out.
  const identity = user?.identityId ? await Identity.findById(user.identityId).select('+password').exec() : null
  const hash = identity ? identity.password : user?.password

  const valid = await verifyPassword(input.password, hash || (await decoy()))
  if (!user || !hash || !valid) throw invalid()

  // The caller holds the password, so the account's state is theirs to know. This org switching
  // them off is the specific answer, so it comes before the person never having activated.
  if (!user.isActive && user.deactivatedAt) throw new LoginRefusedError('disabled', 'Account is disabled')
  if (!user.isActive || (identity && !identity.isActive)) throw notActivated()
  return landInOrg(user, identity, org!)
}

/** The identity path: a username or an address names a person, who lands in one of their orgs. */
async function loginAsPerson(input: LoginInput): Promise<LoginResult> {
  const candidates = await findLoginCandidates(input.username)
  if (candidates.length !== 1) {
    // Still one verification, so a name several people share costs the same as any other.
    await verifyPassword(input.password, await decoy())
    if (candidates.length > 1) throw new LoginRefusedError('ambiguous_login', AMBIGUOUS_LOGIN)
    throw invalid()
  }

  const [candidate] = candidates
  if (candidate.kind === 'user') {
    // Not linked yet (before the migration): the user signs in to its own org, as it always did.
    const { user } = candidate
    const valid = await verifyPassword(input.password, user.password || (await decoy()))
    if (!user.password || !valid) throw invalid()
    if (!user.isActive) throw notActivated() // candidates exclude the deactivated
    const org = await Org.findById(user.orgId).exec()
    if (!org) throw invalid()
    return landInOrg(user, null, org)
  }

  const { identity } = candidate
  const valid = await verifyPassword(input.password, identity.password || (await decoy()))
  if (!identity.password || !valid) throw invalid()
  if (!identity.isActive) throw notActivated()

  const memberships = await membershipsOf(identity._id)
  const landing = chooseLanding(identity, memberships, input.preferredOrgId)
  if (!landing) {
    await Identity.updateOne({ _id: identity._id }, { $set: { lastLoginAt: new Date() } }).exec()
    return { kind: 'choose', identity, memberships }
  }
  const org = await Org.findById(landing.user.orgId).exec()
  if (!org) throw invalid()
  return landInOrg(landing.user, identity, org, memberships)
}

/** The session for one membership: its claims, the person's landing preference, the timestamps. Every sign-in that lands in an org goes through here (password, OAuth). */
export async function landInOrg(member: IUser, identity: IIdentity | null, org: IOrg, memberships?: Membership[]): Promise<LoginResult> {
  member.lastLoginAt = new Date()
  await member.save()
  if (identity) {
    // The person's own sign-in into this org: where they land next time.
    await Identity.updateOne({ _id: identity._id }, { $set: { lastLoginAt: new Date(), lastOrgId: member.orgId } }).exec()
  }
  return {
    kind: 'session',
    user: await sessionFor(member, identity),
    org,
    memberships:
      memberships ??
      (identity
        ? await membershipsOf(identity._id)
        : [{ user: member, org: { id: String(org._id), name: org.name, slug: org.slug } }]),
  }
}

/** An org session for a membership: `tokenize()`, plus the person and their revocation counter. */
export async function sessionFor(member: IUser, identity?: Pick<IIdentity, '_id' | 'tokenVersion'> | null): Promise<SessionUser> {
  const claims: SessionUser = await tokenize(member)
  if (identity) {
    claims.iid = String(identity._id)
    claims.tv = identity.tokenVersion ?? 0
  }
  return claims
}

export async function tokenize(user: IUser): Promise<UserTokenized> {
  // If user has permission sets, compute permissions from them
  if (user.permissionSetIds?.length) {
    /**
     * ⚠ Scoped to the user's OWN org. This looked sets up by `_id` alone, so whichever org
     * owned the id got to decide what this user may do — the grant that answers "what can you
     * do" was the one lookup in the codebase resolved without a tenant filter, while
     * `isForeignOrg` carefully guards "whose data may you ask for". Found live in the dev
     * database: an acme-corp user carrying another org's `Administrator` set (`isAdmin`, i.e.
     * every permission).
     *
     * A set from another org is now simply not found, and a `permissionSetIds` that resolves
     * to NOTHING falls through to the role-based branch below rather than returning an empty
     * permission list — a scoping fix must not log people out of their own permissions.
     */
    const sets = await PermissionSet.find({
      _id: { $in: user.permissionSetIds },
      orgId: user.orgId,
    }).lean()

    if (sets.length < user.permissionSetIds.length) {
      logger.warn(
        {
          userId: String(user._id),
          orgId: String(user.orgId),
          assigned: user.permissionSetIds.length,
          resolved: sets.length,
        },
        'User references permission sets that do not belong to their org — ignoring them',
      )
    }

    if (!sets.length) return tokenizeFromRole(user)

    const isAdmin = sets.some(s => s.isAdmin)
    const allPerms = new Set<string>()
    const ownModules: string[] = []

    for (const set of sets) {
      for (const p of set.permissions) allPerms.add(p)
      if (set.ownRecordsOnly) {
        for (const [mod, own] of Object.entries(set.ownRecordsOnly)) {
          if (own && !ownModules.includes(mod)) ownModules.push(mod)
        }
      }
    }

    // If ANY set is NOT ownRecordsOnly for a module, remove it from ownModules (most permissive wins)
    for (const set of sets) {
      if (set.ownRecordsOnly) {
        for (const [mod, own] of Object.entries(set.ownRecordsOnly)) {
          if (!own) {
            const idx = ownModules.indexOf(mod)
            if (idx >= 0) ownModules.splice(idx, 1)
          }
        }
      }
    }

    if (isAdmin) {
      allPerms.clear()
      PERMISSIONS.forEach(p => allPerms.add(p))
    }

    return {
      id: String(user._id),
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      orgId: String(user.orgId),
      permissions: [...allPerms],
      ownRecordsModules: ownModules,
      operatorCode: user.operatorCode,
    }
  }

  return tokenizeFromRole(user)
}

/**
 * Role-based fallback: used when a user has no permission sets, and when none of the sets they
 * carry belong to their org.
 */
function tokenizeFromRole(user: IUser): UserTokenized {
  const roleDefaults = DEFAULT_ROLE_PERMISSIONS[user.role as Role] || DEFAULT_ROLE_PERMISSIONS.member
  const merged = [...new Set([...roleDefaults, ...(user.permissions || [])])]

  return {
    id: String(user._id),
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    orgId: String(user.orgId),
    permissions: merged,
    ownRecordsModules: [],
    operatorCode: user.operatorCode,
  }
}
