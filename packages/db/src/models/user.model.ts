import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IOAuthProvider {
  provider: string
  providerId: string
  accessToken?: string
  refreshToken?: string
}

export interface IRoleHistoryEntry {
  /** The legacy role key. FR-27 P3-5: no longer written; entries from before keep it. */
  role?: string
  /** FR-27 P3-5: the role given, by id. */
  roleId?: Types.ObjectId
  /** FR-27.8: the role's name at the time (the key alone says nothing of a custom role). */
  roleName?: string
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
  /** The legacy role key. FR-27 P3-5 (#529): no longer written; what a person may do is their role (`roleId`). */
  role?: string
  operatorCode?: string
  position?: string
  roleHistory: IRoleHistoryEntry[]
  /** Legacy (FR-26). FR-27 P3-5: no longer written; P3-7 archives it. */
  permissionSetIds?: Types.ObjectId[]
  /** FR-27.3 (#529): the person's one role in this org. Set by migration 0015; decides from FR-27 Phase 1's switch. */
  roleId?: Types.ObjectId
  orgId: Types.ObjectId
  avatar?: string
  isActive: boolean
  deactivatedAt?: Date
  /** Legacy. FR-27 P3-5: no longer written; P3-7 archives it. */
  permissions?: string[]
  preferences: {
    locale?: string
    theme?: string
    dashboard?: object
  }
  oauthProviders: IOAuthProvider[]
  lastLoginAt?: Date
  /**
   * The person this membership belongs to (`Identity`). Unset until the identity migration links it;
   * a user without one signs in on its own password, as every user did before.
   */
  identityId?: Types.ObjectId
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
    // FR-27 P3-5 (#529): the legacy role key, no longer written (no default: a new membership has none). Read only
    // where a person from before has it; P3-7 archives it.
    role: { type: String },
    operatorCode: { type: String },
    position: { type: String },
    roleHistory: [
      {
        // The legacy key, on entries from before FR-27 P3-5. A new entry names the role by id and name.
        role: String,
        roleId: { type: Schema.Types.ObjectId, ref: 'Role' },
        roleName: String,
        startDate: { type: Date, required: true },
        endDate: Date,
        assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        assignedAt: { type: Date, required: true },
      },
    ],
    // FR-27 P3-5: legacy, no longer written. `default: undefined`, or every new membership would carry `[]`.
    permissionSetIds: { type: [{ type: Schema.Types.ObjectId, ref: 'PermissionSet' }], default: undefined },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role' },
    avatar: String,
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
    // FR-27 P3-5: legacy, no longer written (as `permissionSetIds`).
    permissions: { type: [{ type: String }], default: undefined },
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
    identityId: { type: Schema.Types.ObjectId, ref: 'Identity' },
  },
  { timestamps: true },
)

userSchema.plugin(tenantPlugin)
userSchema.index({ email: 1, orgId: 1 }, { unique: true })
userSchema.index({ username: 1, orgId: 1 }, { unique: true })
userSchema.index({ operatorCode: 1, orgId: 1 }, { unique: true, partialFilterExpression: { operatorCode: { $type: 'string' } } })
// One membership per person per org. Partial: users the migration has not linked yet are left out.
userSchema.index({ identityId: 1, orgId: 1 }, { unique: true, partialFilterExpression: { identityId: { $exists: true } } })

replicate(userSchema, {
  class: 'S',
  // The membership is the home's. ⚠ `identityId` is applied only where global sanctioned the link.
  home: ['username', 'middleName', 'role', 'operatorCode', 'position', 'roleHistory', 'permissionSetIds', 'roleId', 'permissions', 'avatar', 'isActive', 'deactivatedAt', 'preferences', 'identityId', 'createdAt', 'updatedAt'],
  // The person is global's: email and names come from the identity feed, and a password or a
  // provider link is never on a master.
  global: ['email', 'firstName', 'lastName', 'password', 'oauthProviders'],
  node: ['lastLoginAt'],
})

export const User = model<IUser>('User', userSchema)
