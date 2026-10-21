import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IBackgroundTask extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  userId: Types.ObjectId
  type: string
  status: string
  params: object
  result?: object
  progress: number
  logs: string[]
  error?: string
  startedAt?: Date
  completedAt?: Date
  /**
   * The process running it, and when that process last said so (FR-20.23). A task whose owner
   * stopped heartbeating is failed by any process (`services/background/task-owner.ts`).
   */
  owner?: { process: string; pod: string; heartbeatAt: Date }
  createdAt: Date
}

const backgroundTaskSchema = new Schema<IBackgroundTask>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true },
  status: { type: String, default: 'pending', enum: ['pending', 'processing', 'completed', 'failed'] },
  params: { type: Schema.Types.Mixed, default: {} },
  result: Schema.Types.Mixed,
  progress: { type: Number, default: 0 },
  logs: [{ type: String }],
  error: String,
  startedAt: Date,
  completedAt: Date,
  owner: { process: String, pod: String, heartbeatAt: Date },
  createdAt: { type: Date, default: Date.now },
})

backgroundTaskSchema.plugin(tenantPlugin)
backgroundTaskSchema.index({ orgId: 1, userId: 1, status: 1 })
backgroundTaskSchema.index({ status: 1, 'owner.heartbeatAt': 1 })
backgroundTaskSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 * 7 })

export const BackgroundTask = model<IBackgroundTask>('BackgroundTask', backgroundTaskSchema)
