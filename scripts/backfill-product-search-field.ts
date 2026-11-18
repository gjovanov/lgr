/**
 * FR-30.11: fill `Product.searchLower` (the five lowered mirrors joined, `db/plugins/search-field.ts`) where it is
 * missing or no longer what the mirrors say. The plugin keeps it on every write from now on; this is for the articles
 * written before it, and for any a raw driver write left behind. Until it has run, the search still finds them: an
 * article without the field is read by its mirrors.
 *
 * Idempotent: a second run writes nothing. The value is computed by the database from the stored mirrors, so run
 * `scripts/backfill-search-lowercase.ts` first where the mirrors themselves may be missing.
 *
 * Usage:
 *   bun run scripts/backfill-product-search-field.ts                       # dry run: how many would be written
 *   bun run scripts/backfill-product-search-field.ts --execute             # write
 *   bun run scripts/backfill-product-search-field.ts --execute --org <slug>
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { keepHomeOrgs } from './lib/home-guard.js'
import { Org, Product } from '../packages/db/src/models/index.js'
import { refreshSearchField, staleSearchField, type SearchFieldConfig } from '../packages/db/src/plugins/search-field.js'

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : null

/** What `product.model.ts` declares as the joined field. */
export const PRODUCT_SEARCH_FIELD: SearchFieldConfig = {
  field: 'searchLower',
  parts: ['nameLower', 'skuLower', 'barcodeLower', 'descriptionLower', 'categoryLower'],
}

/** Per org, the articles whose field is missing or stale; written with `execute`. Exported for the test. */
export async function backfillProductSearchField(orgIds: unknown[], opts: { execute: boolean }): Promise<{ stale: number; written: number }> {
  let stale = 0
  let written = 0
  for (const orgId of orgIds) {
    stale += await Product.countDocuments(staleSearchField(PRODUCT_SEARCH_FIELD, { orgId }) as any).exec()
    if (opts.execute) written += await refreshSearchField(Product, PRODUCT_SEARCH_FIELD, { orgId })
  }
  return { stale, written }
}

async function main() {
  // Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
  await connectDB({ readOnly: true })
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  const orgs = await keepHomeOrgs(await Org.find(orgSlug ? { slug: orgSlug } : {}).lean() as any[], { named: !!orgSlug })
  console.log(`Orgs: ${orgs.length}`)
  let stale = 0
  let written = 0
  for (const org of orgs) {
    const r = await backfillProductSearchField([org._id], { execute })
    console.log(`  [${org.slug}] stale=${r.stale}${execute ? ` written=${r.written}` : ''}`)
    stale += r.stale
    written += r.written
  }
  console.log(`\nTotal: stale=${stale}${execute ? ` written=${written}` : ''}`)
  if (!execute) console.log('DRY-RUN: nothing written. Re-run with --execute to apply.')
  await disconnectDB()
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
