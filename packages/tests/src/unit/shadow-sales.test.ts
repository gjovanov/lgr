import { describe, expect, it } from 'bun:test'
import { SALES_POSTING_RULES, namedByRules, planSeed, type PostingRuleData } from 'services/biz/accounting-books/posting-rule-seed'
import {
  liveRevision, parseShadowKey, planShadowAction, postShadowSale, postingHashOf, reversedLines, shadowPostingKey,
  type ExistingShadowEntry, type PostingInput, type ProductFacts, type ShadowDocument, type ShadowOutcome, type ShadowPosting,
} from 'services/biz/accounting-books/shadow-sales'

/**
 * FR-25 R3, slice 3: the posting of one sales document into the shadow ledger, as §1.4 books it. Made-up series,
 * numbers, groups, products and amounts.
 */

const G1 = 'a00000000000000000000001'
const G2 = 'a00000000000000000000002'
const CUSTOMER = 'c00000000000000000000001'
const CONTACT = 'b00000000000000000000001'
const DOC = 'd00000000000000000000001'
const CHART = new Map(['304', '411', '4532', '501', '702', '703'].map(code => [code, `acc-${code}`]))

const PRODUCTS = new Map<string, ProductFacts>([
  ['p1', { service: false, group: { id: G1, active: true, unit: 'бр' } }],
  ['p2', { service: false, group: { id: G1, active: true, unit: 'бр' } }],
  ['p3', { service: false, group: { id: G2, active: true, unit: 'бр' } }],
  ['s1', { service: true }],
  ['unmapped', { service: false }],
  ['suggested', { service: false, suggestionOnly: true }],
  ['inactive', { service: false, group: { id: G2, active: false } }],
])

const input = (over: Partial<PostingInput> = {}): PostingInput => ({
  series: { own: ['90002'], otherStores: ['90001'], outside: ['90009'] },
  rules: SALES_POSTING_RULES,
  accounts: CHART,
  products: PRODUCTS,
  partner: root => (root === 'КЛИЕНТИ' ? { analyticId: CUSTOMER } : { refused: 'no_partner_analytic' }),
  unitCost: groupId => ({ [G1]: 0.335, [G2]: 1.25 } as Record<string, number>)[groupId],
  ...over,
})

const line = (productId: string | undefined, quantity: number, unitPrice: number) => ({ ...(productId ? { productId } : {}), quantity, unitPrice, discount: 0, taxRate: 20 })

/** Goods of two groups, two lines on the first, and a service: base 32, VAT 6.40. */
const doc = (over: Partial<ShadowDocument> = {}): ShadowDocument => ({
  id: DOC, type: 'invoice', direction: 'outgoing', number: 'INV-9000200001', status: 'sent',
  issueDate: new Date('2026-03-03T09:00:00.000Z'), currency: 'EUR', subtotal: 32, discountTotal: 0, taxTotal: 6.4, total: 38.4,
  contactId: CONTACT, partner: { vatNumber: 'BG000000011', name: 'Тест Клиент' },
  lines: [line('p1', 1, 10), line('p2', 1, 5), line('p3', 4, 2.5), line('s1', 1, 7)],
  ...over,
})

const posting = (o: ShadowOutcome): ShadowPosting => {
  if (!('posting' in o)) throw new Error(`refused: ${o.refused} ${o.detail ?? ''}`)
  return o.posting
}
/** An entry's operations as `[opNo, debit, debit analytic, credit, credit analytic, amount, quantity]`. */
const ops = (p: ShadowPosting) => {
  const out: unknown[][] = []
  for (const d of p.entry.lines.filter(l => l.side === 'debit')) {
    const c = p.entry.lines.find(l => l.side === 'credit' && l.opNo === d.opNo)!
    expect(c.amount).toBe(d.amount)
    expect(c.quantity).toBe(d.quantity)
    out.push([d.opNo, d.account, d.analyticId ?? null, c.account, c.analyticId ?? null, d.amount, d.quantity ?? null])
  }
  return out
}

describe('the posting of a sales document (§1.4)', () => {
  it('books the cost per group on revenue, the nets, and the VAT, each on the customer', () => {
    const p = posting(postShadowSale(doc(), input()))
    expect(ops(p)).toEqual([
      [1, '702', null, '304', G1, 0.67, 2],
      [2, '702', null, '304', G2, 5, 4],
      [3, '411', CUSTOMER, '702', null, 25, null],
      [4, '411', CUSTOMER, '703', null, 7, null],
      [5, '411', CUSTOMER, '4532', null, 6.4, null],
    ])
    expect(p.entry).toMatchObject({ docType: '-ФЕ', docNumber: '9000200001', registerDocType: '1', partnerAnalyticId: CUSTOMER, docTotal: 38.4, docVat: 6.4, total: 44.07 })
    expect(p.entry.date.toISOString()).toBe('2026-03-03T00:00:00.000Z')
    // The partner's lines name the contact; the group's carry its unit.
    expect(p.entry.lines.filter(l => l.analyticId === CUSTOMER).every(l => l.contactId === CONTACT)).toBe(true)
    expect(p.entry.lines.filter(l => l.analyticId === G1).map(l => l.unit)).toEqual(['бр'])
  })

  it('rounds a group\'s cost once per operation, never per line', () => {
    // Two lines of one group at 0.335 each: 0.67 for the group, where line by line it would be 0.34 + 0.34.
    const p = posting(postShadowSale(doc(), input()))
    expect(p.entry.lines.find(l => l.side === 'credit' && l.analyticId === G1)!.amount).toBe(0.67)
  })

  it('books a credit note negative on the same sides, its quantities too: never swapped', () => {
    const invoice = posting(postShadowSale(doc(), input()))
    const credit = posting(postShadowSale(doc({ type: 'credit_note' }), input()))
    expect(ops(credit)).toEqual(ops(invoice).map(([n, d, ad, k, ak, amount, qty]) => [n, d, ad, k, ak, -(amount as number), qty === null ? null : -(qty as number)]))
    expect(credit.entry).toMatchObject({ registerDocType: '3', docTotal: -38.4, docVat: -6.4 })
    expect(credit.vatRow.row.cells).toEqual({ '02-10': -3200, '02-11': -3200, '02-20': -640, '02-21': -640 })
  })

  it('books what was paid in cash at the counter on the day, and on the customer\'s account', () => {
    const day = new Date('2026-03-03T15:00:00.000Z')
    const p = posting(postShadowSale(doc({
      payments: [
        { date: day, amount: 38.4, method: 'cash', origin: 'cash_on_issue' },
        // A payment a person recorded and a receipt of another day are no part of it.
        { date: day, amount: 1, method: 'cash' },
        { date: new Date('2026-03-04T09:00:00.000Z'), amount: 2, method: 'cash', origin: 'payment_receipt' },
      ],
    }), input()))
    expect(ops(p).at(-1)).toEqual([6, '501', null, '411', CUSTOMER, 38.4, null])
    expect(ops(p)).toHaveLength(6)
  })

  it('books what was paid by card at the counter on the cash account, as the books do, by a rule of its own', () => {
    const day = new Date('2026-03-03T15:00:00.000Z')
    const card = (payments: ShadowDocument['payments']) => postShadowSale(doc({ payments }), input())
    const p = posting(card([
      { date: day, amount: 38.4, method: 'card', origin: 'card_on_issue' },
      // A card payment a person recorded, or one of another day, is no part of it.
      { date: day, amount: 1, method: 'card' },
      { date: new Date('2026-03-04T09:00:00.000Z'), amount: 2, method: 'card', origin: 'payment_receipt' },
    ]))
    expect(ops(p).at(-1)).toEqual([6, '501', null, '411', CUSTOMER, 38.4, null])
    expect(ops(p)).toHaveLength(6)
    // Split tender: the cash first, then the card, each by its own rule.
    const split = posting(card([
      { date: day, amount: 3.4, method: 'card', origin: 'payment_receipt' },
      { date: day, amount: 35, method: 'cash', origin: 'cash_on_issue' },
    ]))
    expect(ops(split).slice(5)).toEqual([[6, '501', null, '411', CUSTOMER, 35, null], [7, '501', null, '411', CUSTOMER, 3.4, null]])
    // The accountant may point the card at another account; with the card's rule switched off, the document waits.
    const elsewhere = SALES_POSTING_RULES.map(r => (r.code === 'sales.invoice.card' ? { ...r, operations: [{ ...r.operations[0], debit: '703' }] } : r))
    expect(ops(posting(postShadowSale(doc({ payments: [{ date: day, amount: 38.4, method: 'card', origin: 'card_on_issue' }] }), input({ rules: elsewhere })))).at(-1))
      .toEqual([6, '703', null, '411', CUSTOMER, 38.4, null])
    const off = SALES_POSTING_RULES.map(r => (r.code === 'sales.invoice.card' ? { ...r, isActive: false } : r))
    expect(postShadowSale(doc({ payments: [{ date: day, amount: 38.4, method: 'card', origin: 'card_on_issue' }] }), input({ rules: off })))
      .toEqual({ refused: 'no_rule', detail: 'card.paid' })
  })

  it('books a card refund at the counter on a credit note negative, on the same sides', () => {
    const day = new Date('2026-03-03T15:00:00.000Z')
    const p = posting(postShadowSale(doc({ type: 'credit_note', payments: [{ date: day, amount: -38.4, method: 'card', origin: 'payment_storno' }] }), input()))
    expect(ops(p).at(-1)).toEqual([6, '501', null, '411', CUSTOMER, -38.4, null])
  })

  it('books a наложен платеж\'s total as paid on its day, as the books do; with its rule off, as LGR holds it', () => {
    const cod = (over: Partial<ShadowDocument> = {}, rules = SALES_POSTING_RULES) => postShadowSale(doc({ paymentMethod: 'cash_on_delivery', ...over }), input({ rules }))
    expect(ops(posting(cod())).at(-1)).toEqual([6, '501', null, '411', CUSTOMER, 38.4, null])
    expect(ops(posting(cod()))).toHaveLength(6)
    // The courier's money recorded on another day is a receipt of its own: the day still books the whole total.
    expect(ops(posting(cod({ payments: [{ date: new Date('2026-03-06T09:00:00.000Z'), amount: 38.4, method: 'cash', origin: 'payment_receipt' }] }))).slice(5))
      .toEqual([[6, '501', null, '411', CUSTOMER, 38.4, null]])
    // What the counter took on the day is booked as taken, and only the rest as the courier's: never twice.
    expect(ops(posting(cod({ payments: [{ date: new Date('2026-03-03T15:00:00.000Z'), amount: 8.4, method: 'cash', origin: 'payment_receipt' }] }))).slice(5))
      .toEqual([[6, '501', null, '411', CUSTOMER, 8.4, null], [7, '501', null, '411', CUSTOMER, 30, null]])
    // A credit note: negative, on the same sides.
    expect(ops(posting(cod({ type: 'credit_note' }))).at(-1)).toEqual([6, '501', null, '411', CUSTOMER, -38.4, null])
    // The switch: with its rule off it posts as LGR holds it, nothing paid, and waits for no rule.
    const off = SALES_POSTING_RULES.map(r => (r.code === 'sales.invoice.cash_on_delivery' ? { ...r, isActive: false } : r))
    expect(ops(posting(cod({}, off)))).toEqual(ops(posting(postShadowSale(doc(), input()))))
    // No other method books it, and two rules for it are refused.
    expect(ops(posting(postShadowSale(doc({ paymentMethod: 'bank_transfer' }), input())))).toHaveLength(5)
    const twice: PostingRuleData[] = [...SALES_POSTING_RULES, { ...SALES_POSTING_RULES.find(r => r.code === 'sales.invoice.cash_on_delivery')!, code: 'sales.invoice.cod.again' }]
    expect(cod({}, twice)).toEqual({ refused: 'rules_overlap', detail: 'cash_on_delivery.paid' })
  })

  it('books a document of services alone on 703 with the whole base, and no cost', () => {
    const p = posting(postShadowSale(doc({ lines: [line('s1', 3, 1.11)], subtotal: 3.33, taxTotal: 0.67, total: 4 }), input()))
    expect(ops(p)).toEqual([
      [1, '411', CUSTOMER, '703', null, 3.33, null],
      [2, '411', CUSTOMER, '4532', null, 0.67, null],
    ])
    expect(p.vatRow.row.description).toBe('Услуги')
  })

  it('takes VAT and base from the document, as the sales register does, so the entry and the row agree', () => {
    const p = posting(postShadowSale(doc(), input()))
    expect(p.vatRow).toEqual({
      period: '202603',
      row: {
        docTypeCode: '01', docNumber: '9000200001', docDate: new Date('2026-03-03T00:00:00.000Z'), partnerVat: 'BG000000011', partnerName: 'Тест Клиент',
        description: 'Стоки', code: '', cells: { '02-10': 3200, '02-11': 3200, '02-20': 640, '02-21': 640 },
      },
    })
    const revenue = p.entry.lines.filter(l => l.side === 'credit' && (l.account === '702' || l.account === '703')).reduce((s, l) => s + l.amount, 0)
    expect(Math.round(revenue * 100)).toBe(p.vatRow.row.cells['02-10'])
  })
})

describe('a document that cannot post says why, and posts nothing', () => {
  const reason = (d: Partial<ShadowDocument>, i: Partial<PostingInput> = {}) => {
    const o = postShadowSale(doc(d), input(i))
    return 'refused' in o ? [o.refused, o.detail] : ['posts']
  }

  it('a line no map posts', () => {
    expect(reason({ lines: [line('p1', 1, 10), line('unmapped', 1, 22)] })).toEqual(['product_unmapped', undefined])
    expect(reason({ lines: [line('suggested', 1, 32)] })).toEqual(['product_suggestion_only', undefined])
    expect(reason({ lines: [line('inactive', 1, 32)] })).toEqual(['group_inactive', undefined])
    expect(reason({ lines: [line(undefined, 1, 32)] })).toEqual(['line_without_product', undefined])
    expect(reason({ lines: [line('elsewhere', 1, 32)] })).toEqual(['product_unknown', undefined])
  })

  it('a partner the books do not hold, or hold twice', () => {
    expect(reason({}, { partner: () => ({ refused: 'no_partner_analytic' }) })).toEqual(['no_partner_analytic', undefined])
    expect(reason({}, { partner: () => ({ refused: 'partner_ambiguous' }) })).toEqual(['partner_ambiguous', undefined])
    expect(reason({ contactId: undefined })).toEqual(['no_partner', undefined])
  })

  it('a group the books never held', () => {
    expect(reason({}, { unitCost: g => (g === G1 ? 0.335 : undefined) })).toEqual(['no_cost', undefined])
  })

  it('a document that is not the org\'s own, not issued, or the till\'s', () => {
    expect(reason({ number: 'INV-9000100001' })).toEqual(['not_own_series', 'other_store'])
    expect(reason({ number: 'INV-9000900001' })).toEqual(['not_own_series', 'outside'])
    expect(reason({ number: 'INV-12345' })).toEqual(['no_register_number', undefined])
    expect(reason({ status: 'draft' })).toEqual(['not_issued', 'draft'])
    expect(reason({ type: 'cash_sale' })).toEqual(['not_a_sales_document', 'cash_sale'])
    expect(reason({ direction: 'incoming' })).toEqual(['not_a_sales_document', 'invoice'])
    expect(reason({ tillSale: true })).toEqual(['till_sale_invoice', undefined])
    expect(reason({ issueDate: new Date('2025-12-31T09:00:00.000Z') })).toEqual(['before_euro_changeover', undefined])
    expect(reason({ currency: 'USD' })).toEqual(['currency_not_eur', 'USD'])
    expect(reason({ lines: [{ ...line('p1', 1, 32), taxRate: 9 }] })).toEqual(['vat_row', 'rate_not_derived'])
  })

  it('a line no rule books, two rules for one amount, or an account the chart lacks', () => {
    const without = (code: string) => SALES_POSTING_RULES.map(r => (r.code === code ? { ...r, isActive: false } : r))
    expect(reason({}, { rules: without('sales.invoice.services') })).toEqual(['no_rule', 'service.net'])
    expect(reason({}, { rules: without('sales.invoice.vat') })).toEqual(['no_rule', 'document.vat'])
    const twice: PostingRuleData[] = [...SALES_POSTING_RULES, { ...SALES_POSTING_RULES[0], code: 'sales.invoice.goods.again' }]
    expect(reason({}, { rules: twice })).toEqual(['rules_overlap', 'goods.cost'])
    expect(reason({}, { accounts: new Map([...CHART].filter(([code]) => code !== '703')) })).toEqual(['unknown_account', '703'])
    const production: PostingRuleData[] = SALES_POSTING_RULES.map(r => (r.code === 'sales.invoice.goods'
      ? { ...r, operations: [{ debit: '702', credit: '304', amount: 'cost', analyticCredit: 'ПРОДУКЦИЯ:Изделие', perGroup: true }, r.operations[1]] }
      : r))
    expect(reason({}, { rules: production })).toEqual(['rule_unsupported', 'sales.invoice.goods'])
  })
})

describe('the hash, the keys and a reversal', () => {
  it('a re-run computes the same hash; a change of what it books changes it', () => {
    const a = posting(postShadowSale(doc(), input()))
    expect(posting(postShadowSale(doc(), input())).hash).toBe(a.hash)
    expect(postingHashOf(a.entry)).toBe(a.hash)
    expect(posting(postShadowSale(doc({ lines: [line('p1', 2, 5), line('p2', 1, 5), line('p3', 4, 2.5), line('s1', 1, 7)] }), input())).hash).not.toBe(a.hash)
    // The books' cost is part of what it books.
    expect(posting(postShadowSale(doc(), input({ unitCost: g => (g === G1 ? 0.4 : 1.25) }))).hash).not.toBe(a.hash)
  })

  it('a reversal is the same lines, negative, on the same sides', () => {
    const p = posting(postShadowSale(doc(), input()))
    const r = reversedLines(p.entry.lines)
    expect(r.map(l => [l.side, l.account, l.analyticId, l.amount, l.quantity])).toEqual(p.entry.lines.map(l => [l.side, l.account, l.analyticId, -l.amount, l.quantity === undefined ? undefined : -l.quantity]))
  })

  it('keys name the document and the revision', () => {
    expect(shadowPostingKey(DOC, 2)).toBe(`shadow:invoice:${DOC}:2`)
    expect(parseShadowKey(shadowPostingKey(DOC, 2, true))).toEqual({ documentId: DOC, revision: 2, reversal: true })
    expect(parseShadowKey(`invoice.posted:${DOC}`)).toBeUndefined()
  })
})

describe('what a run does with a document', () => {
  const posted = posting(postShadowSale(doc(), input()))
  const outcome: ShadowOutcome = { posting: posted }
  const entry = (revision: number, over: Partial<ExistingShadowEntry> = {}): ExistingShadowEntry => ({
    id: `e${revision}${over.reversal ? 'r' : ''}`, revision, reversal: false, voided: false, hash: posted.hash, date: new Date('2026-03-03'), ...over,
  })
  const voidDay = new Date('2026-03-10')

  it('posts it once, and then leaves it', () => {
    expect(planShadowAction(outcome, [])).toEqual({ action: 'post', revision: 1 })
    expect(planShadowAction(outcome, [entry(1)])).toEqual({ action: 'none' })
  })

  it('reverses the live revision and posts the next one when it changed', () => {
    const live = entry(1, { hash: 'before' })
    expect(planShadowAction(outcome, [live])).toEqual({ action: 'repost', reverse: live, revision: 2 })
    // Revision 1 was reversed, revision 2 is live.
    expect(liveRevision([entry(1, { hash: 'before' }), entry(1, { reversal: true }), entry(2)])?.revision).toBe(2)
  })

  it('reverses on the void\'s day, and a void it never saw posts and reverses at once', () => {
    const live = entry(1)
    expect(planShadowAction(outcome, [live], voidDay)).toEqual({ action: 'reverse', reverse: live, on: voidDay })
    expect(planShadowAction(outcome, [], voidDay)).toEqual({ action: 'post_and_reverse', revision: 1, on: voidDay })
    expect(planShadowAction(outcome, [entry(1), entry(1, { reversal: true })], voidDay)).toEqual({ action: 'none' })
  })

  it('reverses a posting whose document no longer posts', () => {
    const live = entry(1)
    expect(planShadowAction({ refused: 'product_unmapped' }, [live])).toEqual({ action: 'reverse', reverse: live, on: live.date })
    expect(planShadowAction({ refused: 'product_unmapped' }, [])).toEqual({ action: 'none' })
  })
})

describe('the seeded rules (§3.7)', () => {
  it('six per kind of sales document, each code once, naming the accounts and roots of §1.4', () => {
    expect(SALES_POSTING_RULES).toHaveLength(18)
    expect(new Set(SALES_POSTING_RULES.map(r => r.code)).size).toBe(18)
    // A card at the counter is booked on the cash account, as the books book it.
    expect(SALES_POSTING_RULES.filter(r => r.match.paymentMethod === 'card').map(r => [r.code, r.operations[0].debit, r.operations[0].credit]))
      .toEqual([['sales.invoice.card', '501', '411'], ['sales.debit_note.card', '501', '411'], ['sales.credit_note.card', '501', '411']])
    // So is a наложен платеж, and its rule is seeded on, as the books have it.
    expect(SALES_POSTING_RULES.filter(r => r.match.paymentMethod === 'cash_on_delivery').map(r => [r.code, r.isActive, r.operations[0].debit, r.operations[0].credit]))
      .toEqual([['sales.invoice.cash_on_delivery', true, '501', '411'], ['sales.debit_note.cash_on_delivery', true, '501', '411'], ['sales.credit_note.cash_on_delivery', true, '501', '411']])
    expect(namedByRules(SALES_POSTING_RULES)).toEqual({ accounts: ['304', '411', '4532', '501', '702', '703'], roots: ['КЛИЕНТИ', 'СТОКИ'] })
    // Production and advances are not this slice's: no rule names them.
    expect(namedByRules(SALES_POSTING_RULES).accounts).not.toContain('701')
    expect(namedByRules(SALES_POSTING_RULES).accounts).not.toContain('412')
  })

  it('seeds what an org lacks, keeps what it has, and refuses a chart that cannot carry them', () => {
    const codes = new Set(['sales.invoice.goods'])
    const plan = planSeed(codes, new Set(CHART.keys()), new Set(['КЛИЕНТИ', 'СТОКИ']))
    expect(plan.create.map(r => r.code)).not.toContain('sales.invoice.goods')
    expect([plan.create.length, plan.kept, plan.missingAccounts, plan.missingRoots]).toEqual([17, 1, [], []])
    const thin = planSeed(new Set(), new Set(['411', '702']), new Set(['КЛИЕНТИ']))
    expect([thin.missingAccounts, thin.missingRoots]).toEqual([['304', '4532', '501', '703'], ['СТОКИ']])
  })
})
