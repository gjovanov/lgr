/**
 * One-off migration: backfill Product/Contact lowered mirror fields used for
 * Cyrillic-safe case-insensitive search (nameLower, skuLower, companyNameLower, etc.).
 *
 * Idempotent — always recomputes from source.
 *
 * Usage:
 *   bun run scripts/backfill-search-lowercase.ts               # dry-run
 *   bun run scripts/backfill-search-lowercase.ts --execute     # apply
 *   bun run scripts/backfill-search-lowercase.ts --execute --org regal
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, Product, Contact } from '../packages/db/src/models/index.js'

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : null

const LOCALE = 'bg'
function lower(v: unknown): string | undefined {
  return typeof v === 'string' ? v.toLocaleLowerCase(LOCALE) : undefined
}

const PRODUCT_FIELDS = {
  name: 'nameLower',
  sku: 'skuLower',
  barcode: 'barcodeLower',
  description: 'descriptionLower',
  category: 'categoryLower',
} as const

const CONTACT_FIELDS = {
  companyName: 'companyNameLower',
  firstName: 'firstNameLower',
  lastName: 'lastNameLower',
  email: 'emailLower',
  taxId: 'taxIdLower',
  vatNumber: 'vatNumberLower',
} as const

async function backfill<T extends Record<string, any>>(
  Model: any,
  label: string,
  orgFilter: any,
  fieldMap: Record<string, string>,
) {
  const docs = await Model.find(orgFilter).select(['_id', ...Object.keys(fieldMap)]).lean()
  let updated = 0
  for (const doc of docs as T[]) {
    const set: Record<string, any> = {}
    for (const [src, tgt] of Object.entries(fieldMap)) {
      const next = lower(doc[src])
      if (next !== undefined) set[tgt] = next
    }
    if (Object.keys(set).length === 0) continue
    if (execute) await Model.updateOne({ _id: doc._id }, { $set: set }).exec()
    updated += 1
  }
  console.log(`  ${label}: scanned=${docs.length} updated=${updated}`)
  return updated
}

async function main() {
  await connectDB()
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  console.log(`Org filter: ${orgSlug || '(all)'}`)

  const orgs = await Org.find(orgSlug ? { slug: orgSlug } : {}).lean()
  console.log(`Orgs: ${orgs.length}`)

  let totalProducts = 0
  let totalContacts = 0
  for (const org of orgs) {
    console.log(`\n[${org.slug}]`)
    totalProducts += await backfill(Product, 'products', { orgId: org._id }, PRODUCT_FIELDS)
    totalContacts += await backfill(Contact, 'contacts', { orgId: org._id }, CONTACT_FIELDS)
  }

  console.log(`\nTotal: products=${totalProducts} contacts=${totalContacts}`)
  if (!execute) console.log('DRY-RUN — no writes performed. Re-run with --execute to apply.')

  await disconnectDB()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
