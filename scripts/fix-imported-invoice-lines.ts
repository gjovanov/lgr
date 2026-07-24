/**
 * Repair the lines of OCR-imported invoices (tags: 'ocr-import') for one org:
 *
 *  1. RE-MATCH product-less lines — the catalog keeps the legacy exports' multi-space
 *     padding ("НОЖ   ТЕХНИЧЕСКИ") while PDF text collapses it, so the importer's
 *     exact nameLower match missed them. Matches whitespace-tolerantly (content-exact,
 *     only space runs may differ) and sets productId + warehouseId on the line.
 *  2. REPRICE lines whose displayed 4-decimal unit price does not reproduce the exact
 *     line total (legacy PDFs round the price for display: 3000 × 0.0213 ≠ 64.00) —
 *     sets unitPrice = lineTotal / qty at 6 decimals. Stored lineTotal/taxAmount and
 *     the invoice totals are untouched (they were always correct).
 *
 * Writes a full JSON backup of every touched invoice next to the repo root before
 * modifying anything. Idempotent: a re-run finds nothing left to fix.
 *
 * Usage:
 *   bun run scripts/fix-imported-invoice-lines.ts --org regal-pz              # dry-run
 *   bun run scripts/fix-imported-invoice-lines.ts --org regal-pz --execute
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, Product, Invoice, Warehouse } from '../packages/db/src/models/index.js'
import { writeFileSync } from 'node:fs'

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
const orgSlug = String(args.org || '')
const execute = !!args.execute
if (!orgSlug) {
  console.error('Usage: bun run scripts/fix-imported-invoice-lines.ts --org <slug> [--execute]')
  process.exit(1)
}

await connectDB()
const org: any = await Org.findOne({ slug: orgSlug }).lean()
if (!org) { console.error(`Org "${orgSlug}" not found`); process.exit(1) }
console.log(`Org ${orgSlug} (${org._id}) — ${execute ? 'EXECUTE' : 'DRY-RUN'}`)

const warehouses: any[] = await Warehouse.find({ orgId: org._id, isActive: true }).lean()
if (warehouses.length !== 1 && !args.warehouse) {
  console.error(`Org has ${warehouses.length} active warehouses — pass --warehouse <code>`)
  process.exit(1)
}
const wh = args.warehouse ? warehouses.find(w => w.code === args.warehouse) : warehouses[0]
if (!wh) { console.error(`Warehouse "${args.warehouse}" not found`); process.exit(1) }
console.log(`Warehouse: ${wh.code} (${wh._id})`)

async function matchByCollapsedName(name: string): Promise<any | null> {
  const lower = name.trim().toLocaleLowerCase('bg')
  if (!lower) return null
  let p: any = await Product.findOne({ orgId: org._id, isActive: true, nameLower: lower }).lean()
  if (!p && /\s/.test(lower)) {
    const pattern = '^' + lower.split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+') + '$'
    p = await Product.findOne({ orgId: org._id, isActive: true, nameLower: { $regex: pattern } }).lean()
  }
  return p
}

const invoices: any[] = await Invoice.find({ orgId: org._id, tags: 'ocr-import' }).lean()
console.log(`${invoices.length} imported invoices\n`)

let matched = 0, repriced = 0, unmatched = 0, touchedInvoices = 0
const backup: any[] = []

for (const inv of invoices) {
  let changed = false
  const lines = []
  for (const l of inv.lines) {
    const line: any = { ...l }
    if (!line.productId && line.description) {
      const p = await matchByCollapsedName(line.description)
      if (p) {
        matched++
        changed = true
        line.productId = p._id
        line.warehouseId = wh._id
        console.log(`  + ${inv.invoiceNumber} "${line.description}" → ${p.sku} (${p.name.replace(/\s+/g, ' ')})`)
      } else {
        unmatched++
        console.log(`  ? ${inv.invoiceNumber} "${line.description}" — still no catalog match`)
      }
    }
    if (line.quantity > 0 && line.lineTotal > 0 && Math.abs(line.quantity * line.unitPrice - line.lineTotal) > 0.005) {
      const newPrice = +(line.lineTotal / line.quantity).toFixed(6)
      repriced++
      changed = true
      console.log(`  ~ ${inv.invoiceNumber} "${(line.description || '').slice(0, 30)}" price ${line.unitPrice} → ${newPrice} (qty ${line.quantity} × price must equal ${line.lineTotal})`)
      line.unitPrice = newPrice
    }
    lines.push(line)
  }
  if (changed) {
    touchedInvoices++
    backup.push(inv)
    if (execute) await Invoice.updateOne({ _id: inv._id }, { $set: { lines } })
  }
}

if (execute && backup.length) {
  const file = `invoice-lines-backup-${orgSlug}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify(backup, null, 2))
  console.log(`\nBackup of ${backup.length} original invoices → ${file}`)
}
console.log(`\nSummary: invoicesTouched=${touchedInvoices} linesMatched=${matched} linesRepriced=${repriced} stillUnmatched=${unmatched}${execute ? '' : ' (dry-run, no writes)'}`)

await disconnectDB()
