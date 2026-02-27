/**
 * Import products from LgrProducts.xlsx into the Regal org.
 *
 * Excel layout (row 5 = headers, data starts at row 6):
 *   Col 1: Име           (name)
 *   Col 2: Мярка         (unit, e.g. "БР", "КГ", "М")
 *   Col 3: Количество    (stock quantity)
 *   Col 15: Цена1        (custom price 1)
 *   Col 16: Цена2        (custom price 2 = purchase price)
 *   selling price = Цена2 * 1.5
 *
 * Usage:
 *   bun run scripts/import-products.ts                     # dry-run (default)
 *   bun run scripts/import-products.ts --execute           # actually import
 *   bun run scripts/import-products.ts --execute --clean   # delete existing Regal products first
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, Product, Warehouse, StockLevel } from '../packages/db/src/models/index.js'
import ExcelJS from 'exceljs'
import path from 'path'

const EXCEL_PATH = path.resolve(import.meta.dir, '../../gjovanov/LgrProducts.xlsx')
const ORG_SLUG = 'regal'
const DATA_START_ROW = 6
const SKIP_NAMES = new Set(['ОБЩО:', 'Опаковка', 'Всичко'])
const BATCH_SIZE = 500

const args = new Set(process.argv.slice(2))
const dryRun = !args.has('--execute')
const clean = args.has('--clean')

interface ExcelItem {
  name: string
  unit: string
  quantity: number
  price1: number
  price2: number
}

async function readExcel(filePath: string): Promise<ExcelItem[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheet = workbook.getWorksheet(1)!
  const items: ExcelItem[] = []

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < DATA_START_ROW) return
    const name = String(row.getCell(1).value || '').trim()
    if (!name || SKIP_NAMES.has(name)) return

    items.push({
      name,
      unit: String(row.getCell(2).value || 'БР').trim(),
      quantity: Number(row.getCell(3).value) || 0,
      price1: Number(row.getCell(15).value) || 0,
      price2: Number(row.getCell(16).value) || 0,
    })
  })

  return items
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN (pass --execute to import)' : 'EXECUTE'}`)
  console.log(`Clean existing: ${clean}`)
  console.log()

  // Read Excel
  console.log(`Reading ${EXCEL_PATH} ...`)
  const items = await readExcel(EXCEL_PATH)
  console.log(`Found ${items.length} products in Excel`)
  console.log(`Sample:`)
  for (const item of items.slice(0, 3)) {
    const sp = +(item.price2 * 1.5).toFixed(4)
    console.log(`  "${item.name}" unit=${item.unit} qty=${item.quantity} purchasePrice=${item.price2} sellingPrice=${sp}`)
  }
  console.log()

  if (dryRun) {
    console.log('Dry run complete. Use --execute to actually import.')
    return
  }

  // Connect to DB
  await connectDB()
  console.log('Connected to MongoDB')

  // Find org
  const org = await Org.findOne({ slug: ORG_SLUG })
  if (!org) {
    console.error(`Org "${ORG_SLUG}" not found. Run seed first.`)
    process.exit(1)
  }
  console.log(`Org: ${org.name} (${org._id})`)

  // Find default warehouse
  const warehouse = await Warehouse.findOne({ orgId: org._id, isDefault: true })
  if (!warehouse) {
    console.error('No default warehouse found for Regal.')
    process.exit(1)
  }
  console.log(`Warehouse: ${warehouse.name} (${warehouse._id})`)

  // Clean if requested
  if (clean) {
    const delProducts = await Product.deleteMany({ orgId: org._id })
    const delStock = await StockLevel.deleteMany({ orgId: org._id })
    console.log(`Cleaned: ${delProducts.deletedCount} products, ${delStock.deletedCount} stock levels`)
  }

  // Build product documents
  const productDocs = items.map((item, i) => ({
    orgId: org._id,
    sku: `RGL-${String(i + 1).padStart(5, '0')}`,
    name: item.name,
    category: 'General',
    type: 'goods' as const,
    unit: item.unit,
    purchasePrice: item.price2,
    sellingPrice: +(item.price2 * 1.5).toFixed(4),
    currency: 'BGN',
    taxRate: 20,
    trackInventory: true,
    customPrices: [],
    isActive: true,
  }))

  // Insert products in batches
  console.log(`Inserting ${productDocs.length} products in batches of ${BATCH_SIZE} ...`)
  const allProducts: Array<{ _id: any; idx: number }> = []
  for (let i = 0; i < productDocs.length; i += BATCH_SIZE) {
    const batch = productDocs.slice(i, i + BATCH_SIZE)
    const inserted = await Product.insertMany(batch)
    for (let j = 0; j < inserted.length; j++) {
      allProducts.push({ _id: inserted[j]._id, idx: i + j })
    }
    console.log(`  Inserted ${Math.min(i + BATCH_SIZE, productDocs.length)} / ${productDocs.length}`)
  }

  // Insert stock levels in batches
  console.log(`Inserting ${allProducts.length} stock levels ...`)
  for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
    const batch = allProducts.slice(i, i + BATCH_SIZE).map(p => ({
      orgId: org._id,
      productId: p._id,
      warehouseId: warehouse._id,
      quantity: Math.max(items[p.idx].quantity, 0),
      reservedQuantity: 0,
      availableQuantity: Math.max(items[p.idx].quantity, 0),
      avgCost: items[p.idx].price2,
    }))
    await StockLevel.insertMany(batch)
    console.log(`  Inserted ${Math.min(i + BATCH_SIZE, allProducts.length)} / ${allProducts.length}`)
  }

  console.log()
  console.log(`Done! Imported ${allProducts.length} products for org "${org.name}".`)
}

await main()
await disconnectDB()
