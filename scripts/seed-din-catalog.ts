/**
 * Seed the global DIN ↔ ISO/EN fastener-standard reference catalog
 * (collection `din_catalog`, model DinCatalog — org-independent) from the
 * committed scripts/data/din-catalog.json (165 rows in 12 Bulgarian
 * categories, extracted from the "DIN_ISO_EN разширен каталог крепежни
 * елементи" DOCX).
 *
 * With --org it ALSO get-or-creates the 12 ProductCategory docs for that org
 * (name = exact category string, sortOrder = categoryIndex) so that
 * assign-din-tags.ts can recategorize products. Existing categories
 * (including „Общи") are never touched. Created via ProductCategory.create()
 * so the loweredFieldsPlugin save hook fills nameLower.
 *
 * Idempotent: catalog rows upsert by `din`; categories are get-or-create.
 *
 * Usage:
 *   bun run scripts/seed-din-catalog.ts                          # dry-run, catalog only
 *   bun run scripts/seed-din-catalog.ts --execute                # write catalog
 *   bun run scripts/seed-din-catalog.ts --org regal-pz --execute # + org categories
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { Org, DinCatalog, ProductCategory } from '../packages/db/src/models/index.js'
// Imported, not read from beside the script: a server package carries the script bundled, and the
// data with it (FR-20 plan step P0b-9).
import catalogRows from './data/din-catalog.json' with { type: 'json' }

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
const execute = !!args.execute
const orgSlug = args.org ? String(args.org) : null

interface CatalogRow {
  din: string
  baseNumber: string
  variant: string | null
  iso: string[]
  en: string[]
  equivalentRaw: string
  description: string
  note: string
  categoryIndex: number
  category: string
}

const rows = catalogRows as unknown as CatalogRow[]
if (!Array.isArray(rows) || !rows.length) {
  console.error('No rows in scripts/data/din-catalog.json')
  process.exit(1)
}
const dinKeys = new Set(rows.map(r => r.din))
if (dinKeys.size !== rows.length) {
  console.error('Duplicate din keys in catalog JSON')
  process.exit(1)
}
const categories = [...new Map(rows.map(r => [r.categoryIndex, r.category])).entries()]
  .sort((a, b) => a[0] - b[0])

console.log(`din-catalog.json: ${rows.length} rows, ${categories.length} categories — ${execute ? 'EXECUTE' : 'DRY-RUN'}`)

await connectDB()

// ── catalog upsert (global, no org) ──────────────────────────────────────────
const existing = await DinCatalog.countDocuments({})
if (execute) {
  const res = await DinCatalog.bulkWrite(
    rows.map(r => ({
      updateOne: {
        filter: { din: r.din },
        update: { $set: { ...r, variant: r.variant ?? undefined } },
        upsert: true,
      },
    })),
    { ordered: false },
  )
  console.log(`din_catalog: had ${existing}, upserted ${res.upsertedCount}, modified ${res.modifiedCount} → total ${await DinCatalog.countDocuments({})}`)
} else {
  console.log(`din_catalog: has ${existing} rows, would upsert ${rows.length}`)
}

// ── per-org product categories ───────────────────────────────────────────────
if (orgSlug) {
  const org: any = await Org.findOne({ slug: orgSlug }).lean()
  if (!org) { console.error(`Org "${orgSlug}" not found`); process.exit(1) }
  await assertScriptHome(org._id, orgSlug)
  console.log(`\nOrg ${orgSlug} (${org._id}) — product categories:`)
  for (const [index, name] of categories) {
    const found = await ProductCategory.findOne({ orgId: org._id, name }).lean()
    if (found) {
      console.log(`  = exists  ${index}. ${name}`)
    } else if (execute) {
      await ProductCategory.create({
        orgId: org._id,
        name,
        description: `DIN ↔ ISO/EN каталог, раздел ${index}`,
        sortOrder: index,
        isActive: true,
      })
      console.log(`  + created ${index}. ${name}`)
    } else {
      console.log(`  + would create ${index}. ${name}`)
    }
  }
}

await disconnectDB()
console.log(`\nDone${execute ? '' : ' (dry-run — pass --execute to write)'}`)
