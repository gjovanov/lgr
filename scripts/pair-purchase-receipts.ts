#!/usr/bin/env bun
/**
 * FR-25 R4, slice 2, option (c): one filed month's purchase register, and how many of its rows pair with the stores'
 * goods receipts.
 *
 *   bun scripts/pair-purchase-receipts.ts --org <slug> --period YYYYMM [--details]
 *
 * `--org` is any org of the books: the home of a split, one of its stores, or an org that keeps its own. The filed
 * purchase register (`POKUPKI`, imported by R2 as `VatRegisterEntry`) is read in the home, the month's and the twelve
 * after it; the receipts and returns (`StockMovement`) in the home and every store of the split. A row and receipts pair
 * on partner, day and amount, never on a number (a receipt holds the store program's own number, never the supplier's).
 * The pairing is `packages/services/src/biz/accounting-books/purchases/receipt-pairing.ts`.
 *
 * ⚠ READ-ONLY. A dry run with nothing to execute: it has no `--execute`, and writes nothing anywhere. Connects without
 * building indexes (#546).
 *
 * ⚠ Prints counts only by default, never a number, a partner or an amount, so its output can go in a public PR or issue.
 * `--details` adds one line per row and receipt, naming the document number, the partner's VAT number and LGR's
 * movement number: that output is for the person running it, privately. Never paste it into the repo, an issue, a PR or
 * a chat.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org } from '../packages/db/src/models/index.js'
import { ROW_TYPE_LABELS } from '../packages/services/src/biz/accounting-books/purchases/pairing.js'
import { PurchasePairingError } from '../packages/services/src/biz/accounting-books/purchases/pairing.service.js'
import { DAY_WINDOW, RECEIPT_EXCLUSIONS, RETURN_DAYS, RETURN_EXCLUSIONS, SUM_DAYS } from '../packages/services/src/biz/accounting-books/purchases/receipt-pairing.js'
import { pairPurchaseReceiptsOf, type ReceiptPairingOf } from '../packages/services/src/biz/accounting-books/purchases/receipt-pairing.service.js'

const SCRIPT = 'scripts/pair-purchase-receipts.ts'
const FLAGS = new Set(['org', 'period', 'details', 'help'])

const HELP = `Usage: bun ${SCRIPT} --org <slug> --period YYYYMM [--details]

FR-25 R4, slice 2: the filed purchase register of one month (read in the home of the books) against the goods
receipts of the home and every store of the split, paired on partner, day and amount.

READ-ONLY: a dry run with nothing to execute. There is no --execute; it writes nothing.
Prints counts only, never a number, a partner or an amount.

  --details   also list each row and receipt with its outcome, by document number, partner VAT number and LGR
              movement number. ⚠ That output holds real identifiers: it is for you, privately. Never paste it into
              the repo, an issue, a PR or a chat.`

const argv = process.argv.slice(2)
const args: Record<string, string | boolean> = {}
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const next = argv[i + 1]
  if (next && !next.startsWith('--')) { args[argv[i].slice(2)] = next; i++ } else args[argv[i].slice(2)] = true
}
if (args.help) {
  console.log(HELP)
  process.exit(0)
}
const slug = typeof args.org === 'string' ? args.org : ''
const period = typeof args.period === 'string' ? args.period : ''
const details = args.details === true
const unknown = Object.keys(args).filter(k => !FLAGS.has(k))
if (!slug || !/^\d{4}(0[1-9]|1[0-2])$/.test(period) || unknown.length) {
  console.error(`${HELP}${unknown.length ? `\n\nUnknown: --${unknown.join(', --')}` : ''}`)
  process.exit(2)
}

const row = (n: number, label: string) => console.log(`${String(n).padStart(7)}  ${label}`)
const typeLabel = (code: string) => `${code} ${ROW_TYPE_LABELS[code] ?? 'other'}`
const byKey = (m: Record<string, number>, label: (k: string) => string, indent = '  ') => {
  for (const [k, n] of Object.entries(m).sort(([a], [b]) => a.localeCompare(b))) row(n, `${indent}${label(k)}`)
}

function print(r: ReceiptPairingOf): void {
  console.log(`\nThe purchase register of ${r.period}, read in ${r.home}; receipts read in ${r.stores.join(', ')} (${r.movementsRead} movements)`)
  console.log(`Paired on partner, day and amount: one to one within ${DAY_WINDOW} days; summed over a partner's receipts of up to ${SUM_DAYS} days before the row; a credit note up to ${RETURN_DAYS} days after its return.`)
  console.log('The filed register')
  row(r.rows.total, 'rows')
  byKey(r.rows.byType, typeLabel)
  row(r.rows.datedEarlier, "  dated in a month before their period")
  row(r.rows.datedLater, '  dated in a month after their period')

  const m = r.month
  console.log("The stores' receipts of the month (Sofia days)")
  row(m.receipts, 'receipts')
  byKey(m.receiptsByOrg, k => `in ${k}`)
  console.log('  left out (each counted once, first reason that holds):')
  for (const k of RECEIPT_EXCLUSIONS) row(m.excluded[k], `    ${k}`)
  row(m.deliveries, "suppliers' deliveries, paired below")
  byKey(m.deliveriesByOrg, k => `in ${k}`)
  row(m.heldByBill, '  of which an LGR bill holds')
  row(m.returns, 'returns to a supplier (the negative lines of a receipt, or a return booked by hand)')
  for (const k of RETURN_EXCLUSIONS) row(m.returnsExcluded[k], `  left out: ${k}`)
  row(m.returnsKept, '  paired below, with credit notes (03)')

  const p = r.partners
  console.log("Tier 1, a partner's month: the rows' base against the deliveries less the returns")
  row(p.withRows, 'partners with rows (01, 02, 03)')
  row(p.withReceipts, 'partners with deliveries or returns')
  row(p.inBoth, 'partners with both')
  row(p.equalNet, '  equal to the base (net)')
  row(p.equalGross, '  equal to the gross only (base + VAT)')
  row(p.differ, '  different')
  row(p.rowsOfEqual, '  rows of the partners whose month is equal')
  row(p.rowsOnly, 'partners with rows and no receipt of the month')
  row(p.receiptsOnly, 'partners with receipts and no row of the month')
  row(p.severalStores, 'partners whose deliveries of the month are in more than one store')

  const q = r.paired
  console.log('Tiers 2 and 3: rows paired')
  row(q.total, 'rows paired')
  row(q.oneToOne.net, '  tier 2, one row to one receipt, to the base')
  row(q.oneToOne.gross, '  tier 2, one row to one receipt, to the gross only')
  row(q.summed.net, "  tier 3, one row to a partner's receipts of a few days summed, to the base")
  row(q.summed.gross, "  tier 3, one row to a partner's receipts of a few days summed, to the gross only")
  row(q.creditOneToOne, '  of those, credit notes (03) to one return')
  row(q.creditSummed, '  of those, credit notes (03) to several returns')
  row(q.sameDay, '  one to one on the same day')
  row(q.acrossStores, '  paired with receipts of more than one store')
  row(q.receiptsOfEarlierMonth, '  with receipts of a month before the period (declared late)')
  row(q.receiptsOfLaterMonth, '  with receipts of a month after the period')

  const u = r.rowsUnpaired
  console.log('Rows with no receipt')
  row(u.total, 'rows')
  byKey(u.byType, typeLabel)
  row(u.partnerHasReceipts, '  01, 02, 03 whose partner delivered or returned something in the year (goods suppliers)')
  row(u.partnerHasNone, '  01, 02, 03 whose partner delivered nothing in the year (services and expenses)')
  row(u.noPartner, '  01, 02, 03 naming no partner')
  row(u.ambiguous, '  left because several receipts, or several runs, fit')

  const later = r.laterPeriods.rows ? `${r.laterPeriods.first} to ${r.laterPeriods.last}, ${r.laterPeriods.rows} rows` : 'none filed'
  console.log(`Where the month's deliveries and returns were declared (later registers read: ${later})`)
  row(r.receiptsOfMonth.inPeriod, "deliveries in this period's register")
  row(r.receiptsOfMonth.later, "deliveries in a later period's register")
  row(r.receiptsOfMonth.notDeclared, 'deliveries not declared in any register read')
  row(r.returnsOfMonth.inPeriod, "returns in this period's register")
  row(r.returnsOfMonth.later, "returns in a later period's register")
  row(r.returnsOfMonth.notDeclared, 'returns not declared in any register read')

  if (details) {
    console.log('\n⚠ Details: real identifiers follow. For you only: never paste them into the repo, an issue, a PR or a chat.')
    for (const d of r.details) console.log(`  ${d.outcome}: ${d.key}`)
  }
}

await connectDB({ readOnly: true })
let code = 1
try {
  const org = await Org.findOne({ slug }).select('_id').lean<{ _id: unknown }>()
  if (!org) {
    console.error(`No org ${slug}.`)
    code = 2
  } else {
    console.log(`Org ${slug}: ${period}. Read-only, a dry run with nothing to execute; counts only${details ? ', and the details asked for' : ''}.`)
    print(await pairPurchaseReceiptsOf(String(org._id), period))
    code = 0
  }
} catch (e) {
  if (!(e instanceof PurchasePairingError)) throw e
  console.error(`Refused (${e.code}): ${e.message}`)
  code = 2
} finally {
  await disconnectDB()
}
process.exit(code)
