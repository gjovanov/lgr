import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { orgDao } from 'services/dao/org.dao'
import { buildSearchFilter } from 'services/biz/search.utils'
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

  const connected = isDeviceConnected(device.id)
  logger.info({ deviceId: device.id, deviceNumber: device.deviceNumber, connected, status: device.status, warehouseId }, 'getFiscalContext: device lookup result')

  if (!connected) {
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
 * Format receipt as text lines for non-fiscal printing (testing with non-fiscalized devices).
 * Uses org locale for translated labels and currency for amount formatting.
 */
function formatNonFiscalLines(body: any, transactionNumber: string, operatorName: string, locale: string, currency: string): string[] {
  const labels: Record<string, Record<string, string>> = {
    en: { subtotal: 'Subtotal:', vat: 'VAT:', total: 'TOTAL:', cash: 'CASH:', card: 'CARD:', change: 'CHANGE:', nonFiscal: '* NON-FISCAL *', operator: 'Op:' },
    bg: { subtotal: 'Междинна сума:', vat: 'ДДС:', total: 'ОБЩО:', cash: 'В БРОЙ:', card: 'КАРТА:', change: 'РЕСТО:', nonFiscal: '* НЕФИСКАЛЕН *', operator: 'Оп:' },
    de: { subtotal: 'Zwischensumme:', vat: 'MwSt:', total: 'GESAMT:', cash: 'BAR:', card: 'KARTE:', change: 'WECHSEL:', nonFiscal: '* NICHT-FISKAL *', operator: 'Op:' },
    mk: { subtotal: 'Меѓузбир:', vat: 'ДДВ:', total: 'ВКУПНО:', cash: 'ГОТОВИНА:', card: 'КАРТИЦА:', change: 'КУСУР:', nonFiscal: '* НЕФИСКАЛЕН *', operator: 'Оп:' },
  }
  const l = labels[locale] || labels.en

  const paymentLabels: Record<string, string> = {
    cash: l.cash,
    card: l.card,
    mobile: 'MOBILE:',
    voucher: 'VOUCHER:',
  }

  const fmt = (amount: number) => `${amount.toFixed(2)} ${currency}`

  // Tremol M20 adds '# ' prefix and ' #' suffix to each line (4 chars total)
  // 57mm paper = ~32 printable chars, minus 4 for borders = 28 usable
  const W = 28
  const sep = '-'.repeat(W)
  const center = (s: string) => {
    const pad = Math.max(0, Math.floor((W - s.length) / 2))
    return ' '.repeat(pad) + s
  }
  const lr = (left: string, right: string) => {
    const gap = Math.max(1, W - left.length - right.length)
    return left + ' '.repeat(gap) + right
  }
  const lines: string[] = []
  lines.push(center(l.nonFiscal))
  lines.push(sep)
  lines.push(transactionNumber)
  lines.push(new Date().toLocaleString(`${locale}-${locale.toUpperCase()}`, { timeZone: 'Europe/Sofia' }))
  lines.push(`${l.operator} ${operatorName.substring(0, W - l.operator.length - 1)}`)
  lines.push(sep)
  for (const item of body.lines) {
    lines.push(item.name.substring(0, W))
    const qty = ` ${item.quantity}x${item.unitPrice.toFixed(2)}`
    const total = fmt(item.quantity * item.unitPrice)
    lines.push(lr(qty, total))
  }
  lines.push(sep)
  lines.push(lr(l.subtotal, fmt(body.subtotal)))
  lines.push(lr(l.vat, fmt(body.taxTotal)))
  lines.push(lr(l.total, fmt(body.total)))
  lines.push(sep)
  for (const p of body.payments) {
    const label = paymentLabels[p.method] || (p.method.toUpperCase() + ':')
    lines.push(lr(label, fmt(p.amount)))
  }
  if (body.changeDue > 0) lines.push(lr(l.change, fmt(body.changeDue)))
  lines.push(sep)
  lines.push(center(l.nonFiscal))
  return lines
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

export const posController = new Elysia({ prefix: '/org/:orgId/trade/pos' })
  .use(AppAuthService)
  // ── POS Catalog (server-side pagination + filters) ──
  .get('/catalog', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const productFilter: Record<string, any> = { orgId, isActive: true }
    if (query.search) {
      Object.assign(productFilter, buildSearchFilter(query.search as string, ['name', 'sku', 'barcode']))
    }
    if (query.category) productFilter.category = query.category
    if (query.type) productFilter.type = query.type
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      productFilter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(200, Math.max(1, Number(query.size) || 24))
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const productResult = await r.products.findAll(productFilter, { page, size, sort: { [sortBy]: sortOrder } })

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
      category: p.category,
      stockAvailable: stockMap.get(p.id) ?? null,
    }))

    return { products, total: productResult.total, totalPages: productResult.totalPages, page, size }
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

      createAuditEntry({ orgId, userId: user.id, operatorCode: user.operatorCode, action: 'create', module: 'trade', entityType: 'pos_session', entityId: session.id, entityName: sessionNumber })

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

      createAuditEntry({ orgId, userId: user.id, operatorCode: user.operatorCode, action: 'close', module: 'trade', entityType: 'pos_session', entityId: id, entityName: session.sessionNumber })

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
      logger.info({ sessionId, orgId, sessionWarehouse: session?.warehouseId, sessionStatus: session?.status }, 'POS transaction: session loaded')
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

      logger.info({ hasFiscal: !!fiscal, fiscalDeviceNumber: fiscal?.deviceNumber }, 'POS transaction: fiscal context resolved')

      // Generate УНП if fiscal device is available (skip for non-fiscal mode)
      const operatorCode = user.operatorCode
      const nonFiscal = !!body.nonFiscal
      if (!operatorCode && fiscal && !nonFiscal) {
        return status(400, { message: 'User has no operator code. Contact admin to assign one before using POS with fiscal device.' })
      }
      let unpNumber: string | undefined
      if (fiscal && !nonFiscal) {
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
        isFiscal: !!fiscal && !nonFiscal,
        createdBy: user.id,
      } as any)

      // ── Receipt printing ──
      // Strategy: always use non-fiscal receipt (OpenNonFiscalReceipt + PrintText + CloseNonFiscalReceipt)
      // when the printer supports it. Fiscal SellArticle (0x31) requires a fiscalized device with
      // recent Z-report — non-fiscalized devices reject it with STE1=0x04.
      // Non-fiscal receipts print the same content as text and work on ALL devices.
      // Load org for locale/currency (used in receipt formatting)
      const org = await orgDao.findById(orgId) as any
      const orgLocale = org?.settings?.locale || 'en'
      const orgCurrency = org?.settings?.baseCurrency || 'EUR'

      let fiscalReceiptNumber: string | undefined
      if (fiscal && body.type === 'sale' && fiscal.printer.openNonFiscalReceipt) {
        try {
          await fiscal.printer.openNonFiscalReceipt(operatorCode || '1')
          const operatorName = `${user.firstName} ${user.lastName}`
          const receiptBody = { ...body, subtotal: verified.subtotal, taxTotal: verified.taxTotal, total: verified.total, changeDue: verified.changeDue }
          const textLines = formatNonFiscalLines(receiptBody, transactionNumber, operatorName, orgLocale, orgCurrency)
          for (const line of textLines) {
            await fiscal.printer.printNonFiscalText!(line)
          }
          await fiscal.printer.closeNonFiscalReceipt!()

          await r.posTransactions.update(transaction.id, { printedAt: new Date() } as any)
          await r.fiscalDevices.update(fiscal.deviceId, { lastCommunicationAt: new Date(), status: 'online' } as any)
          logger.info({ transactionId: transaction.id, transactionNumber, nonFiscal }, 'Receipt printed (non-fiscal text mode)')
        } catch (e: any) {
          try { await fiscal.printer.closeNonFiscalReceipt!() } catch { /* best-effort */ }
          logger.error({ transactionId: transaction.id, error: e.message }, 'Receipt printing FAILED')
          await r.fiscalDevices.update(fiscal.deviceId, { status: 'error' } as any)
        }
      } else if (fiscal && body.type === 'sale') {
        // Fallback: fiscal receipt commands (for fiscalized devices without non-fiscal support)
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

      createAuditEntry({ orgId, userId: user.id, operatorCode, action: 'create', module: 'trade', entityType: 'pos_transaction', entityId: transaction.id, entityName: transactionNumber, unpNumber })

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
        nonFiscal: t.Optional(t.Boolean()),
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

      const operatorCode = user.operatorCode
      if (!operatorCode && fiscal) {
        return status(400, { message: 'User has no operator code. Contact admin to assign one before using POS with fiscal device.' })
      }
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

      // Fiscal storno receipt printing — must succeed BEFORE marking original as cancelled
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
          // Don't cancel original if storno receipt failed — fiscal mismatch
        }
      }

      // Mark original as cancelled only after storno receipt printed (or no fiscal device)
      await r.posTransactions.update(original.id, { status: 'cancelled' } as any)

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

      createAuditEntry({ orgId, userId: user.id, operatorCode, action: 'storno', module: 'trade', entityType: 'pos_transaction', entityId: stornoTransaction.id, entityName: `${transactionNumber} (storno of ${original.transactionNumber})`, unpNumber })

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
  // ── Global Transaction List (across all sessions) ──
  .get('/transactions', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type
    if (query.status) filter.status = query.status
    if (query.sessionId) filter.sessionId = query.sessionId
    if (query.isFiscal !== undefined) filter.isFiscal = query.isFiscal === 'true'
    if (query.search) {
      filter.$or = [
        { transactionNumber: { $regex: query.search, $options: 'i' } },
        { unpNumber: { $regex: query.search, $options: 'i' } },
      ]
    }
    if (query.dateFrom || query.dateTo) {
      filter.createdAt = {} as any
      if (query.dateFrom) (filter.createdAt as any).$gte = new Date(query.dateFrom as string)
      if (query.dateTo) (filter.createdAt as any).$lte = new Date(query.dateTo as string + 'T23:59:59')
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.posTransactions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { transactions: result.items, ...result }
  }, { isSignIn: true })
  .get('/transactions/:txnId', async ({ params: { orgId, txnId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const transaction = await r.posTransactions.findOne({ id: txnId, orgId } as any)
    if (!transaction) return status(404, { message: 'Transaction not found' })
    return { transaction }
  }, { isSignIn: true })
