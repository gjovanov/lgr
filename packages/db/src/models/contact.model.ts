import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { loweredFieldsPlugin } from '../plugins/lowered-fields.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IContactAddress {
  type: string
  street: string
  street2?: string
  city?: string
  state?: string
  postalCode?: string
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
  taxNumber?: string
  vatNumber?: string
  registrationNumber?: string
  addresses: IContactAddress[]
  bankDetails: IContactBankDetail[]
  currency?: string
  paymentTermsDays: number
  creditLimit?: number
  discount?: number
  notes?: string
  /**
   * The person legally responsible for the company (МОЛ), printed on a Bulgarian invoice beside its name. Until
   * FR-25a it was kept as a notes line, `МОЛ: <name>`: `scripts/backfill-contact-representative.ts` moves those.
   */
  representative?: string
  tags?: string[]
  /**
   * Other names this company is written under on documents („Also known as", FR-28.12): a short form, another
   * list's spelling, a name before a rename. Stored cleaned (`config/contact-aliases#cleanContactAliases`). An
   * import that looks a contact up by name takes one of these for this contact when nobody is NAMED that
   * (`doc-import/supplier-name.ts#pickSupplierByName`, `matching.ts#matchContactByName`), and the contact search
   * reads them through `aliasesLower`. Absent on a contact that has none.
   */
  aliases?: string[]
  accountReceivableId?: Types.ObjectId
  accountPayableId?: Types.ObjectId
  isActive: boolean
  deactivatedAt?: Date
  companyNameLower?: string
  firstNameLower?: string
  lastNameLower?: string
  emailLower?: string
  taxIdLower?: string
  vatNumberLower?: string
  aliasesLower?: string[]
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
    taxNumber: String,
    vatNumber: String,
    registrationNumber: String,
    addresses: [
      {
        type: { type: String, required: true, enum: ['billing', 'shipping', 'office'] },
        street: { type: String, required: true },
        street2: String,
        // city/postalCode optional: legacy (PlusMinus) contact exports carry only a
        // street line and a city label, never a postal code.
        city: String,
        state: String,
        postalCode: String,
        country: { type: String, required: true, default: 'BG' },
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
    representative: String,
    tags: [String],
    // No default: a contact with no other name keeps neither field, as every contact before this did.
    aliases: { type: [String], default: undefined },
    accountReceivableId: { type: Schema.Types.ObjectId, ref: 'Account' },
    accountPayableId: { type: Schema.Types.ObjectId, ref: 'Account' },
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
    companyNameLower: { type: String, index: true },
    firstNameLower: { type: String, index: true },
    lastNameLower: { type: String, index: true },
    emailLower: { type: String, index: true },
    taxIdLower: { type: String, index: true },
    vatNumberLower: { type: String, index: true },
    aliasesLower: { type: [String], default: undefined },
  },
  { timestamps: true },
)

contactSchema.plugin(tenantPlugin)
contactSchema.plugin(loweredFieldsPlugin, {
  fields: {
    companyName: 'companyNameLower',
    firstName: 'firstNameLower',
    lastName: 'lastNameLower',
    email: 'emailLower',
    taxId: 'taxIdLower',
    vatNumber: 'vatNumberLower',
    aliases: 'aliasesLower',
  },
})
contactSchema.index({ orgId: 1, type: 1 })
contactSchema.index({ orgId: 1, email: 1 })
contactSchema.index({ orgId: 1, companyName: 1 })
contactSchema.index({ orgId: 1, taxId: 1 })
contactSchema.index({ orgId: 1, vatNumber: 1 })
contactSchema.index({ orgId: 1, taxNumber: 1 })
contactSchema.index({ companyName: 'text', firstName: 'text', lastName: 'text', email: 'text' })

replicate(contactSchema, { class: 'R' })

export const Contact = model<IContact>('Contact', contactSchema)
