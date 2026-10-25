/**
 * FR-11 (#21) — build one day's digest for one org.
 *
 * ⚠ SERVER-ONLY (touches Mongo). The data shape lives in `daily-digest.types.ts`, which is
 * import-pure; the renderer imports only that.
 *
 * Assembly follows the dashboard's fan-out pattern: every section runs independently and is
 * `.catch()`-degraded into a `{ failed, message }` marker. A digest that loses its duplicate
 * heuristic to a bad query must still deliver yesterday's turnover — the alternative is the
 * accountant getting nothing at all on the morning something breaks.
 *
 * Day windows use the shipped `dayStart`/`dayEnd` convention from the reports
 * (`warehouse-operations.report.ts`). `issueDate`-based sections are calendar-exact;
 * `createdAt`/`timestamp`-based ones accept the ≤3 h server-vs-Sofia skew, the same
 * trade-off FR-08 recorded rather than pretending to solve.
 */

import {
  Invoice,
  StockLevel,
  StockMovement,
  Sequence,
  BackgroundTask,
  EmailLog,
  Org,
} from 'db/models'
import { queryAuditLogs } from '../audit-log.service.js'
import {
  readArchiveTriggers, readBackupStatus, readOrgBackupRun, readOrgRestores,
} from '../backup/backup-status.service.js'
import { effectiveMethods, bucketFor } from '../reports/sales-history.report.js'
import { EFFECTIVE_DATE } from '../reports/warehouse-operations.report.js'
import { INVOICING_SEQUENCE_KEYS, resolveDefPrefix } from '../sequence-registry.js'
import { NOT_INVOICE_FOR_CASH_SALE } from '../sale-counting.js'
import {
  DIGEST_CAPS,
  DIGEST_OPT_IN_SECTIONS,
  DIGEST_SECTION_KEYS,
  isSectionError,
  type DailyDigestData,
  type DigestCorrections,
  type DigestDocuments,
  type DigestDuplicates,
  type DigestEdited,
  type DigestKpis,
  type DigestMaterialBlock,
  type DigestMaterials,
  type DigestOps,
  type DigestSectionKey,
  type DigestSequenceLine,
  type DigestStock,
  type DigestUndocumented,
  type Section,
} from './daily-digest.types.js'

function oid(v: unknown) {
  return new Invoice.base.Types.ObjectId(String(v))
}
function dayStart(d: string) { return new Date(`${d}T00:00:00.000`) }
function dayEnd(d: string) { return new Date(`${d}T23:59:59.999`) }
const round2 = (n: number) => +(n || 0).toFixed(2)
const round3 = (n: number) => +(n || 0).toFixed(3)

/** Statuses that mean "this document exists as a document". Drafts are not yet documents. */
const ISSUED_STATUSES = { $nin: ['draft', 'cancelled'] }
/** Movements that actually moved stock. Same set the reports use. */
const LIVE_MOVEMENT_STATUSES = ['confirmed', 'completed']

const SALES_TYPES = ['invoice', 'credit_note', 'debit_note']

/** Run a section, degrading a thrown error into an inline marker instead of losing the mail. */
async function section<T>(name: string, fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return await fn()
  } catch (e: any) {
    return { failed: true, message: `${name}: ${e?.message || 'failed'}` }
  }
}

// The calendar arithmetic lives in `digest-time.ts` — import-pure, so its DST/midnight table
// tests boot nothing. Re-exported here because the controller and runner import it from the
// service, and one import path is enough.
export { orgLocalParts, previousLocalDate, digestHourReached } from './digest-time.js'

// ── FR-11.7 — KPIs ──────────────────────────────────────────────────────────

async function buildKpis(orgId: string, date: string): Promise<DigestKpis> {
  const from = dayStart(date)
  const to = dayEnd(date)
  const org = oid(orgId)

  const docs: any[] = await Invoice.find(
    // An invoice issued for a cash sale is the same money as that cash sale (#171).
    { orgId: org, issueDate: { $gte: from, $lte: to }, status: ISSUED_STATUSES, ...NOT_INVOICE_FOR_CASH_SALE },
    { type: 1, direction: 1, total: 1, currency: 1, paymentMethod: 1, payments: 1, amountPaid: 1 },
  ).lean().exec()

  const kpis: DigestKpis = {
    currency: '', salesCount: 0, salesTotal: 0, cashCount: 0, cashTotal: 0,
    purchaseCount: 0, purchaseTotal: 0, paymentsCount: 0, paymentsTotal: 0,
    byMethod: [], mixedCurrency: false,
  }

  const currencies = new Set<string>()
  const methodTotals = new Map<string, { amount: number; count: number }>()

  for (const d of docs) {
    if (d.currency) currencies.add(d.currency)
    const total = d.total || 0

    if (d.direction === 'outgoing' && SALES_TYPES.includes(d.type)) {
      kpis.salesCount++
      kpis.salesTotal += total
    } else if (d.type === 'cash_sale') {
      kpis.cashCount++
      kpis.cashTotal += total
    } else if (d.direction === 'incoming') {
      kpis.purchaseCount++
      kpis.purchaseTotal += total
    }

    // Register split: reuse FR-08's precedence rather than inventing a second one — money is
    // attributed PER METHOD, so a split-tender document feeds two buckets.
    if (d.direction === 'outgoing') {
      for (const m of effectiveMethods(d)) {
        const bucket = bucketFor(m.method)
        const cur = methodTotals.get(bucket) || { amount: 0, count: 0 }
        cur.amount += m.amount
        cur.count += 1
        methodTotals.set(bucket, cur)
      }
    }
  }

  // Payments recorded ON the day, wherever their document was issued.
  const paid: any[] = await Invoice.aggregate([
    { $match: { orgId: org, 'payments.date': { $gte: from, $lte: to } } },
    { $unwind: '$payments' },
    { $match: { 'payments.date': { $gte: from, $lte: to } } },
    { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$payments.amount' } } },
  ]).exec()

  kpis.paymentsCount = paid[0]?.count || 0
  kpis.paymentsTotal = round2(paid[0]?.total || 0)
  kpis.salesTotal = round2(kpis.salesTotal)
  kpis.cashTotal = round2(kpis.cashTotal)
  kpis.purchaseTotal = round2(kpis.purchaseTotal)
  kpis.mixedCurrency = currencies.size > 1
  kpis.currency = currencies.size === 1 ? [...currencies][0] : ''
  kpis.byMethod = [...methodTotals.entries()]
    .map(([method, v]) => ({ method, amount: round2(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount)

  return kpis
}

// ── FR-11.7b — sequence continuity ──────────────────────────────────────────

/**
 * Parse the numeric suffix of an issued number, across every display prefix a counter has
 * ever rendered. Mirrors `currentMaxSuffix`'s approach: take the trailing digit run, because
 * prefixes, years and separators all vary and only the tail is the counter.
 */
function suffixOf(number: string): number | null {
  const m = /(\d+)\s*$/.exec(number || '')
  return m ? Number(m[1]) : null
}

async function buildSequenceLine(
  orgId: string,
  counterKey: string,
  numbers: string[],
): Promise<DigestSequenceLine> {
  const def = INVOICING_SEQUENCE_KEYS.find(k => k.prefix === counterKey)!
  // Never hardcode a prefix — the org may have overridden the display (year-0 sentinel).
  const prefix = await resolveDefPrefix(orgId, def)

  const year = new Date().getFullYear()
  const counter: any = await Sequence.findOne({ orgId, prefix: counterKey, year }).lean().exec()

  const line: DigestSequenceLine = {
    key: counterKey,
    prefix,
    count: numbers.length,
    missing: [],
    lastNumber: counter?.lastNumber,
  }
  if (!numbers.length) return line

  const parsed = numbers
    .map(n => ({ n, s: suffixOf(n) }))
    .filter((x): x is { n: string; s: number } => x.s !== null)
  if (!parsed.length) return line

  parsed.sort((a, b) => a.s - b.s)
  line.min = parsed[0].n
  line.max = parsed[parsed.length - 1].n

  // Absent numbers INSIDE the day's range — the „липсваща разписка" class: a suffix was
  // allocated but its document is gone (deleted, or never persisted). Voided documents still
  // exist and still carry their number, so they are not gaps by construction.
  const present = new Set(parsed.map(p => p.s))
  const lo = parsed[0].s
  const hi = parsed[parsed.length - 1].s
  // A range this wide is a legacy-numbering artefact, not a day's worth of gaps.
  if (hi - lo <= 5000) {
    for (let s = lo; s <= hi; s++) {
      if (!present.has(s)) line.missing.push(String(s))
      if (line.missing.length >= 50) break
    }
  }

  if (counter && typeof counter.lastNumber === 'number' && counter.lastNumber !== hi) {
    line.lastNumberMismatch = { dayMax: hi, counter: counter.lastNumber }
  }

  return line
}

// ── FR-11.7a — the document register ────────────────────────────────────────

async function buildDocuments(orgId: string, date: string): Promise<DigestDocuments> {
  const from = dayStart(date)
  const to = dayEnd(date)
  const org = oid(orgId)

  const rows: any[] = await Invoice.aggregate([
    { $match: { orgId: org, issueDate: { $gte: from, $lte: to }, status: ISSUED_STATUSES } },
    { $sort: { invoiceNumber: 1 } },
    {
      $lookup: {
        from: 'contacts', localField: 'contactId', foreignField: '_id', as: 'contact',
        pipeline: [{ $project: { companyName: 1, firstName: 1, lastName: 1 } }],
      },
    },
    { $unwind: { path: '$contact', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        id: { $toString: '$_id' },
        number: '$invoiceNumber',
        type: 1, direction: 1, status: 1, currency: 1, paymentMethod: 1,
        total: { $round: [{ $ifNull: ['$total', 0] }, 2] },
        contactName: {
          $ifNull: ['$contact.companyName', {
            $trim: { input: { $concat: [{ $ifNull: ['$contact.firstName', ''] }, ' ', { $ifNull: ['$contact.lastName', ''] }] } },
          }],
        },
      },
    },
  ]).exec()

  const sales = rows.filter(r => r.direction === 'outgoing' && SALES_TYPES.includes(r.type))
  const cash = rows.filter(r => r.type === 'cash_sale')
  const purchases = rows.filter(r => r.direction === 'incoming')

  const pack = (list: any[], key: string, cap: number) => ({
    key,
    rows: list.slice(0, cap).map(r => ({
      id: r.id, number: r.number, type: r.type, contactName: r.contactName || '',
      total: r.total, currency: r.currency || '', status: r.status,
      paymentMethod: r.paymentMethod,
    })),
    more: Math.max(0, list.length - cap),
    total: round2(list.reduce((s, r) => s + (r.total || 0), 0)),
    count: list.length,
  })

  const salesFamily = pack(sales, 'sales', DIGEST_CAPS.documents)
  const cashFamily = pack(cash, 'cash', DIGEST_CAPS.documents)

  const [salesSeq, cashSeq] = await Promise.all([
    buildSequenceLine(orgId, 'SALES_DOC', sales.map(r => r.number)),
    buildSequenceLine(orgId, 'CASH_SALE', cash.map(r => r.number)),
  ])

  return {
    sales: { ...salesFamily, sequence: salesSeq },
    cash: { ...cashFamily, sequence: cashSeq },
    purchases: { count: purchases.length, total: round2(purchases.reduce((s, r) => s + (r.total || 0), 0)) },
  }
}

// ── FR-11.7c — materials ────────────────────────────────────────────────────

/**
 * One aggregation for all three families rather than calling the FR-07 report handler three
 * times: the report windows on the invoice's `issueDate` via a `$lookup` and excludes
 * transfers by design, so reuse would have meant fighting it twice and re-implementing the
 * third block anyway. The effective-date rule is kept (invoice-linked movements window on
 * the invoice's issueDate), because that is what makes the numbers reconcile with FR-07.
 */
async function buildMaterials(orgId: string, date: string): Promise<DigestMaterials> {
  const from = dayStart(date)
  const to = dayEnd(date)
  const org = oid(orgId)

  const rows: any[] = await StockMovement.aggregate([
    {
      $match: {
        orgId: org,
        status: { $in: LIVE_MOVEMENT_STATUSES },
        type: { $in: ['dispatch', 'receipt', 'transfer', 'return'] },
        // A record-only movement repeats goods another movement moved (FR-21.4).
        recordOnly: { $ne: true },
        // Cheap pre-filter; the real window is applied after the invoice lookup below.
        date: { $gte: new Date(from.getTime() - 45 * 864e5), $lte: new Date(to.getTime() + 45 * 864e5) },
      },
    },
    {
      $lookup: {
        from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: 'invoice',
        pipeline: [{ $project: { issueDate: 1, 'stockSource.detectedBy': 1 } }],
      },
    },
    { $unwind: { path: '$invoice', preserveNullAndEmptyArrays: true } },
    // FR-07's rule: `createInvoiceStockMovement` stamps booking time, so the invoice's
    // issueDate is the business date whenever there is one — but a receipt a bill was made
    // from keeps its own date (FR-22.31): it was loaded on that day, and counted then.
    { $addFields: { effectiveDate: EFFECTIVE_DATE } },
    { $match: { effectiveDate: { $gte: from, $lte: to } } },
    { $unwind: '$lines' },
    {
      $addFields: {
        family: {
          $switch: {
            branches: [
              { case: { $eq: ['$type', 'transfer'] }, then: 'transferred' },
              { case: { $eq: ['$type', 'dispatch'] }, then: 'sold' },
              { case: { $eq: ['$type', 'receipt'] }, then: 'loaded' },
              // A return belongs to the family of the side that carries a warehouse.
              { case: { $ifNull: ['$toWarehouseId', false] }, then: 'loaded' },
            ],
            default: 'sold',
          },
        },
        // Returns negate their family.
        sign: { $cond: [{ $eq: ['$type', 'return'] }, -1, 1] },
      },
    },
    {
      $group: {
        _id: { family: '$family', productId: '$lines.productId' },
        quantity: { $sum: { $multiply: ['$lines.quantity', '$sign'] } },
        // On invoice-born dispatches `lines[].unitCost` IS the sale price — which is exactly
        // the value basis this section wants, unlike FR-07's cost columns.
        value: { $sum: { $multiply: [{ $ifNull: ['$lines.totalCost', 0] }, '$sign'] } },
      },
    },
    {
      $lookup: {
        from: 'products', localField: '_id.productId', foreignField: '_id', as: 'product',
        pipeline: [{ $project: { name: 1, sku: 1, unit: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        family: '$_id.family',
        productId: { $toString: '$_id.productId' },
        sku: { $ifNull: ['$product.sku', ''] },
        name: { $ifNull: ['$product.name', ''] },
        unit: { $ifNull: ['$product.unit', ''] },
        quantity: { $round: ['$quantity', 3] },
        value: { $round: ['$value', 2] },
      },
    },
  ]).exec()

  const block = (family: string): DigestMaterialBlock => {
    const list = rows
      .filter(r => r.family === family && (r.quantity !== 0 || r.value !== 0))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    return {
      rows: list.slice(0, DIGEST_CAPS.materials).map(r => ({
        productId: r.productId, sku: r.sku, name: r.name, unit: r.unit,
        quantity: r.quantity, value: r.value,
      })),
      more: Math.max(0, list.length - DIGEST_CAPS.materials),
      totalValue: round2(list.reduce((s, r) => s + (r.value || 0), 0)),
      rowCount: list.length,
    }
  }

  return { sold: block('sold'), transferred: block('transferred'), loaded: block('loaded') }
}

// ── FR-11.8 — stock at or below zero ────────────────────────────────────────

async function buildStock(orgId: string): Promise<DigestStock> {
  // `$match` FIRST, join names after — the ~25 ms class, not the 1.6 s materialisation.
  // StockLevel.quantity genuinely can go negative (no floor in warehouse.service).
  const rows: any[] = await StockLevel.aggregate([
    { $match: { orgId: oid(orgId), quantity: { $lte: 0 } } },
    { $sort: { quantity: 1 } },
    { $limit: DIGEST_CAPS.stock + 1 },
    {
      $lookup: {
        from: 'products', localField: 'productId', foreignField: '_id', as: 'product',
        pipeline: [{ $project: { name: 1, sku: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'warehouses', localField: 'warehouseId', foreignField: '_id', as: 'warehouse',
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    { $unwind: { path: '$warehouse', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        productId: { $toString: '$productId' },
        sku: { $ifNull: ['$product.sku', ''] },
        name: { $ifNull: ['$product.name', ''] },
        warehouseName: { $ifNull: ['$warehouse.name', ''] },
        quantity: { $round: ['$quantity', 3] },
      },
    },
  ]).exec()

  const total = await StockLevel.countDocuments({ orgId: oid(orgId), quantity: { $lte: 0 } }).exec()
  return {
    rows: rows.slice(0, DIGEST_CAPS.stock),
    more: Math.max(0, total - DIGEST_CAPS.stock),
    count: total,
  }
}

// ── FR-11.9 — corrections and write-offs ────────────────────────────────────

async function buildCorrections(orgId: string, date: string): Promise<DigestCorrections> {
  const movements: any[] = await StockMovement.find(
    {
      orgId: oid(orgId),
      type: 'adjustment',
      status: { $in: LIVE_MOVEMENT_STATUSES },
      date: { $gte: dayStart(date), $lte: dayEnd(date) },
    },
    { movementNumber: 1, notes: 1, lines: 1, fromWarehouseId: 1 },
  ).sort({ movementNumber: 1 }).lean().exec()

  const rows = movements.map((m: any) => {
    const notes = String(m.notes || '')
    // The import markers are the only durable record of what a correction WAS.
    const kind: 'correction' | 'writeOff' | 'manual' =
      notes.includes('corr:') ? 'correction' : notes.includes('sklisk:') ? 'writeOff' : 'manual'

    // Sign rule (product-ledger.service): out-side ⇒ negative; otherwise the stored quantity
    // is already signed (inventory-count adjustments write signed values).
    const out = !!m.fromWarehouseId
    let quantity = 0
    let value = 0
    for (const l of m.lines || []) {
      const q = out ? -Math.abs(l.quantity || 0) : (l.quantity || 0)
      quantity += q
      value += out ? -Math.abs(l.totalCost || 0) : (l.totalCost || 0)
    }

    return {
      id: String(m._id),
      movementNumber: m.movementNumber,
      kind,
      lineCount: (m.lines || []).length,
      quantity: round3(quantity),
      value: round2(value),
    }
  })

  return {
    rows: rows.slice(0, DIGEST_CAPS.corrections),
    more: Math.max(0, rows.length - DIGEST_CAPS.corrections),
    count: rows.length,
  }
}

// ── FR-11.10 — sales with no stock document ─────────────────────────────────

async function buildUndocumented(orgId: string, date: string): Promise<DigestUndocumented> {
  const rows: any[] = await Invoice.aggregate([
    {
      $match: {
        orgId: oid(orgId),
        direction: 'outgoing',
        type: { $in: ['invoice', 'cash_sale'] },
        status: ISSUED_STATUSES,
        issueDate: { $gte: dayStart(date), $lte: dayEnd(date) },
        // An invoice for a cash sale moves nothing on purpose: its cash sale did (#171).
        ...NOT_INVOICE_FOR_CASH_SALE,
        // A document whose lines move nothing is legitimately movement-free.
        'lines.productId': { $exists: true, $ne: null },
        'lines.warehouseId': { $exists: true, $ne: null },
      },
    },
    {
      // Needs the new {orgId, invoiceId} index — see stock-movement.model.ts.
      $lookup: {
        from: 'stockmovements', localField: '_id', foreignField: 'invoiceId', as: 'movements',
        pipeline: [{ $project: { _id: 1 } }],
      },
    },
    { $match: { movements: { $size: 0 } } },
    { $sort: { invoiceNumber: 1 } },
    {
      $project: {
        _id: 0,
        id: { $toString: '$_id' },
        number: '$invoiceNumber',
        type: 1,
        total: { $round: [{ $ifNull: ['$total', 0] }, 2] },
        // `skipStockMovement` is a transient request flag — the durable proxy for "imported
        // on purpose without a movement" is the tag the importer writes.
        imported: { $in: ['cash-register-import', { $ifNull: ['$tags', []] }] },
      },
    },
  ]).exec()

  return {
    rows: rows.slice(0, DIGEST_CAPS.undocumented),
    more: Math.max(0, rows.length - DIGEST_CAPS.undocumented),
    count: rows.length,
    importedCount: rows.filter(r => r.imported).length,
  }
}

// ── FR-11.11 — duplicate suspects ───────────────────────────────────────────

async function buildDuplicates(orgId: string, date: string): Promise<DigestDuplicates> {
  const rows: any[] = await Invoice.aggregate([
    {
      $match: {
        orgId: oid(orgId),
        direction: 'outgoing',
        type: { $in: ['invoice', 'cash_sale'] },
        status: ISSUED_STATUSES,
        issueDate: { $gte: dayStart(date), $lte: dayEnd(date) },
        // An invoice for a cash sale repeats that sale's lines by design — it is no duplicate (#171).
        ...NOT_INVOICE_FOR_CASH_SALE,
      },
    },
    { $unwind: '$lines' },
    { $match: { 'lines.productId': { $ne: null } } },
    {
      $group: {
        _id: { productId: '$lines.productId', quantity: '$lines.quantity' },
        occurrences: { $sum: 1 },
        documents: { $addToSet: '$invoiceNumber' },
      },
    },
    { $match: { occurrences: { $gt: 1 } } },
    { $sort: { occurrences: -1 } },
    { $limit: DIGEST_CAPS.duplicates + 1 },
    {
      $lookup: {
        from: 'products', localField: '_id.productId', foreignField: '_id', as: 'product',
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        productId: { $toString: '$_id.productId' },
        quantity: '$_id.quantity',
        name: { $ifNull: ['$product.name', ''] },
        occurrences: 1,
        documents: 1,
      },
    },
  ]).exec()

  return {
    rows: rows.slice(0, DIGEST_CAPS.duplicates),
    more: Math.max(0, rows.length - DIGEST_CAPS.duplicates),
    count: rows.length,
  }
}

// ── FR-11.12 — edited after issue ───────────────────────────────────────────

async function buildEdited(orgId: string, date: string): Promise<DigestEdited> {
  // Explicit size: the default is 25 and would silently truncate a busy day.
  const { auditLogs, total } = await queryAuditLogs(orgId, {
    modules: ['invoicing'],
    actions: ['update', 'void', 'delete'],
    dateFrom: dayStart(date).toISOString(),
    dateTo: dayEnd(date).toISOString(),
    size: 200,
  } as any)

  const rows = auditLogs.map((l: any) => ({
    entityName: l.entityName || l.entityId,
    action: l.action,
    changeCount: (l.changes || []).length,
    userName: l.userName || '',
    at: l.timestamp || '',
  }))

  return {
    rows: rows.slice(0, DIGEST_CAPS.edited),
    more: Math.max(0, total - Math.min(rows.length, DIGEST_CAPS.edited)),
    count: total,
  }
}

// ── FR-11.13 — imports and emails ───────────────────────────────────────────

async function buildOps(orgId: string, date: string): Promise<DigestOps> {
  const from = dayStart(date)
  const to = dayEnd(date)

  const [tasks, failedEmails, failedEmailCount] = await Promise.all([
    BackgroundTask.find(
      {
        orgId: oid(orgId),
        type: { $in: ['doc-import-analyze', 'doc-import-commit', 'opening-stock', 'bill-ocr-draft'] },
        createdAt: { $gte: from, $lte: to },
      },
      { type: 1, status: 1, result: 1 },
    ).lean().exec(),
    EmailLog.find(
      { orgId: oid(orgId), status: 'failed', createdAt: { $gte: from, $lte: to } },
      { to: 1, subject: 1, error: 1 },
    ).sort({ createdAt: -1 }).limit(DIGEST_CAPS.emails).lean().exec(),
    EmailLog.countDocuments({ orgId: oid(orgId), status: 'failed', createdAt: { $gte: from, $lte: to } }).exec(),
  ])

  const byType = new Map<string, { type: string; completed: number; failed: number; created: number; failedRows: number }>()
  for (const t of tasks as any[]) {
    const row = byType.get(t.type) || { type: t.type, completed: 0, failed: 0, created: 0, failedRows: 0 }
    if (t.status === 'completed') row.completed++
    if (t.status === 'failed') row.failed++
    row.created += Number(t.result?.created || 0)
    row.failedRows += Number(t.result?.failed || 0)
    byType.set(t.type, row)
  }

  return {
    tasks: [...byType.values()],
    failedEmails: (failedEmails as any[]).map(e => ({
      to: e.to, subject: e.subject || '', error: String(e.error || '').slice(0, 200),
    })),
    failedEmailCount,
  }
}

// ── Assembly ────────────────────────────────────────────────────────────────

/** True when a section carries nothing worth a reader's attention. */
function sectionIsEmpty(key: DigestSectionKey, value: any): boolean {
  if (!value || isSectionError(value)) return false // an error is not "clear"
  switch (key) {
    // A green backup report is genuinely nothing to report; anything else — including a
    // report that never arrived — must keep the day off "all clear". ⚠ BOTH layers have to
    // be green: a healthy cluster-wide Layer-1 dump says nothing about whether this org's own
    // Layer-2 bundle ran, and a failing per-org bundle must not be able to hide behind it.
    // ⚠ …and a completed bundle with no OFF-SITE copy is not clear either (FR-13.59). The
    // artifact then lives only on `<UPLOAD_DIR>/<orgId>/backups/`, a node-local hostPath on
    // the same node as the live database — one disk holding both the data and its backup.
    // `destinations: []` is the assertion "nowhere"; `undefined` is a run from before this
    // field existed and must not retroactively turn every historic day red.
    case 'backups':
      return value.healthy === true &&
        (!value.orgRun || (
          value.orgRun.status === 'completed' &&
          (value.orgRun.destinations === undefined ||
            value.orgRun.destinations.some((d: any) => d.status === 'reached'))
        )) &&
        // FR-13.37 — a WRITING restore takes the day off "all clear" even when both backup
        // layers are green. It is not an error and it is not a backup problem; it is somebody
        // having reached into live data, and the one property the digest must have is that
        // such a day never reads as an ordinary one. An Inspect writes nothing and does not
        // clear the day off.
        !(value.restores || []).some((r: any) => r.mode === 'merge' || r.mode === 'replace')
    case 'kpis':
      return !value.salesCount && !value.cashCount && !value.purchaseCount && !value.paymentsCount
    case 'documents':
      return !value.sales.count && !value.cash.count && !value.purchases.count
    case 'materials':
      return !value.sold.rowCount && !value.transferred.rowCount && !value.loaded.rowCount
    case 'ops':
      return !value.tasks.length && !value.failedEmailCount
    default:
      return !value.count
  }
}

export interface BuildDigestOptions {
  /** Section toggles; omitted sections default ON. */
  sections?: Record<string, boolean>
  locale?: string
}

/**
 * Build one org's digest for one org-local date.
 *
 * `localDate` is the day being REPORTED ON (yesterday when the scheduler calls it), not the
 * day the mail goes out.
 */
export async function buildDailyDigest(
  orgId: string,
  localDate: string,
  opts: BuildDigestOptions = {},
): Promise<DailyDigestData> {
  const org: any = await Org.findById(orgId).lean().exec()
  const settings = org?.settings || {}
  const cfg = settings.dailyDigest || {}
  const sections = { ...(cfg.sections || {}), ...(opts.sections || {}) }
  // Every section defaults ON except the opt-in ones (FR-13.6's `backups`), which default OFF.
  const on = (k: DigestSectionKey) =>
    DIGEST_OPT_IN_SECTIONS.includes(k) ? sections[k] === true : sections[k] !== false

  const data: DailyDigestData = {
    orgId,
    orgName: org?.name || '',
    date: localDate,
    locale: opts.locale || cfg.locale || settings.locale || 'en',
    timezone: settings.timezone || 'UTC',
    generatedAt: new Date().toISOString(),
    allClear: false,
  }

  // Fan out like the dashboard: independent, each degrading on its own.
  const [kpis, documents, materials, stock, corrections, undocumented, duplicates, edited, ops, backups] =
    await Promise.all([
      on('kpis') ? section('kpis', () => buildKpis(orgId, localDate)) : undefined,
      on('documents') ? section('documents', () => buildDocuments(orgId, localDate)) : undefined,
      on('materials') ? section('materials', () => buildMaterials(orgId, localDate)) : undefined,
      on('stock') ? section('stock', () => buildStock(orgId)) : undefined,
      on('corrections') ? section('corrections', () => buildCorrections(orgId, localDate)) : undefined,
      on('undocumentedSales') ? section('undocumentedSales', () => buildUndocumented(orgId, localDate)) : undefined,
      on('duplicates') ? section('duplicates', () => buildDuplicates(orgId, localDate)) : undefined,
      on('editedAfterIssue') ? section('editedAfterIssue', () => buildEdited(orgId, localDate)) : undefined,
      on('ops') ? section('ops', () => buildOps(orgId, localDate)) : undefined,
      // Layer 1 is deployment-wide — the same figures for every org that enables it. Layer 2
      // is this org's own bundle, and is attached here so one section answers both "are the
      // cluster's backups running?" and "did MY backup run?".
      on('backups')
        ? section('backups', async () => {
          const status = await readBackupStatus()
          const orgRun = await readOrgBackupRun(orgId)
          // FR-13.37 — a restore is an operator reaching into live data, and it MUST be
          // visible to the people who did not perform it. The digest is where they already
          // look, and this is the only place in the product where that act surfaces without
          // someone going to find it.
          const restores = await readOrgRestores(orgId, dayStart(localDate), dayEnd(localDate))
          // FR-13.47 — the volumes at which FR-13.40's "rows are never archived" has to be
          // reopened. Never before year 10 at the measured rate, which is precisely why it
          // needs watching by something other than a person's memory.
          const archiveTriggers = await readArchiveTriggers(orgId, status.lastRestore)
          return {
            ...status,
            ...(orgRun ? { orgRun } : {}),
            ...(restores.length ? { restores } : {}),
            ...(archiveTriggers.length ? { archiveTriggers } : {}),
          }
        })
        : undefined,
    ])

  data.kpis = kpis
  data.documents = documents
  data.materials = materials
  data.stock = stock
  data.corrections = corrections
  data.undocumentedSales = undocumented
  data.duplicates = duplicates
  data.editedAfterIssue = edited
  data.ops = ops
  data.backups = backups

  data.allClear = DIGEST_SECTION_KEYS.every(k => {
    const v = (data as any)[k]
    return v === undefined || sectionIsEmpty(k, v)
  })

  return data
}
