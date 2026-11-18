import { Schema, model } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * FR-29.27: which process runs a scheduler job that may run on ONE pod at a time (`where: 'one'`,
 * `services/scheduler/registry.ts`). `_id` is the job's name. A pod takes the lease with a conditional write when it
 * is free or lapsed, renews it on each tick it runs, and another pod runs the job once it lapses (the pod stopped).
 *
 * Node state: it names a process of this database's servers, and means nothing anywhere else. No `orgId`.
 */
export interface ISchedulerLease {
  _id: string
  holder: string
  leaseUntil: Date
  takenAt: Date
}

const schedulerLeaseSchema = new Schema<ISchedulerLease>(
  {
    _id: { type: String, required: true },
    holder: { type: String, required: true },
    leaseUntil: { type: Date, required: true },
    takenAt: { type: Date, required: true },
  },
  { collection: 'scheduler_leases', versionKey: false },
)

replicate(schedulerLeaseSchema, { class: 'N' })

export const SchedulerLease = model<ISchedulerLease>('SchedulerLease', schedulerLeaseSchema)
