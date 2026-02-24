import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IContactAddress {
  type: string
  street: string
  street2?: string
  city: string
  state?: string
  postalCode: string
  country: string
  isDefault: boolean
}

export interface IContactBankDetail {
  bankName: string
  accountNumber: string
  iban?: string
  swift?: string
  currency: string
  isDefault: boolean
}

export interface IContact extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  type: string
  companyName?: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  mobile?: string
  website?: string
  taxId?: string
  registrationNumber?: string
  addresses: IContactAddress[]
  bankDetails: IContactBankDetail[]
  currency?: string
  paymentTermsDays: number
  creditLimit?: number
  discount?: number
  notes?: string
  tags?: string[]
  accountReceivableId?: Types.ObjectId
  accountPayableId?: Types.ObjectId
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const contactSchema = new Schema<IContact>(
  {
    type: { type: String, required: true, enum: ['customer', 'supplier', 'both'] },
    companyName: String,
    firstName: String,
    lastName: String,
    email: String,
    phone: String,
    mobile: String,
    website: String,
    taxId: String,
    registrationNumber: String,
    addresses: [
      {
        type: { type: String, required: true, enum: ['billing', 'shipping', 'office'] },
        street: { type: String, required: true },
        street2: String,
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
        accountNumber: { type: String, required: true },
        iban: String,
        swift: String,
        currency: { type: String, default: 'EUR' },
        isDefault: { type: Boolean, default: false },
      },
    ],
    currency: String,
    paymentTermsDays: { type: Number, default: 30 },
    creditLimit: Number,
    discount: Number,
    notes: String,
    tags: [String],
    accountReceivableId: { type: Schema.Types.ObjectId, ref: 'Account' },
    accountPayableId: { type: Schema.Types.ObjectId, ref: 'Account' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

contactSchema.plugin(tenantPlugin)
contactSchema.index({ orgId: 1, type: 1 })
contactSchema.index({ orgId: 1, email: 1 })
contactSchema.index({ orgId: 1, companyName: 1 })
contactSchema.index({ orgId: 1, taxId: 1 })

export const Contact = model<IContact>('Contact', contactSchema)
