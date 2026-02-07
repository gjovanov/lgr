import { Org, User, type IOrg, type IUser } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS, MODULES, type Role } from 'config/constants'
import { logger } from '../logger/logger.js'

export interface RegisterInput {
  orgName: string
  orgSlug: string
  email: string
  username: string
  password: string
  firstName: string
  lastName: string
  baseCurrency?: string
  locale?: string
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
  const existingOrg = await Org.findOne({ slug: input.orgSlug })
  if (existingOrg) throw new Error('Organization slug already taken')

  const org = await Org.create({
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

  const hashedPassword = await Bun.password.hash(input.password)
  const user = await User.create({
    email: input.email,
    username: input.username,
    password: hashedPassword,
    firstName: input.firstName,
    lastName: input.lastName,
    role: 'admin',
    orgId: org._id,
    isActive: true,
    permissions: DEFAULT_ROLE_PERMISSIONS.admin,
  })

  org.ownerId = user._id
  await org.save()

  logger.info({ orgId: org._id, userId: user._id }, 'New organization registered')
  return { org, user }
}

export async function login(input: LoginInput): Promise<{ user: UserTokenized; org: IOrg }> {
  const org = await Org.findOne({ slug: input.orgSlug.toLowerCase() })
  if (!org) throw new Error('Organization not found')

  const user = await User.findOne({ username: input.username, orgId: org._id })
  if (!user) throw new Error('Invalid credentials')
  if (!user.isActive) throw new Error('Account is disabled')

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
