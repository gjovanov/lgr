import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * FR-27.3 (#529) — a role: a name, a description, and what it may do as capabilities (`config/access`). A person
 * has exactly one per organization (`User.roleId`).
 *
 * - **Built-in** (`isBuiltin`, `templateKey`): the ten legacy roles. Never edited, it takes its access from its
 *   template (`config/access/templates.ts`), so a release that adds a capability gives it as its template does.
 *   Edited, it keeps the `caps` it was saved with.
 * - **Imported** (`legacyKey`): what migration 0015 made for a person whose access no built-in role matched: their
 *   sets, or their role plus extra permissions. `legacyKey` is that access, so the migration finds the role again.
 * - **`all`**: the Administrator, every capability there is and any added later. Never edited or emptied.
 * - **`legacy`**: what a release that reads no roles gives the role's people (FR-27 §4 step 3): the role key,
 *   permissions and areas `tokenize()` reads.
 *
 * Replicated like permission sets (class R).
 */
export interface IRole extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  description?: string
  templateKey?: string
  isBuiltin: boolean
  edited: boolean
  all: boolean
  caps: string[]
  landing?: string
  legacy: { role: string; permissions: string[]; areas?: string[]; setId?: Types.ObjectId }
  legacyKey?: string
  /** The projection does not say all the role grants: the legacy model serves its people less (FR-27 §4 step 4). */
  needsRelease: boolean
  /** Bumped on every change of what the role grants: the token's `rv` (FR-27.5). */
  version: number
  createdAt: Date
  updatedAt: Date
}

const roleSchema = new Schema<IRole>(
  {
    name: { type: String, required: true },
    description: String,
    templateKey: String,
    isBuiltin: { type: Boolean, default: false },
    edited: { type: Boolean, default: false },
    all: { type: Boolean, default: false },
    caps: [{ type: String }],
    landing: String,
    legacy: {
      role: { type: String, required: true },
      permissions: [{ type: String }],
      // ⚠ `default: undefined`: absent and `[]` are opposites (FR-26), as on a permission set.
      areas: { type: [String], default: undefined },
      // The permission set that carries the projection, which its people are put on (FR-27 §4 step 3).
      setId: { type: Schema.Types.ObjectId, ref: 'PermissionSet' },
    },
    legacyKey: String,
    needsRelease: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
)

roleSchema.plugin(tenantPlugin)
roleSchema.index({ orgId: 1, name: 1 }, { unique: true })
roleSchema.index({ orgId: 1, templateKey: 1 }, { unique: true, partialFilterExpression: { isBuiltin: true } })
roleSchema.index({ orgId: 1, legacyKey: 1 }, { unique: true, partialFilterExpression: { legacyKey: { $type: 'string' } } })

replicate(roleSchema, { class: 'R' })

export const Role = model<IRole>('Role', roleSchema)
