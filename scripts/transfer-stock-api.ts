/**
 * Store-to-store transfer-OUT import, direct from PlusMinus's own `/mobile` API — the sibling of
 * `transfer-stock.ts` (which takes one hand-written transfers file). Reads a folder of
 * `sklrazp_<N>.json` pulls, maps each via `services/biz/doc-import/map-plusminus-sklrazp.ts`
 * #mapSklrazpDoc into the exact `{transfers:[...]}` shape that script already consumes, writes
 * ONE generated file, and spawns it — product matching, Σvalue cross-check, dedup-by-marker and
 * movement booking are all its own proven logic, not re-implemented here.
 *
 * Usage:
 *   bun run scripts/transfer-stock-api.ts --dir <dir with sklrazp_*.json>            # dry-run
 *   bun run scripts/transfer-stock-api.ts --dir <dir> --execute
 *
 * Options:
 *   --dir <dir>        (required) folder with sklrazp_<number>.json (WSL UNC ok)
 *   --org <slug>       org slug (default: regal-pz)
 *   --api <url>        API base (default: https://lgrai.app)
 *   --warehouse <c>    source warehouse code (default: org default)
 *   --only <nums>      comma-separated document numbers to limit the run to
 *   --skip-unmatched   forwarded to transfer-stock.ts
 *   --execute          actually book (default: dry-run, no writes)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD — inherited by the subprocess.
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mapSklrazpDoc } from '../packages/services/src/biz/doc-import/map-plusminus-sklrazp.js'
import type { PlusMinusDocument } from '../packages/services/src/biz/doc-import/map-plusminus-invoice.js'

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
const dir = args.dir as string
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const warehouseCode = args.warehouse as string | undefined
const only = args.only ? new Set(String(args.only).split(',').map(s => String(Number(s.trim())))) : null
const skipUnmatched = !!args['skip-unmatched']
const execute = !!args.execute

if (!dir) { console.error('Required: --dir <dir with sklrazp_*.json>. See header for options.'); process.exit(2) }

async function main() {
  const files = readdirSync(dir).filter(f => /^sklrazp_\d+\.json$/i.test(f)).sort()
  if (!files.length) { console.error('No sklrazp_*.json in dir.'); process.exit(1) }

  console.log(`Transfer stock OUT (direct API) | dir: ${dir} | ${files.length} document(s)${only ? ` | --only ${[...only].join(',')}` : ''}`)

  const transfers: any[] = []
  for (const f of files) {
    const doc: PlusMinusDocument = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    try {
      const m = mapSklrazpDoc(doc)
      if (only && !only.has(String(Number(m.number)))) continue
      transfers.push({ number: m.number, date: m.date, destination: m.destination, total: m.total, lines: m.lines })
    } catch (e: any) {
      console.log(`✗ ${f}: ${e?.message || e} — skipped`)
    }
  }
  if (!transfers.length) { console.error('Nothing mapped.'); process.exit(1) }

  const tmpFile = join(tmpdir(), `sklrazp-batch-${process.pid}.json`)
  writeFileSync(tmpFile, JSON.stringify({ transfers }))
  try {
    const cliArgs = ['run', 'scripts/transfer-stock.ts', '--items', tmpFile, '--org', orgSlug, '--api', api]
    if (warehouseCode) cliArgs.push('--warehouse', warehouseCode)
    if (skipUnmatched) cliArgs.push('--skip-unmatched')
    if (execute) cliArgs.push('--execute')
    const proc = Bun.spawn(['bun', ...cliArgs], { cwd: join(import.meta.dir, '..'), env: process.env, stdout: 'inherit', stderr: 'inherit' })
    const code = await proc.exited
    if (code !== 0) process.exit(code)
  } finally {
    try { unlinkSync(tmpFile) } catch { /* best effort */ }
  }
}

await main()
