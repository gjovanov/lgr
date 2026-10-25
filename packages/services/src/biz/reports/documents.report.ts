/**
 * FR-06 (#14) P2 — the three document registers: `sales-documents`, `purchase-documents`
 * and `cash-register`.
 *
 * These mirror the three KINDS the invoicing export endpoint has always had
 * (`POST /invoicing/export/kind/:kind`), and deliberately do NOT replace it: that endpoint
 * stays mounted and byte-compatible (FR-6.20), and the moved three-tab export page keeps
 * driving it. What the registry adds is the other half — the same population as a runnable,
 * filterable, drill-downable TABLE, which the export page cannot do.
 *
 *   outgoing  = invoice + credit_note + debit_note, direction outgoing (shared SALES_DOC numbering)
 *   incoming  = bills — type invoice, direction incoming
 *   cash_register = cash_sale (its own numbering)
 *
 * Draft documents are included but flagged by their status: a draft register is exactly what
 * you want when hunting for the document someone forgot to issue. Converted proformas never
 * appear — they are not in any of the three type sets.
 *
 * ── The per-method columns (gjovanov/lgr#127) ────────────────────────────────
 * Each register splits its documents across the four methods the app offers (cash, card,
 * cash on delivery, bank transfer), each with its own column total — the question "how much of
 * today's invoicing came in over the counter" was otherwise unanswerable from this screen.
 * WHAT is split differs by register:
 *
 *  - The SALES register splits each document's TOTAL (the operator's rule, 2026-10-15): an
 *    invoice not paid in cash, by card or by cash on delivery is „По банка". The four columns
 *    are a partition, so on every row and in the totals they add up to Общо, which the page
 *    ends on. #127's first cut split only what was PAID, and a bank invoice stays unpaid until
 *    the transfer arrives (only a cash invoice is settled on issue), so „По банка" sat at 0
 *    under every one of them and the printed register closed on that 0 as its bottom line.
 *  - The purchase register and the cash register split what was PAID: paidCash + paidCard +
 *    paidCashOnDelivery + paidBank + `meta.unattributedPaid` equals the Платено total (to the
 *    extent `payments[]` and `amountPaid` agree on a document — where they disagree the payment
 *    rows win, since they are the record of what was tendered). Платено / Остатък are shown
 *    beside them there, so an unpaid bill is visible as unpaid rather than as „by bank".
 *
 * ⚠ A credit note counts AGAINST its register. Notes are stored as positive magnitudes with
 * the sign on the type (`doc-import/map-invoice.ts` normalises the printed negatives; the
 * auto-journal, the contact ledger and the sales history all negate by type), so summing them
 * as stored added every refund to Общо instead of taking it off.
 */

import { Invoice } from 'db/models'
import {
  rowCapFor,
  type ReportColumn,
  type ReportHandlerContext,
  type ReportResult,
} from '../report-registry.types.js'

export type DocumentKind = 'outgoing' | 'incoming' | 'cash_register'

/** Type + direction filter per kind — the same split the export controller uses. */
const KIND_FILTER: Record<DocumentKind, Record<string, any>> = {
  outgoing: { type: { $in: ['invoice', 'credit_note', 'debit_note'] }, direction: 'outgoing' },
  incoming: { type: 'invoice', direction: 'incoming' },
  cash_register: { type: 'cash_sale' },
}

/**
 * Exactly the Invoice model's status enum — no more. Offering a filter value the schema can
 * never produce (`completed`, which some list views still show) is a filter that silently
 * returns nothing.
 */
const STATUS_OPTIONS = [
  'draft', 'sent', 'received', 'partially_paid', 'paid', 'overdue', 'voided', 'cancelled', 'converted',
]

function oid(v: unknown) {
  return new Invoice.base.Types.ObjectId(String(v))
}

function dayStart(d: string) { return new Date(`${d}T00:00:00.000`) }
function dayEnd(d: string) { return new Date(`${d}T23:59:59.999`) }

/** Onto cents, and never a negative zero: that prints as „-0,00". */
function cents(n: number): number {
  const v = +n.toFixed(2)
  return v === 0 ? 0 : v
}

/** A credit note gives money back: it counts against the period, whatever sign it was stored with. */
function signed(docType: string | undefined, value: number): number {
  return docType === 'credit_note' && value ? -Math.abs(value) : value
}

/** The document amounts a register shows and totals. */
const MONEY_FIELDS = ['subtotal', 'taxTotal', 'total', 'amountPaid', 'amountDue'] as const

/** What each register splits across the method columns — see the file head. */
const SPLIT: Record<DocumentKind, 'total' | 'paid'> = {
  outgoing: 'total',
  incoming: 'paid',
  cash_register: 'paid',
}

const METHOD_KEYS = {
  total: ['paidCash', 'paidCard', 'paidCashOnDelivery', 'bank'],
  paid: ['paidCash', 'paidCard', 'paidCashOnDelivery', 'paidBank'],
} as const

type SalesMethodKey = (typeof METHOD_KEYS.total)[number]

/**
 * The sales register's column for a method: the three paid over the counter or to the courier
 * have their own, and everything else — a transfer, an `other` tender, no method at all — is
 * „По банка".
 */
const SALES_METHOD_COLUMN: Record<string, SalesMethodKey> = {
  cash: 'paidCash',
  card: 'paidCard',
  cash_on_delivery: 'paidCashOnDelivery',
}

function salesColumn(method: unknown): SalesMethodKey {
  return SALES_METHOD_COLUMN[String(method || '').toLowerCase()] ?? 'bank'
}

/**
 * Where a sales document's (signed) total goes.
 *
 *   1. `payments[]`, in the order they were recorded, up to the total — the record of how the
 *      money actually came in (a cash invoice's settlement on issue is one of these), so split
 *      tender feeds two columns;
 *   2. whatever is still open, by the document's own `paymentMethod`: a card or cash-on-delivery
 *      invoice is one whether or not anybody has recorded its payment (only cash is settled on
 *      issue), and an open invoice with a bank method, or none, is „По банка".
 *
 * Tender beyond the total — the payment endpoint does not refuse an overpayment — is not part
 * of the document, so it is left out rather than pushed into a column as a negative.
 */
function splitTotal(
  doc: { paymentMethod?: string; payments?: { method?: string; amount?: number }[] },
  total: number,
): Record<SalesMethodKey, number> {
  const out: Record<SalesMethodKey, number> = { paidCash: 0, paidCard: 0, paidCashOnDelivery: 0, bank: 0 }
  let open = Math.abs(total)
  for (const p of doc.payments || []) {
    const amount = Math.min(open, Math.abs(Number(p?.amount) || 0))
    if (amount <= 0) continue
    out[salesColumn(p.method)] += amount
    open -= amount
  }
  if (open > 0) out[salesColumn(doc.paymentMethod)] += open

  // Back onto the document's sign and onto cents. „По банка" takes the rounding, so the four
  // add up to the total exactly rather than to within a cent.
  const sign = total < 0 ? -1 : 1
  out.paidCash = cents(sign * out.paidCash)
  out.paidCard = cents(sign * out.paidCard)
  out.paidCashOnDelivery = cents(sign * out.paidCashOnDelivery)
  out.bank = cents(total - out.paidCash - out.paidCard - out.paidCashOnDelivery)
  return out
}

/**
 * `Invoice.payments[].method` / `Invoice.paymentMethod` → column key, for the registers that
 * split what was paid. The model's enum also allows `other`, and `paymentMethod` is a free
 * String, so anything unmapped lands in `meta.unattributedPaid` rather than being quietly
 * dropped or folded into cash.
 */
const METHOD_COLUMN: Record<string, string> = {
  cash: 'paidCash',
  card: 'paidCard',
  cash_on_delivery: 'paidCashOnDelivery',
  bank_transfer: 'paidBank',
}

/**
 * How much of this document's `amountPaid` came in by which method.
 *
 *   1. `payments[]` when present — the real record of what was tendered, so a split-tender
 *      document feeds two columns;
 *   2. else the header `paymentMethod`, for whatever has actually been paid;
 *   3. else, for a cash sale that was paid, infer cash — the one document kind that is paid on
 *      the spot and is routinely recorded without a payment row (imported CSR day-aggregates).
 *
 * Steps 2 and 3 mirror `effectiveMethods` (FR-08); only the amount differs, see the file head.
 */
function paidByMethod(doc: {
  docType?: string
  paymentMethod?: string
  payments?: { method?: string; amount?: number }[]
  amountPaid?: number
}): { method: string; amount: number }[] {
  const rows = (doc.payments || []).filter(p => p && Number(p.amount))
  if (rows.length) {
    return rows.map(p => ({ method: String(p.method || 'other'), amount: Number(p.amount) || 0 }))
  }
  const paid = Number(doc.amountPaid) || 0
  if (!paid) return []
  if (doc.paymentMethod) return [{ method: String(doc.paymentMethod), amount: paid }]
  if (doc.docType === 'cash_sale') return [{ method: 'cash', amount: paid }]
  return []
}

const COL = {
  date:        { key: 'date',        labelKey: 'reports.columns.date',        type: 'date' },
  number:      { key: 'number',      labelKey: 'reports.columns.document' },
  docType:     { key: 'docType',     labelKey: 'reports.columns.docType' },
  // #171: the cash sale an invoice was issued for. That sale is already in the cash register
  // report, so whoever adds the two registers up must take these out once.
  cashSale:    { key: 'cashSale',    labelKey: 'reports.columns.cashSale' },
  contactName: { key: 'contactName', labelKey: 'reports.columns.contact' },
  status:      { key: 'status',      labelKey: 'common.status' },
  currency:    { key: 'currency',    labelKey: 'common.currency' },
  subtotal:    { key: 'subtotal',    labelKey: 'reports.columns.net',      type: 'money', align: 'end' },
  taxTotal:    { key: 'taxTotal',    labelKey: 'reports.columns.tax',      type: 'money', align: 'end' },
  total:       { key: 'total',       labelKey: 'reports.columns.total',    type: 'money', align: 'end' },
  amountPaid:  { key: 'amountPaid',  labelKey: 'reports.columns.paid',     type: 'money', align: 'end' },
  amountDue:   { key: 'amountDue',   labelKey: 'reports.columns.due',      type: 'money', align: 'end' },
  paidCash:           { key: 'paidCash',           labelKey: 'reports.columns.paidCash',           type: 'money', align: 'end' },
  paidCard:           { key: 'paidCard',           labelKey: 'reports.columns.paidCard',           type: 'money', align: 'end' },
  paidCashOnDelivery: { key: 'paidCashOnDelivery', labelKey: 'reports.columns.paidCashOnDelivery', type: 'money', align: 'end' },
  paidBank:           { key: 'paidBank',           labelKey: 'reports.columns.paidBank',           type: 'money', align: 'end' },
  // The sales register's bank column: everything not paid in cash, by card or cash on delivery,
  // paid or not yet — hence „По банка", not „Платени по банка".
  bank:               { key: 'bank',               labelKey: 'reports.columns.bank',               type: 'money', align: 'end' },
} satisfies Record<string, ReportColumn>

/** The paid-by-method split. Last, so the register still reads left-to-right as a document list. */
const PAID_COLUMNS: ReportColumn[] = [COL.paidCash, COL.paidCard, COL.paidCashOnDelivery, COL.paidBank]

/**
 * ⚠ The sales register follows the operator's layout (2026-10-15): the four method columns,
 * then ДДС, then Общо LAST — the register ends on the total of every document, never on one
 * method's share of it. Платено / Остатък are not shown there (2026-10-14); Данъчна основа and
 * Валута, which the operator's list does not mention, keep their place in front of the money.
 * The purchase register and the cash register keep the original order. The rows still carry
 * `amountPaid` and `amountDue` for all three; only what is SHOWN differs.
 *
 * ⚠ The runner keeps a per-user column order in the browser and a saved order wins
 * (`useGridColumns`), so a user who reordered this report sees the new default only after
 * Reset in the column picker.
 */
const COLUMNS: Record<DocumentKind, ReportColumn[]> = {
  outgoing: [
    COL.date, COL.number, COL.docType, COL.cashSale, COL.contactName, COL.status, COL.currency, COL.subtotal,
    COL.paidCash, COL.paidCard, COL.paidCashOnDelivery, COL.bank,
    COL.taxTotal, COL.total,
  ],
  incoming: [
    COL.date, COL.number, COL.docType, COL.contactName, COL.status, COL.currency,
    COL.subtotal, COL.taxTotal, COL.total, COL.amountPaid, COL.amountDue,
    ...PAID_COLUMNS,
  ],
  cash_register: [
    COL.date, COL.number, COL.docType, COL.contactName, COL.status, COL.currency,
    COL.subtotal, COL.taxTotal, COL.total, COL.amountPaid, COL.amountDue,
    ...PAID_COLUMNS,
  ],
}

/**
 * One handler, three registry entries. The kind is bound at registration time rather than
 * read from a param, so each register is its own catalog card with its own permission and
 * its own shareable URL — which is what the legacy screens were.
 */
export function makeDocumentsReport(kind: DocumentKind) {
  return async function runDocuments(ctx: ReportHandlerContext): Promise<ReportResult> {
    const cap = rowCapFor(ctx.output)
    const period = (ctx.params.period || {}) as { from?: string; to?: string }

    const match: Record<string, any> = { orgId: oid(ctx.orgId), ...KIND_FILTER[kind] }

    if (period.from || period.to) {
      match.issueDate = {
        ...(period.from ? { $gte: dayStart(period.from) } : {}),
        ...(period.to ? { $lte: dayEnd(period.to) } : {}),
      }
    }
    if (ctx.params.contactId) match.contactId = oid(ctx.params.contactId)
    if (ctx.params.currency) match.currency = String(ctx.params.currency)

    const statuses = (ctx.params.statuses as string[] | undefined)?.filter(s => STATUS_OPTIONS.includes(s))
    if (statuses?.length) match.status = { $in: statuses }

    const rows = await Invoice.aggregate([
      { $match: match },
      { $sort: { issueDate: -1, invoiceNumber: -1 } },
      { $limit: cap + 1 },
      {
        $lookup: {
          from: 'contacts',
          localField: 'contactId',
          foreignField: '_id',
          as: 'contact',
          pipeline: [{ $project: { companyName: 1, firstName: 1, lastName: 1 } }],
        },
      },
      { $unwind: { path: '$contact', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          invoiceId: { $toString: '$_id' },
          date: { $dateToString: { format: '%Y-%m-%d', date: '$issueDate' } },
          number: '$invoiceNumber',
          docType: '$type',
          cashSale: { $ifNull: ['$cashSaleRef.number', ''] },
          contactName: {
            $ifNull: [
              '$contact.companyName',
              {
                $trim: {
                  input: {
                    $concat: [{ $ifNull: ['$contact.firstName', ''] }, ' ', { $ifNull: ['$contact.lastName', ''] }],
                  },
                },
              },
            ],
          },
          status: 1,
          currency: 1,
          subtotal: { $round: [{ $ifNull: ['$subtotal', 0] }, 2] },
          taxTotal: { $round: [{ $ifNull: ['$taxTotal', 0] }, 2] },
          total: { $round: [{ $ifNull: ['$total', 0] }, 2] },
          amountPaid: { $round: [{ $ifNull: ['$amountPaid', 0] }, 2] },
          amountDue: { $round: [{ $ifNull: ['$amountDue', 0] }, 2] },
          // Carried only to compute the per-method split below; stripped from the rows after.
          paymentMethod: 1,
          payments: 1,
        },
      },
    ]).exec()

    const truncated = rows.length > cap
    const raw = truncated ? rows.slice(0, cap) : rows
    const split = SPLIT[kind]

    // Split each document across the four method columns (see the file head for what is
    // split where). In the paid split, tender under an unmapped method (`other`, or a
    // free-text value) is counted apart rather than lost.
    let unattributedPaid = 0
    const page = raw.map(r => {
      const { paymentMethod: _pm, payments: _pay, ...rest } = r
      for (const k of MONEY_FIELDS) rest[k] = signed(r.docType, rest[k])
      if (split === 'total') return { ...rest, ...splitTotal(r, rest.total) }

      const byMethod: Record<string, number> = { paidCash: 0, paidCard: 0, paidCashOnDelivery: 0, paidBank: 0 }
      for (const { method, amount } of paidByMethod(r)) {
        const key = METHOD_COLUMN[method.toLowerCase()]
        if (key) byMethod[key] += signed(r.docType, amount)
        else unattributedPaid += signed(r.docType, amount)
      }
      for (const k of METHOD_KEYS.paid) byMethod[k] = cents(byMethod[k])
      return { ...rest, ...byMethod }
    })

    const sum = (k: string) => cents(page.reduce((s, r) => s + (r[k] || 0), 0))
    const currencies = [...new Set(page.map(r => r.currency).filter(Boolean))]

    return {
      columns: COLUMNS[kind],
      rows: page,
      totals: {
        subtotal: sum('subtotal'),
        taxTotal: sum('taxTotal'),
        total: sum('total'),
        amountPaid: sum('amountPaid'),
        amountDue: sum('amountDue'),
        ...Object.fromEntries((METHOD_KEYS[split] as readonly string[]).map(k => [k, sum(k)])),
      },
      meta: {
        truncated,
        cap,
        rowCount: page.length,
        kind,
        /**
         * The column whose total is the register's bottom line. The PDF's closing box ends on
         * it, wherever it sits in the table; left to itself the box takes the LAST money
         * column, which on all three registers was a method column — „Платени по банка".
         */
        grandTotalKey: 'total',
        /**
         * #171: the invoices in this page that were issued for a cash sale. Their money is the
         * cash register's: the cash register report counts it already.
         */
        ...(kind === 'outgoing'
          ? {
              forCashSales: {
                count: page.filter(r => r.cashSale).length,
                total: cents(page.filter(r => r.cashSale).reduce((s, r) => s + (r.total || 0), 0)),
              },
            }
          : {}),
        /**
         * Paid under a method with no column of its own (`other`, or a free-text
         * `paymentMethod`). The four columns plus this always add up to the Платено total, so
         * a non-zero value here is the explanation for a split that looks short. The sales
         * register has no such remainder: anything that is not a counter method is „По банка".
         */
        ...(split === 'paid' ? { unattributedPaid: cents(unattributedPaid) } : {}),
        // Totals across mixed currencies mean nothing; the renderers print a note instead
        // of a totals box when this is set (same rule as the cash-aggregate export).
        currency: currencies.length === 1 ? currencies[0] : undefined,
        mixedCurrency: currencies.length > 1,
      },
    }
  }
}

export { STATUS_OPTIONS as DOCUMENT_STATUS_OPTIONS }
