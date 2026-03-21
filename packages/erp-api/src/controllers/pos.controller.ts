import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { getNextNumber, generateUNP } from 'services/biz/sequence.service'
import { confirmMovement } from 'services/biz/warehouse.service'
import { logger } from 'services/logger'
import { POSSession } from 'db/models'
import {
  isDeviceConnected,
  getPrinter,
  type IFiscalPrinter,
} from 'fiscal/fiscal-device.service'
import { toFiscalPaymentType } from 'fiscal/types'
import { mapTaxRateToVatGroup } from 'fiscal/vat-groups'

/**
 * Look up the active fiscal device for a warehouse.
 * Returns { deviceId, deviceNumber, printer } if connected, or null if no fiscal device.
 * Throws if a device is configured but in error state (Appendix 29: must block operations).
 */
async function getFiscalContext(orgId: string, warehouseId: string) {
  const r = getRepos()
  const device = await r.fiscalDevices.findOne({
    orgId,
    warehouseId,
    isActive: true,
  } as any) as any
  if (!device) return null

  if (!isDeviceConnected(device.id)) {
    if (device.status === 'error') {
      throw new Error(`Fiscal device "${device.name}" is in error state. Cannot process sale.`)
    }
    logger.warn({ deviceId: device.id, warehouseId }, 'Fiscal device offline, proceeding without fiscal receipt')
    return null
  }

  return {
    deviceId: device.id,
    deviceNumber: device.deviceNumber as string,
    printer: getPrinter(device.id),
  }
}

/**
 * Recalculate and validate totals from line items (H5: server-side validation).
 * Returns the verified totals or throws on mismatch.
 */
function validateTotals(body: any) {
  let subtotal = 0
  let discountTotal = 0
  let taxTotal = 0

  for (const line of body.lines) {
    const lineBase = line.quantity * line.unitPrice
    const lineDiscount = lineBase * ((line.discount || 0) / 100)
    const taxableAmount = lineBase - lineDiscount
    const lineTax = taxableAmount * ((line.taxRate || 0) / 100)

    subtotal += lineBase
    discountTotal += lineDiscount
    taxTotal += lineTax
  }

  const total = subtotal - discountTotal + taxTotal

  // Allow 1 cent tolerance for floating point
  if (Math.abs(total - body.total) > 0.02) {
    throw new Error(`Total mismatch: calculated ${total.toFixed(2)}, received ${body.total.toFixed(2)}`)
  }

  const paymentTotal = body.payments.reduce((s: number, p: any) => s + p.amount, 0)
  if (paymentTotal < total - 0.02) {
    throw new Error(`Insufficient payment: total ${total.toFixed(2)}, paid ${paymentTotal.toFixed(2)}`)
  }

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discountTotal: Math.round(discountTotal * 100) / 100,
    taxTotal: Math.round(taxTotal * 100) / 100,
    total: Math.round(total * 100) / 100,
    changeDue: Math.round((paymentTotal - total) * 100) / 100,
  }
}

export const posController = new Elysia({ prefix: '/org/:orgId/erp/pos' })
  .use(AppAuthService)
  // ── POS Catalog ──
  .get('/catalog', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const productFilter: Record<string, any> = { orgId, isActive: true }
    const search = query.search as string | undefined
    if (search) productFilter.$text = { $search: search }
    const productResult = await r.products.findAll(productFilter, { page: 0, size: 200, sort: { name: 1 } })

    let stockMap = new Map<string, number>()
    if (query.warehouseId && productResult.items.length > 0) {
      const productIds = productResult.items.map((p: any) => p.id)
      const stockLevels = await r.stockLevels.findMany(
        { orgId, warehouseId: query.warehouseId, productId: { $in: productIds } } as any,
      )
      for (const sl of stockLevels) {
        stockMap.set(sl.productId, sl.quantity)
      }
    }

    const products = productResult.items.map((p: any) => ({
      productId: p.id,
      productName: p.name,
      sku: p.sku,
      barcode: p.barcode,
      unitPrice: p.sellingPrice,
      taxRate: p.taxRate ?? 0,
      unit: p.unit,
      type: p.type,
      stockAvailable: stockMap.get(p.id) ?? null,
    }))

    return { products }
  }, { isSignIn: true })
  // ── Sessions ──
  .post(
    '/session',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.posSessions.findOne({ orgId, cashierId: user.id, status: 'open' } as any)
      if (existing) return status(400, { message: 'You already have an open session' })

      try {
        await getFiscalContext(orgId, body.warehouseId)
      } catch (e: any) {
        return status(503, { message: e.message })
      }

      const sessionNumber = await getNextNumber(orgId, 'POS', 6)

      const session = await r.posSessions.create({
        ...body,
        orgId,
        sessionNumber,
        cashierId: user.id,
        openedAt: new Date(),
        status: 'open',
        totalSales: 0,
        totalReturns: 0,
        totalCash: 0,
        totalCard: 0,
        transactionCount: 0,
      } as any)

      createAuditEntry({ orgId, userId: user.id, operatorCode: user.operatorCode, action: 'create', module: 'erp', entityType: 'pos_session', entityId: session.id, entityName: sessionNumber })

      return { session }
    },
    {
      isSignIn: true,
      body: t.Object({
        warehouseId: t.String(),
        openingBalance: t.Number({ minimum: 0 }),
        currency: t.String(),
      }),
    },
  )
  .get('/session', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.cashierId) filter.cashierId = query.cashierId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'openedAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.posSessions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { sessions: result.items, ...result }
  }, { isSignIn: true })
  .get('/session/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const session = await r.posSessions.findOne({ id, orgId } as any)
    if (!session) return status(404, { message: 'POS session not found' })
    return { session }
  }, { isSignIn: true })
  .post(
    '/session/:id/close',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const session = await r.posSessions.findOne({ id, orgId } as any) as any
      if (!session) return status(404, { message: 'POS session not found' })
      if (session.status === 'closed') return status(400, { message: 'Session already closed' })

      const expectedBalance = session.openingBalance + session.totalCash
      const updated = await r.posSessions.update(id, {
        status: 'closed',
        closedAt: new Date(),
        closingBalance: body.closingBalance,
        expectedBalance,
        difference: body.closingBalance - (expectedBalance || 0),
      } as any)

      createAuditEntry({ orgId, userId: user.id, operatorCode: user.operatorCode, action: 'close', module: 'erp', entityType: 'pos_session', entityId: id, entityName: session.sessionNumber })

      return { session: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        closingBalance: t.Number(),
      }),
    },
  )
  // ── Transactions ──
  .post(
    '/session/:id/transaction',
    async ({ params: { orgId, id: sessionId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const session = await r.posSessions.findOne({ id: sessionId, orgId } as any) as any
      if (!session) return status(404, { message: 'POS session not found' })
      if (session.status === 'closed') return status(400, { message: 'Session is closed' })

      // H5: Server-side total validation
      let verified: ReturnType<typeof validateTotals>
      try {
        verified = validateTotals(body)
      } catch (e: any) {
        return status(400, { message: e.message })
      }

      // Look up fiscal device
      let fiscal: { deviceId: string; deviceNumber: string; printer: IFiscalPrinter } | null = null
      try {
        fiscal = await getFiscalContext(orgId, session.warehouseId)
      } catch (e: any) {
        return status(503, { message: e.message })
      }

      // Generate УНП if fiscal device is available
      const operatorCode = user.operatorCode || '0000'
      let unpNumber: string | undefined
      if (fiscal) {
        unpNumber = await generateUNP(orgId, fiscal.deviceNumber, operatorCode)
      }

      const transactionNumber = await getNextNumber(orgId, 'TXN', 7)

      const transaction = await r.posTransactions.create({
        ...body,
        orgId,
        sessionId,
        transactionNumber,
        status: 'completed',
        // Use server-validated totals
        subtotal: verified.subtotal,
        discountTotal: verified.discountTotal,
        taxTotal: verified.taxTotal,
        total: verified.total,
        changeDue: verified.changeDue,
        unpNumber,
        fiscalDeviceNumber: fiscal?.deviceNumber,
        isFiscal: !!fiscal,
        createdBy: user.id,
      } as any)

      // ── Fiscal receipt printing ──
      let fiscalReceiptNumber: string | undefined
      if (fiscal && body.type === 'sale') {
        try {
          const operatorName = `${user.firstName} ${user.lastName}`
          await fiscal.printer.openFiscalReceipt(operatorCode, operatorName, unpNumber!)

          for (const line of body.lines) {
            const isService = line.type === 'service'
            const vatGroup = mapTaxRateToVatGroup(line.taxRate ?? 0, isService)
            await fiscal.printer.printSaleLine(line.name, line.quantity, line.unitPrice, vatGroup, line.discount)
          }

          for (const payment of body.payments) {
            await fiscal.printer.printPayment(toFiscalPaymentType(payment.method), payment.amount)
          }

          const receiptResult = await fiscal.printer.closeFiscalReceipt()
          fiscalReceiptNumber = receiptResult.fiscalReceiptNumber

          await r.posTransactions.update(transaction.id, {
            fiscalReceiptNumber,
            printedAt: new Date(),
          } as any)

          await r.fiscalDevices.update(fiscal.deviceId, {
            lastCommunicationAt: new Date(),
            status: 'online',
          } as any)

          logger.info({ transactionId: transaction.id, unpNumber, fiscalReceiptNumber }, 'Fiscal receipt printed')
        } catch (e: any) {
          // C3: Attempt to close/cancel the partially opened receipt
          try {
            await fiscal.printer.closeFiscalReceipt()
          } catch { /* printer may not have an open receipt */ }

          logger.error({ transactionId: transaction.id, unpNumber, error: e.message }, 'Fiscal receipt printing FAILED')
          await r.fiscalDevices.update(fiscal.deviceId, { status: 'error' } as any)
        }
      }

      // H1: Atomic session total updates using MongoDB $inc
      const incData: Record<string, number> = { transactionCount: 1 }
      if (body.type === 'sale') incData.totalSales = verified.total
      else if (body.type === 'return') incData.totalReturns = verified.total

      const cashPayment = body.payments.filter((p: any) => p.method === 'cash').reduce((s: number, p: any) => s + p.amount, 0)
      const cardPayment = body.payments.filter((p: any) => p.method === 'card').reduce((s: number, p: any) => s + p.amount, 0)
      if (cashPayment) incData.totalCash = cashPayment
      if (cardPayment) incData.totalCard = cardPayment

      await POSSession.findByIdAndUpdate(sessionId, { $inc: incData }).exec()

      // Stock movement for sales
      if (body.type === 'sale') {
        try {
          const productLines = body.lines.filter((l: any) => l.productId)
          if (productLines.length > 0) {
            const movementNumber = await getNextNumber(orgId, 'SM', 5)
            const movementLines = productLines.map((l: any) => ({
              productId: l.productId,
              quantity: l.quantity,
              unitCost: l.unitPrice,
              totalCost: l.quantity * l.unitPrice,
            }))
            const totalAmount = movementLines.reduce((s: number, l: any) => s + l.totalCost, 0)

            const movement = await r.stockMovements.create({
              orgId, movementNumber, type: 'dispatch', status: 'draft', date: new Date(),
              fromWarehouseId: session.warehouseId, lines: movementLines, totalAmount,
              notes: `POS sale ${transactionNumber}`, createdBy: user.id,
            } as any)

            await confirmMovement(movement.id, r)
            await r.posTransactions.update(transaction.id, { movementId: movement.id } as any)
          }
        } catch (e: any) {
          logger.warn({ transactionId: transaction.id, error: e.message }, 'POS stock movement failed')
        }
      }

      createAuditEntry({ orgId, userId: user.id, operatorCode, action: 'create', module: 'erp', entityType: 'pos_transaction', entityId: transaction.id, entityName: transactionNumber, unpNumber })

      return { transaction: { ...transaction, fiscalReceiptNumber, unpNumber } }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.Union([t.Literal('sale'), t.Literal('return'), t.Literal('exchange')]),
        customerId: t.Optional(t.String()),
        lines: t.Array(t.Object({
          productId: t.String(),
          name: t.String(),
          quantity: t.Number({ minimum: 1 }),
          unitPrice: t.Number(),
          discount: t.Optional(t.Number()),
          taxRate: t.Optional(t.Number()),
          taxAmount: t.Optional(t.Number()),
          lineTotal: t.Number(),
          type: t.Optional(t.String()),
          priceExplanation: t.Optional(t.Array(t.Object({
            type: t.Union([t.Literal('base'), t.Literal('tag'), t.Literal('contact'), t.Literal('override')]),
            label: t.String(),
            price: t.Number(),
          }))),
        })),
        subtotal: t.Number(),
        discountTotal: t.Optional(t.Number()),
        taxTotal: t.Optional(t.Number()),
        total: t.Number(),
        payments: t.Array(t.Object({
          method: t.Union([t.Literal('cash'), t.Literal('card'), t.Literal('mobile'), t.Literal('voucher')]),
          amount: t.Number(),
          reference: t.Optional(t.String()),
        })),
        changeDue: t.Optional(t.Number()),
      }),
    },
  )
  .get('/session/:id/transaction', async ({ params: { orgId, id: sessionId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const filter: Record<string, any> = { orgId, sessionId }
    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1
    const result = await r.posTransactions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { transactions: result.items, ...result }
  }, { isSignIn: true })
  // ── Storno (Appendix 29 compliance) ──
  .post(
    '/session/:id/storno',
    async ({ params: { orgId, id: sessionId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      // H4: Storno requires manager or admin role
      if (!['admin', 'manager', 'warehouse_manager'].includes(user.role)) {
        return status(403, { message: 'Storno requires manager or admin authorization' })
      }

      const r = getRepos()

      const session = await r.posSessions.findOne({ id: sessionId, orgId } as any) as any
      if (!session) return status(404, { message: 'POS session not found' })
      if (session.status === 'closed') return status(400, { message: 'Session is closed' })

      const original = await r.posTransactions.findOne({ id: body.originalTransactionId, orgId } as any) as any
      if (!original) return status(404, { message: 'Original transaction not found' })
      if (original.status === 'cancelled') return status(400, { message: 'Original transaction is already cancelled' })
      if (original.type === 'storno') return status(400, { message: 'Cannot storno a storno transaction' })

      let fiscal: { deviceId: string; deviceNumber: string; printer: IFiscalPrinter } | null = null
      try {
        fiscal = await getFiscalContext(orgId, session.warehouseId)
      } catch (e: any) {
        return status(503, { message: e.message })
      }

      const operatorCode = user.operatorCode || '0000'
      let unpNumber: string | undefined
      if (fiscal) {
        unpNumber = await generateUNP(orgId, fiscal.deviceNumber, operatorCode)
      }

      const transactionNumber = await getNextNumber(orgId, 'TXN', 7)

      const stornoTransaction = await r.posTransactions.create({
        orgId, sessionId, transactionNumber, type: 'storno', status: 'completed',
        customerId: original.customerId, lines: original.lines,
        subtotal: original.subtotal, discountTotal: original.discountTotal,
        taxTotal: original.taxTotal, total: original.total,
        payments: body.payments || original.payments, changeDue: 0,
        unpNumber, fiscalDeviceNumber: fiscal?.deviceNumber, isFiscal: !!fiscal,
        originalTransactionId: original.id, originalUNP: original.unpNumber,
        originalFiscalReceiptNumber: original.fiscalReceiptNumber,
        originalTransactionDate: original.createdAt, stornoReason: body.reason,
        createdBy: user.id,
      } as any)

      // C2: Mark original transaction as cancelled
      await r.posTransactions.update(original.id, { status: 'cancelled' } as any)

      // Fiscal storno receipt printing
      let fiscalReceiptNumber: string | undefined
      if (fiscal && original.isFiscal && original.fiscalReceiptNumber) {
        try {
          const operatorName = `${user.firstName} ${user.lastName}`
          const stornoLines = original.lines.map((l: any) => ({
            name: l.name, quantity: l.quantity, price: l.unitPrice,
            vatGroup: mapTaxRateToVatGroup(l.taxRate ?? 0),
          }))
          const paymentMethod = body.payments?.[0]?.method || original.payments?.[0]?.method || 'cash'

          const stornoResult = await fiscal.printer.printStornoReceipt(
            operatorCode, operatorName, unpNumber!,
            original.fiscalReceiptNumber, original.createdAt, original.unpNumber,
            body.reason, stornoLines,
            { type: toFiscalPaymentType(paymentMethod), amount: original.total },
          )
          fiscalReceiptNumber = stornoResult.fiscalReceiptNumber

          await r.posTransactions.update(stornoTransaction.id, { fiscalReceiptNumber, printedAt: new Date() } as any)
          logger.info({ transactionId: stornoTransaction.id, unpNumber, fiscalReceiptNumber }, 'Storno fiscal receipt printed')
        } catch (e: any) {
          logger.error({ transactionId: stornoTransaction.id, error: e.message }, 'Storno fiscal receipt printing FAILED')
          if (fiscal) await r.fiscalDevices.update(fiscal.deviceId, { status: 'error' } as any)
        }
      }

      // H1: Atomic session total update
      await POSSession.findByIdAndUpdate(sessionId, {
        $inc: { totalReturns: original.total, transactionCount: 1 },
      }).exec()

      // Reverse stock movement
      if (original.movementId) {
        try {
          const movementNumber = await getNextNumber(orgId, 'SM', 5)
          const movementLines = original.lines.filter((l: any) => l.productId).map((l: any) => ({
            productId: l.productId, quantity: l.quantity, unitCost: l.unitPrice, totalCost: l.quantity * l.unitPrice,
          }))
          const totalAmount = movementLines.reduce((s: number, l: any) => s + l.totalCost, 0)

          const reverseMovement = await r.stockMovements.create({
            orgId, movementNumber, type: 'return', status: 'draft', date: new Date(),
            toWarehouseId: session.warehouseId, lines: movementLines, totalAmount,
            notes: `Storno reversal for ${original.transactionNumber}`, createdBy: user.id,
          } as any)

          await confirmMovement(reverseMovement.id, r)
          await r.posTransactions.update(stornoTransaction.id, { movementId: reverseMovement.id } as any)
        } catch (e: any) {
          logger.warn({ transactionId: stornoTransaction.id, error: e.message }, 'Storno stock reversal failed')
        }
      }

      createAuditEntry({ orgId, userId: user.id, operatorCode, action: 'storno', module: 'erp', entityType: 'pos_transaction', entityId: stornoTransaction.id, entityName: `${transactionNumber} (storno of ${original.transactionNumber})`, unpNumber })

      return { transaction: { ...stornoTransaction, fiscalReceiptNumber, unpNumber } }
    },
    {
      isSignIn: true,
      body: t.Object({
        originalTransactionId: t.String(),
        reason: t.Union([t.Literal('operator_error'), t.Literal('customer_return'), t.Literal('price_reduction'), t.Literal('tax_base_reduction')]),
        payments: t.Optional(t.Array(t.Object({
          method: t.Union([t.Literal('cash'), t.Literal('card'), t.Literal('mobile'), t.Literal('voucher')]),
          amount: t.Number(),
          reference: t.Optional(t.String()),
        }))),
      }),
    },
  )
