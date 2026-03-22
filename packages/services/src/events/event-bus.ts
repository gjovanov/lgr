import { EventEmitter } from 'events'
import { logger } from '../logger/logger.js'

// ── Event Types ──

export interface SalesOrderConfirmedEvent {
  type: 'sales.order.confirmed'
  payload: {
    salesOrderId: string
    orgId: string
    lines: { productId: string; quantity: number; warehouseId?: string; unitPrice: number }[]
    contactId: string
    userId: string
  }
}

export interface PurchaseOrderConfirmedEvent {
  type: 'purchase.order.confirmed'
  payload: {
    purchaseOrderId: string
    orgId: string
    lines: { productId: string; quantity: number; warehouseId?: string; unitCost: number }[]
    vendorId: string
    userId: string
    expectedDate?: Date
  }
}

export interface InvoicePostedEvent {
  type: 'invoice.posted'
  payload: {
    invoiceId: string
    orgId: string
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
    amount: number
    method: string
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

export interface ProductionCompletedEvent {
  type: 'production.completed'
  payload: {
    productionOrderId: string
    orgId: string
    finishedProductId: string
    quantity: number
    materialsConsumed: { productId: string; quantity: number }[]
  }
}

export interface ApprovalRequestedEvent {
  type: 'approval.requested'
  payload: {
    entityType: string
    entityId: string
    orgId: string
    requesterId: string
  }
}

export interface ApprovalDecidedEvent {
  type: 'approval.decided'
  payload: {
    entityType: string
    entityId: string
    orgId: string
    decision: 'approved' | 'rejected'
    decidedBy: string
  }
}

export interface ProjectCreatedEvent {
  type: 'project.created'
  payload: {
    projectId: string
    orgId: string
    name: string
    managerId: string
    memberIds: string[]
  }
}

export interface TicketCreatedEvent {
  type: 'ticket.created'
  payload: {
    ticketId: string
    orgId: string
    name: string
    assigneeId?: string
    teamId?: string
    partnerId?: string
    channelSource: string
  }
}

export type DomainEvent =
  | SalesOrderConfirmedEvent
  | PurchaseOrderConfirmedEvent
  | InvoicePostedEvent
  | PaymentRecordedEvent
  | StockMovementConfirmedEvent
  | ProductionCompletedEvent
  | ApprovalRequestedEvent
  | ApprovalDecidedEvent
  | ProjectCreatedEvent
  | TicketCreatedEvent

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
    this.emitter.removeAllListeners(eventType)
  }
}

/** Singleton event bus instance */
export const eventBus = new DomainEventBus()
