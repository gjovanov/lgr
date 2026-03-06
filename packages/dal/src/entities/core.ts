import type { BaseEntity, TenantEntity } from '../types.js'

// ── Org ──

export interface IVatRate {
  name: string
  rate: number
}

export interface ITaxConfig {
  vatEnabled: boolean
  defaultVatRate: number
  vatRates: IVatRate[]
  taxIdLabel: string
}

export interface IPayrollConfig {
  payFrequency: string
  socialSecurityRate: number
  healthInsuranceRate: number
  pensionRate: number
}

export interface ICloudStorageIntegration {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  email: string
}

export interface IOrgSettings {
  baseCurrency: string
  fiscalYearStart: number
  dateFormat: string
  timezone: string
  locale: string
  taxConfig: ITaxConfig
  payroll: IPayrollConfig
  modules: string[]
  integrations?: {
    googleDrive?: ICloudStorageIntegration
    onedrive?: ICloudStorageIntegration
    dropbox?: ICloudStorageIntegration
  }
}

export interface IOrgSubscription {
  plan: string
  maxUsers: number
  expiresAt?: Date
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  status: string
  currentPeriodEnd?: Date
  cancelAtPeriodEnd: boolean
}

export interface IOrg extends BaseEntity {
  name: string
  slug: string
  description?: string
  logo?: string
  ownerId: string
  settings: IOrgSettings
  subscription: IOrgSubscription
}

// ── User ──

export interface IOAuthProvider {
  provider: string
  providerId: string
  accessToken?: string
  refreshToken?: string
}

export interface IUserPreferences {
  locale?: string
  theme?: string
  dashboard?: Record<string, any>
}

export interface IUser extends TenantEntity {
  email: string
  username: string
  password?: string
  firstName: string
  lastName: string
  role: string
  avatar?: string
  isActive: boolean
  permissions: string[]
  preferences: IUserPreferences
  oauthProviders: IOAuthProvider[]
  lastLoginAt?: Date
}

// ── Invite ──

export type InviteStatus = 'active' | 'expired' | 'revoked' | 'exhausted'

export interface IInvite extends TenantEntity {
  code: string
  inviterId: string
  targetEmail?: string
  maxUses?: number
  useCount: number
  status: InviteStatus
  assignRole: string
  expiresAt?: Date
}

// ── Code ──

export type CodeType = 'user_activation'

export interface ICode extends TenantEntity {
  userId: string
  token: string
  type: CodeType
  validTo: Date
}

// ── EmailLog ──

export interface IEmailLog extends BaseEntity {
  creatorId?: string
  orgId?: string
  from: string
  to: string
  subject: string
  body: string
}

// ── AuditLog ──

export interface IAuditLogChange {
  field: string
  oldValue: any
  newValue: any
}

export interface IAuditLog extends TenantEntity {
  userId: string
  action: string
  module: string
  entityType: string
  entityId: string
  changes?: IAuditLogChange[]
  ipAddress?: string
  userAgent?: string
  timestamp: Date
}

// ── File ──

export interface IAiRecognition {
  status: string
  extractedData?: Record<string, any>
  confidence?: number
  processedAt?: Date
}

export interface IFile extends TenantEntity {
  uploadedBy: string
  originalName: string
  storagePath: string
  storageProvider: string
  mimeType: string
  size: number
  module: string
  entityType?: string
  entityId?: string
  aiRecognition?: IAiRecognition
  tags?: string[]
}

// ── Notification ──

export interface INotification extends TenantEntity {
  userId: string
  type: string
  title: string
  message: string
  module: string
  entityType?: string
  entityId?: string
  read: boolean
  readAt?: Date
}

// ── BackgroundTask ──

export interface IBackgroundTask extends TenantEntity {
  userId: string
  type: string
  status: string
  params: Record<string, any>
  result?: Record<string, any>
  progress: number
  logs: string[]
  error?: string
  startedAt?: Date
  completedAt?: Date
}

// ── OrgApp ──

export interface IOrgApp extends TenantEntity {
  appId: string
  enabled: boolean
  activatedAt: Date
  activatedBy?: string
}

// ── Tag ──

export interface ITag extends TenantEntity {
  type: string
  value: string
}
