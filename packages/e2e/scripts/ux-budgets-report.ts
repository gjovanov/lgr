/**
 * FR-22: print the click-budget table from the walks' results.
 *
 *   bun run ux:report [test-results-dir]
 *
 * Each walk in `tests/ux-budgets/` writes `<outputDir>/ux-budgets/<id>/result.json`; this reads
 * them all and prints a Markdown table plus every walk's notes, in the order the ids sort.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface UxResult {
  id: string
  title: string
  clicks: number
  typed: number
  keys: number
  hops: number
  dialogs: number
  seconds: number
  notes: string[]
}

const outputDir = process.argv[2] || 'test-results'
const dir = join(outputDir, 'ux-budgets')
if (!existsSync(dir)) {
  console.error(`No walk results under ${dir}. Run the ux-budgets project first.`)
  process.exit(1)
}

const results: UxResult[] = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'result.json')))
  .map((d) => JSON.parse(readFileSync(join(dir, d.name, 'result.json'), 'utf8')))
  .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))

console.log('| Walk | Task | Clicks | Typed | Keys | Page loads | Dialogs |')
console.log('|---|---|--:|--:|--:|--:|--:|')
for (const r of results) {
  console.log(`| ${r.id} | ${r.title} | ${r.clicks} | ${r.typed} | ${r.keys} | ${r.hops} | ${r.dialogs} |`)
}
for (const r of results.filter((x) => x.notes.length)) {
  console.log(`\n**${r.id}**`)
  for (const n of r.notes) console.log(`- ${n}`)
}
