/**
 * Assign fastener facet tags to an org's products, derived from product NAMES:
 *   - DIN standard numbers ("DIN 933", whitelisted variants "DIN 7504-K")
 *   - ISO / EN numbers found in the name ("ISO 7380", "EN 14399-4")
 *   - cross-equivalents from the global din_catalog reference (DIN 933 → ISO 4017,
 *     EN 14399-4 → DIN 6914, …)
 *   - dimensions, canonical Cyrillic ("М8Х25", "Ф90Х529", "6Х70", "М10Х1.25Х40")
 *   - coating / material / strength codes (ZN, BL, HDG, YELLOW ZINC, A2, A4,
 *     МЕСИНГ, 6.8, 8.8, 10.9, 12.9)
 *
 * Also (default ON) RECATEGORIZES products whose name carries a catalog DIN into
 * the standard's category (12 categories seeded by seed-din-catalog.ts --org).
 * The FIRST catalog DIN in the name wins ("ШАЙБА - DIN 5406 - за DIN 981" is the
 * washer, not the nut). To avoid fighting manual curation, a product is only
 * moved when its current category is „Общи" or one of the 12 catalog categories
 * (override with --force-category).
 *
 * Writes are additive + idempotent: $addToSet for tags, per-doc $set for the
 * category triple (category, categoryId, categoryLower — set explicitly because
 * Model.bulkWrite bypasses the loweredFieldsPlugin query middleware). Tag
 * vocabulary docs { orgId, type: 'product', value } are upserted so TagInput
 * autocomplete and the products tag filter work. Re-runs converge; rule changes
 * never REMOVE stale tags (delete via the portal tag admin, which $pulls).
 *
 * ⚠ A `seed-products` --clean re-baseline wipes tags AND categories — re-run
 *   seed-din-catalog.ts --org <slug> and this script afterwards. New products
 *   created by receive-new-products land untagged in „Общи" — re-run this
 *   script after daily imports (cheap, converges).
 *
 * Usage:
 *   bun run scripts/assign-din-tags.ts --org regal-pz              # dry-run + report
 *   bun run scripts/assign-din-tags.ts --org regal-pz --execute
 * Options:
 *   --org <slug>          org (default: regal-pz)
 *   --execute             perform writes (default: dry-run)
 *   --no-recategorize     tags only, leave categories alone
 *   --force-category      recategorize even products manually moved to other categories
 *   --batch <n>           bulkWrite batch size (default 500)
 *   --samples <n>         sample lines in the report (default 30)
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { Org, Product, ProductCategory, DinCatalog, Tag } from '../packages/db/src/models/index.js'
import {
  extractFastenerFacets,
  formatDinTag,
  type DinRef,
} from '../packages/services/src/biz/fastener-tags.utils.js'

const GENERAL_CATEGORY = 'Общи'

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
const orgSlug = String(args.org || 'regal-pz')
const execute = !!args.execute
const recategorize = !args['no-recategorize']
const forceCategory = !!args['force-category']
const BATCH = Math.max(1, Number(args.batch) || 500)
const SAMPLES = Math.max(0, Number(args.samples) || 30)

await connectDB()
const org: any = await Org.findOne({ slug: orgSlug }).lean()
if (!org) { console.error(`Org "${orgSlug}" not found`); process.exit(1) }
await assertScriptHome(org._id, orgSlug)
const orgId = org._id
console.log(`Org ${orgSlug} (${orgId}) — ${execute ? 'EXECUTE' : 'DRY-RUN'}${recategorize ? '' : ' (tags only)'}`)

// ── catalog maps ─────────────────────────────────────────────────────────────
const catalog: any[] = await DinCatalog.find({}).lean()
if (!catalog.length) {
  console.error('din_catalog is EMPTY — run: bun run scripts/seed-din-catalog.ts --execute')
  process.exit(1)
}
const rowsByBase = new Map<string, any[]>()
const rowByDin = new Map<string, any>()
const isoToBases = new Map<string, string[]>()
const enToBases = new Map<string, string[]>()
const categoryByBase = new Map<string, string>()
for (const r of catalog) {
  if (!rowsByBase.has(r.baseNumber)) rowsByBase.set(r.baseNumber, [])
  rowsByBase.get(r.baseNumber)!.push(r)
  rowByDin.set(r.din, r)
  categoryByBase.set(r.baseNumber, r.category)
  for (const iso of r.iso || []) {
    // exact key + suffixless base key ("ISO 7380-1" also answers "ISO 7380")
    for (const key of new Set([iso, iso.replace(/-\d+$/, '')])) {
      if (!isoToBases.has(key)) isoToBases.set(key, [])
      if (!isoToBases.get(key)!.includes(r.baseNumber)) isoToBases.get(key)!.push(r.baseNumber)
    }
  }
  for (const en of r.en || []) {
    if (!enToBases.has(en)) enToBases.set(en, [])
    if (!enToBases.get(en)!.includes(r.baseNumber)) enToBases.get(en)!.push(r.baseNumber)
  }
}
const catalogCategories = [...new Map(catalog.map(r => [r.categoryIndex, r.category])).entries()]
  .sort((a, b) => a[0] - b[0]).map(([, name]) => name as string)
console.log(`din_catalog: ${catalog.length} rows, ${catalogCategories.length} categories`)

// ── org categories ───────────────────────────────────────────────────────────
const categoryDocs = new Map<string, any>() // name → doc
for (const c of await ProductCategory.find({ orgId, name: { $in: catalogCategories } }).lean()) {
  categoryDocs.set((c as any).name, c)
}
if (recategorize) {
  const missing = catalogCategories.filter(n => !categoryDocs.has(n))
  if (missing.length) {
    console.error(`Missing ${missing.length} product categories for org — run: bun run scripts/seed-din-catalog.ts --org ${orgSlug} --execute`)
    console.error(`  ${missing.join('\n  ')}`)
    process.exit(1)
  }
}
// Categories this script is allowed to move a product OUT of (unless --force-category).
const movableFrom = new Set<string>([GENERAL_CATEGORY, ...catalogCategories])

// ── helpers ──────────────────────────────────────────────────────────────────
/** Catalog rows for a DIN ref: exact variant row when known, else all base rows. */
function catalogRowsFor(ref: DinRef): any[] {
  if (ref.variant) {
    const exact = rowByDin.get(formatDinTag(ref))
    if (exact) return [exact]
  }
  return rowsByBase.get(ref.base) || []
}

// ── main pass ────────────────────────────────────────────────────────────────
let scanned = 0
let productsWithTags = 0
let productsNeedingTagUpdate = 0
let newTagAssignments = 0
let recatCount = 0
let recatSkippedManual = 0
let multiCategoryFirstWins = 0
let updatedProducts = 0
const facetProducts = { din: 0, iso: 0, en: 0, dims: 0, coatings: 0 }
const tagCounts = new Map<string, number>() // desired tag → product count
const desiredVocab = new Set<string>()
const notInCatalog = new Map<string, number>()
const recatByCategory = new Map<string, number>()
const sampleLines: string[] = []
const bulk: any[] = []
let writeErrors = 0

async function flush() {
  if (!execute || !bulk.length) { bulk.length = 0; return }
  const ops = bulk.splice(0)
  const res: any = await Product.bulkWrite(ops, { ordered: false })
  updatedProducts += res.modifiedCount || 0
  const errs = res.getWriteErrors?.() || []
  if (errs.length) {
    writeErrors += errs.length
    console.error(`  bulkWrite: ${errs.length} write errors (first: ${errs[0]?.errmsg})`)
  }
}

const cursor = Product.find({ orgId })
  .select({ name: 1, tags: 1, category: 1, categoryId: 1 })
  .lean()
  .cursor()

for await (const prod of cursor as any) {
  scanned++
  const name: string = prod.name || ''
  const f = extractFastenerFacets(name)

  const desired = new Set<string>()
  // ordered catalog bases for category resolution: name DINs first, then reverse ISO/EN
  const categoryBases: string[] = []

  for (const ref of f.din) {
    desired.add(`DIN ${ref.base}`)
    if (ref.variant) desired.add(formatDinTag(ref))
    const rows = catalogRowsFor(ref)
    if (rows.length) {
      if (!categoryBases.includes(ref.base)) categoryBases.push(ref.base)
      for (const r of rows) {
        for (const iso of r.iso || []) desired.add(iso)
        for (const en of r.en || []) desired.add(en)
      }
    } else {
      notInCatalog.set(ref.base, (notInCatalog.get(ref.base) || 0) + 1)
    }
  }
  for (const iso of f.iso) {
    desired.add(iso)
    for (const base of isoToBases.get(iso) || []) {
      desired.add(`DIN ${base}`)
      if (!categoryBases.includes(base)) categoryBases.push(base)
    }
  }
  for (const en of f.en) {
    desired.add(en)
    for (const base of enToBases.get(en) || []) {
      desired.add(`DIN ${base}`)
      if (!categoryBases.includes(base)) categoryBases.push(base)
    }
  }
  for (const d of f.dims) desired.add(d)
  for (const c of f.coatings) desired.add(c)

  if (f.din.length) facetProducts.din++
  if (f.iso.length) facetProducts.iso++
  if (f.en.length) facetProducts.en++
  if (f.dims.length) facetProducts.dims++
  if (f.coatings.length) facetProducts.coatings++
  if (desired.size) productsWithTags++
  for (const t of desired) {
    tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
    desiredVocab.add(t)
  }

  const existing = new Set<string>((prod.tags || []) as string[])
  const newTags = [...desired].filter(t => !existing.has(t))

  // category target: first catalog DIN wins
  let categorySet: Record<string, unknown> | null = null
  let targetCategory: string | null = null
  if (recategorize && categoryBases.length) {
    const distinct = new Set(categoryBases.map(b => categoryByBase.get(b)!))
    if (distinct.size > 1) multiCategoryFirstWins++
    targetCategory = categoryByBase.get(categoryBases[0])!
    if (prod.category !== targetCategory) {
      if (forceCategory || movableFrom.has(prod.category)) {
        const catDoc = categoryDocs.get(targetCategory)!
        categorySet = {
          category: targetCategory,
          categoryId: catDoc._id,
          // Model.bulkWrite bypasses loweredFieldsPlugin — mirror set explicitly,
          // exact plugin normalization: toLocaleLowerCase('bg'), no trim.
          categoryLower: targetCategory.toLocaleLowerCase('bg'),
        }
        recatCount++
        recatByCategory.set(targetCategory, (recatByCategory.get(targetCategory) || 0) + 1)
      } else {
        recatSkippedManual++
      }
    }
  }

  if (newTags.length || categorySet) {
    if (newTags.length) {
      productsNeedingTagUpdate++
      newTagAssignments += newTags.length
    }
    const update: Record<string, unknown> = {}
    if (newTags.length) update.$addToSet = { tags: { $each: newTags } }
    if (categorySet) update.$set = categorySet
    bulk.push({ updateOne: { filter: { _id: prod._id }, update } })
    if (bulk.length >= BATCH) await flush()
    if (sampleLines.length < SAMPLES) {
      sampleLines.push(
        `  ${name}\n    +[${newTags.join(' | ')}]${categorySet ? `  → ${targetCategory}` : ''}`,
      )
    }
  }
}
await flush()

// ── tag vocabulary upsert ────────────────────────────────────────────────────
const vocabExisting = new Set<string>(
  (await Tag.find({ orgId, type: 'product' }).select({ value: 1 }).lean()).map((t: any) => t.value),
)
const vocabNew = [...desiredVocab].filter(v => !vocabExisting.has(v))
if (execute && vocabNew.length) {
  const res = await Tag.bulkWrite(
    vocabNew.map(value => ({
      updateOne: {
        filter: { orgId, type: 'product', value },
        update: { $setOnInsert: { orgId, type: 'product', value } },
        upsert: true,
      },
    })),
    { ordered: false },
  )
  console.log(`Tag vocabulary: +${res.upsertedCount} new (had ${vocabExisting.size})`)
} else {
  console.log(`Tag vocabulary: ${execute ? 'no new needed' : `would add ${vocabNew.length} new`} (has ${vocabExisting.size})`)
}

// ── report ───────────────────────────────────────────────────────────────────
const top = (prefixTest: (t: string) => boolean, n = 15) =>
  [...tagCounts.entries()].filter(([t]) => prefixTest(t)).sort((a, b) => b[1] - a[1])
    .slice(0, n).map(([t, c]) => `${t}(${c})`).join(' ')

console.log(`\n══ ${execute ? 'EXECUTED' : 'DRY-RUN'} report ══`)
console.log(`products scanned: ${scanned}`)
console.log(`  with ≥1 derivable tag: ${productsWithTags} (din:${facetProducts.din} dims:${facetProducts.dims} coatings:${facetProducts.coatings} iso-in-name:${facetProducts.iso} en-in-name:${facetProducts.en})`)
console.log(`  needing tag updates: ${productsNeedingTagUpdate} (${newTagAssignments} tag assignments)`)
if (recategorize) {
  console.log(`  recategorized: ${recatCount}; skipped (manual category, use --force-category): ${recatSkippedManual}; multi-category names (first DIN wins): ${multiCategoryFirstWins}`)
  for (const [c, v] of [...recatByCategory.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${c}`)
}
if (execute) console.log(`  bulkWrite: modified ${updatedProducts} products, ${writeErrors} write errors`)
console.log(`distinct tags: ${desiredVocab.size}`)
console.log(`  top DIN:      ${top(t => t.startsWith('DIN '))}`)
console.log(`  top ISO:      ${top(t => t.startsWith('ISO '))}`)
console.log(`  top EN:       ${top(t => t.startsWith('EN '))}`)
console.log(`  top dims:     ${top(t => /^[МФ]?\d/.test(t) && t.includes('Х'))}`)
console.log(`  coatings:     ${top(t => ['ZN', 'BL', 'HDG', 'YELLOW ZINC', 'A2', 'A4', 'МЕСИНГ', '6.8', '8.8', '10.9', '12.9'].includes(t), 20)}`)
const notCat = [...notInCatalog.entries()].sort((a, b) => b[1] - a[1])
console.log(`DIN bases NOT in catalog (${notCat.length} distinct, tagged anyway, no category/cross-refs):`)
console.log(`  ${notCat.map(([k, v]) => `${k}(${v})`).join(' ')}`)
if (sampleLines.length) {
  console.log(`\nsamples (${sampleLines.length}):`)
  for (const s of sampleLines) console.log(s)
}

await disconnectDB()
console.log(`\nDone${execute ? '' : ' (dry-run — pass --execute to write)'}`)
