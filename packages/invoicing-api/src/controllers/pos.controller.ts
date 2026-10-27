import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { buildProductSearchFilter } from 'services/biz/search.utils'
import { createAuditEntry, generateCorrelationId } from 'services/biz/audit-log.service'
import { eventBus } from 'services/events/event-bus'
import { nextRegistryNumber } from 'services/biz/sequence-registry'
import { assertDispatchAvailable } from 'services/biz/invoicing.service'
import { logger } from 'services/logger'
import { POSSession } from 'db/models'
import { loadPosRows } from 'services/biz/cash-register/pos-union'
import { cashRegisterRefusal } from 'services/biz/cash-register/freeze-check'
import {
  RegisterRefusal, insertRegisterDocument, runSaleSteps, settleKeyedDocument, tillSaleDocument,
} from 'services/biz/cash-register/register.service'
import { isDeviceConnected, getPrinter } from 'fiscal/fiscal-device.service'
import { maySaleOpen } from 'fiscal/device-reach'
import { computePosTotals, roundCents } from 'config/pos-totals'
import { readIdempotencyKey, requestHash, isDuplicateKey, WAIT_MS } from 'services/biz/hot-path-key'
import {
  STORNO_ROLES, findKeyedTillDocument, getFiscalContext, saleResponse, stornoDoor, tillContext, tillSettings,
} from '../lib/cash-register-till.js'

// FR-21: the till's device, its receipts and the price a device is given live with the cash-register
// service's till side; re-exported for the tests and callers that import them from here.
export { fiscalUnitPrice, formatNonFiscalLines } from '../lib/cash-register-till.js'
export { stornoRefundBuckets } from 'services/biz/cash-register/register.service'

// ── FR-09 (#18): end-of-day close ──────────────────────────────────────────

/** Payment buckets the close screen reconciles, in display order. */
export const CLOSE_METHODS = ['cash', 'card', 'other'] as const

export interface ExpectedTotals { cash: number; card: number; other: number }

/**
 * What the register SHOULD hold, from the session's own accumulators.
 *
 * Cash includes the opening float; card and other do not — nobody starts the day with a
 * card balance. Note this reads the session totals rather than `expectedBalance`, which is
 * only written at close.
 */
export function expectedTotals(session: any): ExpectedTotals {
  return {
    cash: round2((session.openingBalance || 0) + (session.totalCash || 0)),
    card: round2(session.totalCard || 0),
    other: round2(session.totalOther || 0),
  }
}

export function buildClosingBreakdown(expected: ExpectedTotals, counted: Record<string, number | undefined>) {
  return CLOSE_METHODS.map(method => {
    const exp = round2(expected[method] || 0)
    const got = round2(Number(counted?.[method]) || 0)
    return { method, expected: exp, counted: got, difference: round2(got - exp) }
  })
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

/**
 * The device to close the fiscal day on. Unlike `getFiscalContext` (which is about printing
 * a receipt and returns null for an offline device), this returns the CONFIGURED device
 * regardless of connection state — an unreachable device must produce a loud fiscal error,
 * not a silent skip. Prefers a connected device when a warehouse has more than one.
 */
async function resolveFiscalDeviceForClose(orgId: string, warehouseId: string): Promise<any | null> {
  const r = getRepos()
  const devices = await r.fiscalDevices.findMany({ orgId, warehouseId, isActive: true } as any) as any[]
  if (!devices?.length) return null
  return devices.find(d => isDeviceConnected(d.id)) || devices[0]
}

/**
 * Turn a printer error into something a cashier can act on. The transport layer throws
 * plain `Error`s with no codes, so this matches on their text — see the error inventory in
 * FR-09 §1 (`not connected`, `timeout`, `NAK`, `bridge disconnected`).
 */
function fiscalErrorMessage(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes('not connected') || m.includes('disconnected') || m.includes('timeout')) {
    return `Няма връзка с фискалното устройство. Денят НЕ е приключен. (${raw})`
  }
  return `Фискалното устройство върна грешка. Денят НЕ е приключен. (${raw})`
}

/**
 * Recalculate and validate totals from line items (H5: server-side validation).
 * Returns the verified totals or throws on mismatch.
 */
function validateTotals(body: any) {
  // The same function the terminal computes its screen with, so they cannot disagree.
  const { subtotal, discountTotal, taxTotal, total } = computePosTotals(body.lines)

  // The tolerance only serves clients that still round their own way (an open tab from
  // before the shared computation shipped); the current terminal sends exactly `total`.
  if (Math.abs(total - body.total) > 0.02) {
    throw new Error(`Total mismatch: calculated ${total.toFixed(2)}, received ${body.total.toFixed(2)}`)
  }

  const paymentTotal = body.payments.reduce((s: number, p: any) => s + p.amount, 0)
  if (paymentTotal < total - 0.02) {
    throw new Error(`Insufficient payment: total ${total.toFixed(2)}, paid ${paymentTotal.toFixed(2)}`)
  }

  return {
    subtotal,
    discountTotal,
    taxTotal,
    total,
    // Never negative: a cent short inside the tolerance is a shortfall, not change owed.
    changeDue: Math.max(0, roundCents(paymentTotal - total)),
  }
}

/** The body of a POS sale. */
const SALE_BODY = t.Object({
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
})

// ── The terminals' catalog ──────────────────────────────────────────────────────────────────
// `GET /catalog` is the product grid of the till (PosTerminalView) and of the cash-sale terminal
// (CashSaleTerminal); `GET /catalog/lookup` is the one product Enter adds from their search.

/** The grid's filter: active products, the typed search, and the category / type / tag filters. */
function catalogFilter(orgId: string, query: Record<string, any>): Record<string, any> {
  const productFilter: Record<string, any> = { orgId, isActive: true }
  if (query.search) {
    // The same search the inventory product list runs (see buildProductSearchFilter).
    Object.assign(productFilter, buildProductSearchFilter(query.search as string))
  }
  if (query.category) productFilter.category = query.category
  if (query.type) productFilter.type = query.type
  if (query.tags) {
    const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
    productFilter.tags = { $in: tagList }
  }
  return productFilter
}

/** Products the way a terminal shows them, with the stock of `warehouseId` when one is given. */
async function toCatalogProducts(orgId: string, items: any[], warehouseId: unknown) {
  const stockMap = new Map<string, number>()
  if (warehouseId && items.length > 0) {
    const productIds = items.map((p: any) => p.id)
    const stockLevels = await getRepos().stockLevels.findMany(
      { orgId, warehouseId, productId: { $in: productIds } } as any,
    )
    for (const sl of stockLevels) {
      stockMap.set(sl.productId, sl.quantity)
    }
  }
  return items.map((p: any) => ({
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
}

type CodeMatch = 'barcode' | 'sku' | 'search'

/**
 * FR-22.55: the product Enter adds from a terminal's search. A barcode scanner types the code
 * and presses Enter within milliseconds, long before the search's 300 ms debounce has filtered
 * the grid, so the terminal asks here instead of counting the cards it shows.
 *
 * The first rung that matches anything decides:
 *   1. the barcode is the code: as typed, then ignoring case;
 *   2. the SKU is the code, the same way (a barcode outranks a SKU: a scanner reads barcodes);
 *   3. no exact match: the grid's own search, with the grid's filters, finds exactly one product.
 * Two products on the deciding rung answer `null`, as does a search finding several: a scan is
 * never guessed, and the terminal shows the search instead. Only active products, as in the
 * grid. The exact rungs ignore the grid's category / type / tag filters: a scanned article is
 * that article, whatever the cashier was browsing.
 */
async function lookupCatalogCode(
  orgId: string,
  code: string,
  query: Record<string, any>,
): Promise<{ product: any; matchedBy: CodeMatch } | null> {
  const r = getRepos()
  const lower = code.toLocaleLowerCase('bg')
  // The raw fields as well as the `*Lower` mirrors: a product written past the mirror hooks
  // (a bulkWrite) is still found by the code exactly as printed on it.
  const exact = await r.products.findAll({
    orgId,
    isActive: true,
    $or: [{ barcode: code }, { barcodeLower: lower }, { sku: code }, { skuLower: lower }],
  } as any, { page: 0, size: 20, sort: { name: 1 } })
  const folded = (v: unknown) => (typeof v === 'string' ? v.toLocaleLowerCase('bg') : undefined)
  const rungs: Array<[CodeMatch, (p: any) => boolean]> = [
    ['barcode', p => p.barcode === code],
    ['barcode', p => folded(p.barcode) === lower],
    ['sku', p => p.sku === code],
    ['sku', p => folded(p.sku) === lower],
  ]
  for (const [matchedBy, matches] of rungs) {
    const hits = exact.items.filter(matches)
    if (hits.length === 1) return { product: hits[0], matchedBy }
    if (hits.length > 1) return null
  }
  const found = await r.products.findAll(catalogFilter(orgId, { ...query, search: code }), { page: 0, size: 2, sort: { name: 1 } })
  return found.total === 1 ? { product: found.items[0], matchedBy: 'search' } : null
}

/**
 * A page of till rows: sorted on `sortBy` (newest first by default) and paged after the union, in
 * the shape these routes always answered (the DAL's page).
 */
function pageOf(rows: any[], query: Record<string, any>) {
  const page = Math.max(0, Number(query.page) || 0)
  const size = query.size !== undefined ? Number(query.size) : 10
  const sortBy = (query.sortBy as string) || 'createdAt'
  const dir = (query.sortOrder as string) === 'asc' ? 1 : -1
  const key = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' && sortBy.endsWith('At') ? Date.parse(v) : v) as any
  rows.sort((a, b) => {
    const x = key(a[sortBy])
    const y = key(b[sortBy])
    return (x === y ? 0 : x === undefined || x === null ? -1 : y === undefined || y === null ? 1 : x < y ? -1 : 1) * dir
  })

  const total = rows.length
  const items = size > 0 ? rows.slice(page * size, page * size + size) : rows
  return {
    transactions: items,
    items,
    total,
    page: size > 0 ? page : 0,
    size: size > 0 ? size : items.length,
    totalPages: size > 0 ? Math.ceil(total / size) : 1,
  }
}

export const posController = new Elysia({ prefix: '/org/:orgId/trade/pos' })
  .use(AppAuthService)
  // FR-21.28: the till is refused, with the reason, until its history may be read from documents only.
  .onBeforeHandle(async ({ status }) => {
    const refusal = await cashRegisterRefusal()
    if (refusal) return status(503, refusal)
  })
  // ── POS Catalog (server-side pagination + filters) ──
  .get('/catalog', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(200, Math.max(1, Number(query.size) || 24))
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const productResult = await r.products.findAll(catalogFilter(orgId, query), { page, size, sort: { [sortBy]: sortOrder } })
    const products = await toCatalogProducts(orgId, productResult.items, query.warehouseId)

    return { products, total: productResult.total, totalPages: productResult.totalPages, page, size }
  }, { isSignIn: true })
  // FR-22.55: the one product Enter adds from the till's or the cash-sale terminal's search —
  // `{ product, matchedBy }`, or `{ product: null }` when the code names nothing unambiguously.
  // `warehouseId`, `category`, `type` and `tags` are the grid's own parameters.
  .get('/catalog/lookup', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const code = typeof query.code === 'string' ? query.code.trim() : ''
    const hit = code ? await lookupCatalogCode(orgId, code, query) : null
    if (!hit) return { product: null, matchedBy: null }
    const [product] = await toCatalogProducts(orgId, [hit.product], query.warehouseId)
    return { product, matchedBy: hit.matchedBy }
  }, { isSignIn: true })
  // ── Sessions ──
  .post(
    '/session',
    async ({ params: { orgId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }
      const hash = key ? requestHash('pos.session.open', body) : undefined
      /** A retried open returns the session it opened — before the "already open" check would refuse it. */
      const replay = async (keyed: any) => {
        if (keyed.requestHash !== hash) {
          return status(422, { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' })
        }
        return { session: await r.posSessions.findById(String(keyed._id)) }
      }
      if (key) {
        const keyed = await POSSession.findOne({ orgId, clientKey: key }).lean().exec()
        if (keyed) return replay(keyed)
      }

      const existing = await r.posSessions.findOne({ orgId, cashierId: user.id, status: 'open' } as any)
      if (existing) return status(400, { message: 'You already have an open session' })

      try {
        await getFiscalContext(orgId, body.warehouseId)
      } catch (e: any) {
        return status(503, { message: e.message })
      }

      const sessionNumber = await nextRegistryNumber(orgId, 'pos_session')

      let session: any
      try {
        session = await r.posSessions.create({
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
          ...(key ? { clientKey: key, requestHash: hash } : {}),
        } as any)
      } catch (e: any) {
        // A concurrent duplicate of this open won the insert: answer with its session.
        if (!key || !(isDuplicateKey(e) || e?.code === 'DUPLICATE')) throw e
        const keyed = await POSSession.findOne({ orgId, clientKey: key }).lean().exec()
        if (!keyed) throw e
        return replay(keyed)
      }

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
  /**
   * FR-9.8 — what the operator sees BEFORE committing: the expected amount per method, the
   * fiscal device that will be used, and whether anyone else still has this warehouse open
   * (a Z-report zeroes the DEVICE's fiscal day, not just one session).
   */
  .get('/session/:id/close-preview', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const session = await r.posSessions.findOne({ id, orgId } as any) as any
    if (!session) return status(404, { message: 'POS session not found' })

    const device = await resolveFiscalDeviceForClose(orgId, String(session.warehouseId))
    const openOnWarehouse = await POSSession.countDocuments({
      orgId, warehouseId: session.warehouseId, status: 'open', _id: { $ne: id },
    }).exec()

    return {
      expected: expectedTotals(session),
      currency: session.currency,
      openSessionsOnWarehouse: openOnWarehouse,
      fiscalDevice: device
        ? { id: device.id, name: device.name, deviceNumber: device.deviceNumber, connected: isDeviceConnected(device.id) }
        : null,
    }
  }, { isSignIn: true })

  /**
   * FR-9.3–9.6 — the real close.
   *
   * Order matters and is the whole point: **the Z-report runs FIRST**, and the session is
   * only marked closed once the device confirms. The old flow closed the session
   * unconditionally and never spoke to the printer at all, so a day could read as closed in
   * LGR while the fiscal device still had it open — exactly the state the ordinance exists
   * to prevent.
   *
   * Backward compatible: the legacy `{ closingBalance }` body still works and maps to
   * `counted.cash` (existing e2e and any API clients depend on it).
   */
  .post(
    '/session/:id/close',
    async ({ params: { orgId, id }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()
      const b = body as any

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }
      const hash = key ? requestHash(`pos.session.close:${id}`, body) : undefined

      /**
       * The close this key already made, or the one in progress under it. A retry after a
       * successful close gets that close back — never a second Z-report, never "already
       * closed". A close that failed was released (its key cleared), so its retry closes anew.
       */
      const replayClose = async (): Promise<any> => {
        const deadline = Date.now() + WAIT_MS
        for (;;) {
          const s = await POSSession.findOne({ _id: id, orgId }).lean().exec() as any
          if (!s || s.closeClientKey !== key) return null
          if (s.closeRequestHash !== hash) {
            return status(422, { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' })
          }
          if (s.status === 'closed') {
            return { session: await r.posSessions.findByIdInOrg(id, orgId), fiscalStatus: s.fiscalStatus, zReportNumber: s.zReportNumber }
          }
          if (Date.now() >= deadline) {
            return status(409, { code: 'idempotency_in_progress', message: 'This close is still being processed — retry with the same Idempotency-Key.' })
          }
          await new Promise(res => setTimeout(res, 150))
        }
      }

      const session = await r.posSessions.findOne({ id, orgId } as any) as any
      if (!session) return status(404, { message: 'POS session not found' })
      if (key && session.closeClientKey === key) {
        const replayed = await replayClose()
        if (replayed) return replayed
      }
      if (session.status === 'closed') return status(400, { message: 'Session already closed' })

      // The cashier who owns the session may close it; anyone else needs a manager role.
      const isManager = user.role === 'admin' || user.role === 'manager'
      if (String(session.cashierId) !== String(user.id) && !isManager) {
        return status(403, { message: 'Only the session owner or a manager can close it' })
      }

      // Legacy single-number body maps onto the cash line.
      const counted = b.counted ?? { cash: Number(b.closingBalance) || 0 }
      const expected = expectedTotals(session)

      /**
       * A conditional transition, not a read-then-write: two tills hitting Close at once
       * used to both proceed, each firing its own Z-report. The loser now sees "already
       * closing" instead.
       */
      const claimed = await POSSession.findOneAndUpdate(
        { _id: id, orgId, status: 'open' },
        { $set: { status: 'closing_control', ...(key ? { closeClientKey: key, closeRequestHash: hash } : {}) } },
        { new: true },
      ).exec()
      if (!claimed) {
        // A concurrent duplicate of this close holds the claim: answer as it does.
        if (key) {
          const replayed = await replayClose()
          if (replayed) return replayed
        }
        return status(400, { message: 'Session is already being closed' })
      }

      /** Put the session back the way we found it — a failed close must not strand it. */
      const release = async (fiscalStatus?: 'failed', fiscalError?: string) => {
        await POSSession.updateOne(
          { _id: id, orgId },
          {
            $set: { status: 'open', ...(fiscalStatus ? { fiscalStatus, fiscalError } : {}) },
            $unset: { closeClientKey: 1, closeRequestHash: 1 },
          },
        ).exec()
      }

      const device = await resolveFiscalDeviceForClose(orgId, String(session.warehouseId))

      let fiscalStatus: 'closed' | 'skipped' = 'skipped'
      let zReportNumber: string | undefined
      let fiscalClosedAt: Date | undefined

      if (device && b.closeWithoutFiscal) {
        // Only an explicit, privileged decision may bypass a device that exists. A
        // connected-but-failing device is NEVER silently skipped.
        if (!isManager) {
          await release()
          return status(403, { message: 'Closing without a fiscal report requires a manager' })
        }
      } else if (device) {
        try {
          const printer = getPrinter(device.id)
          const report = await printer.printDailyZReport()
          fiscalStatus = 'closed'
          fiscalClosedAt = new Date()
          // Tremol reports 'unknown' — store nothing rather than that literal, so the UI
          // can say "the fiscal day is closed" without printing a bogus number.
          const num = (report as any)?.reportNumber
          if (num && num !== 'unknown') zReportNumber = String(num)
        } catch (e: any) {
          const message = e?.message || 'Fiscal device error'
          await release('failed', message.slice(0, 300))
          // Mirror the sale path: a device that just failed is marked so the next operation
          // does not walk into it blind.
          try {
            await r.fiscalDevices.update(device.id, { status: 'error' } as any)
          } catch { /* the close outcome must not depend on this bookkeeping */ }

          logger.error({ orgId, sessionId: id, deviceId: device.id, err: message }, 'Z-report failed — session left open')
          createAuditEntry({
            orgId, userId: user.id, operatorCode: user.operatorCode, action: 'z_report_failed',
            module: 'pos', entityType: 'pos_session', entityId: id, entityName: session.sessionNumber,
          })
          return status(503, { code: 'fiscal_error', message: fiscalErrorMessage(message) })
        }
      }
      // device === null → no active device on this warehouse; close proceeds as 'skipped'.

      const breakdown = buildClosingBreakdown(expected, counted)
      const cashLine = breakdown.find(l => l.method === 'cash')!

      let updated: any
      try {
        updated = await POSSession.findOneAndUpdate(
          { _id: id, orgId },
          {
            $set: {
              status: 'closed',
              closedAt: new Date(),
              // Legacy fields keep their cash-only meaning — the JE handler reads `difference`.
              closingBalance: cashLine.counted,
              expectedBalance: cashLine.expected,
              difference: cashLine.difference,
              closingBreakdown: breakdown,
              notes: b.notes ?? session.notes,
              fiscalStatus,
              fiscalError: undefined,
              ...(zReportNumber ? { zReportNumber } : {}),
              ...(fiscalClosedAt ? { fiscalClosedAt } : {}),
              ...(device ? { fiscalDeviceId: device.id } : {}),
            },
          },
          { new: true },
        ).exec()
      } catch (e: any) {
        // FR-9 edge case 5: the fiscal day IS closed on the device but we could not record
        // it. Say so loudly — the recovery is a retry with closeWithoutFiscal.
        logger.error(
          { orgId, sessionId: id, err: e?.message },
          'Z-report succeeded but the session update failed — retry the close with closeWithoutFiscal',
        )
        await release()
        return status(500, {
          message: 'The fiscal day was closed on the device, but the session could not be updated. Retry the close without a fiscal report.',
        })
      }

      const correlationId = generateCorrelationId()
      createAuditEntry({
        orgId, userId: user.id, operatorCode: user.operatorCode, action: 'close',
        module: 'pos', entityType: 'pos_session', entityId: id, entityName: session.sessionNumber,
        correlationId,
      })
      if (fiscalStatus === 'closed') {
        createAuditEntry({
          orgId, userId: user.id, operatorCode: user.operatorCode, action: 'z_report',
          module: 'pos', entityType: 'pos_session', entityId: id,
          entityName: zReportNumber || session.sessionNumber,
          correlationId,
        })
      }

      // Emit for cross-module batch movement + journal entry creation (unchanged: async,
      // fire-and-forget — a JE failure must not un-close a fiscally closed day).
      eventBus.emit('pos.session.closed', { sessionId: id, orgId, userId: user.id })

      return { session: updated, fiscalStatus, zReportNumber }
    },
    {
      isSignIn: true,
      body: t.Object({
        /** Legacy single-number form — still accepted, maps to `counted.cash`. */
        closingBalance: t.Optional(t.Number()),
        counted: t.Optional(t.Object({
          cash: t.Number(),
          card: t.Optional(t.Number()),
          other: t.Optional(t.Number()),
        })),
        notes: t.Optional(t.String()),
        closeWithoutFiscal: t.Optional(t.Boolean()),
      }),
    },
  )
  // ── Transactions ──
  // FR-21 (R2): a till sale is a cash-register document, written by the cash-register service
  // (`services/biz/cash-register/register.service.ts`). The request and the answer are the till's as
  // they always were: the answer is the document read back as the POS row it stands for.
  .post(
    '/session/:id/transaction',
    async ({ params: { orgId, id: sessionId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }

      const session = await r.posSessions.findOne({ id: sessionId, orgId } as any) as any
      logger.info({ sessionId, orgId, sessionWarehouse: session?.warehouseId, sessionStatus: session?.status }, 'POS transaction: session loaded')
      if (!session) return status(404, { message: 'POS session not found' })

      // H5: Server-side total validation
      let verified: ReturnType<typeof validateTotals>
      try {
        verified = validateTotals(body)
      } catch (e: any) {
        return status(400, { message: e.message })
      }
      const nonFiscal = !!body.nonFiscal
      const hash = key ? requestHash(`pos.sale:${sessionId}`, body) : undefined
      /** The device and the checks that depend on it — for a new sale or a resumed one. */
      const context = () => tillContext(orgId, user, session, { needsOperator: !nonFiscal })

      try {
        // ⚠ A keyed retry is answered BEFORE anything is allocated: a sale that already happened
        // must not draw a second УНП, number or receipt — even if the session has closed since (the
        // retry is of a sale made while it was open). A sale an older release rang up is found too.
        if (key) {
          const existing = await findKeyedTillDocument(orgId, key)
          if (existing) return saleResponse(await settleKeyedDocument(existing, hash!, context, runSaleSteps))
        }

        if (session.status === 'closed') return status(400, { message: 'Session is closed' })
        // A return or an exchange has no cash-register document (FR-21 §6 edge 7): the terminal never
        // sends one, and a sale is reversed by its storno.
        if (body.type !== 'sale') {
          return status(422, { code: 'register_type_unsupported', message: 'Only sales are rung up at the till; a sale is reversed by its storno' })
        }

        const c = await context()

        // FR-20.49 — Прил. 29 т. 8: no fiscal sale opens on a device not reached in two hours (SUPTO
        // production mode only). ⚠ Here, for a NEW sale only: a keyed retry above is a sale that
        // already opened, and refusing it now would strand its receipt.
        if (!nonFiscal) {
          const verdict = await maySaleOpen(orgId, session.warehouseId)
          if (!verdict.ok) {
            return status(409, {
              code: 'fiscal_device_unreached',
              message: `The fiscal device "${verdict.deviceName}" has not answered for more than 2 hours. A sale cannot open until it does (Н-18, Прил. 29 т. 8).`,
              deviceName: verdict.deviceName,
              lastCommunicationAt: verdict.lastCommunicationAt,
            })
          }
        }

        const settings = await tillSettings(orgId)
        // FR-21.16: refused before a receipt can print, when the org does not let the till sell what
        // the warehouse does not hold. By default it may, as the till always could.
        if (!settings.allowNegativeStock) {
          try {
            await assertDispatchAvailable(orgId, body.lines.map((l: any) => ({
              productId: l.productId, warehouseId: String(session.warehouseId), quantity: l.quantity, description: l.name,
            })))
          } catch (e: any) {
            return status(400, { code: 'insufficient_stock', message: e.message })
          }
        }

        const document = await tillSaleDocument({
          orgId, user, session: c.session!, baseCurrency: settings.baseCurrency, customerId: body.customerId,
          lines: body.lines, totals: verified, payments: body.payments, printer: c.printer ?? null, nonFiscal,
        })
        // The УНП is drawn AFTER this document exists (`runSaleSteps`), so of several requests racing
        // on one key, only the one whose insert wins ever draws one.
        const outcome = await insertRegisterDocument(orgId, document, key ? { key, hash: hash! } : undefined)
        if ('existing' in outcome) return saleResponse(await settleKeyedDocument(outcome.existing, hash!, context, runSaleSteps))
        return saleResponse(await runSaleSteps(c, String(outcome.inserted._id)))
      } catch (e: any) {
        if (e instanceof RegisterRefusal) return status(e.statusCode, e.body)
        throw e
      }
    },
    {
      isSignIn: true,
      body: SALE_BODY,
    },
  )
  // FR-21.8: the session's till rows from both stores, each once.
  .get('/session/:id/transaction', async ({ params: { orgId, id: sessionId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return pageOf(await loadPosRows({ orgId, sessionId }), query)
  }, { isSignIn: true })
  // ── Storno (Appendix 29 compliance) ──
  // FR-21.18: a storno is its own `cash_storno` document and the sale stays `paid`, stornoed
  // (`lib/cash-register-till.ts#stornoDoor`, which the journal's storno goes through too).
  .post(
    '/session/:id/storno',
    async ({ params: { orgId, id: sessionId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      // H4: Storno requires manager or admin role
      if (!STORNO_ROLES.includes(user.role)) {
        return status(403, { message: 'Storno requires manager or admin authorization' })
      }

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }

      const session = await getRepos().posSessions.findOne({ id: sessionId, orgId } as any) as any
      if (!session) return status(404, { message: 'POS session not found' })

      const out = await stornoDoor({
        orgId, user, originalId: body.originalTransactionId, reason: body.reason, payments: body.payments, session,
        key, hash: key ? requestHash(`pos.storno:${sessionId}`, body) : undefined,
      })
      return 'status' in out ? status(out.status, out.body) : out
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
  // FR-21.27: `GET /transactions` and `/transactions/:txnId` are gone. The journal
  // (`/cash-register/documents[/:id]`) lists and opens every till sale and storno since R1.
