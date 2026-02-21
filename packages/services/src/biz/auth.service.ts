import { Org, User, OrgApp, type IOrg, type IUser } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS, MODULES, APP_IDS, type Role } from 'config/constants'
import { logger } from '../logger/logger.js'
import { inviteDao } from '../dao/invite.dao.js'

export interface RegisterInput {
  orgName?: string
  orgSlug?: string
  email: string
  username: string
  password: string
  firstName: string
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
}

export async function register(input: RegisterInput): Promise<{ org: IOrg; user: IUser }> {
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
          defaultVatRate: 18,
          vatRates: [
            { name: 'Standard', rate: 18 },
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
  const user = await User.create({
    email: input.email,
    username: input.username,
    password: hashedPassword,
    firstName: input.firstName,
    lastName: input.lastName,
    role,
    orgId: org._id,
    isActive: true,
    permissions,
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
  }

  logger.info({ orgId: org._id, userId: user._id }, 'New organization registered')
  return { org, user }
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

  const tokenized: UserTokenized = {
    id: String(user._id),
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    orgId: String(org._id),
    permissions: [...user.permissions],
  }

  return { user: tokenized, org }
}

export function tokenize(user: IUser): UserTokenized {
  return {
    id: String(user._id),
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    orgId: String(user.orgId),
    permissions: [...user.permissions],
  }
}
