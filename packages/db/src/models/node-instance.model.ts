import { Schema, model } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * Which copy of a master's data this is (FR-20.71, plan Part A.5.1): one random id, made the first
 * time it is asked for, carried in every page. Global keeps the one it was sent, and refuses pages of
 * another until a re-seed (P3-7). A restore makes a new one (P3-7), and so does a database that was
 * lost and started again empty: either is a different history from the one the mirror saw.
 *
 * A singleton (`_id: 'instance'`), node-local, with no org: it is never in a bundle.
 */
export interface INodeInstance {
  _id: string
  instanceEpoch: string
  createdAt: Date
}

const nodeInstanceSchema = new Schema<INodeInstance>(
  {
    _id: { type: String, required: true },
    instanceEpoch: { type: String, required: true, maxlength: 64 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'node_instance' },
)

replicate(nodeInstanceSchema, { class: 'N' })

export const NodeInstance = model<INodeInstance>('NodeInstance', nodeInstanceSchema)
