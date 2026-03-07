import { LWWStrategy, FieldLevelLWWStrategy } from './lww.js'
import { AdditiveStrategy } from './additive.js'
import {
  StateMachineStrategy,
  INVOICE_STATUS_ORDER,
  JOURNAL_STATUS_ORDER,
  MOVEMENT_STATUS_ORDER,
  PAYROLL_STATUS_ORDER,
  PRODUCTION_STATUS_ORDER,
  LEAVE_STATUS_ORDER,
  TRIP_STATUS_ORDER,
  DEAL_STATUS_ORDER,
} from './state-machine.js'

export interface ResolvedConflict {
  resolution: 'local_wins' | 'remote_wins' | 'merged'
  data: Record<string, unknown>
}

export interface ConflictStrategy {
  resolve(
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    localTimestamp: string,
    remoteTimestamp: string,
    base?: Record<string, unknown>,
  ): ResolvedConflict
}

/**
 * Central conflict resolver that selects the appropriate strategy per table.
 */
export class ConflictResolver {
  private strategies = new Map<string, ConflictStrategy>()
  private defaultStrategy = new FieldLevelLWWStrategy()

  constructor() {
    // Additive merge for quantity/balance tables
    this.strategies.set('stock_levels', new AdditiveStrategy(['quantity', 'reserved_quantity', 'available_quantity']))
    this.strategies.set('accounts', new AdditiveStrategy(['balance']))
    this.strategies.set('leave_balances', new AdditiveStrategy(['taken', 'pending', 'remaining']))

    // State machine for status-driven entities
    this.strategies.set('invoices', new StateMachineStrategy('status', INVOICE_STATUS_ORDER))
    this.strategies.set('journal_entries', new StateMachineStrategy('status', JOURNAL_STATUS_ORDER))
    this.strategies.set('stock_movements', new StateMachineStrategy('status', MOVEMENT_STATUS_ORDER))
    this.strategies.set('payroll_runs', new StateMachineStrategy('status', PAYROLL_STATUS_ORDER))
    this.strategies.set('production_orders', new StateMachineStrategy('status', PRODUCTION_STATUS_ORDER))
    this.strategies.set('leave_requests', new StateMachineStrategy('status', LEAVE_STATUS_ORDER))
    this.strategies.set('business_trips', new StateMachineStrategy('status', TRIP_STATUS_ORDER))
    this.strategies.set('deals', new StateMachineStrategy('status', DEAL_STATUS_ORDER))
  }

  resolve(
    tableName: string,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    localTimestamp: string,
    remoteTimestamp: string,
    base?: Record<string, unknown>,
  ): ResolvedConflict {
    const strategy = this.strategies.get(tableName) || this.defaultStrategy
    return strategy.resolve(local, remote, localTimestamp, remoteTimestamp, base)
  }
}
