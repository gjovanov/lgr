import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CAPABILITIES } from 'config/access'

/**
 * FR-27.11.D (#529) — a view never renders a cost figure for a role that does not hold it. The server sends none
 * (FR-27.11.C), and the view asks the same rule: `seesCosts` / `can('products.costs')`, a `v-cap`, or (where the cell
 * only follows the data, the column already gated) a `data-cap` on the figure (FR-27.7's mark of a gated figure).
 *
 * The ratchet: a template that renders a cost figure (`purchasePrice`, `avgCost`, `unitCost`, `varianceCost`, the
 * ledgers' values, an order's expected price…) consults that rule, or is on a list below with its reason.
 */

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue')) out.push(p)
  }
  return out
}
const FILES = readdirSync(join(ROOT, 'packages'))
  .filter(p => p.endsWith('-ui') || p === 'ui-shared' || p === 'ui-shell')
  .flatMap(p => {
    try { return walk(join(ROOT, 'packages', p, 'src')) } catch { return [] }
  })
  .map(p => ({ file: relative(join(ROOT, 'packages'), p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

/** A cost figure rendered by a template: in a mustache, a binding, a column key or an item slot. */
const FIGURE = /(?:\{\{[^}]*|:[\w-]+="[^"]*|key:\s*'|#item\.)\b(purchasePrice|standardCost|avgCost|unitCost|varianceCost|lineTotalCost|runningValue|expectedUnitPrice|lastCost|profitabilityNet|profitabilityGross|costAllocations|resolvedUnitCost|currentValue)\b/
const CONSULTS = [/\bseesCosts\b/, /'products\.costs'/, /\bcapOfTier\b/, /\bv-cap\b/, /\bdata-cap\b/, /\bcanSeeSupplierPrices\b/]

/** The books' own figures: Accounting's cost of a fixed asset follows the accounting features, not the price levels. */
const BOOKS = new Set([
  'accounting-ui/src/views/accounting/FixedAssetFormView.vue',
  'accounting-ui/src/views/accounting/FixedAssetsView.vue',
])

const template = (text: string) => text.split('<script')[0]
const renders = (text: string) => FIGURE.test(template(text))
const offends = (text: string) => renders(text) && !CONSULTS.some(r => r.test(text))

describe('FR-27.11.D: no view renders a cost figure the role does not hold', () => {
  it('finds the views and components', () => {
    expect(FILES.length).toBeGreaterThan(150)
    expect(FILES.filter(f => renders(f.text)).length).toBeGreaterThan(5)
  })

  it('every one that renders a cost figure asks the rule', () => {
    expect(FILES.filter(f => offends(f.text) && !BOOKS.has(f.file)).map(f => f.file)).toEqual([])
  })

  it('and the exemptions still render one (or are gone)', () => {
    const byFile = new Map(FILES.map(f => [f.file, f.text]))
    expect([...BOOKS].filter(f => !byFile.has(f) || !offends(byFile.get(f)!))).toEqual([])
  })

  it('every data-cap names a capability the catalogue knows', () => {
    const named = FILES.flatMap(f => [...template(f.text).matchAll(/(?<![:\w-])data-cap="([^"{]+)"/g)].map(m => m[1].trim()))
    expect(named.length).toBeGreaterThan(3)
    expect(named.filter(c => !c.split(/\s+/).every(x => CAPABILITIES.has(x)))).toEqual([])
  })
})
