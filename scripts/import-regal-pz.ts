/**
 * Bootstrap org `regal-pz` (Regal Pazardzhik) and import products + stock from
 * storeAvailability_20260720_113402.xlsx (repo root).
 *
 * Excel layout (rows 1-4 title block, row 5 = headers, data starts at row 6,
 * last row "Всичко" = grand total, skipped):
 *   Col 1:  Име            (name)
 *   Col 2:  Мярка          (unit, e.g. "БР", "КГ", "М")
 *   Col 3:  Количество     (stock quantity — negatives preserved)
 *   Col 4:  Доставна цена  (purchase price, StockLevel.avgCost, tier slot 1)
 *   Col 5:  Продажна цена  (selling price)
 *   Col 6:  Цена на едро   (wholesale price, tier slot 2)
 *   Col 7-11:  Цена1..Цена5 (tier slots 3-7)
 *   Col 12-14: Цена7..Цена9 (tier slots 8-10; the legacy system has no Цена6)
 *
 * Creates (idempotent, find-or-create): org regal-pz (BGN/bg/Europe/Sofia,
 * professional plan), admin user rdodova with operator code + permission sets,
 * warehouse Pazardzhik (pz), category "Общи", then inserts products (10 price
 * tiers each) and stock levels.
 *
 * Usage:
 *   bun run scripts/import-regal-pz.ts                     # dry-run (default)
 *   bun run scripts/import-regal-pz.ts --execute           # actually import
 *   bun run scripts/import-regal-pz.ts --execute --clean   # delete regal-pz products + stock first
 *
 * Production: MONGODB_URI='mongodb://user:pass@localhost:27017/lgr?authSource=admin&directConnection=true' \
 *   bun run scripts/import-regal-pz.ts --execute
 *
 * Creating the admin (first run only) also needs REGAL_PZ_ADMIN_PASSWORD, its initial password.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import {
  Org, User, OrgApp, PermissionSet, ProductCategory,
  Warehouse, Product, StockLevel, Identity,
} from '../packages/db/src/models/index.js'
import { DEFAULT_ROLE_PERMISSIONS, MODULES, APP_IDS } from '../packages/config/src/constants.js'
import { seedDefaultPermissionSets } from '../packages/services/src/biz/permission-set.seed.js'
import { allocateOperatorCode } from '../packages/services/src/biz/sequence.service.js'
import { discardIdentity, identityForOperatorJoin } from '../packages/services/src/biz/identity/identity.service.js'
import { createMongoRepositories } from '../packages/dal-mongo/src/index.js'
import ExcelJS from 'exceljs'
import path from 'path'

const EXCEL_PATH = path.resolve(import.meta.dir, '../storeAvailability_20260720_113402.xlsx')
const ORG_SLUG = 'regal-pz'
const ORG_NAME = 'Regal Pazardzhik'
const HEADER_ROW = 5
const DATA_START_ROW = 6
const SKIP_NAMES = new Set(['Всичко', 'ОБЩО:', 'Опаковка'])
const BATCH_SIZE = 500
const SKU_PREFIX = 'RPZ'

const EXPECTED_HEADERS = [
  'Име', 'Мярка', 'Количество', 'Доставна цена', 'Продажна цена', 'Цена на едро',
  'Цена1', 'Цена2', 'Цена3', 'Цена4', 'Цена5', 'Цена7', 'Цена8', 'Цена9',
]
const TIER_NAMES = [
  'Доставна цена', 'Цена на едро',
  'Цена 1', 'Цена 2', 'Цена 3', 'Цена 4', 'Цена 5', 'Цена 7', 'Цена 8', 'Цена 9',
]

const args = new Set(process.argv.slice(2))
const dryRun = !args.has('--execute')
const clean = args.has('--clean')

interface ExcelItem {
  row: number
  name: string
  unit: string
  quantity: number
  purchase: number
  selling: number
  tierPrices: number[] // 10 values: [Доставна, На едро, Цена1..Цена5, Цена7..Цена9]
}

const round4 = (v: number) => +v.toFixed(4)

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

async function readExcel(filePath: string): Promise<ExcelItem[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheet = workbook.getWorksheet(1)!

  const headers = EXPECTED_HEADERS.map((_, i) => String(sheet.getRow(HEADER_ROW).getCell(i + 1).text ?? '').trim())
  const mismatch = EXPECTED_HEADERS.findIndex((h, i) => headers[i] !== h)
  if (mismatch !== -1) {
    console.error(`Header mismatch at column ${mismatch + 1}: expected "${EXPECTED_HEADERS[mismatch]}", got "${headers[mismatch]}"`)
    console.error(`Full header row: ${JSON.stringify(headers)}`)
    process.exit(1)
  }

  const items: ExcelItem[] = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < DATA_START_ROW) return
    const name = String(row.getCell(1).text ?? '').trim()
    if (!name || SKIP_NAMES.has(name)) return

    const purchase = round4(cellNum(row.getCell(4).value))
    const wholesale = round4(cellNum(row.getCell(6).value))
    const legacyPrices = [7, 8, 9, 10, 11, 12, 13, 14].map(c => round4(cellNum(row.getCell(c).value)))

    items.push({
      row: rowNumber,
      name,
      unit: normalizeUnit(String(row.getCell(2).text ?? '')),
      quantity: cellNum(row.getCell(3).value),
      purchase,
      selling: round4(cellNum(row.getCell(5).value)),
      tierPrices: [purchase, wholesale, ...legacyPrices],
    })
  })

  return items
}

/**
 * Filterless storage slots (resolvePrice skips them). Mirrors the product form's
 * manual-edit behavior: explicit prices are pinned via manualOverride so future
 * purchase-price cascades don't overwrite the imported values.
 */
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

function printStats(items: ExcelItem[]) {
  const units = new Map<string, number>()
  const names = new Map<string, number>()
  let negQty = 0, zeroPurchase = 0, zeroSelling = 0
  for (const item of items) {
    units.set(item.unit, (units.get(item.unit) || 0) + 1)
    names.set(item.name, (names.get(item.name) || 0) + 1)
    if (item.quantity < 0) negQty++
    if (item.purchase === 0) zeroPurchase++
    if (item.selling === 0) zeroSelling++
  }
  const dups = [...names.entries()].filter(([, c]) => c > 1)

  console.log(`Rows: ${items.length}`)
  console.log(`Negative quantities (preserved): ${negQty}`)
  console.log(`Zero purchase price: ${zeroPurchase}, zero selling price: ${zeroSelling}`)
  console.log(`Duplicate names (imported as separate products): ${dups.length}`)
  for (const [name, count] of dups.slice(0, 10)) console.log(`  ${count}x "${name}"`)
  console.log(`Units: ${[...units.entries()].sort((a, b) => b[1] - a[1]).map(([u, c]) => `${u}=${c}`).join(', ')}`)
  console.log()
  console.log('Samples:')
  for (const item of items.slice(0, 3)) {
    console.log(`  "${item.name}" unit=${item.unit} qty=${item.quantity} purchase=${item.purchase} selling=${item.selling}`)
    console.log(`    tiers: ${buildTiers(item.purchase, item.tierPrices).map(t => `${t.name}=${t.finalPrice}${t.manualOverride ? '' : ' (empty)'}`).join(' | ')}`)
  }
  console.log()
}

async function bootstrapOrg() {
  let org = await Org.findOne({ slug: ORG_SLUG })
  if (org) {
    console.log(`Org exists: ${org.name} (${org._id})`)
    await assertScriptHome(org._id, ORG_SLUG)
  } else {
    org = await Org.create({
      name: ORG_NAME,
      slug: ORG_SLUG,
      taxNumber: '112500982',
      settings: {
        baseCurrency: 'BGN',
        fiscalYearStart: 1,
        dateFormat: 'DD.MM.YYYY',
        timezone: 'Europe/Sofia',
        locale: 'bg',
        taxConfig: {
          vatEnabled: true,
          defaultVatRate: 20,
          vatRates: [{ name: 'Standard', rate: 20 }, { name: 'Reduced', rate: 9 }, { name: 'Zero', rate: 0 }],
          taxIdLabel: 'ЕИК',
        },
        payroll: { payFrequency: 'monthly', socialSecurityRate: 24.7, healthInsuranceRate: 8, pensionRate: 5 },
        modules: [...MODULES],
      },
      subscription: { plan: 'professional', maxUsers: 50 },
    })
    console.log(`Org created: ${org.name} (${org._id})`)
  }

  let user = await User.findOne({ orgId: org._id, username: 'rdodova' })
  if (user) {
    console.log(`User exists: ${user.username} (${user._id})`)
  } else {
    const email = 'rdodova@gmail.com'
    // ⚠ Never a literal. This used to hash a hardcoded password, which put a real person's
    // credential in git history (2026-10-05). It is asked for only when the run creates a NEW
    // person: someone who already has an account joins as they are, with their own password.
    const initialPassword = process.env.REGAL_PZ_ADMIN_PASSWORD
    if (!initialPassword && !(await Identity.exists({ email }).exec())) {
      throw new Error('REGAL_PZ_ADMIN_PASSWORD is not set; it is the initial password of the rdodova admin this run creates')
    }
    const hashedPassword = initialPassword ? await Bun.password.hash(initialPassword) : undefined
    const person = await identityForOperatorJoin({
      email,
      password: hashedPassword, // an operator-set password: the helper records who and where
      firstName: 'Rozalina', lastName: 'Dodova', isActive: true,
    }, org._id)
    // Operator code (SUPTO compliance) — same allocator as auth.service register
    const operatorCode = await allocateOperatorCode(String(org._id))

    try {
      user = await User.create({
        email: person ? person.identity.email : email,
        username: 'rdodova',
        // The legacy copy matches the person's own hash, so a rollback signs them in as before.
        password: person && !person.created ? person.identity.password : hashedPassword,
        identityId: person?.identity._id,
        firstName: 'Rozalina',
        lastName: 'Dodova',
        role: 'admin',
        operatorCode,
        orgId: org._id,
        isActive: true,
        permissions: DEFAULT_ROLE_PERMISSIONS.admin,
        roleHistory: [{ role: 'admin', startDate: new Date(), assignedAt: new Date() }],
      })
    } catch (err) {
      if (person?.created) await discardIdentity(person.identity._id)
      throw err
    }
    console.log(`User created: rdodova (operator ${operatorCode}${person && !person.created ? ', linked to her existing account' : ''})`)
  }

  if (!org.ownerId) {
    org.ownerId = user._id
    await org.save()
  }

  const repos = await createMongoRepositories({ backend: 'mongo' })
  await seedDefaultPermissionSets(String(org._id), repos)
  const adminSet = await PermissionSet.findOne({ orgId: org._id, name: 'Administrator' })
  if (adminSet && (!user.permissionSetIds || user.permissionSetIds.length === 0)) {
    user.permissionSetIds = [adminSet._id]
    await user.save()
  }

  for (const appId of APP_IDS) {
    const existing = await OrgApp.findOne({ orgId: org._id, appId })
    if (!existing) {
      await OrgApp.create({ orgId: org._id, appId, enabled: true, activatedAt: new Date(), activatedBy: user._id })
    }
  }
  console.log(`Apps enabled: ${APP_IDS.join(', ')}`)

  let warehouse = await Warehouse.findOne({ orgId: org._id, code: 'pz' })
  if (warehouse) {
    console.log(`Warehouse exists: ${warehouse.name} (${warehouse._id})`)
  } else {
    warehouse = await Warehouse.create({
      orgId: org._id,
      name: 'Pazardzhik',
      code: 'pz',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
      address: { street: '', city: 'Pazardzhik', postalCode: '4400', country: 'BG' },
    })
    console.log(`Warehouse created: Pazardzhik (pz)`)
  }

  let category = await ProductCategory.findOne({ orgId: org._id, name: 'Общи' })
  if (category) {
    console.log(`Category exists: ${category.name} (${category._id})`)
  } else {
    category = await ProductCategory.create({ orgId: org._id, name: 'Общи', isActive: true })
    console.log(`Category created: Общи`)
  }

  return { org, user, warehouse, category }
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN (pass --execute to import)' : 'EXECUTE'}`)
  console.log(`Clean existing products: ${clean}`)
  console.log()

  console.log(`Reading ${EXCEL_PATH} ...`)
  const items = await readExcel(EXCEL_PATH)
  printStats(items)

  if (dryRun) {
    console.log('Dry run complete. Use --execute to actually import.')
    return
  }

  await connectDB()
  console.log('Connected to MongoDB')

  const { org, warehouse, category } = await bootstrapOrg()

  const existingCount = await Product.countDocuments({ orgId: org._id })
  if (existingCount > 0 && !clean) {
    console.error(`Org already has ${existingCount} products. Re-run with --clean to wipe and reload (index-based SKUs make partial upserts unsafe).`)
    process.exit(1)
  }
  if (clean && existingCount > 0) {
    const delProducts = await Product.deleteMany({ orgId: org._id })
    const delStock = await StockLevel.deleteMany({ orgId: org._id })
    console.log(`Cleaned: ${delProducts.deletedCount} products, ${delStock.deletedCount} stock levels`)
  }

  const productDocs = items.map((item, i) => ({
    orgId: org._id,
    sku: `${SKU_PREFIX}-${String(i + 1).padStart(5, '0')}`,
    name: item.name,
    category: 'Общи',
    categoryId: category._id,
    type: 'goods' as const,
    unit: item.unit,
    purchasePrice: item.purchase,
    sellingPrice: item.selling,
    currency: 'BGN',
    taxRate: 20,
    trackInventory: true,
    priceTiers: buildTiers(item.purchase, item.tierPrices),
    customPrices: [],
    isActive: true,
  }))

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

  console.log(`Inserting ${allProducts.length} stock levels ...`)
  for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
    const batch = allProducts.slice(i, i + BATCH_SIZE).map(p => ({
      orgId: org._id,
      productId: p._id,
      warehouseId: warehouse._id,
      quantity: items[p.idx].quantity,
      reservedQuantity: 0,
      availableQuantity: items[p.idx].quantity,
      avgCost: items[p.idx].purchase,
    }))
    await StockLevel.insertMany(batch)
    console.log(`  Inserted ${Math.min(i + BATCH_SIZE, allProducts.length)} / ${allProducts.length}`)
  }

  console.log()
  console.log(`Done! Org "${org.name}" (${ORG_SLUG}): ${allProducts.length} products + stock levels in warehouse Pazardzhik.`)
  console.log(`Login: ${ORG_SLUG} / rdodova / <REGAL_PZ_ADMIN_PASSWORD, or the password it has been changed to>`)
}

await main()
await disconnectDB()
