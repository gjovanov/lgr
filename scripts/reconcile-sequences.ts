/**
 * One-off migration: reconcile Sequence counters with the highest existing invoice numbers
 * per org × year × prefix group.
 *
 * Background: after switching INV/CRN/DBN to a shared SALES_DOC counter, legacy orgs have
 * invoices that were numbered by the old per-prefix algorithm. Their SALES_DOC counter is at
 * 0 (or the old CRN counter), so a fresh CRN allocates below the highest existing INV number.
 * This script bumps every counter to max(current, highest existing suffix) so subsequent
 * allocations continue strictly above all pre-existing numbers.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   bun run scripts/reconcile-sequences.ts               # dry-run audit
 *   bun run scripts/reconcile-sequences.ts --execute     # apply updates
 *   bun run scripts/reconcile-sequences.ts --org regal   # single org
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Invoice, Org, Sequence } from '../packages/db/src/models/index.js'
import { ensureSequenceAtLeast } from '../packages/services/src/biz/sequence.service.js'

const PREFIX_GROUPS: { key: string; prefixes: string[] }[] = [
  { key: 'SALES_DOC', prefixes: ['INV', 'CRN', 'DBN'] },
  { key: 'PROFORMA', prefixes: ['PRF'] },
  { key: 'CASH_SALE', prefixes: ['CS'] },
  { key: 'BILL', prefixes: ['BILL'] },
]

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : null

function extractSuffix(invoiceNumber: string, prefixes: string[], year: number): number | null {
  const m = invoiceNumber.match(new RegExp(`^(?:${prefixes.join('|')})-${year}-(\\d+)$`))
  return m ? Number(m[1]) : null
}

async function main() {
  await connectDB()
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  console.log(`Org filter: ${orgSlug || '(all)'}`)

  const orgs = await Org.find(orgSlug ? { slug: orgSlug } : {}).lean()
  console.log(`Orgs: ${orgs.length}`)

  let totalBumped = 0
  for (const org of orgs) {
    const invoices = await Invoice.find({ orgId: org._id }, { invoiceNumber: 1 }).lean()
    // Group by (year, groupKey) and find max suffix.
    const maxPerGroup = new Map<string, number>() // "year|key" → max
    for (const inv of invoices) {
      const num = (inv as any).invoiceNumber as string
      if (!num) continue
      const yearMatch = num.match(/-(\d{4})-/)
      if (!yearMatch) continue
      const year = Number(yearMatch[1])
      for (const g of PREFIX_GROUPS) {
        const suf = extractSuffix(num, g.prefixes, year)
        if (suf !== null) {
          const key = `${year}|${g.key}`
          maxPerGroup.set(key, Math.max(maxPerGroup.get(key) ?? 0, suf))
        }
      }
    }

    if (maxPerGroup.size === 0) {
      console.log(`  [${org.slug}] no numbered invoices — skipping`)
      continue
    }

    for (const [comboKey, max] of maxPerGroup) {
      const [yearStr, key] = comboKey.split('|')
      const year = Number(yearStr)
      const current = await Sequence.findOne({ orgId: org._id, prefix: key, year }).lean()
      const currentVal = (current as any)?.lastNumber ?? 0

      if (currentVal >= max) {
        console.log(`  [${org.slug}] ${key} ${year}: counter=${currentVal}, max=${max} — OK`)
        continue
      }

      console.log(`  [${org.slug}] ${key} ${year}: counter=${currentVal} → ${max}${execute ? ' (BUMPING)' : ''}`)
      if (execute) {
        await ensureSequenceAtLeast(String(org._id), key, year, max)
        totalBumped++
      }
    }
  }

  console.log('')
  console.log(`Summary: counters bumped=${totalBumped}`)
  if (!execute) console.log('Re-run with --execute to apply.')

  await disconnectDB()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
