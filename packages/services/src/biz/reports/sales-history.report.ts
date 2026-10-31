/**
 * FR-08 (#17) — „История на продажбите" / Sales History & cash reconciliation.
 *
 * One chronological list of every register-related sale in a period — cash-paid sales
 * invoices, card-paid sales invoices, and cash sales — plus a summary block comparing
 * system sales ↔ expected cash ↔ card, so the operator can tie the drawer out at day end.
 *
 * ── Two sale worlds, one report ──────────────────────────────────────────────
 * LGR has `Invoice` documents and `POSTransaction` rows, and nothing links them
 * (`POSTransaction.invoiceId` is declared but never written). This report is their UNION —
 * the same shape the SUPTO 18.1 export already takes. At regal the volume is in documents;
 * POS rows appear if and when the terminal is used.
 *
 * ── Why the method rule lives here and not in a $match ───────────────────────
 * `buildPaymentMethodFilter` (invoice controller) ORs `payments.method` against the header
 * `paymentMethod`, so a document with a stray payment row matches BOTH cash and card and a
 * naive split double-counts it. And the export controller infers `cash` for any cash-sale
 * with `amountPaid > 0` even when the header explicitly says `card` — which is precisely
 * how regal records its card days. Neither behavior can be fixed in place (those outputs
 * are contract-frozen), so this handler computes the effective method itself, with an
 * explicit precedence, and the money is attributed per method rather than per document.
 */

import { Invoice, POSSession, Contact, User, Warehouse } from 'db/models'
import { rowCapFor, type ReportHandlerContext, type ReportResult, type ReportColumn } from '../report-registry.types.js'
import { saleScopeFilter } from '../sale-counting.js'
import { invoicingByCashSale } from '../cash-sale-invoice.service.js'
import { keptByMethod, posRowSign } from '../cash-register/counting.js'
import { loadPosRows } from '../cash-register/pos-union.js'

/** Methods the summary always reports, even at zero — an absent line reads as "not checked". */
export const REPORTED_METHODS = ['cash', 'card'] as const

/** Anything outside cash/card rolls up as „other" (mobile, voucher, bank_transfer, cash_on_delivery). */
export function bucketFor(method: string | undefined | null): 'cash' | 'card' | 'other' {
  const m = (method || '').toLowerCase()
  if (m === 'cash') return 'cash'
  if (m === 'card') return 'card'
  return 'other'
}

/** Documents that never represent money taken at the register. */
const EXCLUDED_STATUSES = ['draft', 'voided', 'cancelled', 'converted']

/** The import marker that means "this row has no true time of day" (map-cash-sale.ts). */
const CSR_IMPORT_TAG = 'cash-register-import'

export interface MethodAmount { method: string; amount: number }

/**
 * FR-8.4 — the precedence rule. Returns per-method amounts, which is what the summary needs
 * (a split-tender document contributes to two buckets, not one).
 *
 *   1. `payments[]` when present — the real record of what was tendered;
 *   2. else the header `paymentMethod` for the full amount;
 *   3. else, for a cash sale that was actually paid, infer cash.
 *
 * Exported for its unit test: the card-marked cash sale is the case that regresses.
 */
export function effectiveMethods(doc: {
  type?: string
  paymentMethod?: string
  payments?: { method?: string; amount?: number }[]
  amountPaid?: number
  total?: number
}): MethodAmount[] {
  const rows = (doc.payments || []).filter(p => p && Number(p.amount))
  if (rows.length) {
    return rows.map(p => ({ method: String(p.method || 'other'), amount: Number(p.amount) || 0 }))
  }
  const total = Number(doc.total) || 0
  if (doc.paymentMethod) return [{ method: String(doc.paymentMethod), amount: total }]
  // A cash sale with no payment row was paid in cash at the till; its storno refunds in cash.
  if ((doc.type === 'cash_sale' || doc.type === 'cash_storno') && Number(doc.amountPaid) > 0) return [{ method: 'cash', amount: total }]
  return []
}

const COLUMNS: ReportColumn[] = [
  { key: 'date', labelKey: 'reports.columns.date', type: 'date' },
  { key: 'time', labelKey: 'reports.columns.time' },
  { key: 'register', labelKey: 'reports.columns.register' },
  { key: 'userName', labelKey: 'reports.columns.user' },
  { key: 'number', labelKey: 'reports.columns.operationNumber' },
  { key: 'contactName', labelKey: 'reports.columns.contact' },
  { key: 'status', labelKey: 'common.status', type: 'status' },
  { key: 'invoiceNumber', labelKey: 'reports.columns.invoiceNumber' },
  { key: 'total', labelKey: 'reports.columns.value', type: 'money', align: 'end' },
  { key: 'paymentLabel', labelKey: 'reports.columns.payment' },
]

function oid(v: unknown) {
  return new Invoice.base.Types.ObjectId(String(v))
}
function dayStart(d: string) { return new Date(`${d}T00:00:00.000`) }
function dayEnd(d: string) { return new Date(`${d}T23:59:59.999`) }
function hhmm(d: Date | undefined | null): string {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return ''
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`
}
function isoDay(d: Date | undefined | null): string {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return ''
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

function contactLabel(c: any): string {
  if (!c) return ''
  return c.companyName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || ''
}
function userLabel(u: any): string {
  if (!u) return ''
  return `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || u.email || ''
}

export async function runSalesHistory(ctx: ReportHandlerContext): Promise<ReportResult> {
  const cap = rowCapFor(ctx.output)
  const orgObjectId = oid(ctx.orgId)

  const period = (ctx.params.period || {}) as { from?: string; to?: string }
  const from = period.from ? dayStart(period.from) : undefined
  const to = period.to ? dayEnd(period.to) : undefined

  const source = ctx.params.source || 'all'
  const wanted: string[] = Array.isArray(ctx.params.paymentMethods) && ctx.params.paymentMethods.length
    ? ctx.params.paymentMethods
    : ['cash', 'card']
  const includeNonRegister = ctx.params.includeNonRegister === true

  const rows: Record<string, any>[] = []
  let creditNoteCount = 0
  let noTimeCount = 0

  // ── Document rows ─────────────────────────────────────────────────────────
  if (source === 'all' || source === 'documents') {
    const docMatch: Record<string, any> = {
      orgId: orgObjectId,
      direction: 'outgoing',
      // Credit notes and cash-sale stornos ride along as negatives so a refunded day nets out.
      type: { $in: ['invoice', 'cash_sale', 'credit_note', 'cash_storno'] },
      status: { $nin: EXCLUDED_STATUSES },
      // A till document is a POS row; the POS branch below lists it (FR-21.8).
      'register.origin': { $ne: 'pos' },
    }
    // The business day is the issue date — `createdAt` is when it was typed in.
    if (from || to) {
      docMatch.issueDate = {}
      if (from) docMatch.issueDate.$gte = from
      if (to) docMatch.issueDate.$lte = to
    }
    if (ctx.params.contactId) docMatch.contactId = oid(ctx.params.contactId)
    // #171: a sale invoiced from a cash sale counts once — on the cash sale, or, for one customer,
    // on the invoice issued to them.
    Object.assign(docMatch, await saleScopeFilter(ctx.orgId, ctx.params.contactId))
    if (ctx.params.userId) docMatch.createdBy = oid(ctx.params.userId)
    if (ctx.params.warehouseId) docMatch['lines.warehouseId'] = oid(ctx.params.warehouseId)

    const docs = await Invoice.find(docMatch, {
      invoiceNumber: 1, type: 1, status: 1, issueDate: 1, createdAt: 1, total: 1, currency: 1,
      contactId: 1, createdBy: 1, paymentMethod: 1, payments: 1, amountPaid: 1, tags: 1,
      'lines.warehouseId': 1,
    }).lean()

    // The „-ФЕ №" of a cash sale is the invoice issued for it, when there is one.
    const cashSaleIds = (docs as any[]).filter(d => d.type === 'cash_sale').map(d => String(d._id))
    const invoicedAs = cashSaleIds.length ? await invoicingByCashSale(ctx.orgId, cashSaleIds) : new Map()

    for (const d of docs as any[]) {
      const methods = effectiveMethods(d)
      const buckets = methods.map(m => bucketFor(m.method))
      // Register scope: keep a document only if some tender lands in a requested bucket.
      // `includeNonRegister` widens it to bank transfers and cheques.
      const matches = buckets.some(b => wanted.includes(b)) || (includeNonRegister && methods.length > 0)
      if (!matches) continue

      const sign = d.type === 'credit_note' || d.type === 'cash_storno' ? -1 : 1
      if (d.type === 'credit_note') creditNoteCount++

      // Imported day-aggregate cash sales have no true time — `createdAt` is the import run.
      const imported = Array.isArray(d.tags) && d.tags.includes(CSR_IMPORT_TAG)
      if (imported) noTimeCount++

      rows.push({
        rowType: 'document',
        // The drill-down opens a cash sale on its own page (FR-21.3).
        docType: d.type,
        _sortAt: new Date(d.issueDate || d.createdAt).getTime(),
        invoiceId: String(d._id),
        date: isoDay(d.issueDate),
        time: imported ? '' : hhmm(d.createdAt),
        registerWarehouseId: d.lines?.find((l: any) => l.warehouseId)?.warehouseId ?? null,
        userId: d.createdBy ?? null,
        number: d.invoiceNumber,
        contactId: d.contactId ?? null,
        status: d.status,
        // The legacy „-ФЕ №" column: an invoice's own number, or the invoices of a cash sale (#171).
        invoiceNumber: d.type === 'invoice'
          ? d.invoiceNumber
          : d.type === 'cash_sale' ? (invoicedAs.get(String(d._id))?.invoices || []).map((i: any) => i.number).join(', ') : '',
        total: +((Number(d.total) || 0) * sign).toFixed(2),
        currency: d.currency || 'EUR',
        methods: methods.map(m => ({ method: m.method, amount: +(m.amount * sign).toFixed(2) })),
      })
    }
  }

  // ── POS rows ──────────────────────────────────────────────────────────────
  if (source === 'all' || source === 'pos') {
    // Every status: a stornoed sale is `cancelled` and still counts, its storno takes it back
    // (FR-21.1). `posRowSign` decides, below. POS rows window on real wall-clock time — the
    // asymmetry with issueDate is deliberate and stated in the meta. Both stores, each row once
    // (FR-21.8): a till sale is a POS row until R2 and a cash-register document after it.
    const txns = (await loadPosRows({ orgId: ctx.orgId, from, to })).filter(t =>
      (!ctx.params.contactId || String(t.customerId) === String(ctx.params.contactId))
      && (!ctx.params.userId || String(t.createdBy) === String(ctx.params.userId)))

    // A POS row has no currency of its own: it is the session's (FR-21.3). The warehouse filter
    // goes through the session too.
    const sessionIds = [...new Set((txns as any[]).map(t => String(t.sessionId)))]
    const sessions: any[] = sessionIds.length
      ? await POSSession.find({ _id: { $in: sessionIds.map(oid) } }, { currency: 1, warehouseId: 1 }).lean()
      : []
    const sessionById = new Map(sessions.map(s => [String(s._id), s]))
    const wantedWarehouse = ctx.params.warehouseId ? String(ctx.params.warehouseId) : null

    for (const t of txns as any[]) {
      const session = sessionById.get(String(t.sessionId))
      if (wantedWarehouse && String(session?.warehouseId) !== wantedWarehouse) continue

      const sign = posRowSign(t)
      if (!sign) continue

      // What the drawer kept, not what was tendered: change goes back out in cash.
      const kept = keptByMethod(t)
      const otherMethod = (t.payments || []).find((p: any) => p?.method !== 'cash' && p?.method !== 'card')?.method
      const methods: MethodAmount[] = [
        ...(kept.cash ? [{ method: 'cash', amount: kept.cash }] : []),
        ...(kept.card ? [{ method: 'card', amount: kept.card }] : []),
        ...(kept.other ? [{ method: String(otherMethod || 'other'), amount: kept.other }] : []),
      ]
      if (!methods.some(m => wanted.includes(bucketFor(m.method))) && !includeNonRegister) continue

      rows.push({
        rowType: 'pos',
        _sortAt: new Date(t.createdAt).getTime(),
        posId: String(t._id),
        date: isoDay(t.createdAt),
        time: hhmm(t.createdAt),
        register: t.fiscalDeviceNumber || '',
        userId: t.createdBy ?? null,
        number: t.transactionNumber,
        contactId: t.customerId ?? null,
        // Every till row kept here is a paid document: a sale (a stornoed one stays paid) or a
        // storno that printed — `posRowSign` skipped a voided one. It says `paid`, as the document
        // rows beside it do, not the POS row's `completed`, which no document has.
        status: 'paid',
        invoiceNumber: '', // no POS→invoice link exists today
        total: +((Number(t.total) || 0) * sign).toFixed(2),
        currency: session?.currency || 'EUR',
        methods: methods.map((m: MethodAmount) => ({ method: m.method, amount: +(m.amount * sign).toFixed(2) })),
      })
    }
  }

  // ── Hydration (batched, never per row) ────────────────────────────────────
  const contactIds = [...new Set(rows.map(r => r.contactId).filter(Boolean).map(String))]
  const userIds = [...new Set(rows.map(r => r.userId).filter(Boolean).map(String))]
  const whIds = [...new Set(rows.map(r => r.registerWarehouseId).filter(Boolean).map(String))]

  const [contacts, users, warehouses] = await Promise.all([
    contactIds.length
      ? Contact.find({ _id: { $in: contactIds.map(oid) } }, { companyName: 1, firstName: 1, lastName: 1 }).lean()
      : [],
    userIds.length
      ? User.find({ _id: { $in: userIds.map(oid) } }, { firstName: 1, lastName: 1, username: 1, email: 1 }).lean()
      : [],
    whIds.length ? Warehouse.find({ _id: { $in: whIds.map(oid) } }, { name: 1 }).lean() : [],
  ])
  const contactMap = new Map(contacts.map((c: any) => [String(c._id), c]))
  const userMap = new Map(users.map((u: any) => [String(u._id), u]))
  const whMap = new Map(warehouses.map((w: any) => [String(w._id), w]))

  rows.sort((a, b) => b._sortAt - a._sortAt)
  const truncated = rows.length > cap
  const page = truncated ? rows.slice(0, cap) : rows

  // ── Summary (FR-8.7): per currency, per bucket ────────────────────────────
  const byCurrency = new Map<string, { count: number; total: number; cash: number; card: number; other: number }>()
  for (const r of page) {
    const cur = r.currency || 'EUR'
    if (!byCurrency.has(cur)) byCurrency.set(cur, { count: 0, total: 0, cash: 0, card: 0, other: 0 })
    const acc = byCurrency.get(cur)!
    acc.count++
    acc.total += r.total
    for (const m of r.methods as MethodAmount[]) acc[bucketFor(m.method)] += m.amount
  }
  const summary = [...byCurrency.entries()].map(([currency, v]) => ({
    currency,
    count: v.count,
    total: +v.total.toFixed(2),
    cash: +v.cash.toFixed(2),
    card: +v.card.toFixed(2),
    other: +v.other.toFixed(2),
  }))

  // Presentation: resolve names and collapse the per-method amounts into one label.
  const finalRows = page.map(r => {
    const { _sortAt, methods, contactId, userId, registerWarehouseId, ...rest } = r
    return {
      ...rest,
      contactName: contactLabel(contactMap.get(String(contactId))),
      userName: userLabel(userMap.get(String(userId))),
      // A document has no register identity; the dominant line warehouse is the best proxy.
      register: r.register || (registerWarehouseId ? whMap.get(String(registerWarehouseId))?.name || '' : ''),
      paymentLabel: (methods as MethodAmount[]).map(m => m.method).join(' + '),
      cashAmount: (methods as MethodAmount[]).filter(m => bucketFor(m.method) === 'cash').reduce((s, m) => s + m.amount, 0),
      cardAmount: (methods as MethodAmount[]).filter(m => bucketFor(m.method) === 'card').reduce((s, m) => s + m.amount, 0),
    }
  })

  const single = summary.length === 1 ? summary[0] : undefined

  return {
    columns: COLUMNS,
    rows: finalRows,
    totals: single ? { total: single.total } : undefined,
    meta: {
      truncated,
      cap,
      rowCount: finalRows.length,
      summary,
      mixedCurrency: summary.length > 1,
      creditNoteCount,
      /** Imported day-aggregate rows carry no time of day — the UI footnotes this. */
      rowsWithoutTime: noTimeCount,
      /** Documents window on issueDate, POS rows on createdAt. Stated, not hidden. */
      windowing: { documents: 'issueDate', pos: 'createdAt' },
    },
  }
}
