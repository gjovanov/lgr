/**
 * FR-25a §4.2: what the books import would make of a company's fixed assets, read from the files on the PC that holds
 * them, before anything is deployed or written. Runs the import's own mapping (`fixed-asset-params.ts`) and its own rule
 * for what an asset is not made without, and touches no database and no API.
 *
 * ⚠ COUNTS ONLY: no asset's name, no value and no amount is printed. Property names and account codes are, as the
 * audit printed them: they are the program's and the chart's, no one's data.
 *
 * Usage:
 *   bun run scripts/check-fixed-asset-params.ts --books <dir> --year <YYYY>        # a pull-plusminus-books folder
 *   bun run scripts/check-fixed-asset-params.ts --analytics <ap_ДА_….json> --chart <chart-YYYY.json>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAnalyticsFile } from '../packages/services/src/biz/accounting-books/plusminus-exports.js'
import { chartJunkReason } from '../packages/services/src/biz/accounting-books/registry.js'
import { FIXED_ASSET_PARAMS, FIXED_ASSET_ROOT, canMakeAsset, mapFixedAssetParams } from '../packages/services/src/biz/accounting-books/fixed-asset-params.js'
import { assetProblemsText } from './lib/books-import-print.js'

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

const argv = process.argv.slice(2)
const arg = (name: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const books = arg('--books')
const year = arg('--year')
const analyticsFile = books
  ? join(books, readdirSync(books).find(f => f.startsWith(`ap_${FIXED_ASSET_ROOT}_`) && f.endsWith('.json')) ?? fail(`${books} has no ap_${FIXED_ASSET_ROOT}_….json`))
  : arg('--analytics') ?? fail('Give --books <dir> --year <YYYY>, or --analytics <file> --chart <file>.')
const chartFile = books ? join(books, `chart-${year ?? fail('--books needs --year <YYYY>.')}.json`) : arg('--chart') ?? fail('--analytics needs --chart <file>.')

// The chart as the import keeps it: the codes it does not drop.
const rows: { code: string; name: string }[] = JSON.parse(readFileSync(chartFile, 'utf8')).rows ?? []
const chart = new Map(rows.filter(r => !chartJunkReason(String(r.code).trim(), String(r.name ?? ''))).map(r => [String(r.code).trim(), true]))
const items = parseAnalyticsFile(readFileSync(analyticsFile)).filter(i => i.path.startsWith(`${FIXED_ASSET_ROOT}:`))

const tally = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)
const text = (map: Map<string, number>) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'
const read = new Set(Object.values(FIXED_ASSET_PARAMS).map(k => k.toLocaleUpperCase('bg').replace(/\s+/g, '')))

let withParams = 0
let made = 0
const status = new Map<string, number>()
const currency = new Map<string, number>()
const others = new Map<string, number>()
const problems: { key?: string; reason: string; code?: string }[] = []
for (const item of items) {
  if (item.params?.length) withParams++
  const { fields, problems: found } = mapFixedAssetParams(item.params ?? [], chart)
  problems.push(...found.map(({ key, reason, code }) => ({ key, reason, ...(code ? { code } : {}) })))
  if (!canMakeAsset(fields)) continue
  made++
  tally(status, fields.status ?? 'active (unknown)')
  tally(currency, fields.currency ?? '?')
  for (const p of item.params ?? []) if (!read.has(p.key.toLocaleUpperCase('bg').replace(/\s+/g, ''))) tally(others, p.key)
}

console.log(`${FIXED_ASSET_ROOT} analytics: ${items.length}, ${withParams} with properties; chart: ${chart.size} accounts`)
console.log(`an asset would be made of ${made}; of ${items.length - made} none`)
console.log(`status of those made: ${text(status)}`)
console.log(`currency of those made: ${text(currency)}`)
console.log(`problems (property reason ×analytics): ${problems.length ? assetProblemsText(problems) : 'none'}`)
console.log(`properties kept in params only, on those made (name ×assets): ${text(others)}`)
