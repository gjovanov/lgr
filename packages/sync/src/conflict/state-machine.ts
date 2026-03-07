import type { ResolvedConflict, ConflictStrategy } from './resolver.js'

/**
 * State machine merge for status fields.
 * Status transitions are ordered; take the furthest state.
 * Other fields use LWW.
 */
export class StateMachineStrategy implements ConflictStrategy {
  constructor(
    private statusField: string,
    private statusOrder: string[],
  ) {}

  resolve(
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    localTimestamp: string,
    remoteTimestamp: string,
  ): ResolvedConflict {
    const merged: Record<string, unknown> = {}

    // Merge all fields with LWW except the status field
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      if (key === this.statusField) continue
      // LWW for non-status fields
      merged[key] = remoteTimestamp > localTimestamp ? remote[key] : local[key]
    }

    // Status field: take the furthest state
    const localStatus = local[this.statusField] as string
    const remoteStatus = remote[this.statusField] as string
    const localIndex = this.statusOrder.indexOf(localStatus)
    const remoteIndex = this.statusOrder.indexOf(remoteStatus)

    if (localIndex >= 0 && remoteIndex >= 0) {
      merged[this.statusField] = remoteIndex >= localIndex ? remoteStatus : localStatus
    } else {
      // Unknown status; fall back to LWW
      merged[this.statusField] = remoteTimestamp > localTimestamp ? remoteStatus : localStatus
    }

    return {
      resolution: localStatus === remoteStatus ? 'merged' :
        (remoteIndex > localIndex ? 'remote_wins' : 'local_wins'),
      data: merged,
    }
  }
}

// Common status orderings for LGR entities
export const INVOICE_STATUS_ORDER = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'voided', 'cancelled', 'converted']
export const JOURNAL_STATUS_ORDER = ['draft', 'posted', 'voided']
export const MOVEMENT_STATUS_ORDER = ['draft', 'confirmed', 'completed', 'cancelled']
export const PAYROLL_STATUS_ORDER = ['draft', 'calculated', 'approved', 'paid', 'cancelled']
export const PRODUCTION_STATUS_ORDER = ['planned', 'in_progress', 'quality_check', 'completed', 'cancelled']
export const LEAVE_STATUS_ORDER = ['pending', 'approved', 'rejected', 'cancelled']
export const TRIP_STATUS_ORDER = ['requested', 'approved', 'completed', 'cancelled']
export const DEAL_STATUS_ORDER = ['open', 'won', 'lost']
