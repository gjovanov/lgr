import { Schema, model, type Document, type Types } from 'mongoose'

export interface IOrg extends Document {
  _id: Types.ObjectId
  name: string
  slug: string
  description?: string
  logo?: string
  ownerId: Types.ObjectId
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
    modules: string[]
    integrations?: {
      googleDrive?: { accessToken: string; refreshToken: string; expiresAt: Date; email: string }
      onedrive?: { accessToken: string; refreshToken: string; expiresAt: Date; email: string }
      dropbox?: { accessToken: string; refreshToken: string; expiresAt: Date; email: string }
    }
  }
  subscription: {
    plan: string
    maxUsers: number
    expiresAt?: Date
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
    settings: {
      baseCurrency: { type: String, default: 'EUR' },
      fiscalYearStart: { type: Number, default: 1 },
      dateFormat: { type: String, default: 'DD.MM.YYYY' },
      timezone: { type: String, default: 'Europe/Berlin' },
      locale: { type: String, default: 'en' },
      taxConfig: {
        vatEnabled: { type: Boolean, default: true },
        defaultVatRate: { type: Number, default: 18 },
        vatRates: [{ name: String, rate: Number }],
        taxIdLabel: { type: String, default: 'VAT ID' },
      },
      payroll: {
        payFrequency: { type: String, default: 'monthly' },
        socialSecurityRate: { type: Number, default: 0 },
        healthInsuranceRate: { type: Number, default: 0 },
        pensionRate: { type: Number, default: 0 },
      },
      modules: [{ type: String }],
      integrations: {
        googleDrive: { accessToken: String, refreshToken: String, expiresAt: Date, email: String },
        onedrive: { accessToken: String, refreshToken: String, expiresAt: Date, email: String },
        dropbox: { accessToken: String, refreshToken: String, expiresAt: Date, email: String },
      },
    },
    subscription: {
      plan: { type: String, default: 'free' },
      maxUsers: { type: Number, default: 5 },
      expiresAt: Date,
    },
  },
  { timestamps: true },
)

export const Org = model<IOrg>('Org', orgSchema)
