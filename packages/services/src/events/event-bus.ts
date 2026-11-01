import { EventEmitter } from 'events'
import { logger } from '../logger/logger.js'

// ── Event Types ──

export interface InvoicePostedEvent {
  type: 'invoice.posted'
  payload: {
    invoiceId: string
    orgId: string
    userId: string
    direction: string
    total: number
    contactId: string
  }
}

export interface PaymentRecordedEvent {
  type: 'payment.recorded'
  payload: {
    invoiceId: string
    orgId: string
    userId: string
    amount: number
    method: string
    date?: string
    /** The receipt that took it at the counter (FR-23): the payment row it is stamped on. */
    receiptId?: string
    /** The row's own id, for a payment no receipt took. */
    paymentId?: string
  }
}

export interface StockMovementConfirmedEvent {
  type: 'stock.movement.confirmed'
  payload: {
    movementId: string
    orgId: string
    type: string
    lines: { productId: string; quantity: number }[]
  }
}

export interface POSSessionClosedEvent {
  type: 'pos.session.closed'
  payload: {
    sessionId: string
    orgId: string
    userId: string
  }
}

export type DomainEvent =
  | InvoicePostedEvent
  | PaymentRecordedEvent
  | StockMovementConfirmedEvent
  | POSSessionClosedEvent

export type EventType = DomainEvent['type']
export type EventPayload<T extends EventType> = Extract<DomainEvent, { type: T }>['payload']

type EventHandler<T extends EventType> = (payload: EventPayload<T>) => Promise<void> | void

// ── Event Bus ──

class DomainEventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(50) // Allow many cross-module subscribers
  }

  on<T extends EventType>(eventType: T, handler: EventHandler<T>): () => void {
    const wrapper = async (payload: EventPayload<T>) => {
      try {
        await handler(payload)
      } catch (err: any) {
        logger.error({ eventType, error: err.message }, `Event handler failed for ${eventType}`)
      }
    }
    this.emitter.on(eventType, wrapper)
    return () => { this.emitter.off(eventType, wrapper) }
  }

  once<T extends EventType>(eventType: T, handler: EventHandler<T>): () => void {
    const wrapper = async (payload: EventPayload<T>) => {
      try {
        await handler(payload)
      } catch (err: any) {
        logger.error({ eventType, error: err.message }, `Event handler failed for ${eventType}`)
      }
    }
    this.emitter.once(eventType, wrapper)
    return () => { this.emitter.off(eventType, wrapper) }
  }

  emit<T extends EventType>(eventType: T, payload: EventPayload<T>): void {
    logger.debug({ eventType }, `Emitting domain event: ${eventType}`)
    this.emitter.emit(eventType, payload)
  }

  removeAllListeners(eventType?: EventType): void {
    // ⚠ Node reads the argument count: an explicit undefined removes the listeners of an event of that name.
    if (eventType) this.emitter.removeAllListeners(eventType)
    else this.emitter.removeAllListeners()
  }
}

/** Singleton event bus instance */
export const eventBus = new DomainEventBus()
