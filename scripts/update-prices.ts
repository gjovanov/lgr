/**
 * Update product prices from LgrProducts.xlsx for the Regal org.
 *
 * Matches existing products by exact name, then sets:
 *   purchasePrice = price2 (Col 16)
 *   sellingPrice  = price2 * 1.5
 *   avgCost on corresponding StockLevel records = price2
 *
 * Usage:
 *   bun run scripts/update-prices.ts                # dry-run (default)
 *   bun run scripts/update-prices.ts --execute      # actually update
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, Product, StockLevel } from '../packages/db/src/models/index.js'
import ExcelJS from 'exceljs'
import path from 'path'

const EXCEL_PATH = path.resolve(import.meta.dir, '../../gjovanov/LgrProducts.xlsx')
const ORG_SLUG = 'regal'
const DATA_START_ROW = 6
const SKIP_NAMES = new Set(['ОБЩО:', 'Опаковка', 'Всичко'])

const args = new Set(process.argv.slice(2))
const dryRun = !args.has('--execute')

interface ExcelItem {
  name: string
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

    const price2 = Number(row.getCell(16).value) || 0
    if (price2 > 0) items.push({ name, price2 })
  })

  return items
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN (pass --execute to update)' : 'EXECUTE'}`)
  console.log()

  // Read Excel
  console.log(`Reading ${EXCEL_PATH} ...`)
  const items = await readExcel(EXCEL_PATH)
  console.log(`Found ${items.length} products with prices in Excel`)
  console.log(`Sample:`)
  for (const item of items.slice(0, 3)) {
    console.log(`  "${item.name}" purchasePrice=${item.price2} sellingPrice=${+(item.price2 * 1.5).toFixed(4)}`)
  }
  console.log()

  if (dryRun) {
    console.log('Dry run complete. Use --execute to actually update.')
    return
  }

  // Connect to DB
  await connectDB()
  console.log('Connected to MongoDB')

  // Find org
  const org = await Org.findOne({ slug: ORG_SLUG })
  if (!org) {
    console.error(`Org "${ORG_SLUG}" not found.`)
    process.exit(1)
  }
  console.log(`Org: ${org.name} (${org._id})`)

  // Build name→price map
  const priceMap = new Map<string, number>()
  for (const item of items) {
    priceMap.set(item.name, item.price2)
  }

  // Fetch all products for this org
  const products = await Product.find({ orgId: org._id }).exec()
  console.log(`Found ${products.length} products in DB`)

  // Build product bulk updates
  const productOps: any[] = []
  const matchedProductIds: Array<{ productId: any; price2: number }> = []
  let matched = 0
  let skipped = 0

  for (const product of products) {
    const price2 = priceMap.get(product.name)
    if (price2 === undefined) {
      skipped++
      continue
    }
    matched++
    const sellingPrice = +(price2 * 1.5).toFixed(4)
    productOps.push({
      updateOne: {
        filter: { _id: product._id },
        update: { $set: { purchasePrice: price2, sellingPrice } },
      },
    })
    matchedProductIds.push({ productId: product._id, price2 })
  }

  console.log(`Matched: ${matched}, Skipped (no price in Excel): ${skipped}`)

  // Execute product updates
  if (productOps.length) {
    const result = await Product.bulkWrite(productOps)
    console.log(`Products updated: ${result.modifiedCount}`)
  }

  // Build stock level bulk updates
  const stockOps: any[] = []
  for (const { productId, price2 } of matchedProductIds) {
    stockOps.push({
      updateMany: {
        filter: { orgId: org._id, productId },
        update: { $set: { avgCost: price2 } },
      },
    })
  }

  if (stockOps.length) {
    const result = await StockLevel.bulkWrite(stockOps)
    console.log(`Stock levels updated: ${result.modifiedCount}`)
  }

  console.log()
  console.log(`Done! Updated prices for ${matched} products.`)
}

await main()
await disconnectDB()
