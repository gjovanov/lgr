/**
 * Cross-module event handlers.
 * Register these at startup after service context is initialized.
 *
 * Event flow:
 *   sales.order.confirmed  → Create draft stock dispatch movement
 *   purchase.order.confirmed → Create draft stock receipt movement
 */
import { config } from 'config'
import { eventBus } from './event-bus.js'
import { getRepos } from '../context.js'
import { getNextNumber } from '../biz/sequence.service.js'
import { trackEvent } from '../biz/purestat.service.js'
import { createRoom } from '../biz/roomler.service.js'
import { logger } from '../logger/logger.js'

let _registered = false
export function registerEventHandlers(): void {
  if (_registered) {
    logger.warn('Event handlers already registered — skipping')
    return
  }
  _registered = true

  // ── Sales → Warehouse: confirmed SO creates dispatch movement ──
  eventBus.on('sales.order.confirmed', async (payload) => {
    const r = getRepos()
    const { salesOrderId, orgId, lines, userId, contactId } = payload

    // Only create movement for lines with products
    const productLines = lines.filter((l) => l.productId)
    if (productLines.length === 0) return

    try {
      // Check idempotency — skip if movement already exists for this SO
      const existing = await r.stockMovements.findMany({
        orgId,
        reference: `SO:${salesOrderId}`,
      } as any)
      if (existing.length > 0) {
        logger.warn({ salesOrderId }, 'Dispatch movement already exists for SO — skipping duplicate')
        return
      }

      // Find default warehouse or use line-level warehouse
      const warehouseIds = new Set(productLines.map((l) => l.warehouseId).filter(Boolean))
      let defaultWarehouse: any = null
      if (warehouseIds.size === 0) {
        const warehouses = await r.warehouses.findMany({ orgId } as any, { createdAt: 1 })
        defaultWarehouse = warehouses[0]
        if (!defaultWarehouse) {
          logger.warn({ salesOrderId }, 'No warehouse found — skipping stock dispatch')
          return
        }
      }

      const movementNumber = await getNextNumber(orgId, 'SM')
      const movement = await r.stockMovements.create({
        orgId,
        movementNumber,
        type: 'dispatch',
        status: 'draft',
        fromWarehouseId: defaultWarehouse?.id || [...warehouseIds][0],
        contactId,
        date: new Date(),
        reference: `SO:${salesOrderId}`,
        lines: productLines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitCost: l.unitPrice || 0,
        })),
        notes: `Auto-created from Sales Order confirmation`,
        createdBy: userId || '',
      } as any)

      // Link movement to SO
      const order = await r.salesOrders.findById(salesOrderId)
      if (order) {
        await r.salesOrders.update(salesOrderId, {
          movementIds: [...(order.movementIds || []), movement.id],
        } as any)
      }

      logger.info({ salesOrderId, movementId: movement.id }, 'Dispatch movement created from SO')
    } catch (err: any) {
      logger.error({ salesOrderId, error: err.message }, 'Failed to create dispatch from SO')
    }
  })

  // ── Purchase → Warehouse: confirmed PO creates receipt movement ──
  eventBus.on('purchase.order.confirmed', async (payload) => {
    const r = getRepos()
    const { purchaseOrderId, orgId, lines, userId, vendorId } = payload
    const contactId = vendorId // PO uses vendorId, map to contactId for stock movement

    const productLines = lines.filter((l) => l.productId)
    if (productLines.length === 0) return

    try {
      // Check idempotency — skip if movement already exists for this PO
      const existing = await r.stockMovements.findMany({
        orgId,
        reference: `PO:${purchaseOrderId}`,
      } as any)
      if (existing.length > 0) {
        logger.warn({ purchaseOrderId }, 'Receipt movement already exists for PO — skipping duplicate')
        return
      }

      const warehouseIds = new Set(productLines.map((l) => l.warehouseId).filter(Boolean))
      let defaultWarehouse: any = null
      if (warehouseIds.size === 0) {
        const warehouses = await r.warehouses.findMany({ orgId } as any, { createdAt: 1 })
        defaultWarehouse = warehouses[0]
        if (!defaultWarehouse) {
          logger.warn({ purchaseOrderId }, 'No warehouse found — skipping stock receipt')
          return
        }
      }

      const movementNumber = await getNextNumber(orgId, 'SM')
      const movement = await r.stockMovements.create({
        orgId,
        movementNumber,
        type: 'receipt',
        status: 'draft',
        toWarehouseId: defaultWarehouse?.id || [...warehouseIds][0],
        contactId,
        date: new Date(),
        reference: `PO:${purchaseOrderId}`,
        lines: productLines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitCost: l.unitCost || 0,
        })),
        notes: `Auto-created from Purchase Order confirmation`,
        createdBy: userId || '',
      } as any)

      // Link movement to PO
      const order = await r.purchaseOrders.findById(purchaseOrderId)
      if (order) {
        await r.purchaseOrders.update(purchaseOrderId, {
          movementIds: [...(order.movementIds || []), movement.id],
        } as any)
      }

      logger.info({ purchaseOrderId, movementId: movement.id }, 'Receipt movement created from PO')
    } catch (err: any) {
      logger.error({ purchaseOrderId, error: err.message }, 'Failed to create receipt from PO')
    }
  })

  // ── Roomler: auto-create chat rooms for projects and tickets ──
  if (config.externalIntegrations?.roomler?.enabled) {
    eventBus.on('project.created', async (payload) => {
      const room = await createRoom({
        name: `Project: ${payload.name}`,
        orgId: payload.orgId,
        memberIds: [payload.managerId, ...payload.memberIds],
        entityType: 'project',
        entityId: payload.projectId,
      })
      if (room) {
        const r = getRepos()
        await r.projects.update(payload.projectId, { roomId: room.id } as any)
        logger.info({ projectId: payload.projectId, roomId: room.id }, 'Roomler room created for project')
      }
    })

    eventBus.on('ticket.created', async (payload) => {
      if (payload.channelSource === 'chat') {
        const memberIds = [payload.assigneeId, payload.partnerId].filter(Boolean) as string[]
        const room = await createRoom({
          name: `Ticket: ${payload.name}`,
          orgId: payload.orgId,
          memberIds,
          entityType: 'ticket',
          entityId: payload.ticketId,
        })
        if (room) {
          const r = getRepos()
          await r.tickets.update(payload.ticketId, { roomId: room.id } as any)
          logger.info({ ticketId: payload.ticketId, roomId: room.id }, 'Roomler room created for ticket')
        }
      }
    })
  }

  // ── Analytics: track key business events in Purestat ──
  if (config.externalIntegrations?.purestat?.enabled) {
    eventBus.on('sales.order.confirmed', async (payload) => {
      await trackEvent('sales.order.confirmed', { orgId: payload.orgId, lines: payload.lines.length })
    })
    eventBus.on('purchase.order.confirmed', async (payload) => {
      await trackEvent('purchase.order.confirmed', { orgId: payload.orgId, lines: payload.lines.length })
    })
    eventBus.on('invoice.posted', async (payload) => {
      await trackEvent('invoice.posted', { orgId: payload.orgId, total: payload.total })
    })
    eventBus.on('payment.recorded', async (payload) => {
      await trackEvent('payment.recorded', { orgId: payload.orgId, amount: payload.amount })
    })
  }

  logger.info('Cross-module event handlers registered')
}

/** Reset registration guard (for tests only). */
export function resetEventHandlers(): void {
  _registered = false
}
