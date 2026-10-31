/**
 * FR-24.15: the one SPA's bundle budget, checked on its built `dist/` (CI runs it after the build).
 *
 *  1. First-load JS (the entry and what `index.html` preloads), gzipped, at most 360 KB.
 *  2. No module's views in the first load: a view is a lazy route, so a `*View-*.js` file there means
 *     an eager import pulled a module in.
 *  3. The fiscal bridge's code in exactly one chunk, so one bridge serves every module. Vite can
 *     duplicate a workspace module across chunks (`ui-shared/plugins` warns of it).
 *
 * Usage: bun scripts/check-web-bundle.ts [distDir] [--report]
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { gzipSync } from 'zlib'

export const FIRST_LOAD_BUDGET_KB = 360
const BRIDGE_MARKER = 'fiscal:bridge:register'

export interface BundleReport {
  firstLoad: { file: string; gzipKb: number }[]
  firstLoadGzipKb: number
  viewsInFirstLoad: string[]
  bridgeChunks: string[]
  problems: string[]
}

export function checkWebBundle(dist: string): BundleReport {
  const html = readFileSync(join(dist, 'index.html'), 'utf8')
  const refs = [
    ...html.matchAll(/<script[^>]+type="module"[^>]+src="\/([^"]+\.js)"/g),
    ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/([^"]+\.js)"/g),
  ].map(m => m[1])
  const firstLoad = [...new Set(refs)].map(file => ({
    file,
    gzipKb: Math.round((gzipSync(readFileSync(join(dist, file))).length / 1024) * 10) / 10,
  }))
  const firstLoadGzipKb = Math.round(firstLoad.reduce((s, f) => s + f.gzipKb, 0) * 10) / 10
  const viewsInFirstLoad = firstLoad.map(f => f.file).filter(f => /View-[\w-]+\.js$/.test(f))
  const assets = join(dist, 'ui')
  const bridgeChunks = readdirSync(assets)
    .filter(f => f.endsWith('.js') && readFileSync(join(assets, f), 'utf8').includes(BRIDGE_MARKER))

  const problems: string[] = []
  if (!firstLoad.length) problems.push('index.html loads no module script')
  if (firstLoadGzipKb > FIRST_LOAD_BUDGET_KB) problems.push(`first-load JS is ${firstLoadGzipKb} KB gzipped, over the ${FIRST_LOAD_BUDGET_KB} KB budget`)
  if (viewsInFirstLoad.length) problems.push(`module views in the first load: ${viewsInFirstLoad.join(', ')}`)
  if (bridgeChunks.length !== 1) problems.push(`the fiscal bridge is in ${bridgeChunks.length} chunks (${bridgeChunks.join(', ') || 'none'}), not exactly one`)
  return { firstLoad, firstLoadGzipKb, viewsInFirstLoad, bridgeChunks, problems }
}

if (import.meta.main) {
  const dist = process.argv.slice(2).find(a => !a.startsWith('--')) ?? join(import.meta.dir, '..', 'packages', 'web', 'dist')
  const report = checkWebBundle(dist)
  console.log(`first-load JS: ${report.firstLoadGzipKb} KB gzipped (budget ${FIRST_LOAD_BUDGET_KB} KB)`)
  if (process.argv.includes('--report')) for (const f of report.firstLoad) console.log(`  ${f.file}  ${f.gzipKb} KB`)
  console.log(`fiscal bridge chunks: ${report.bridgeChunks.join(', ') || 'none'}`)
  if (report.problems.length) {
    for (const p of report.problems) console.error(`✗ ${p}`)
    process.exit(1)
  }
  console.log('✓ the one SPA is within its budget')
}
