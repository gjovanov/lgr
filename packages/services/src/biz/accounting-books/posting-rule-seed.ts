/**
 * FR-25 R3, slice 3: the posting rules a books org starts with (§3.7), the patterns of §1.4 for the sales documents an
 * org issues in its own series: the invoice, the debit notice and the credit notice. Data from the moment they are
 * written: `posting-rule.service.ts#seedPostingRules` inserts the ones an org lacks and never touches one it has, so
 * whatever the accountant changed stays.
 *
 * Seeded per kind of document, six rules each, applied together to a document (`shadow-sales.ts`):
 *   - goods lines: per goods group `D702 K304[СТОКИ:group]` with the group's quantity, at the group's cost; and
 *     `D411[КЛИЕНТИ:partner] K702` their net;
 *   - service lines: `D411[КЛИЕНТИ:partner] K703` their net;
 *   - the document: `D411[КЛИЕНТИ:partner] K4532` its VAT, and the sales register row it makes;
 *   - paid in cash as it was issued: `D501 K411[КЛИЕНТИ:partner]` what was paid;
 *   - paid by card as it was issued: `D501 K411[КЛИЕНТИ:partner]` what was paid;
 *   - cash on delivery (наложен платеж): `D501 K411[КЛИЕНТИ:partner]` its total, as paid on its day.
 *
 * ⚠ Cost of sales is a debit on revenue (`D702`), and a credit note books the same operations, negative, on the same
 * sides (§1.4, "three things that read as mistakes and are not"). Neither is a rule's choice: the seed keeps both.
 *
 * ⚠ A card payment at the counter is booked on `501`, as cash is: the books code such a document `1` (paid on its own
 * operations) and debit `501` what was paid (2026-11-25: every card sale at the counter of the months compared but one).
 * It is a rule of its own so the accountant can point it at another account without touching cash.
 *
 * ⚠ A наложен платеж is booked as the books book it: paid in cash on its day, its whole total, although LGR records no
 * payment until the courier pays (the books code it `1`; 2026-11-25: 13 of the 14 compared). Seeded on, as the books have
 * it, and the one rule that is a switch (the owner's decision of 2026-11-25): turned off, a наложен платеж posts as LGR
 * holds it, with nothing paid, instead of waiting for a rule (`scripts/switch-posting-rule.ts`).
 *
 * Out of this slice, and refused rather than guessed: production (`K701`, `D701 K303`) and advances (`K412`). A document
 * that needs them finds no rule and waits, counted.
 *
 * Import-pure.
 */
import type { IPostingRuleMatch, IPostingRuleOperation } from 'db/models'
import { REGISTER_DOC_TYPES } from '../vat-files/sales-register.js'
import {
  ANALYTIC_ROOTS, CASH_ACCOUNT, CUSTOMERS_ACCOUNT, GOODS_ACCOUNT, GOODS_REVENUE_ACCOUNT, SALES_INVOICE_DOC_TYPE, SERVICES_REVENUE_ACCOUNT,
  VAT_OUTPUT_ACCOUNT,
} from './registry.js'

/** A rule as the posting reads it: the stored row without its bookkeeping. */
export interface PostingRuleData {
  code: string
  label: string
  isActive: boolean
  match: IPostingRuleMatch
  docType: string
  partnerRoot?: string
  operations: IPostingRuleOperation[]
  vat?: { register: 'sales' | 'purchase'; docTypeCode: string; vatKind?: string }
}

/** The analytic spec of a side: the document's partner, or the goods group of the lines (§3.7). */
export const PARTNER_ANALYTIC = 'contact'
export const GROUP_ANALYTIC = 'group'

const rootOf = (kind: string) => ANALYTIC_ROOTS.find(r => r.kind === kind)!.root
/** Where a customer's analytic is: `КЛИЕНТИ`. */
export const CUSTOMERS_ROOT = rootOf('customer')
/** Where a goods group is: `СТОКИ`. */
export const GOODS_ROOT = rootOf('goods_group')

const LABELS: Record<string, string> = { invoice: 'Sales invoice', debit_note: 'Debit notice', credit_note: 'Credit notice' }

/** The rules of one kind of document. */
function rulesOf(docKind: string): PostingRuleData[] {
  const label = LABELS[docKind]
  const match = (more: Partial<IPostingRuleMatch> = {}): IPostingRuleMatch => ({ docKind, direction: 'outgoing', ...more })
  const base = { isActive: true, docType: SALES_INVOICE_DOC_TYPE, partnerRoot: CUSTOMERS_ROOT }
  return [
    {
      ...base,
      code: `sales.${docKind}.goods`,
      label: `${label}: goods, their cost per group and their net`,
      match: match({ lineKind: 'goods' }),
      operations: [
        { debit: GOODS_REVENUE_ACCOUNT, credit: GOODS_ACCOUNT, amount: 'cost', analyticCredit: GROUP_ANALYTIC, perGroup: true },
        { debit: CUSTOMERS_ACCOUNT, credit: GOODS_REVENUE_ACCOUNT, amount: 'net', analyticDebit: PARTNER_ANALYTIC },
      ],
    },
    {
      ...base,
      code: `sales.${docKind}.services`,
      label: `${label}: services, their net`,
      match: match({ lineKind: 'service' }),
      operations: [{ debit: CUSTOMERS_ACCOUNT, credit: SERVICES_REVENUE_ACCOUNT, amount: 'net', analyticDebit: PARTNER_ANALYTIC }],
    },
    {
      ...base,
      code: `sales.${docKind}.vat`,
      label: `${label}: its VAT`,
      match: match(),
      operations: [{ debit: CUSTOMERS_ACCOUNT, credit: VAT_OUTPUT_ACCOUNT, amount: 'vat', analyticDebit: PARTNER_ANALYTIC }],
      vat: { register: 'sales', docTypeCode: REGISTER_DOC_TYPES[docKind] },
    },
    {
      ...base,
      code: `sales.${docKind}.cash`,
      label: `${label}: paid in cash as it was issued`,
      match: match({ paymentMethod: 'cash' }),
      operations: [{ debit: CASH_ACCOUNT, credit: CUSTOMERS_ACCOUNT, amount: 'paid', analyticCredit: PARTNER_ANALYTIC }],
    },
    {
      ...base,
      code: `sales.${docKind}.card`,
      label: `${label}: paid by card as it was issued`,
      match: match({ paymentMethod: 'card' }),
      operations: [{ debit: CASH_ACCOUNT, credit: CUSTOMERS_ACCOUNT, amount: 'paid', analyticCredit: PARTNER_ANALYTIC }],
    },
    {
      ...base,
      code: `sales.${docKind}.cash_on_delivery`,
      label: `${label}: cash on delivery, its total as paid on its day`,
      match: match({ paymentMethod: 'cash_on_delivery' }),
      operations: [{ debit: CASH_ACCOUNT, credit: CUSTOMERS_ACCOUNT, amount: 'paid', analyticCredit: PARTNER_ANALYTIC }],
    },
  ]
}

/** Every rule this slice seeds: the three kinds of sales document of an org's own series. */
export const SALES_POSTING_RULES: readonly PostingRuleData[] = Object.keys(REGISTER_DOC_TYPES).flatMap(rulesOf)

/** The account codes the rules name, and the analytic roots, sorted. */
export function namedByRules(rules: readonly PostingRuleData[]): { accounts: string[]; roots: string[] } {
  const accounts = new Set<string>()
  const roots = new Set<string>()
  for (const r of rules) {
    if (r.partnerRoot) roots.add(r.partnerRoot)
    for (const op of r.operations) {
      accounts.add(op.debit)
      accounts.add(op.credit)
      if (op.analyticDebit === GROUP_ANALYTIC || op.analyticCredit === GROUP_ANALYTIC) roots.add(GOODS_ROOT)
    }
  }
  return { accounts: [...accounts].sort(), roots: [...roots].sort() }
}

export interface SeedPlan {
  create: PostingRuleData[]
  /** Rules the org already holds, by code: never changed by a seed. */
  kept: number
  /** What the rules name and the org's chart or tree lacks. The seed refuses then: a rule must post in this org. */
  missingAccounts: string[]
  missingRoots: string[]
}

/** What seeding an org would do: the rules it lacks, if its chart and tree hold what they name. */
export function planSeed(existingCodes: ReadonlySet<string>, chart: ReadonlySet<string>, roots: ReadonlySet<string>, rules: readonly PostingRuleData[] = SALES_POSTING_RULES): SeedPlan {
  const named = namedByRules(rules)
  return {
    create: rules.filter(r => !existingCodes.has(r.code)),
    kept: rules.filter(r => existingCodes.has(r.code)).length,
    missingAccounts: named.accounts.filter(code => !chart.has(code)),
    missingRoots: named.roots.filter(root => !roots.has(root)),
  }
}
