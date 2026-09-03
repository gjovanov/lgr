import { Schema, model, type Document, type Types } from 'mongoose'

export interface IOrgAddress {
  type: string
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
  isDefault?: boolean
}

export interface IOrgBankDetail {
  bankName: string
  accountNumber?: string
  iban?: string
  swift?: string
  currency?: string
  isDefault?: boolean
}

export interface IOrg extends Document {
  _id: Types.ObjectId
  name: string
  slug: string
  description?: string
  logo?: string
  ownerId: Types.ObjectId
  taxNumber?: string
  vatNumber?: string
  email?: string
  phone?: string
  website?: string
  addresses?: IOrgAddress[]
  bankDetails?: IOrgBankDetail[]
  settings: {
    baseCurrency: string
    fiscalYearStart: number
    dateFormat: string
    timezone: string
    locale: string
    taxConfig: {
      vatEnabled: boolean
      defaultVatRate: number
      vatRates: { name: string; rate: number }[]
      taxIdLabel: string
    }
    payroll: {
      payFrequency: string
      socialSecurityRate: number
      healthInsuranceRate: number
      pensionRate: number
    }
    inventory?: {
      defaultCostingMethod?: string
      allowNegativeStock?: boolean
      autoPostJournalEntries?: boolean
      defaultInventoryAccountId?: string
      defaultCOGSAccountId?: string
      useLocations?: boolean
    }
    accounting?: {
      defaultReceivableAccountId?: string
      defaultPayableAccountId?: string
      defaultRevenueAccountId?: string
      defaultExpenseAccountId?: string
      defaultSaleJournalId?: string
      defaultPurchaseJournalId?: string
      defaultCashJournalId?: string
      defaultBankJournalId?: string
      autoPostInvoiceEntries?: boolean
      autoPostPaymentEntries?: boolean
    }
    /**
     * FR-11 (#21) — the daily digest email. `hour` is ORG-LOCAL, read through
     * `settings.timezone`, which this feature is the first consumer of.
     */
    dailyDigest?: {
      enabled?: boolean
      /** 0–23, in `settings.timezone`. */
      hour?: number
      recipients?: { userId: string }[]
      sections?: Record<string, boolean>
      /** Overrides `settings.locale` for the digest only. */
      locale?: string
    }
    modules: string[]
    integrations?: {
      googleDrive?: { accessToken: string; refreshToken: string; expiresAt: Date; email: string }
      onedrive?: { accessToken: string; refreshToken: string; expiresAt: Date; email: string }
      dropbox?: { accessToken: string; refreshToken: string; expiresAt: Date; email: string }
      roomler?: boolean
      tickytack?: boolean
      purestat?: boolean
    }
  }
  subscription: {
    plan: string
    maxUsers: number
    expiresAt?: Date
    stripeCustomerId?: string
    stripeSubscriptionId?: string
    status: string
    currentPeriodEnd?: Date
    cancelAtPeriodEnd: boolean
  }
  createdAt: Date
  updatedAt: Date
}

const orgSchema = new Schema<IOrg>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    description: String,
    logo: String,
    ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
    taxNumber: String,
    vatNumber: String,
    email: String,
    phone: String,
    website: String,
    addresses: [
      {
        type: { type: String, required: true, enum: ['billing', 'shipping', 'office'] },
        street: { type: String, required: true },
        city: { type: String, required: true },
        state: String,
        postalCode: { type: String, required: true },
        country: { type: String, required: true },
        isDefault: { type: Boolean, default: false },
      },
    ],
    bankDetails: [
      {
        bankName: { type: String, required: true },
        accountNumber: String,
        iban: String,
        swift: String,
        currency: { type: String, default: 'EUR' },
        isDefault: { type: Boolean, default: false },
      },
    ],
    settings: {
      baseCurrency: { type: String, default: 'EUR' },
      fiscalYearStart: { type: Number, default: 1 },
      dateFormat: { type: String, default: 'DD.MM.YYYY' },
      timezone: { type: String, default: 'Europe/Berlin' },
      locale: { type: String, default: 'en' },
      taxConfig: {
        vatEnabled: { type: Boolean, default: true },
        defaultVatRate: { type: Number, default: 20 },
        vatRates: [{ name: String, rate: Number }],
        taxIdLabel: { type: String, default: 'VAT ID' },
      },
      payroll: {
        payFrequency: { type: String, default: 'monthly' },
        socialSecurityRate: { type: Number, default: 0 },
        healthInsuranceRate: { type: Number, default: 0 },
        pensionRate: { type: Number, default: 0 },
      },
      inventory: {
        defaultCostingMethod: { type: String, enum: ['wac', 'fifo', 'lifo', 'fefo', 'standard'], default: 'wac' },
        allowNegativeStock: { type: Boolean, default: false },
        autoPostJournalEntries: { type: Boolean, default: false },
        defaultInventoryAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
        defaultCOGSAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
        useLocations: { type: Boolean, default: false },
      },
      accounting: {
        defaultReceivableAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
        defaultPayableAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
        defaultRevenueAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
        defaultExpenseAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
        defaultSaleJournalId: { type: Schema.Types.ObjectId, ref: 'Journal' },
        defaultPurchaseJournalId: { type: Schema.Types.ObjectId, ref: 'Journal' },
        defaultCashJournalId: { type: Schema.Types.ObjectId, ref: 'Journal' },
        defaultBankJournalId: { type: Schema.Types.ObjectId, ref: 'Journal' },
        autoPostInvoiceEntries: { type: Boolean, default: false },
        autoPostPaymentEntries: { type: Boolean, default: false },
      },
      // FR-11 (#21). Every section defaults ON: a digest nobody configured in detail
      // should still be the full picture — switching parts OFF is the deliberate act.
      dailyDigest: {
        enabled: { type: Boolean, default: false },
        hour: { type: Number, default: 7, min: 0, max: 23 },
        recipients: [{ userId: { type: Schema.Types.ObjectId, ref: 'User' } }],
        sections: {
          kpis: { type: Boolean, default: true },
          documents: { type: Boolean, default: true },
          materials: { type: Boolean, default: true },
          stock: { type: Boolean, default: true },
          corrections: { type: Boolean, default: true },
          undocumentedSales: { type: Boolean, default: true },
          duplicates: { type: Boolean, default: true },
          editedAfterIssue: { type: Boolean, default: true },
          ops: { type: Boolean, default: true },
          // FR-13.6 (#24) — the ONE section that defaults OFF. Backup status is
          // infrastructure state for whoever operates the deployment, not tenant data; every
          // org sees the same cluster-wide figures. Turning it on is the deliberate act here,
          // and it is the last step of the Layer-1 install (docs/BACKUP-RUNBOOK.md §3).
          backups: { type: Boolean, default: false },
        },
        locale: String,
      },
      modules: [{ type: String }],
      integrations: {
        googleDrive: { accessToken: String, refreshToken: String, expiresAt: Date, email: String },
        onedrive: { accessToken: String, refreshToken: String, expiresAt: Date, email: String },
        dropbox: { accessToken: String, refreshToken: String, expiresAt: Date, email: String },
        roomler: { type: Boolean, default: false },
        tickytack: { type: Boolean, default: false },
        purestat: { type: Boolean, default: false },
      },
    },
    subscription: {
      plan: { type: String, default: 'free' },
      maxUsers: { type: Number, default: 3 },
      expiresAt: Date,
      stripeCustomerId: String,
      stripeSubscriptionId: String,
      status: { type: String, default: 'active' },
      currentPeriodEnd: Date,
      cancelAtPeriodEnd: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
)

export const Org = model<IOrg>('Org', orgSchema)
