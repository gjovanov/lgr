import { Schema, model, type Document, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

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
  /**
   * FR-20.3 — global's own record of the highest home epoch it has seen for this org, beside the
   * `org_homes` row. A row that disagrees with it (or a missing row once it is set) puts the org
   * in `hold`: read-only until a sys-admin resolves it. Unset for every org that never moved.
   */
  homeEpochHighWater?: number
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
    /** FR-21: the cash register (the till and every cash-register document). */
    cashRegister?: {
      /**
       * Whether the till may sell what the warehouse does not hold (FR-21.16). Unset means YES,
       * which is what the till always did: it never checked. `false` checks the stock before a
       * receipt can print, and refuses the sale. Not `inventory.allowNegativeStock`, which
       * defaults to false and which no code read: following it would have made every till that
       * never touched it refuse sales.
       */
      allowNegativeStock?: boolean
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
      /**
       * FR-21.2: where a POS session's counted-versus-expected cash difference is posted. Unset,
       * the session journal entry posts no over/short line and the difference stays on the session.
       */
      cashOverShortAccountId?: string
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
    /**
     * FR-13.10 (#24) — the per-org backup bundle. `enabled` defaults FALSE and gates the
     * SCHEDULER only: an admin can always take a manual backup of their own org. 73 of the 80
     * orgs in production are `e2e-*` test tenants, and nightly-bundling all of them would put
     * artifacts nobody wants on the PV that is already the tightest resource in the system.
     */
    backup?: {
      enabled?: boolean
      /** 0–23, in `settings.timezone`. Falls back to `config.backup.hour`. */
      hour?: number
    }
    /**
     * FR-14.19 (#57) — LGR Desktop clients.
     *
     * ⚠ `ephemeralKeysEnabled` defaults FALSE and is checked on USE, not only when a key is
     * minted, so turning it off revokes the whole class of reusable enrollment keys at once. They
     * exist for the field-test lanes' throwaway VMs; a normal org should never have one.
     */
    desktop?: {
      ephemeralKeysEnabled?: boolean
    }
    /**
     * FR-20.2 (P2-1) — masters registered with global. `ephemeralKeysEnabled` is the desktops'
     * rule again: off by default, checked on USE, for the field lanes' throwaway masters only.
     */
    node?: {
      ephemeralKeysEnabled?: boolean
      /**
       * FR-20.69 (P3-3): whether this org's files travel to global's mirror while its home is a
       * master. Unset is yes; `false` is the metadata-only option: the records are mirrored, the
       * files stay on the master. Global's own, like the rest of `settings.node`.
       */
      mirrorFiles?: boolean
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
    homeEpochHighWater: Number,
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
      // No default: an org that never set it reads as "allowed" (see the interface).
      cashRegister: {
        allowNegativeStock: Boolean,
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
        cashOverShortAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
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
      // FR-13.10 (#24). Gates the SCHEDULER only — a manual backup is always available to an
      // org admin. Defaults off for the same reason the digest's Backups section does: it
      // must be a deliberate act, not something 73 e2e tenants inherit.
      backup: {
        enabled: { type: Boolean, default: false },
        hour: { type: Number, min: 0, max: 23 },
      },
      // FR-14.19 — reusable enrollment keys for throwaway field-test VMs. Off unless asked for.
      desktop: {
        ephemeralKeysEnabled: { type: Boolean, default: false },
      },
      // FR-20.2 — reusable registration keys for the field lanes' throwaway masters. Off unless asked for.
      node: {
        ephemeralKeysEnabled: { type: Boolean, default: false },
        // FR-20.69: unset means "mirror the files too". No default, so no org needs a backfill.
        mirrorFiles: { type: Boolean },
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

replicate(orgSchema, {
  class: 'S',
  // The org is the document itself: no `orgId`, its `_id` is the org (applied by `{_id}`).
  orgPath: '_id',
  // The company's own data and its settings are the home's (FR-20.63).
  home: ['name', 'description', 'logo', 'ownerId', 'taxNumber', 'vatNumber', 'email', 'phone', 'website', 'addresses', 'bankDetails', 'settings', 'createdAt', 'updatedAt'],
  // ⚠ Global's: the address label, the billing, the cloud integrations' tokens, the masters' enrolment
  // switch, and the second home record. A page never overwrites them (acceptance 33).
  global: ['slug', 'subscription', 'settings.integrations', 'settings.node', 'homeEpochHighWater'],
  node: [],
})

export const Org = model<IOrg>('Org', orgSchema)

/**
 * An org's settings as a client may see them (S-29). `settings.integrations` reserves an access and
 * a refresh token per cloud provider. Nothing writes them today, but the routes that return the
 * org answer every member of it, so a token stored there would reach every browser.
 */
export function settingsForClient<T>(settings: T): T {
  if (!settings || typeof settings !== 'object') return settings
  const s: any = typeof (settings as any).toObject === 'function' ? (settings as any).toObject() : { ...(settings as any) }
  if (s.integrations && typeof s.integrations === 'object') {
    s.integrations = Object.fromEntries(Object.entries(s.integrations).map(([provider, value]) => {
      if (!value || typeof value !== 'object') return [provider, value]
      const { accessToken: _a, refreshToken: _r, ...rest } = value as Record<string, unknown>
      return [provider, rest]
    }))
  }
  return s
}

/** `settingsForClient`, applied to a whole serialised org. */
export function orgForClient<T extends { settings?: unknown }>(org: T): T {
  return org?.settings ? { ...org, settings: settingsForClient(org.settings) } : org
}
