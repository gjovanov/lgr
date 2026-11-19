/**
 * FR-25 R3: an invoice issued for a cash sale whose VAT is not the VAT it prints, and its repair
 * (`scripts/repair-cash-sale-invoice-vat.ts`).
 *
 * Until #485 the PDF import took the sum of the lines' rounded VAT instead of the VAT the invoice prints, one or two
 * cents away. #489 put the printed figures back, but left alone an invoice paid through the till register: the invoice a
 * store issues for a cash sale („фактура към касова продажба", `cashSaleRef`) is born paid by ONE mirrored payment of its
 * whole total (`cash-sale-invoice.service.ts#mirroredPayments`, origin `cash_register`), and that payment has to move
 * with the total. The filed sales register carries the printed VAT, so each such invoice is a row whose VAT differs.
 *
 * What it changes, and why each is safe:
 *   - the VAT, the total and the base-currency total: to the VAT and sum due the PDF the invoice was committed from
 *     prints. The base never moves: an invoice whose PDF prints another base is left alone;
 *   - `amountPaid` and the mirrored payment's amount: to the new total. The cash sale took the money; this payment only
 *     mirrors it on the tax document, and claims on the sale are by quantity, never by money. The cash sale itself is
 *     not written (an issued sale never is, FR-20.51).
 * Left alone and counted: an invoice not issued for a cash sale (#489's `repair-printed-invoice-totals.ts` takes those);
 * one with any other payment, a payment receipt holding it, a till session, or a journal entry of its own; a PDF the
 * reader takes no VAT from; one off by more than the VAT's rounding.
 * Never written: a journal entry, a VAT register row, a tax return.
 */
import { DocFile, Invoice, JournalEntry } from '../../packages/db/src/models/index.js'
import { draftFromLayoutText } from '../../packages/services/src/biz/doc-import/parse-table.js'
import { auditRun, cents, manifestHead, oid, parseManifestOf, type ManifestHead } from './repair-run.js'

export const NAME = 'repair-cash-sale-invoice-vat'
export const SCRIPT = `scripts/${NAME}.ts`

const DOC_TYPES = ['invoice', 'credit_note', 'debit_note']
const round2 = (v: number) => Math.round(v * 100) / 100

/** The figures a repair reads and writes. The write is conditional on every `before` value. */
export interface Figures { taxTotal: number; total: number; totalBase: number; amountPaid: number; payment: number }

export interface CashSaleVatPlan {
  id: string
  invoiceNumber: string
  before: Figures
  after: Figures
}

export interface CashSaleVatSurvey {
  orgId: string
  plans: CashSaleVatPlan[]
  /** Committed invoice PDFs looked at, and what became of each, by reason. */
  counts: Record<string, number>
}

/** Every committed invoice PDF of the org issued for a cash sale, against the invoice it was committed to. Reads only. */
export async function planCashSaleVat(orgId: string): Promise<CashSaleVatSurvey> {
  const counts: Record<string, number> = {}
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1 }
  const plans: CashSaleVatPlan[] = []
  const files = DocFile.find({ orgId: oid(orgId), docType: 'invoice', status: 'committed' }).select('extractedText committedIds').lean().cursor()
  for await (const f of files as AsyncIterable<any>) {
    bump('committed invoice PDFs')
    const inv: any = await Invoice.findOne({ orgId: oid(orgId), _id: { $in: f.committedIds ?? [] }, direction: 'outgoing', type: { $in: DOC_TYPES } })
      .select('invoiceNumber status subtotal discountTotal taxTotal total totalBase exchangeRate amountPaid amountDue payments receiptHolds register cashSaleRef').lean()
    if (!inv) { bump('left: no outgoing invoice behind the PDF'); continue }
    if (!inv.cashSaleRef?.cashSaleId) { bump('left: not issued for a cash sale (repair-printed-invoice-totals.ts takes those)'); continue }
    const printed = draftFromLayoutText(String(f.extractedText ?? ''), 'invoice')?.extraction
    if (printed?.vat_total == null || printed.gross_total == null || printed.net_total == null) { bump('left: the PDF prints no VAT and sum due the reader can take'); continue }
    const base = cents(inv.total) - cents(inv.taxTotal)
    const vat = Math.abs(cents(printed.vat_total)), gross = Math.abs(cents(printed.gross_total))
    if (vat === cents(inv.taxTotal) && gross === cents(inv.total)) { bump('equal to the print already'); continue }
    if (Math.abs(cents(printed.net_total)) !== base || cents(inv.subtotal) - cents(inv.discountTotal) !== base || gross !== base + vat) {
      bump('left: the PDF and the invoice hold different bases (edited, or a re-export)'); continue
    }
    if (Math.abs(vat - cents(inv.taxTotal)) > 2) { bump('left: off by more than the VAT\'s rounding'); continue }

    const pays: any[] = inv.payments ?? []
    const p = pays[0]
    const mirrored = inv.status === 'paid' && pays.length === 1 && p.origin === 'cash_register' && p.tendered == null &&
      cents(p.amount) === cents(inv.total) && cents(inv.amountPaid) === cents(inv.total) && !cents(inv.amountDue)
    if (!mirrored) { bump(`left: ${inv.status}, ${pays.map((x: any) => x.origin ?? x.method).join('+') || 'no payment'}: not one mirrored payment of the whole total`); continue }
    if ((inv.receiptHolds ?? []).length) { bump('left: held by a payment receipt'); continue }
    if (inv.register?.sessionId) { bump('left: in a till session'); continue }
    if (await JournalEntry.exists({ orgId: oid(orgId), sourceId: inv._id })) { bump('left: it has a journal entry of its own'); continue }

    const total = gross / 100
    const rate = Number(inv.exchangeRate) || 1
    plans.push({
      id: String(inv._id),
      invoiceNumber: inv.invoiceNumber,
      before: { taxTotal: inv.taxTotal, total: inv.total, totalBase: inv.totalBase, amountPaid: inv.amountPaid, payment: p.amount },
      after: { taxTotal: vat / 100, total, totalBase: round2(total * rate), amountPaid: total, payment: total },
    })
    bump('to repair: the VAT and sum due it prints, its mirrored payment with them')
  }
  return { orgId, plans, counts }
}

// ── The manifest ────────────────────────────────────────────────────────────────────────────────

export interface CashSaleVatManifest extends ManifestHead {
  invoices: CashSaleVatPlan[]
}

export const manifestOf = (survey: CashSaleVatSurvey, slug: string): CashSaleVatManifest =>
  ({ ...manifestHead(NAME, survey.orgId, slug), invoices: survey.plans })

const FIGURES: (keyof Figures)[] = ['taxTotal', 'total', 'totalBase', 'amountPaid', 'payment']
const figures = (v: any): Figures => Object.fromEntries(FIGURES.map(k => [k, Number(v?.[k])])) as unknown as Figures

export function parseManifest(text: string, orgId: string): CashSaleVatManifest {
  const ok = (f: any) => f && FIGURES.every(k => Number.isFinite(Number(f[k])))
  const m = parseManifestOf(text, NAME, orgId, x => Array.isArray(x.invoices) && x.invoices.every((i: any) => i?.id && ok(i.before) && ok(i.after)))
  return {
    script: NAME, version: 1, orgId: String(m.orgId), slug: String(m.slug), at: String(m.at),
    invoices: m.invoices.map((i: any) => ({ id: String(i.id), invoiceNumber: String(i.invoiceNumber ?? ''), before: figures(i.before), after: figures(i.after) })),
  }
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────

/** The invoice as `f` describes it, with its one mirrored payment: the condition of every write. */
const reading = (orgId: string, id: string, f: Figures) => ({
  _id: oid(id), orgId: oid(orgId), status: 'paid', taxTotal: f.taxTotal, total: f.total, amountPaid: f.amountPaid,
  'payments.0.origin': 'cash_register', 'payments.0.amount': f.payment, 'payments.1': { $exists: false }, 'receiptHolds.0': { $exists: false },
})
const writing = (f: Figures) => ({ taxTotal: f.taxTotal, total: f.total, totalBase: f.totalBase, amountPaid: f.amountPaid, 'payments.0.amount': f.payment })

export interface CashSaleVatResult { repaired: number; failed: string[] }

/** Write every plan. Each write is conditional on the invoice still reading as the plan saw it; one changed since is reported. */
export async function applyCashSaleVat(survey: CashSaleVatSurvey): Promise<CashSaleVatResult> {
  const result: CashSaleVatResult = { repaired: 0, failed: [] }
  for (const p of survey.plans) {
    // Posted since the plan read it: its entry holds the old figures, and only a person re-posts it.
    if (await JournalEntry.exists({ orgId: oid(survey.orgId), sourceId: oid(p.id) })) {
      result.failed.push(`invoice ${p.id}: has a journal entry since the dry run; left alone`)
      continue
    }
    const r = await Invoice.updateOne(reading(survey.orgId, p.id, p.before), { $set: writing(p.after) }).exec()
    if (r.modifiedCount === 1) result.repaired++
    else result.failed.push(`invoice ${p.id}: no longer as the dry run saw it; left alone`)
  }
  if (result.repaired) {
    await auditRun(survey.orgId, SCRIPT, 'invoice', `invoices issued for a cash sale given the VAT they print (${SCRIPT})`, { invoices: result.repaired })
  }
  return result
}

export interface CashSaleVatUndo { invoices: number; back: number; changed: number }

/** What `--undo` takes back, or takes back with `execute`: the invoices that still read as the run left them. */
export async function undoCashSaleVat(m: CashSaleVatManifest, execute: boolean): Promise<CashSaleVatUndo> {
  const counts: CashSaleVatUndo = { invoices: m.invoices.length, back: 0, changed: 0 }
  for (const i of m.invoices) {
    const left = reading(m.orgId, i.id, i.after)
    const n = execute
      ? (await Invoice.updateOne(left, { $set: writing(i.before) }).exec()).modifiedCount
      : await Invoice.countDocuments(left).exec()
    if (n) counts.back++
    else counts.changed++
  }
  if (execute && counts.back) {
    await auditRun(m.orgId, SCRIPT, 'invoice', `invoices issued for a cash sale given their VAT back (${SCRIPT} --undo)`, { invoices: counts.back })
  }
  return counts
}
