/**
 * FR-24.15: the one SPA's bundle budget, checked on its built `dist/` (CI runs it after the build).
 *
 *  1. First-load JS (the entry and what `index.html` preloads), gzipped, at most 360 KB.
 *  2. No module's views in the first load: a view is a lazy route, so a `*View-*.js` file there means
 *     an eager import pulled a module in.
 *  3. The fiscal bridge's code in exactly one chunk, so one bridge serves every module. Vite can
 *     duplicate a workspace module across chunks (`ui-shared/plugins` warns of it).
 *  4. FR-30.25: the first load's styles (gzipped) and fonts (as they are: woff2 is compressed already), each and with
 *     the JavaScript in total. The stylesheet (87 KB gzipped) and the icon font (395 KB) were outside the budget.
 *
 * Usage: bun scripts/check-web-bundle.ts [distDir] [--report]
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { gzipSync } from 'zlib'

export const FIRST_LOAD_BUDGET_KB = 360
/** FR-30.25: the first load's styles, gzipped. */
export const STYLES_BUDGET_KB = 60
/** FR-30.21/.25: the fonts the first load's styles ask for (the icon subset). */
export const FONTS_BUDGET_KB = 40
/** FR-30.25: JavaScript, styles and fonts together; the sign-in page's whole first visit is to stay within 500 KB. */
export const TOTAL_BUDGET_KB = 450
const BRIDGE_MARKER = 'fiscal:bridge:register'

export interface BundleReport {
  firstLoad: { file: string; gzipKb: number }[]
  firstLoadGzipKb: number
  styles: { file: string; gzipKb: number }[]
  stylesGzipKb: number
  fonts: { file: string; kb: number }[]
  fontsKb: number
  totalKb: number
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
  const kb = (n: number) => Math.round((n / 1024) * 10) / 10
  const styles = [...new Set([...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/([^"]+\.css)"/g)].map(m => m[1]))]
    .map(file => ({ file, gzipKb: kb(gzipSync(readFileSync(join(dist, file))).length) }))
  const stylesGzipKb = Math.round(styles.reduce((s, f) => s + f.gzipKb, 0) * 10) / 10
  // The fonts those styles name, by their built paths (`url(/ui/x.woff2)`); a browser fetches one of a rule's list.
  const fontFiles = new Set<string>()
  for (const s of styles) {
    for (const m of readFileSync(join(dist, s.file), 'utf8').matchAll(/url\(\s*["']?\/?([^"')?#]+\.(?:woff2|woff|ttf|eot|otf))/g)) fontFiles.add(m[1].replace(/^\//, ''))
  }
  const fonts = [...fontFiles].map(file => ({ file, kb: kb(readFileSync(join(dist, file)).length) }))
  const fontsKb = Math.round(fonts.reduce((s, f) => s + f.kb, 0) * 10) / 10
  const totalKb = Math.round((firstLoadGzipKb + stylesGzipKb + fontsKb) * 10) / 10
  const viewsInFirstLoad = firstLoad.map(f => f.file).filter(f => /View-[\w-]+\.js$/.test(f))
  const assets = join(dist, 'ui')
  const bridgeChunks = readdirSync(assets)
    .filter(f => f.endsWith('.js') && readFileSync(join(assets, f), 'utf8').includes(BRIDGE_MARKER))

  const problems: string[] = []
  if (!firstLoad.length) problems.push('index.html loads no module script')
  if (firstLoadGzipKb > FIRST_LOAD_BUDGET_KB) problems.push(`first-load JS is ${firstLoadGzipKb} KB gzipped, over the ${FIRST_LOAD_BUDGET_KB} KB budget`)
  if (stylesGzipKb > STYLES_BUDGET_KB) problems.push(`first-load styles are ${stylesGzipKb} KB gzipped, over the ${STYLES_BUDGET_KB} KB budget`)
  if (fontsKb > FONTS_BUDGET_KB) problems.push(`first-load fonts are ${fontsKb} KB, over the ${FONTS_BUDGET_KB} KB budget`)
  if (totalKb > TOTAL_BUDGET_KB) problems.push(`the first load is ${totalKb} KB, over the ${TOTAL_BUDGET_KB} KB budget`)
  if (viewsInFirstLoad.length) problems.push(`module views in the first load: ${viewsInFirstLoad.join(', ')}`)
  if (bridgeChunks.length !== 1) problems.push(`the fiscal bridge is in ${bridgeChunks.length} chunks (${bridgeChunks.join(', ') || 'none'}), not exactly one`)
  return { firstLoad, firstLoadGzipKb, styles, stylesGzipKb, fonts, fontsKb, totalKb, viewsInFirstLoad, bridgeChunks, problems }
}

if (import.meta.main) {
  const dist = process.argv.slice(2).find(a => !a.startsWith('--')) ?? join(import.meta.dir, '..', 'packages', 'web', 'dist')
  const report = checkWebBundle(dist)
  console.log(`first-load JS: ${report.firstLoadGzipKb} KB gzipped (budget ${FIRST_LOAD_BUDGET_KB} KB)`)
  console.log(`first-load styles: ${report.stylesGzipKb} KB gzipped (budget ${STYLES_BUDGET_KB} KB)`)
  console.log(`first-load fonts: ${report.fontsKb} KB (budget ${FONTS_BUDGET_KB} KB)`)
  console.log(`first load in all: ${report.totalKb} KB (budget ${TOTAL_BUDGET_KB} KB)`)
  if (process.argv.includes('--report')) for (const f of [...report.firstLoad, ...report.styles]) console.log(`  ${f.file}  ${f.gzipKb} KB`)
  if (process.argv.includes('--report')) for (const f of report.fonts) console.log(`  ${f.file}  ${f.kb} KB`)
  console.log(`fiscal bridge chunks: ${report.bridgeChunks.join(', ') || 'none'}`)
  if (report.problems.length) {
    for (const p of report.problems) console.error(`✗ ${p}`)
    process.exit(1)
  }
  console.log('✓ the one SPA is within its budget')
}
