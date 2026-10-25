import { Schema, model, type Document } from 'mongoose'

/**
 * A master's own small records about itself, by name (FR-20, plan step P2-5): today the identity
 * feed's cursor. No `orgId`, so no org bundle ever carries one (`tenantCollections`), and a restore
 * never rewrites one.
 */
export interface INodeState extends Omit<Document, '_id'> {
  _id: string
  value: Record<string, unknown>
  updatedAt: Date
}

const nodeStateSchema = new Schema<INodeState>(
  {
    _id: { type: String, required: true, maxlength: 80 },
    value: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'node_state', minimize: false },
)

export const NodeState = model<INodeState>('NodeState', nodeStateSchema)
