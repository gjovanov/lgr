/**
 * One-off migration: backfill Product.priceTiers[] with 10 default slots
 * (name = "Price N", percent = 0, finalPrice = sellingPrice, no filters).
 *
 * Idempotent — only seeds products whose priceTiers array is empty.
 *
 * Usage:
 *   bun run scripts/backfill-price-tiers.ts               # dry-run
 *   bun run scripts/backfill-price-tiers.ts --execute     # apply
 *   bun run scripts/backfill-price-tiers.ts --org regal   # single org
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { keepHomeOrgs } from './lib/home-guard.js'
import { Org, Product } from '../packages/db/src/models/index.js'

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : null

function defaultTiers(sellingPrice: number) {
  const tiers = []
  for (let i = 1; i <= 10; i++) {
    tiers.push({
      name: `Price ${i}`,
      percent: 0,
      finalPrice: sellingPrice,
      manualOverride: false,
      contactIds: [],
      tags: [],
    })
  }
  return tiers
}

async function main() {
  await connectDB()
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  console.log(`Org filter: ${orgSlug || '(all)'}`)

  const orgs = await keepHomeOrgs(await Org.find(orgSlug ? { slug: orgSlug } : {}).lean() as any[], { named: !!orgSlug })
  console.log(`Orgs: ${orgs.length}`)

  let seeded = 0
  let skipped = 0
  for (const org of orgs) {
    const products = await Product.find({ orgId: org._id }).select({ _id: 1, sellingPrice: 1, priceTiers: 1 })
    for (const p of products) {
      if (Array.isArray(p.priceTiers) && p.priceTiers.length > 0) {
        skipped += 1
        continue
      }
      const tiers = defaultTiers(Number(p.sellingPrice) || 0)
      if (execute) {
        await Product.updateOne({ _id: p._id }, { $set: { priceTiers: tiers } }).exec()
      }
      seeded += 1
    }
    console.log(`  ${org.slug}: ${products.length} products, +${seeded - (skipped > 0 ? 0 : 0)} seeded so far`)
  }

  console.log(`\nTotal: seeded=${seeded} skipped=${skipped}`)
  if (!execute) console.log('DRY-RUN — no writes performed. Re-run with --execute to apply.')

  await disconnectDB()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
