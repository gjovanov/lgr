import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IOAuthProvider {
  provider: string
  providerId: string
  accessToken?: string
  refreshToken?: string
}

export interface IRoleHistoryEntry {
  role: string
  startDate: Date
  endDate?: Date
  assignedBy?: Types.ObjectId
  assignedAt: Date
}

export interface IUser extends Document {
  _id: Types.ObjectId
  email: string
  username: string
  password?: string
  firstName: string
  middleName?: string
  lastName: string
  role: string
  operatorCode?: string
  position?: string
  roleHistory: IRoleHistoryEntry[]
  orgId: Types.ObjectId
  avatar?: string
  isActive: boolean
  deactivatedAt?: Date
  permissions: string[]
  preferences: {
    locale?: string
    theme?: string
    dashboard?: object
  }
  oauthProviders: IOAuthProvider[]
  lastLoginAt?: Date
  createdAt: Date
  updatedAt: Date
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true },
    username: { type: String, required: true },
    password: { type: String },
    firstName: { type: String, required: true },
    middleName: { type: String },
    lastName: { type: String, required: true },
    role: { type: String, required: true, default: 'member' },
    operatorCode: { type: String },
    position: { type: String },
    roleHistory: [
      {
        role: { type: String, required: true },
        startDate: { type: Date, required: true },
        endDate: Date,
        assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        assignedAt: { type: Date, required: true },
      },
    ],
    avatar: String,
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
    permissions: [{ type: String }],
    preferences: {
      locale: String,
      theme: String,
      dashboard: Schema.Types.Mixed,
    },
    oauthProviders: [
      {
        provider: { type: String, required: true },
        providerId: { type: String, required: true },
        accessToken: String,
        refreshToken: String,
      },
    ],
    lastLoginAt: Date,
  },
  { timestamps: true },
)

userSchema.plugin(tenantPlugin)
userSchema.index({ email: 1, orgId: 1 }, { unique: true })
userSchema.index({ username: 1, orgId: 1 }, { unique: true })
userSchema.index({ operatorCode: 1, orgId: 1 }, { unique: true, sparse: true })

export const User = model<IUser>('User', userSchema)
