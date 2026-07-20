/**
 * Seed / update products + stock for an org from a "storeAvailability" Excel export.
 *
 * Generic, repeatable version of import-regal-pz.ts + update-prices.ts. Two modes:
 *   --clean    (DEFAULT) wipe the org's existing products + stock levels, then
 *              insert everything fresh from the file.
 *   --no-clean update-in-place: match existing products by name and update only
 *              the selected --columns (prices, stock, etc.) — leaves the rest alone.
 *
 * Excel layout (storeAvailability_*.xlsx): rows 1-4 title block, row 5 = headers,
 * data rows 6..N, final "Всичко" grand-total row skipped. Columns:
 *   1 Име · 2 Мярка · 3 Количество · 4 Доставна цена · 5 Продажна цена ·
 *   6 Цена на едро · 7-11 Цена1..Цена5 · 12-14 Цена7..Цена9  (no Цена6 → 10 tier slots)
 *
 * Usage:
 *   bun run scripts/seed-products.ts --org <slug> --file <path.xlsx>            # dry-run, clean mode
 *   bun run scripts/seed-products.ts --org <slug> --file <f> --execute          # wipe + reimport
 *   bun run scripts/seed-products.ts --org <slug> --file <f> --no-clean --columns purchase,selling,tiers --execute   # reprice only
 *   bun run scripts/seed-products.ts --org <slug> --file <f> --no-clean --columns quantity --execute                 # restock only
 *
 * Options:
 *   --org <slug>         (required) target org — must already exist
 *   --file <path>        (required) xlsx path
 *   --warehouse <code>   warehouse for stock levels (default: the org's isDefault warehouse)
 *   --category <name>    category for NEW products (default: Общи) — created if missing
 *   --sku-prefix <p>     SKU prefix in clean mode (default: derived from org slug)
 *   --clean / --no-clean wipe-and-reimport (DEFAULT) vs. update-in-place by name
 *   --columns <csv>      fields to write/update (default: all)
 *                        one or more of: name,unit,quantity,purchase,selling,tiers  (or "all")
 *   --clamp-negative     clamp negative quantities to 0 (default: preserve negatives)
 *   --execute            perform writes (default: dry-run)
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, Warehouse, ProductCategory, Product, StockLevel } from '../packages/db/src/models/index.js'
import ExcelJS from 'exceljs'
import path from 'path'

const HEADER_ROW = 5
const DATA_START_ROW = 6
const SKIP_NAMES = new Set(['Всичко', 'ОБЩО:', 'Опаковка'])
const BATCH_SIZE = 500
// Each column accepts one or more header labels (exports vary: full vs abbreviated).
const EXPECTED_HEADERS: string[][] = [
  ['Име'], ['Мярка'], ['Количество'],
  ['Доставна цена', 'Дост. цена'],
  ['Продажна цена', 'Прод. цена'],
  ['Цена на едро', 'Цена едро'],
  ['Цена1'], ['Цена2'], ['Цена3'], ['Цена4'], ['Цена5'], ['Цена7'], ['Цена8'], ['Цена9'],
]
const TIER_NAMES = [
  'Доставна цена', 'Цена на едро',
  'Цена 1', 'Цена 2', 'Цена 3', 'Цена 4', 'Цена 5', 'Цена 7', 'Цена 8', 'Цена 9',
]
const ALL_COLUMNS = ['name', 'unit', 'quantity', 'purchase', 'selling', 'tiers'] as const
type Column = (typeof ALL_COLUMNS)[number]

// ── args ──
function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}
const args = parseArgs(process.argv.slice(2))
const dryRun = !args.execute
const orgSlug = args.org as string
const filePath = args.file as string
const cleanMode = !args['no-clean'] // default clean
const clampNegative = !!args['clamp-negative']
const warehouseCode = args.warehouse as string | undefined
const categoryName = (args.category as string) || 'Общи'

if (!orgSlug || !filePath) {
  console.error('Required: --org <slug> --file <path.xlsx>. See header for options.')
  process.exit(2)
}
const columns: Set<Column> = new Set(
  (!args.columns || args.columns === 'all' || args.columns === true)
    ? ALL_COLUMNS
    : String(args.columns).split(',').map(s => s.trim()) as Column[],
)
for (const c of columns) if (!ALL_COLUMNS.includes(c as Column)) { console.error(`Unknown column "${c}". Valid: ${ALL_COLUMNS.join(',')}`); process.exit(2) }

const skuPrefix = (args['sku-prefix'] as string) || orgSlug.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SKU'
const round4 = (v: number) => +v.toFixed(4)

interface Item {
  row: number; name: string; unit: string; quantity: number
  purchase: number; selling: number; tierPrices: number[]
}

function cellNum(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'object' && 'result' in (v as any)) return Number((v as any).result) || 0
  return Number(v) || 0
}
function normalizeUnit(raw: string): string {
  let u = raw.trim().replace(/^\//, '').toLocaleUpperCase('bg')
  if (!u || u === '0') u = 'БР'
  return u
}
function buildTiers(purchase: number, tierPrices: number[]) {
  return tierPrices.map((price, i) => ({
    name: TIER_NAMES[i],
    percent: purchase > 0 && price > 0 ? +(((price - purchase) / purchase) * 100).toFixed(1) : 0,
    finalPrice: price,
    manualOverride: price > 0,
    contactIds: [],
    tags: [],
  }))
}

async function readExcel(fp: string): Promise<Item[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const sheet = wb.getWorksheet(1)!
  const headers = EXPECTED_HEADERS.map((_, i) => String(sheet.getRow(HEADER_ROW).getCell(i + 1).text ?? '').trim())
  const bad = EXPECTED_HEADERS.findIndex((aliases, i) => !aliases.includes(headers[i]))
  if (bad !== -1) {
    console.error(`Header mismatch at column ${bad + 1}: expected one of ${JSON.stringify(EXPECTED_HEADERS[bad])}, got "${headers[bad]}"`)
    console.error(`Full header row: ${JSON.stringify(headers)}`)
    process.exit(1)
  }
  const items: Item[] = []
  sheet.eachRow((row, rn) => {
    if (rn < DATA_START_ROW) return
    const name = String(row.getCell(1).text ?? '').trim()
    if (!name || SKIP_NAMES.has(name)) return
    const purchase = round4(cellNum(row.getCell(4).value))
    const wholesale = round4(cellNum(row.getCell(6).value))
    const legacy = [7, 8, 9, 10, 11, 12, 13, 14].map(c => round4(cellNum(row.getCell(c).value)))
    items.push({
      row: rn, name, unit: normalizeUnit(String(row.getCell(2).text ?? '')),
      quantity: cellNum(row.getCell(3).value),
      purchase, selling: round4(cellNum(row.getCell(5).value)),
      tierPrices: [purchase, wholesale, ...legacy],
    })
  })
  return items
}

function qtyOf(item: Item) { return clampNegative ? Math.max(item.quantity, 0) : item.quantity }

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'} | ${cleanMode ? 'CLEAN (wipe + reimport)' : 'UPDATE (in-place by name)'}`)
  console.log(`Org: ${orgSlug} | file: ${filePath} | columns: ${[...columns].join(',')} | negatives: ${clampNegative ? 'clamped' : 'preserved'}`)
  console.log()

  const items = await readExcel(path.resolve(filePath))
  const names = new Map<string, number>()
  let neg = 0
  for (const it of items) { names.set(it.name, (names.get(it.name) || 0) + 1); if (it.quantity < 0) neg++ }
  const dups = [...names.entries()].filter(([, c]) => c > 1)
  console.log(`Rows: ${items.length} | negative qty: ${neg} | duplicate names: ${dups.length}`)
  for (const it of items.slice(0, 2)) {
    console.log(`  "${it.name}" unit=${it.unit} qty=${it.quantity} purchase=${it.purchase} selling=${it.selling}`)
    if (columns.has('tiers')) console.log(`    tiers: ${buildTiers(it.purchase, it.tierPrices).map(t => `${t.name}=${t.finalPrice}`).join(' | ')}`)
  }
  console.log()

  if (dryRun) { console.log('Dry run complete. Add --execute to write.'); return }

  await connectDB()
  console.log('Connected to MongoDB')

  const org = await Org.findOne({ slug: orgSlug })
  if (!org) { console.error(`Org "${orgSlug}" not found. Create it first (see seed-user skill / register flow).`); process.exit(1) }

  const warehouse = warehouseCode
    ? await Warehouse.findOne({ orgId: org._id, code: warehouseCode })
    : await Warehouse.findOne({ orgId: org._id, isDefault: true })
  if (!warehouse) { console.error(`Warehouse ${warehouseCode ? `"${warehouseCode}"` : '(default)'} not found for org.`); process.exit(1) }
  console.log(`Warehouse: ${warehouse.name} (${warehouse.code})`)

  let category = await ProductCategory.findOne({ orgId: org._id, name: categoryName })
  if (!category) category = await ProductCategory.create({ orgId: org._id, name: categoryName, isActive: true })

  if (cleanMode) await runClean(org, warehouse, category, items)
  else await runUpdate(org, warehouse, items, names)

  console.log('\nDone.')
}

async function runClean(org: any, warehouse: any, category: any, items: Item[]) {
  const delP = await Product.deleteMany({ orgId: org._id })
  const delS = await StockLevel.deleteMany({ orgId: org._id })
  console.log(`Cleaned: ${delP.deletedCount} products, ${delS.deletedCount} stock levels`)

  const docs = items.map((it, i) => ({
    orgId: org._id,
    sku: `${skuPrefix}-${String(i + 1).padStart(5, '0')}`,
    name: it.name,
    category: category.name,
    categoryId: category._id,
    type: 'goods' as const,
    unit: columns.has('unit') ? it.unit : 'БР',
    purchasePrice: columns.has('purchase') ? it.purchase : 0,
    sellingPrice: columns.has('selling') ? it.selling : 0,
    currency: org.settings?.baseCurrency || 'BGN',
    taxRate: org.settings?.taxConfig?.defaultVatRate ?? 20,
    trackInventory: true,
    priceTiers: columns.has('tiers') ? buildTiers(it.purchase, it.tierPrices) : [],
    customPrices: [],
    isActive: true,
  }))

  console.log(`Inserting ${docs.length} products ...`)
  const inserted: Array<{ _id: any; idx: number }> = []
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = await Product.insertMany(docs.slice(i, i + BATCH_SIZE))
    batch.forEach((p, j) => inserted.push({ _id: p._id, idx: i + j }))
    console.log(`  products ${Math.min(i + BATCH_SIZE, docs.length)} / ${docs.length}`)
  }

  if (columns.has('quantity') || columns.has('purchase')) {
    console.log(`Inserting ${inserted.length} stock levels ...`)
    for (let i = 0; i < inserted.length; i += BATCH_SIZE) {
      const batch = inserted.slice(i, i + BATCH_SIZE).map(p => {
        const q = columns.has('quantity') ? qtyOf(items[p.idx]) : 0
        return {
          orgId: org._id, productId: p._id, warehouseId: warehouse._id,
          quantity: q, reservedQuantity: 0, availableQuantity: q,
          avgCost: columns.has('purchase') ? items[p.idx].purchase : 0,
        }
      })
      await StockLevel.insertMany(batch)
      console.log(`  stock ${Math.min(i + BATCH_SIZE, inserted.length)} / ${inserted.length}`)
    }
  }
}

async function runUpdate(org: any, warehouse: any, items: Item[], names: Map<string, number>) {
  // last-write-wins map by name for the file values
  const byName = new Map<string, Item>()
  for (const it of items) byName.set(it.name, it)

  const products = await Product.find({ orgId: org._id }).select('_id name purchasePrice').lean()
  console.log(`Products in org: ${products.length}`)

  const prodOps: any[] = []
  const stockOps: any[] = []
  let matched = 0
  for (const p of products) {
    const it = byName.get(p.name as string)
    if (!it) continue
    matched++
    const set: any = {}
    if (columns.has('unit')) set.unit = it.unit
    if (columns.has('purchase')) set.purchasePrice = it.purchase
    if (columns.has('selling')) set.sellingPrice = it.selling
    if (columns.has('tiers')) set.priceTiers = buildTiers(it.purchase, it.tierPrices)
    if (Object.keys(set).length) prodOps.push({ updateOne: { filter: { _id: p._id }, update: { $set: set } } })

    const stockSet: any = {}
    if (columns.has('quantity')) { stockSet.quantity = qtyOf(it); stockSet.availableQuantity = qtyOf(it) }
    if (columns.has('purchase')) stockSet.avgCost = it.purchase
    if (Object.keys(stockSet).length) {
      stockOps.push({
        updateOne: {
          filter: { orgId: org._id, productId: p._id, warehouseId: warehouse._id },
          update: { $set: stockSet, $setOnInsert: { reservedQuantity: 0 } },
          upsert: true,
        },
      })
    }
  }
  console.log(`Matched by name: ${matched} (unmatched file rows: ${items.length - matched})`)

  for (let i = 0; i < prodOps.length; i += BATCH_SIZE) {
    const r = await Product.bulkWrite(prodOps.slice(i, i + BATCH_SIZE))
    console.log(`  products updated ${Math.min(i + BATCH_SIZE, prodOps.length)} / ${prodOps.length} (modified ${r.modifiedCount})`)
  }
  for (let i = 0; i < stockOps.length; i += BATCH_SIZE) {
    const r = await StockLevel.bulkWrite(stockOps.slice(i, i + BATCH_SIZE))
    console.log(`  stock upserted ${Math.min(i + BATCH_SIZE, stockOps.length)} / ${stockOps.length} (modified ${r.modifiedCount}, upserted ${r.upsertedCount})`)
  }
}

await main()
await disconnectDB()
