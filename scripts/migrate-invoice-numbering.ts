/**
 * One-off migration: fix invoices whose `invoiceNumber` prefix doesn't match their `type`.
 *
 * Background: The invoice grid filter change (Phase 1) now filters by `type`. Any legacy
 * rows where e.g. `type === 'proforma'` but `invoiceNumber` starts with `INV-` will vanish
 * from the proforma list, and any rows where `type === 'invoice'` but the number starts
 * with `PRF-` / `CRN-` / `DBN-` / `CS-` will vanish from the invoices list.
 *
 * This script:
 *   1. Audits all invoices per org, flagging mismatches.
 *   2. In --execute mode, renumbers mismatched rows to a fresh number using the correct
 *      prefix and the per-org/year Sequence counter. Old number is kept in `oldInvoiceNumber`
 *      for traceability.
 *
 * Usage:
 *   bun run scripts/migrate-invoice-numbering.ts                    # dry-run audit
 *   bun run scripts/migrate-invoice-numbering.ts --execute          # actually migrate
 *   bun run scripts/migrate-invoice-numbering.ts --org regal        # single org
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Invoice, Org, Sequence } from '../packages/db/src/models/index.js'

const TYPE_PREFIX: Record<string, string> = {
  invoice: 'INV', // direction=outgoing
  proforma: 'PRF',
  credit_note: 'CRN',
  debit_note: 'DBN',
  cash_sale: 'CS',
}

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : null

async function nextNumber(orgId: string, prefix: string, year: number): Promise<string> {
  const doc = await Sequence.findOneAndUpdate(
    { orgId, prefix, year },
    { $inc: { lastNumber: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()
  return `${prefix}-${year}-${String(doc!.lastNumber).padStart(5, '0')}`
}

function expectedPrefix(type: string, direction: string): string {
  if (type === 'invoice') return direction === 'incoming' ? 'BILL' : 'INV'
  return TYPE_PREFIX[type] || 'INV'
}

function currentPrefix(num: string): string {
  const m = num.match(/^([A-Z]+)-\d{4}-\d+$/)
  return m ? m[1] : ''
}

async function main() {
  await connectDB()
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  console.log(`Org filter: ${orgSlug || '(all)'}`)

  const orgFilter = orgSlug ? { slug: orgSlug } : {}
  const orgs = await Org.find(orgFilter).lean()
  console.log(`Orgs: ${orgs.length}`)

  let totalAudited = 0
  let totalMismatched = 0
  let totalRenumbered = 0

  for (const org of orgs) {
    const invoices = await Invoice.find({ orgId: org._id }).lean()
    totalAudited += invoices.length

    const mismatched = invoices.filter(inv => {
      const want = expectedPrefix(inv.type, inv.direction)
      return currentPrefix(inv.invoiceNumber) !== want
    })

    if (mismatched.length === 0) {
      console.log(`  [${org.slug}] ${invoices.length} invoices, 0 mismatches`)
      continue
    }

    console.log(`  [${org.slug}] ${invoices.length} invoices, ${mismatched.length} mismatches:`)
    for (const inv of mismatched) {
      const want = expectedPrefix(inv.type, inv.direction)
      const have = currentPrefix(inv.invoiceNumber)
      console.log(`    ${inv.invoiceNumber}  type=${inv.type} dir=${inv.direction}  have=${have} want=${want}`)
      totalMismatched++

      if (execute) {
        const year = new Date(inv.issueDate).getFullYear() || new Date().getFullYear()
        const newNum = await nextNumber(String(org._id), want, year)
        await Invoice.updateOne(
          { _id: inv._id },
          { $set: { invoiceNumber: newNum, oldInvoiceNumber: inv.invoiceNumber } },
          { strict: false },
        )
        console.log(`      -> renumbered to ${newNum}`)
        totalRenumbered++
      }
    }
  }

  console.log('')
  console.log(`Summary: audited=${totalAudited} mismatched=${totalMismatched} renumbered=${totalRenumbered}`)
  if (!execute && totalMismatched > 0) {
    console.log(`Re-run with --execute to apply.`)
  }

  await disconnectDB()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
