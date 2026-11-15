/**
 * One-time correction of an org's purchase prices: „Покупна цена" = „Цена 2" / 1.2 (owner, 2026-11-15).
 *
 * Until then every import wrote PlusMinus's „Доставна цена" as the product's purchasePrice. That figure is the
 * price with the trade discount: it stays in the tier slot of that name (drawn as „Цена с ТО"). PlusMinus keeps no
 * buying price, and „Цена 2" / 1.2 approximates it. The rule and its rounding: packages/config/src/price-tiers.ts.
 *
 * For every product of the org whose „Цена 2" slot holds a price above zero (deactivated ones too: they can be
 * reactivated), the run sets `purchasePrice` to the rule and gives the slots a purchase price moves the margin
 * (`percent`) that stands over the new one. It changes NO price: no finalPrice, no sellingPrice, and no avgCost,
 * stock level, movement or document. A product without „Цена 2" is left untouched and counted. A second run
 * writes nothing.
 *
 * Usage (one org per run; dry run unless --execute):
 *   bun run scripts/set-purchase-price-from-tier2.ts --org <slug>
 *   bun run scripts/set-purchase-price-from-tier2.ts --org <slug> --execute --backup <file.ndjson>
 *   bun run scripts/set-purchase-price-from-tier2.ts --org <slug> --restore <file.ndjson>            # dry run
 *   bun run scripts/set-purchase-price-from-tier2.ts --org <slug> --restore <file.ndjson> --execute
 *
 * Options:
 *   --org <slug>       (required) the org
 *   --execute          write (default: count only)
 *   --backup <file>    (required with --execute) where the before-values go, one NDJSON line per changed product:
 *                      _id, sku, the purchase price before and after, the margins changed. Must not exist yet.
 *   --restore <file>   put a backup's before-values back. A product edited since the run keeps the edit.
 *   --batch <n>        products per page and per bulkWrite (default 1000)
 *
 * It prints counts and a few sample rows by SKU. No audit-log rows are written (the sibling one-off price scripts
 * write none either): the backup file is the record of what changed.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { Org } from '../packages/db/src/models/index.js'
import { restorePurchasePrices, setPurchasePricesFromTier2 } from '../packages/services/src/biz/purchase-price-from-tier2.js'

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[a.slice(2)] = next; i++ } else { o[a.slice(2)] = true }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
const orgSlug = typeof args.org === 'string' ? args.org : ''
const execute = args.execute === true
const backupPath = typeof args.backup === 'string' ? args.backup : ''
const restorePath = typeof args.restore === 'string' ? args.restore : ''
const batchSize = Math.max(1, Number(args.batch) || 1000)

if (!orgSlug) { console.error('Required: --org <slug>. See the header for the options.'); process.exit(2) }
if (restorePath && backupPath) { console.error('--restore and --backup do not go together.'); process.exit(2) }
if (execute && !restorePath && !backupPath) { console.error('--execute needs --backup <file>: the before-values are saved before anything is written.'); process.exit(2) }

const started = Date.now()
// Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
await connectDB({ readOnly: true })
let code = 0
try {
  const org: any = await Org.findOne({ slug: orgSlug }).lean()
  if (!org) throw new Error(`org "${orgSlug}" not found`)
  await assertScriptHome(org._id, orgSlug)
  const orgId = String(org._id)

  if (restorePath) {
    console.log(`Restore | org ${orgSlug} | ${execute ? 'EXECUTE' : 'DRY RUN'} | from ${restorePath}`)
    const r = await restorePurchasePrices(orgId, restorePath, { execute, batchSize })
    console.log(`  backup lines            : ${r.lines}`)
    console.log(`  ${execute ? 'restored' : 'would restore'}          : ${r.restored}`)
    console.log(`  skipped (edited since)  : ${r.skipped}`)
  } else {
    console.log(`Purchase price = „Цена 2" / 1.2 | org ${orgSlug} | ${execute ? `EXECUTE, backup → ${backupPath}` : 'DRY RUN'}`)
    const r = await setPurchasePricesFromTier2(orgId, {
      execute, backupPath: backupPath || undefined, batchSize,
      onProgress: (seen, changed) => { if (seen % (batchSize * 10) === 0) console.log(`  … ${seen} products read, ${changed} to change`) },
    })
    console.log(`  products                : ${r.products}`)
    console.log(`  ${execute ? 'changed' : 'to change'}               : ${r.changed}  (of them deactivated: ${r.inactiveChanged}; margins only: ${r.marginsOnly})`)
    console.log(`  already right           : ${r.alreadyRight}`)
    console.log(`  no „Цена 2" (untouched) : ${r.noTier2}`)
    if (execute) console.log(`  written                 : ${r.written}${r.written === r.changed ? '' : '  ⚠ fewer than changed: a product was saved by someone else meanwhile, run again'}`)
    for (const s of r.samples) console.log(`    ${s.sku}  Цена 2 ${s.tier2}  purchase ${s.from} → ${s.to}  (${s.margins} margin${s.margins === 1 ? '' : 's'})`)
    if (!execute) console.log('Dry run: nothing was written. Add --execute --backup <file> to write.')
  }
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
} catch (e: any) {
  console.error(`Failed: ${e?.message ?? e}`)
  code = 1
} finally {
  await disconnectDB()
}
process.exit(code)
