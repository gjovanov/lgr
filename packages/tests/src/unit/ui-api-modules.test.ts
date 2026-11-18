import { describe, it, expect } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * FR-32.24 (#797): a screen of `inventory-ui` or `invoicing-ui` makes no HTTP call by itself. It calls a function of
 * its package's API modules (`src/api/`), which declares the body its route's schema takes and the answer its handler
 * returns, so the screen no longer guesses the answer's shape (`data.x || data`, `_id || id`).
 *
 * - `inventory-ui` is converted: no file of it outside `src/api/` imports the HTTP client or calls it, and none reads
 *   an id one way and then the other.
 * - `invoicing-ui` goes screen by screen, the daily ones first. Its raw calls outside `src/api/` are counted, and the
 *   count may not grow. Lower `INVOICING_RAW_CALLS` when a screen moves to its module.
 *   ⚠ A ceiling, not an exact count: the order forms (FR-32.23) and the document form (FR-32.22) are refactored beside
 *   this, and folding two copies of a call into one lowers the count without a screen moving.
 */
const PACKAGES = resolve(import.meta.dir, '..', '..', '..')

/** `httpClient.get(…)`, `httpClient.post<T>(…)`, `axios.put(…)`: a request made where it stands. */
const RAW_CALL = /\b(?:httpClient|axios)\.(?:get|post|put|patch|delete|request)\s*[<(]/g
const CLIENT_IMPORT = /from\s+'(?:ui-shared\/composables\/useHttpClient|axios)'/
/** An id read one way and then the other: `x._id || x.id`, `x.id || x._id`. */
const ID_FALLBACK = /\._id\s*(?:\|\||\?\?)\s*[\w.?]*\bid\b|\.id\s*(?:\|\||\?\?)\s*[\w.?]*\._id\b/

/** invoicing-ui's raw calls outside `src/api/` when FR-32.24 started (130 in its components, 27 in composables). */
const INVOICING_RAW_CALLS = 157

function sources(pkg: string): Array<[string, string]> {
  return [...new Glob(`${pkg}/src/**/*.{ts,vue}`).scanSync(PACKAGES)]
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => !f.startsWith(`${pkg}/src/api/`))
    .map(f => [f, readFileSync(join(PACKAGES, f), 'utf8')])
}

const rawCalls = (text: string) => [...text.matchAll(RAW_CALL)].length

describe('the screens call their API modules (FR-32.24)', () => {
  it('reads both packages, and counts a call (a positive control)', () => {
    expect(sources('inventory-ui').length).toBeGreaterThan(20)
    expect(sources('invoicing-ui').length).toBeGreaterThan(50)
    expect(rawCalls("await httpClient.get(`${org}/x`); httpClient.post<{ a: 1 }>(u, b)")).toBe(2)
    expect(ID_FALLBACK.test('const id = data.product._id || data.product.id')).toBe(true)
  })

  it('inventory-ui: no file outside its API modules imports or calls the HTTP client', () => {
    const offenders = sources('inventory-ui')
      .filter(([, text]) => CLIENT_IMPORT.test(text) || rawCalls(text) > 0)
      .map(([f]) => f)
    expect(offenders).toEqual([])
  })

  it('inventory-ui: its API modules make the calls', () => {
    const modules = [...new Glob('inventory-ui/src/api/*.ts').scanSync(PACKAGES)]
    const calls = modules.reduce((n, f) => n + rawCalls(readFileSync(join(PACKAGES, f), 'utf8')), 0)
    expect(calls).toBeGreaterThanOrEqual(40)
  })

  it('inventory-ui: no id is read one way and then the other', () => {
    const files = [...new Glob('inventory-ui/src/**/*.{ts,vue}').scanSync(PACKAGES)].map(f => f.replace(/\\/g, '/'))
    const guessed = files.filter(f => ID_FALLBACK.test(readFileSync(join(PACKAGES, f), 'utf8')))
    expect(guessed).toEqual([])
  })

  it('invoicing-ui: the raw calls outside its API modules do not grow', () => {
    const count = sources('invoicing-ui').reduce((n, [, text]) => n + rawCalls(text), 0)
    expect({ count, atMost: INVOICING_RAW_CALLS, grew: count > INVOICING_RAW_CALLS }).toEqual({ count, atMost: INVOICING_RAW_CALLS, grew: false })
  })
})
