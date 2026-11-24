/**
 * FR-25 R3, slice 3: what one of an org's own sales documents books in the shadow ledger (§1.4, §3.4, §3.7), or why it
 * cannot. Import-pure: the caller (`shadow-sales.service.ts`) loads the document, the rules, the org's chart, the
 * product → group map, the partner's analytic and the books' cost of each group as of the document's day.
 *
 * A document posts whole or not at all: the first reason it cannot is its outcome, and it waits, counted. Nothing is
 * guessed. The entry is what the accountant's journal shows for the same document (§1.4):
 *
 *   per goods group   D702        K304[group]     the group's quantity, at the books' cost of the group
 *   goods             D411[partner] K702          the net of the goods lines
 *   services          D411[partner] K703          the net of the service lines
 *   the document      D411[partner] K4532         its VAT
 *   paid at issue     D501        K411[partner]   what was paid in cash at the counter as it was issued
 *
 * ⚠ Three things that read as mistakes and are not (§1.4): cost of sales is a debit on REVENUE (`D702 K304`); the
 * customer's account is hit even for a sale paid in cash (`D411 … K702`, then `D501 K411`); and a credit note books the
 * same operations NEGATIVE on the SAME sides, never swapped. The sign is the document's, never the rule's.
 *
 * Amounts, to the cent:
 *   - VAT and base are the document's own (`taxTotal`, `total − taxTotal`), rounded as the sales register rounds them,
 *     so the entry's `K4532` and `K70x` are the register row's cells to the cent;
 *   - the services' net is the sum of their lines' taxable amounts, rounded once; the goods' net is what remains of the
 *     base. A document of one kind of line gives that kind the whole base;
 *   - a group's cost is rounded once per operation (per group, per document): `Σ quantity × unit cost`, half away from
 *     zero (`roundCents`). The unit cost is the group's moving average replayed from the books (`group-cost.ts`),
 *     never LGR's, and never the books' own cost of a sale.
 */
import { registerDocTypeCode } from 'config/journal-header'
import { lineAmounts } from 'config/line-amounts'
import type { VatRow } from '../vat-files/codec.js'
import { REGISTER_DOC_TYPES, registerNumber, salesRegisterRow, sofiaDay, sofiaPeriod, type RegisterDocument } from '../vat-files/sales-register.js'
import { sha256 } from './journal-plan.js'
import { GROUP_ANALYTIC, PARTNER_ANALYTIC, type PostingRuleData } from './posting-rule-seed.js'
import { placeOf, type OrgSeries } from './product-groups.js'
import { EUR_CHANGEOVER, SALES_INVOICE_DOC_TYPE, roundCents } from './registry.js'

// ── the input ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ShadowLineInput {
  productId?: string
  quantity: number
  /** Net, as LGR stores it. */
  unitPrice: number
  /** In percent. */
  discount?: number
  taxRate?: number
}

export interface ShadowPaymentInput {
  date: Date
  amount: number
  method: string
  origin?: string
}

export interface ShadowDocument {
  id: string
  type: string
  direction: string
  /** As LGR shows it, display prefix and all. */
  number: string
  status: string
  issueDate: Date
  /** When a `voided` document was voided, from its status history. */
  voidedAt?: Date
  currency?: string
  subtotal?: number
  discountTotal?: number
  taxTotal?: number
  total?: number
  contactId?: string
  partner?: RegisterDocument['partner']
  /** An invoice made for a till sale (`cashSaleRef`): the till's sale is booked by the till's month (§12, question 2). */
  tillSale?: boolean
  lines: readonly ShadowLineInput[]
  payments?: readonly ShadowPaymentInput[]
}

/** What the posting org knows of a product: a service, or goods and the group the map gives them. */
export type ProductFacts =
  | { service: true }
  | {
    service: false
    /** The map's group, when its row is one a line posts by (`POSTABLE_SOURCES`). */
    group?: { id: string; active: boolean; unit?: string }
    /** The map holds only a suggestion for it (`rule`, `ai`): it posts nothing until reviewed (§6.1). */
    suggestionOnly?: boolean
  }

export type PartnerFacts = { analyticId: string } | { refused: 'no_partner_analytic' | 'partner_ambiguous' }

export interface PostingInput {
  series: OrgSeries
  /** The org's rules: inactive ones are ignored. */
  rules: readonly PostingRuleData[]
  /** The posting org's chart: account code → its id there. */
  accounts: ReadonlyMap<string, string>
  products: ReadonlyMap<string, ProductFacts>
  /** The document's partner's analytic under a root, in the posting org. */
  partner(root: string): PartnerFacts
  /** A goods group's unit cost at the start of a business day (`group-cost.ts`), or nothing when the books never held it. */
  unitCost(groupId: string, day: Date): number | undefined
}

// ── the outcome ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every reason a document does not post, in the order they are tried: the first one is its outcome. */
export const SHADOW_REFUSALS = [
  'not_a_sales_document',
  'not_issued',
  'no_register_number',
  'not_own_series',
  'before_euro_changeover',
  'currency_not_eur',
  'till_sale_invoice',
  'vat_row',
  'no_lines',
  'line_without_product',
  'product_unknown',
  'rule_unsupported',
  'no_rule',
  'rules_overlap',
  'rules_conflict',
  'unknown_account',
  'no_partner',
  'no_partner_analytic',
  'partner_ambiguous',
  'product_suggestion_only',
  'product_unmapped',
  'group_inactive',
  'no_cost',
  'nothing_to_post',
] as const
export type ShadowRefusal = (typeof SHADOW_REFUSALS)[number]

export interface ShadowLine {
  opNo: number
  side: 'debit' | 'credit'
  /** The account's code: what a rule names, and what the self-check compares by across orgs. */
  account: string
  accountId: string
  analyticId?: string
  /** On the partner's side: the partner, as the books import sets it where an analytic names one. */
  contactId?: string
  /** Signed, to the cent: a correction is negative on its own side. */
  amount: number
  quantity?: number
  unit?: string
}

export interface ShadowEntryDraft {
  /** The document's business day in Sofia, at UTC midnight. */
  date: Date
  docType: string
  /** The register's ten digits, as the books carry a document's number. */
  docNumber: string
  /** `1` invoice, `2` debit notice, `3` credit notice, as the books book it. */
  registerDocType: string
  partnerAnalyticId: string
  /** The document's gross and VAT, signed as the books carry a correction. */
  docTotal: number
  docVat: number
  lines: ShadowLine[]
  /** Σ debit = Σ credit. */
  total: number
}

export interface ShadowPosting {
  entry: ShadowEntryDraft
  /** The document's row of the sales register, for the HOME's register (`ledger: 'shadow'`): R7 keeps the VAT files there. */
  vatRow: { period: string; row: Omit<VatRow, 'rowNo'> }
  /** What the entry books (`postingHashOf`): a re-run that finds it unchanged writes nothing. */
  hash: string
}

export type ShadowOutcome = { posting: ShadowPosting } | { refused: ShadowRefusal; detail?: string }

// ── the posting ────────────────────────────────────────────────────────────────────────────────────────────────────

/** As the sales register rounds a document's own figures (`sales-register.ts`), so the entry and the row agree. */
const cents = (v: unknown) => Math.round((Number(v) || 0) * 100)
/** Quantities are summed as doubles: keep what a quantity can mean, drop the noise. */
const cleanQty = (q: number) => Math.round(q * 1e6) / 1e6 || 0
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The payments that are the document's own settlement at the counter: the settlement rule's (`cash_on_issue`) and a
 * printed receipt's or storno's (FR-23), in cash, on the document's business day. A payment a person records, or one
 * of another day, is a cash receipt of its own in the books, and no part of this entry.
 */
export const PAID_AT_ISSUE_ORIGINS: ReadonlySet<string> = new Set(['cash_on_issue', 'payment_receipt', 'payment_storno'])

type Scope = 'goods' | 'service' | 'document' | 'cash'
type Slot = `${Scope}.${'net' | 'vat' | 'cost' | 'paid'}`
const ALLOWED: Record<Scope, readonly string[]> = { goods: ['cost', 'net'], service: ['net'], document: ['vat'], cash: ['paid'] }

const refuse = (refused: ShadowRefusal, detail?: string): ShadowOutcome => ({ refused, ...(detail !== undefined ? { detail } : {}) })

/** A rule's scope, or why it cannot be applied. */
function scopeOf(rule: PostingRuleData): Scope | { unsupported: string } {
  const { lineKind, paymentMethod } = rule.match
  if (lineKind && paymentMethod) return { unsupported: rule.code }
  if (lineKind) return lineKind === 'goods' || lineKind === 'service' ? lineKind : { unsupported: rule.code }
  if (paymentMethod) return paymentMethod === 'cash' ? 'cash' : { unsupported: rule.code }
  return 'document'
}

/** What one document books in the shadow ledger, or the first reason it cannot. */
export function postShadowSale(doc: ShadowDocument, input: PostingInput): ShadowOutcome {
  const docTypeCode = REGISTER_DOC_TYPES[doc.type]
  if (!docTypeCode || doc.direction !== 'outgoing') return refuse('not_a_sales_document', doc.type)
  if (doc.status === 'draft' || doc.status === 'cancelled') return refuse('not_issued', doc.status)
  const docNumber = registerNumber(doc.number)
  if (!docNumber) return refuse('no_register_number')
  const place = placeOf({ docType: SALES_INVOICE_DOC_TYPE, docNumber }, input.series)
  if (place !== 'own') return refuse('not_own_series', place)
  const day = sofiaDay(doc.issueDate)
  if (isoDay(day) < EUR_CHANGEOVER) return refuse('before_euro_changeover')
  if ((doc.currency || 'EUR') !== 'EUR') return refuse('currency_not_eur', doc.currency)
  if (doc.tillSale) return refuse('till_sale_invoice')

  // The register row first: a document the register cannot carry is no document this posts.
  const isService = (l: ShadowLineInput) => !!l.productId && input.products.get(l.productId)?.service === true
  const derived = salesRegisterRow({ ...doc, lines: doc.lines.map(l => ({ taxRate: l.taxRate, service: isService(l) })) }, sofiaPeriod(doc.issueDate))
  if ('refused' in derived) return refuse('vat_row', derived.refused)

  if (!doc.lines.length) return refuse('no_lines')
  const goods: { line: ShadowLineInput; facts: Extract<ProductFacts, { service: false }> }[] = []
  const services: ShadowLineInput[] = []
  for (const line of doc.lines) {
    if (!line.productId) return refuse('line_without_product')
    const facts = input.products.get(line.productId)
    if (!facts) return refuse('product_unknown')
    if (facts.service) services.push(line)
    else goods.push({ line, facts })
  }

  const sign = docTypeCode === '03' ? -1 : 1
  const vat = cents(doc.taxTotal)
  const base = cents(doc.total) - vat
  const servicesNet = !services.length ? 0 : !goods.length ? base : cents(roundCents(services.reduce((s, l) => s + lineAmounts(l, true).taxable, 0)))
  const goodsNet = base - servicesNet
  const paid = cents(roundCents(Math.abs((doc.payments ?? [])
    // ⚠ A payment with no date is none of the day's: `Intl` formats `undefined` as now.
    .filter(p => p.method === 'cash' && !!p.origin && PAID_AT_ISSUE_ORIGINS.has(p.origin) && p.date instanceof Date && +sofiaDay(p.date) === +day)
    .reduce((s, p) => s + (Number(p.amount) || 0), 0))))

  // The rules this document applies, by what they carry.
  const present: Record<Scope, boolean> = { goods: goods.length > 0, service: services.length > 0, document: true, cash: paid !== 0 }
  const applying = input.rules.filter(r => r.isActive && r.match.docKind === doc.type && r.match.direction === 'outgoing')
  const bySlot = new Map<Slot, { rule: PostingRuleData; op: PostingRuleData['operations'][number] }[]>()
  for (const rule of applying) {
    const scope = scopeOf(rule)
    if (typeof scope !== 'string') return refuse('rule_unsupported', scope.unsupported)
    if (!present[scope]) continue
    for (const op of rule.operations) {
      const analytics = [op.analyticDebit, op.analyticCredit]
      const known = analytics.every(a => a === undefined || a === PARTNER_ANALYTIC || a === GROUP_ANALYTIC)
      const groupSide = analytics.includes(GROUP_ANALYTIC)
      const sound = ALLOWED[scope].includes(op.amount) && known
        && (op.amount === 'cost' ? !!op.perGroup && op.analyticCredit === GROUP_ANALYTIC && op.analyticDebit !== GROUP_ANALYTIC : !op.perGroup && !groupSide)
      if (!sound) return refuse('rule_unsupported', rule.code)
      const slot = `${scope}.${op.amount}` as Slot
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), { rule, op }])
    }
  }
  const needed: Slot[] = [
    ...(goods.length ? ['goods.cost', 'goods.net'] as Slot[] : []),
    ...(services.length ? ['service.net'] as Slot[] : []),
    ...(vat ? ['document.vat'] as Slot[] : []),
    ...(paid ? ['cash.paid'] as Slot[] : []),
  ]
  for (const slot of needed) {
    const n = bySlot.get(slot)?.length ?? 0
    if (!n) return refuse('no_rule', slot)
    if (n > 1) return refuse('rules_overlap', slot)
  }
  const used = needed.map(s => bySlot.get(s)![0])
  const docTypes = [...new Set(used.map(u => u.rule.docType))]
  const roots = [...new Set(used.map(u => u.rule.partnerRoot).filter((r): r is string => !!r))]
  if (docTypes.length !== 1) return refuse('rules_conflict', 'docType')
  if (roots.length > 1) return refuse('rules_conflict', 'partnerRoot')
  const vatRule = bySlot.get('document.vat')?.[0]?.rule
  if (vatRule?.vat && (vatRule.vat.register !== 'sales' || vatRule.vat.docTypeCode !== docTypeCode)) return refuse('rules_conflict', 'vat')
  for (const { op } of used) {
    for (const code of [op.debit, op.credit]) if (!input.accounts.has(code)) return refuse('unknown_account', code)
  }

  // The partner, when a rule names it.
  const namesPartner = used.some(({ op }) => op.analyticDebit === PARTNER_ANALYTIC || op.analyticCredit === PARTNER_ANALYTIC)
  let partnerAnalyticId = ''
  if (namesPartner) {
    if (!roots.length) return refuse('rule_unsupported', used.find(u => !u.rule.partnerRoot)!.rule.code)
    if (!doc.contactId) return refuse('no_partner')
    const partner = input.partner(roots[0])
    if ('refused' in partner) return refuse(partner.refused)
    partnerAnalyticId = partner.analyticId
  }

  // The goods, by the group each posts to.
  const groups = new Map<string, { quantity: number; unit?: string }>()
  for (const { facts, line } of goods) {
    if (facts.suggestionOnly) return refuse('product_suggestion_only')
    if (!facts.group) return refuse('product_unmapped')
    if (!facts.group.active) return refuse('group_inactive')
    const g = groups.get(facts.group.id) ?? { quantity: 0, ...(facts.group.unit ? { unit: facts.group.unit } : {}) }
    g.quantity += Number(line.quantity) || 0
    groups.set(facts.group.id, g)
  }
  const costs: { groupId: string; quantity: number; amount: number; unit?: string }[] = []
  for (const groupId of [...groups.keys()].sort()) {
    const g = groups.get(groupId)!
    const quantity = cleanQty(g.quantity)
    if (!quantity) continue
    const unitCost = input.unitCost(groupId, day)
    if (unitCost === undefined || !Number.isFinite(unitCost)) return refuse('no_cost')
    costs.push({ groupId, quantity, amount: roundCents(quantity * unitCost), ...(g.unit ? { unit: g.unit } : {}) })
  }

  // The operations, in a fixed order: the cost per group, the nets, the VAT, the cash.
  const lines: ShadowLine[] = []
  let opNo = 0
  const analyticOf = (spec: string | undefined, groupId?: string) =>
    spec === PARTNER_ANALYTIC ? { analyticId: partnerAnalyticId, ...(doc.contactId ? { contactId: doc.contactId } : {}) }
      : spec === GROUP_ANALYTIC && groupId ? { analyticId: groupId } : {}
  const book = (op: PostingRuleData['operations'][number], amountCents: number, extra: { groupId?: string; quantity?: number; unit?: string } = {}) => {
    opNo++
    for (const side of ['debit', 'credit'] as const) {
      const account = side === 'debit' ? op.debit : op.credit
      lines.push({
        opNo, side, account, accountId: input.accounts.get(account)!,
        ...analyticOf(side === 'debit' ? op.analyticDebit : op.analyticCredit, extra.groupId),
        amount: (sign * amountCents) / 100 || 0,
        ...(extra.quantity !== undefined ? { quantity: sign * extra.quantity || 0 } : {}),
        ...(extra.unit ? { unit: extra.unit } : {}),
      })
    }
  }
  const opOf = (slot: Slot) => bySlot.get(slot)![0].op
  // A group's cost moves its quantity out even when the books hold it at no value.
  for (const c of costs) book(opOf('goods.cost'), cents(c.amount), { groupId: c.groupId, quantity: c.quantity, ...(c.unit ? { unit: c.unit } : {}) })
  if (goods.length && goodsNet) book(opOf('goods.net'), goodsNet)
  if (services.length && servicesNet) book(opOf('service.net'), servicesNet)
  if (vat) book(opOf('document.vat'), vat)
  if (paid) book(opOf('cash.paid'), paid)
  if (!lines.length) return refuse('nothing_to_post')

  const entry: ShadowEntryDraft = {
    date: day,
    docType: docTypes[0],
    docNumber,
    registerDocType: String(Number(registerDocTypeCode(docTypeCode))),
    partnerAnalyticId,
    docTotal: (sign * cents(doc.total)) / 100 || 0,
    docVat: (sign * vat) / 100 || 0,
    lines,
    total: lines.filter(l => l.side === 'debit').reduce((s, l) => s + cents(l.amount), 0) / 100,
  }
  return { posting: { entry, vatRow: { period: sofiaPeriod(doc.issueDate), row: derived.row }, hash: postingHashOf(entry) } }
}

/**
 * What a shadow posting books, as one hash: its day, its document, its partner and every line (operation, side,
 * account, analytic, amount in cents, quantity). A re-run computes it again and writes nothing when it is unchanged.
 * The books' cost of a group is part of what it books, so an import that restates a group's past changes the hash too.
 */
export function postingHashOf(entry: Pick<ShadowEntryDraft, 'date' | 'docType' | 'docNumber' | 'registerDocType' | 'partnerAnalyticId' | 'lines'>): string {
  return sha256(JSON.stringify([
    'shadow-sales/v1',
    isoDay(entry.date), entry.docType, entry.docNumber, entry.registerDocType, entry.partnerAnalyticId,
    entry.lines.map(l => [l.opNo, l.side, l.account, l.analyticId ?? null, cents(l.amount), l.quantity ?? null]),
  ]))
}

/** A reversal's lines: the same operations, on the same sides, negative (§1.4). Never swapped. */
export function reversedLines<T extends { amount: number; quantity?: number }>(lines: readonly T[]): T[] {
  return lines.map(l => ({ ...l, amount: -l.amount || 0, ...(l.quantity !== undefined ? { quantity: -l.quantity || 0 } : {}) }))
}

// ── the posting keys ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A shadow posting's key (`JournalEntry.postingKey`, unique per org): `shadow:invoice:<document>:<revision>`, and its
 * reversal's `…:<revision>:reversal`. A document posts revision 1 first; a change reverses the live revision and
 * posts the next one, so every entry ever made for it stays, and none is overwritten.
 */
export function shadowPostingKey(documentId: string, revision: number, reversal = false): string {
  return `shadow:invoice:${documentId}:${revision}${reversal ? ':reversal' : ''}`
}

export function parseShadowKey(key: string | undefined): { documentId: string; revision: number; reversal: boolean } | undefined {
  const m = /^shadow:invoice:([0-9a-f]{24}):(\d+)(:reversal)?$/.exec(String(key ?? ''))
  return m ? { documentId: m[1], revision: Number(m[2]), reversal: !!m[3] } : undefined
}

// ── what a run does with one document ──────────────────────────────────────────────────────────────────────────────

export interface ExistingShadowEntry {
  id: string
  revision: number
  reversal: boolean
  /** Voided by hand: it books nothing, and counts as no posting. */
  voided: boolean
  hash?: string
  date: Date
}

export type ShadowAction =
  | { action: 'none' }
  | { action: 'post'; revision: number }
  /** The document changed: the live revision is reversed on its own day, and the next one posted. */
  | { action: 'repost'; reverse: ExistingShadowEntry; revision: number }
  /** Voided, or no longer postable: the live revision is reversed. */
  | { action: 'reverse'; reverse: ExistingShadowEntry; on: Date }
  /** Voided before it was ever posted: posted and reversed at once, so the ledger ends as if the run had come in time. */
  | { action: 'post_and_reverse'; revision: number; on: Date }

/** The revision that books the document now: the last posting with no reversal. */
export function liveRevision(entries: readonly ExistingShadowEntry[]): ExistingShadowEntry | undefined {
  const reversed = new Set(entries.filter(e => e.reversal && !e.voided).map(e => e.revision))
  return entries.filter(e => !e.reversal && !e.voided && !reversed.has(e.revision)).sort((a, b) => b.revision - a.revision)[0]
}

/**
 * What a run does with a document, given its outcome and the shadow entries it already has. `voidDay` is the void's
 * business day, for a voided document.
 */
export function planShadowAction(outcome: ShadowOutcome, entries: readonly ExistingShadowEntry[], voidDay?: Date): ShadowAction {
  const live = liveRevision(entries)
  const next = Math.max(0, ...entries.map(e => e.revision)) + 1
  if (voidDay) {
    if (live) return { action: 'reverse', reverse: live, on: voidDay }
    if (!entries.some(e => !e.reversal) && 'posting' in outcome) return { action: 'post_and_reverse', revision: next, on: voidDay }
    return { action: 'none' }
  }
  if ('refused' in outcome) return live ? { action: 'reverse', reverse: live, on: live.date } : { action: 'none' }
  if (!live) return { action: 'post', revision: next }
  if (live.hash === outcome.posting.hash) return { action: 'none' }
  return { action: 'repost', reverse: live, revision: next }
}
