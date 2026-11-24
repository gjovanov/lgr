#!/usr/bin/env bun
/**
 * FR-25 R4, slice 1: one filed month's purchase register, and how many of its rows pair with an LGR bill.
 *
 *   bun scripts/pair-purchases.ts --org <slug> --period YYYYMM [--details]
 *
 * `--org` is any org of the books: the home of a split, one of its stores, or an org that keeps its own. The filed
 * purchase register (`POKUPKI`, imported by R2 as `VatRegisterEntry`) is read in the home, and LGR's bills (incoming
 * invoices, debit and credit notes) in the home and every store of the split. The pairing is
 * `packages/services/src/biz/accounting-books/purchases/pairing.ts`.
 *
 * ⚠ READ-ONLY. A dry run with nothing to execute: it has no `--execute`, and writes nothing anywhere. Connects without
 * building indexes (#546).
 *
 * ⚠ Prints counts only by default, never a number, a partner or an amount, so its output can go in a public PR or issue.
 * `--details` adds one line per row or bill that does not pair exactly, naming the document number, the partner's VAT
 * number and LGR's bill number: that output is for the person running it, privately. Never paste it into the repo, an
 * issue, a PR or a chat.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org } from '../packages/db/src/models/index.js'
import { DIFFERENCE_KINDS, ROW_TYPE_LABELS } from '../packages/services/src/biz/accounting-books/purchases/pairing.js'
import { PurchasePairingError, pairPurchasesOf, type PurchasePairingOf } from '../packages/services/src/biz/accounting-books/purchases/pairing.service.js'

const SCRIPT = 'scripts/pair-purchases.ts'
const FLAGS = new Set(['org', 'period', 'details', 'help'])

const HELP = `Usage: bun ${SCRIPT} --org <slug> --period YYYYMM [--details]

FR-25 R4, slice 1: the filed purchase register of one month (read in the home of the books) against LGR's bills
(read in the home and every store of the split), and how many rows pair with a bill.

READ-ONLY: a dry run with nothing to execute. There is no --execute; it writes nothing.
Prints counts only, never a number, a partner or an amount.

  --details   also list each row or bill that does not pair exactly, by document number, partner VAT number and
              LGR bill number. ⚠ That output holds real identifiers: it is for you, privately. Never paste it into
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

const KIND_LABELS: Record<(typeof DIFFERENCE_KINDS)[number], string> = {
  amount: 'amounts (base or VAT, more than a cent apart)',
  sign: 'amounts of the opposite sign',
  currency: 'a currency other than the register\'s (amounts not compared)',
  date: "the document's day",
  type: 'the document type',
  'number format': 'the number as written (the same digits)',
  period: "the bill's own VAT period",
  number: 'the number (paired on partner, day and amounts)',
  partner: 'the partner (paired on number and amounts)',
}

function print(r: PurchasePairingOf): void {
  console.log(`\nThe purchase register of ${r.period} (${r.currency}), read in ${r.home}; bills read in ${r.billOrgs.join(', ')}`)
  console.log('The filed register')
  row(r.rows.total, 'rows')
  byKey(r.rows.byType, typeLabel)

  const b = r.bills
  console.log("LGR's bills of the period (by VAT period, else the Sofia month of the tax event or issue)")
  row(b.inPeriod, 'received bills')
  byKey(b.byOrg, k => `in ${k}`)
  byKey(b.byType, typeLabel)
  row(b.ocr, '  drafted by the document import (OCR)')
  row(b.noNumber, "  with no supplier's number")
  row(b.noPartner, '  with no supplier VAT number or EIK')
  row(b.converted, "  in leva in a euro period, or the other way, converted at the fixed rate")
  row(b.drafts, 'drafts of the period, left out')
  row(b.voided, 'voided bills of the period, left out')

  const p = r.paired
  console.log('Paired')
  row(p.exactly, 'exactly')
  row(p.annulledBoth, '  of which annulled on both sides (a blank row, a voided bill)')
  row(p.withDifferences, 'with differences; in (a pair can differ in several):')
  for (const k of DIFFERENCE_KINDS) row(p.byKind[k], `  ${KIND_LABELS[k]}`)
  row(p.billOfEarlierPeriod, "pairs whose bill is of an earlier period (declared late)")
  row(p.billOfLaterPeriod, 'pairs whose bill is of a later period')
  row(p.severalBills, 'rows that found several bills under their partner and number')

  const w = r.rowsWithoutBill
  console.log('Register rows with no LGR bill')
  row(w.total, 'rows')
  byKey(w.byType, typeLabel)
  row(w.draftOnly, '  of which LGR holds only a draft')
  row(w.voidedOnly, '  of which LGR holds only a voided bill')

  const o = r.billsWithoutRow
  console.log(`LGR bills of the period with no register row (other registers read: ${r.otherPeriods.first} to ${r.otherPeriods.last}, ${r.otherPeriods.rows} rows)`)
  row(o.total, 'bills')
  byKey(o.byType, typeLabel)
  row(o.inEarlierRegister, "  in an earlier period's register")
  row(o.inLaterRegister, "  in a later period's register")
  row(o.inNoRegister, '  in no register read')

  const verdict = r.rows.total > 0 && p.exactly === r.rows.total && o.total === 0 ? 'equal' : 'not equal'
  console.log(`The register against LGR's bills: ${verdict}`)

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
    print(await pairPurchasesOf(String(org._id), period))
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
