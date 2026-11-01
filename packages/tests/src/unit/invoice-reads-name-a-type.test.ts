import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * FR-23: a `payment_receipt` is an `Invoice` row: outgoing, paid, with a customer on it and, printed
 * whole, the invoice's products. A reader with no `type` in its filter counts it beside its invoice, a
 * 24.00 cash invoice reads as 48.00 paid, and nothing marks that wrong. So every read of several
 * invoices names what it reads, or says why it need not.
 *
 * "Names" means its filter says `type`, an id, a client key, or `NOT_PAYMENT_RECEIPT`. A filter held in
 * a variable, or a read that cannot count money, cannot be told from here, so it is listed below with
 * its reason. A read that is neither fails: add `...NOT_PAYMENT_RECEIPT`, or say why not here.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')

/** `file method first-argument`, as this test prints it, and why it is safe. */
const SAYS_SO: Record<string, string> = {
  'invoicing-api/src/controllers/invoice-export.controller.ts find filter': 'its callers set `type`, or a kind',
  'invoicing-api/src/controllers/invoice.controller.ts findAll filter': 'the list route: NOT_PAYMENT_RECEIPT unless a type is asked for',
  'services/src/biz/cash-register/copy-org.ts find { orgId: org, invoiceNumber: { $in: numbers.slice(i, i + BATCH) } }': 'a number taken is taken, whoever took it',
  'services/src/biz/cash-register/journal.service.ts find docMatch': 'TILL_DOCUMENT_TYPES: the journal lists receipts',
  'services/src/biz/cash-register/journal.service.ts countDocuments docMatch': 'the same',
  'services/src/biz/cash-register/payment-receipt.service.ts distinct \'register.paidInvoiceId\'': 'names the type in its second argument',
  'services/src/biz/cash-register/payment-receipt.service.ts find liveReceipts(orgId, documentId)': 'the receipts of a document',
  'services/src/biz/cash-register/pos-union.ts find match': 'REGISTER_TYPES, or TILL_DOCUMENT_TYPES when asked',
  'services/src/biz/cash-sale-invoice.service.ts distinct CASH_SALE_REF_ID': 'only invoices carry a cash-sale link',
  'services/src/biz/contact-ledger.service.ts aggregate countPipeline': 'its $match says NOT_PAYMENT_RECEIPT',
  'services/src/biz/contact-ledger.service.ts aggregate pipeline': 'the same',
  'services/src/biz/contact-ledger.service.ts aggregate summaryPipeline': 'the same',
  'services/src/biz/contact-ledger.service.ts aggregate costPipeline': 'the same',
  'services/src/biz/digest/daily-digest.service.ts find // An invoice issued for a cash sale is the same money as that cash sale (#171)': 'its filter says NOT_PAYMENT_RECEIPT, under this comment',
  'services/src/biz/move/fenced-export.service.ts find { orgId, invoiceNumber: { $in: numbers } }': 'a number taken is taken, whoever took it',
  'services/src/biz/number-clash.service.ts find { orgId: org, \'numberClash.withId\': { $exists: true } }': 'flagged documents, listed for a person',
  'services/src/biz/product-ledger.service.ts aggregate pipeline': 'its $match names the sale types',
  'services/src/biz/reports/sales-history.report.ts find docMatch': 'names its types where it is built',
  'services/src/biz/reservation-ops.service.ts countDocuments { orgId, status: { $nin: [\'voided\', \'cancelled\'] }, $or: [{ internalOrderId }, { \'lines.orderRef.internalOr': 'an order link, which a receipt never carries',
  'services/src/biz/reservation.service.ts find { orgId, orderId, direction: \'incoming\', status: { $nin: LIVE_STATUSES_EXCLUDED } } as any': 'incoming: a receipt is outgoing',
  'services/src/biz/sale-counting.ts distinct CASH_SALE_REF_ID': 'only invoices carry a cash-sale link',
  'services/src/biz/settlement-backlog.ts distinct \'register.paidInvoiceId\'': 'names the type in its second argument',
  'services/src/biz/supto-export.service.ts findMany invoiceQuery': 'names cash_sale where it is built',
}

const READ = /\b(?:Invoice|invoices)\.(find|aggregate|countDocuments|distinct|findAll|findMany|count)\(/g
const NAMES_WHAT_IT_READS = /\btype\b|\b_id\b|\bid\b|NOT_PAYMENT_RECEIPT|clientKey/

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'tests' || name === 'e2e') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (name.endsWith('.ts')) yield path
  }
}

/** The call's first argument, as written. */
function firstArgument(text: string, from: number): string {
  let depth = 1
  let i = from
  for (; i < text.length && depth > 0; i++) {
    const c = text[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 1) break
  }
  return text.slice(from, depth === 0 ? i - 1 : i).replace(/\s+/g, ' ').trim()
}

describe('a read of several invoices', () => {
  it('names what it reads, or says why it need not', () => {
    const silent: string[] = []
    const heard = new Set<string>()
    let reads = 0
    for (const file of sources(PACKAGES)) {
      const rel = relative(PACKAGES, file).replace(/\\/g, '/')
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(READ)) {
        reads++
        const first = firstArgument(text, m.index! + m[0].length)
        if (NAMES_WHAT_IT_READS.test(first)) continue
        const known = Object.keys(SAYS_SO).find(k => `${rel} ${m[1]} ${first}`.startsWith(k))
        if (known) heard.add(known)
        else silent.push(`${rel} ${m[1]} ${first.slice(0, 80)}`)
      }
    }
    expect(reads).toBeGreaterThan(50)
    expect(silent).toEqual([])
    // A site that is gone goes from the list too, or the list stops saying anything.
    expect(Object.keys(SAYS_SO).filter(k => !heard.has(k))).toEqual([])
  })
})
