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
import { keepHomeOrgs } from './lib/home-guard.js'
import { Invoice, Org, Sequence } from '../packages/db/src/models/index.js'
import { ensureSequenceAtLeast } from '../packages/services/src/biz/sequence.service.js'
import { currentMaxSuffix } from '../packages/services/src/biz/invoice-numbering.service.js'
import { INVOICING_SEQUENCE_KEYS } from '../packages/services/src/biz/sequence-registry.js'

/**
 * The issued counters whose numbers live on invoicing documents, from the registry (#325). Their
 * prefixes are the org's, resolved by `currentMaxSuffix` as every allocation does: the registry
 * default, the org's override on the sequences page, and the legacy aliases (CRN/DBN). This list
 * hard-coded INV/CRN/DBN/PRF/CS/BILL, so an org that renamed a prefix was never reconciled.
 */
const INVOICE_GROUPS = new Set(['invoice', 'proforma', 'bill', 'cash_sale'])
const COUNTER_KEYS = [...new Set(INVOICING_SEQUENCE_KEYS
  .filter(e => INVOICE_GROUPS.has(e.group) && e.variant === 'issued' && !e.closed && !e.unused)
  .map(e => e.prefix))]

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : null

async function main() {
  await connectDB()
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  console.log(`Org filter: ${orgSlug || '(all)'}`)

  const orgs = await keepHomeOrgs(await Org.find(orgSlug ? { slug: orgSlug } : {}).lean() as any[], { named: !!orgSlug })
  console.log(`Orgs: ${orgs.length}`)

  let totalBumped = 0
  for (const org of orgs) {
    const invoices = await Invoice.find({ orgId: org._id }, { invoiceNumber: 1 }).lean()
    // The years any number names; per year and counter, the highest suffix in use.
    const years = new Set<number>()
    for (const inv of invoices) {
      const m = String((inv as any).invoiceNumber || '').match(/-(\d{4})-\d+$/)
      if (m) years.add(Number(m[1]))
    }
    const maxPerGroup = new Map<string, number>() // "year|key" → max
    for (const year of years) {
      for (const key of COUNTER_KEYS) {
        const max = await currentMaxSuffix(String(org._id), key, year)
        if (max > 0) maxPerGroup.set(`${year}|${key}`, max)
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
