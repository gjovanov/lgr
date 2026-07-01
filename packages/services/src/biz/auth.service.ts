import { Org, User, OrgApp, Sequence, PermissionSet, type IOrg, type IUser } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, MODULES, APP_IDS, type Role } from 'config/constants'
import { config } from 'config'
import { logger } from '../logger/logger.js'
import { inviteDao } from '../dao/invite.dao.js'
import { codeDao } from '../dao/code.dao.js'
import { sendEmail } from './email.service.js'
import { seedDefaultPermissionSets } from './permission-set.seed.js'

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
  username: string
  password: string
  orgSlug: string
}

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

export async function register(input: RegisterInput): Promise<{ org: IOrg; user: IUser; activationToken: string }> {
  let org: IOrg
  let role = 'admin'
  let permissions = DEFAULT_ROLE_PERMISSIONS.admin

  if (input.inviteCode) {
    // Invite-based registration: join existing org
    const invite = await inviteDao.findByCode(input.inviteCode)
    if (!invite) throw new Error('Invalid invite code')

    const validation = inviteDao.validate(invite)
    if (!validation.valid) throw new Error(validation.reason || 'Invite is not valid')

    if (invite.targetEmail && invite.targetEmail !== input.email) {
      throw new Error('This invite is for a different email address')
    }

    const existingOrg = await Org.findById(invite.orgId)
    if (!existingOrg) throw new Error('Organization not found')
    org = existingOrg

    role = invite.assignRole || 'member'
    permissions = DEFAULT_ROLE_PERMISSIONS[role as Role] || DEFAULT_ROLE_PERMISSIONS.member

    const updated = await inviteDao.incrementUseCount(String(invite._id))
    if (!updated) throw new Error('Invite could not be used')
  } else {
    // Normal registration: create new org
    if (!input.orgName || !input.orgSlug) throw new Error('Organization name and slug are required')

    const existingOrg = await Org.findOne({ slug: input.orgSlug })
    if (existingOrg) throw new Error('Organization slug already taken')

    org = await Org.create({
      name: input.orgName,
      slug: input.orgSlug,
      settings: {
        baseCurrency: input.baseCurrency || 'EUR',
        fiscalYearStart: 1,
        dateFormat: 'DD.MM.YYYY',
        timezone: 'Europe/Berlin',
        locale: input.locale || 'en',
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
      },
      subscription: { plan: 'free', maxUsers: 5 },
    })
  }

  const hashedPassword = await Bun.password.hash(input.password)

  // Assign operator code atomically (SUPTO compliance — every user needs one)
  const opSeq = await Sequence.findOneAndUpdate(
    { orgId: org._id, prefix: 'OPERATOR', year: 0 },
    { $inc: { lastNumber: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()
  const operatorCode = String(opSeq!.lastNumber).padStart(4, '0')

  const user = await User.create({
    email: input.email,
    username: input.username,
    password: hashedPassword,
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

  if (!input.inviteCode) {
    org.ownerId = user._id
    await org.save()

    // Auto-activate all apps for new orgs (freemium model)
    await Promise.all(
      APP_IDS.map(appId =>
        OrgApp.create({ orgId: org._id, appId, enabled: true, activatedAt: new Date(), activatedBy: user._id }),
      ),
    )

    // Seed default permission sets for the new org
    await seedDefaultPermissionSets(String(org._id))

    // Assign admin user to the Administrator permission set
    const adminSet = await PermissionSet.findOne({ orgId: org._id, name: 'Administrator' })
    if (adminSet) {
      user.permissionSetIds = [adminSet._id]
      await user.save()
    }
  } else {
    // For invite-based registration, assign default permission set
    const defaultSet = await PermissionSet.findOne({ orgId: org._id, isDefault: true })
    if (defaultSet) {
      user.permissionSetIds = [defaultSet._id]
      await user.save()
    }
  }

  logger.info({ orgId: org._id, userId: user._id }, 'New organization registered')

  // Generate activation code
  const { token: activationToken } = await codeDao.createActivationCode(String(user._id), String(org._id), config.email.activationTokenTtlMinutes)

  // Send activation email (non-fatal)
  const activationUrl = `${config.email.appUrl}/auth/activate?userId=${user._id}&token=${activationToken}`
  await sendEmail({
    to: input.email,
    subject: 'Activate your LGR account',
    html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
<h2>Welcome to LGR, ${input.firstName}!</h2>
<p>Your account has been created for organization <strong>${org.name}</strong>.</p>
<p>Please activate your account within <strong>${config.email.activationTokenTtlMinutes} minutes</strong>:</p>
<p style="margin: 32px 0;">
  <a href="${activationUrl}" style="background:#1976d2;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
    Activate Account
  </a>
</p>
<p>Or copy: <a href="${activationUrl}">${activationUrl}</a></p>
<p style="color:#999;font-size:12px;">If you did not create an account, please ignore this email.</p>
</div>`,
    orgId: String(org._id),
  }).catch(err => console.warn('Failed to send activation email:', err))

  return { org, user, activationToken }
}

export async function login(input: LoginInput): Promise<{ user: UserTokenized; org: IOrg }> {
  const org = await Org.findOne({ slug: input.orgSlug.toLowerCase() })
  if (!org) throw new Error('Organization not found')

  const user = await User.findOne({ username: input.username, orgId: org._id })
  if (!user) throw new Error('Invalid credentials')
  if (!user.isActive) throw new Error('Account is disabled')

  if (!user.password) throw new Error('Please login with your OAuth provider')
  const valid = await Bun.password.verify(input.password, user.password)
  if (!valid) throw new Error('Invalid credentials')

  user.lastLoginAt = new Date()
  await user.save()

  return { user: await tokenize(user), org }
}

export async function tokenize(user: IUser): Promise<UserTokenized> {
  // If user has permission sets, compute permissions from them
  if (user.permissionSetIds?.length) {
    const sets = await PermissionSet.find({ _id: { $in: user.permissionSetIds } }).lean()
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

  // Legacy fallback (no permission sets)
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
