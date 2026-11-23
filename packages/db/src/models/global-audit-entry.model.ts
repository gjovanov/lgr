import { Schema, model } from 'mongoose'
import { auditEntryFields, type IAuditLog } from './audit-log.model.js'
import { replicate } from '../replication/declare.js'

/**
 * An audit entry global wrote about an org whose home is elsewhere (FR-29.21 with FR-20.4): a sign-in on lgrai.app into
 * an org homed on its server, a change on the org's Servers page there, an export read from the mirror.
 *
 * Global cannot put it in the org's trail (`AuditLog`). The write guard refuses every write of an org that is not home
 * here, and on global that trail is the mirror of the server's, which a move back compares collection by collection,
 * by count and hash (`homeDigests`): one row of global's own in `auditlogs` would fail that comparison for good. Until
 * 2026-11 the entry was only logged as an audit write failure.
 *
 * So global keeps it here, with the same fields and where the org's home was when global wrote it.
 * - ⚠ NODE STATE (`home/node-state.ts`), not the org's data: never mirrored (class N), never in a backup bundle (the
 *   way an org moves), never compared by a move. It stays on global when the org comes home too.
 * - ⚠ Never pruned. An audit entry is kept like the trail itself (`retention.service.ts` names neither).
 * - The audit page on global reads both, merged by time (`queryAuditLogs`).
 */
export interface IGlobalAuditEntry extends IAuditLog {
  /** The org's home when global wrote the entry: a server's node id, or `global` during a move's freeze. */
  home: string
  /** Its state then: `active` on a server, or `freezing`, `frozen`, `fenced`, `hold`. */
  homeState: string
  homeEpoch?: number
}

const globalAuditEntrySchema = new Schema<IGlobalAuditEntry>(
  {
    ...auditEntryFields(),
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    home: { type: String, required: true },
    homeState: { type: String, required: true },
    homeEpoch: Number,
  },
  { collection: 'global_audit_entries' },
)

globalAuditEntrySchema.index({ orgId: 1, timestamp: -1 })
globalAuditEntrySchema.index({ orgId: 1, correlationId: 1 })

replicate(globalAuditEntrySchema, { class: 'N' })

export const GlobalAuditEntry = model<IGlobalAuditEntry>('GlobalAuditEntry', globalAuditEntrySchema)
