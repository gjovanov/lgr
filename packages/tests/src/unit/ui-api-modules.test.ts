import { describe, it, expect } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * FR-32.24 (#797): a screen of `inventory-ui` or `invoicing-ui` makes no HTTP call by itself. It calls a function of
 * its package's API modules (`src/api/`), which declares the body its route's schema takes and the answer its handler
 * returns, so the screen no longer guesses the answer's shape (`data.x || data`, `_id || id`).
 *
 * Both packages are converted: no file of either outside `src/api/` imports the HTTP client or calls it, and none
 * reads an id one way and then the other. A new call is a new function in the resource's module, written from its
 * controller.
 */
const PACKAGES = resolve(import.meta.dir, '..', '..', '..')
const CONVERTED = [
  // The modules of each make at least this many calls: the screens' requests are there, not gone.
  { pkg: 'inventory-ui', calls: 40 },
  { pkg: 'invoicing-ui', calls: 100 },
] as const

/** `httpClient.get(…)`, `httpClient.post<T>(…)`, `axios.put(…)`: a request made where it stands. */
const RAW_CALL = /\b(?:httpClient|axios)\.(?:get|post|put|patch|delete|request)\s*[<(]/g
const CLIENT_IMPORT = /from\s+'(?:ui-shared\/composables\/useHttpClient|axios)'/
/** An id read one way and then the other: `x._id || x.id`, `x.id || x._id`. */
const ID_FALLBACK = /\._id\s*(?:\|\||\?\?)\s*[\w.?]*\bid\b|\.id\s*(?:\|\||\?\?)\s*[\w.?]*\._id\b/

function files(pkg: string): string[] {
  return [...new Glob(`${pkg}/src/**/*.{ts,vue}`).scanSync(PACKAGES)].map(f => f.replace(/\\/g, '/'))
}

function sources(pkg: string): Array<[string, string]> {
  return files(pkg)
    .filter(f => !f.startsWith(`${pkg}/src/api/`))
    .map(f => [f, readFileSync(join(PACKAGES, f), 'utf8')])
}

const rawCalls = (text: string) => [...text.matchAll(RAW_CALL)].length

describe('the screens call their API modules (FR-32.24)', () => {
  it('reads both packages, and counts a call (a positive control)', () => {
    expect(sources('inventory-ui').length).toBeGreaterThan(20)
    expect(sources('invoicing-ui').length).toBeGreaterThan(50)
    expect(rawCalls("await httpClient.get(`${org}/x`); httpClient.post<{ a: 1 }>(u, b)")).toBe(2)
    expect(CLIENT_IMPORT.test("import { httpClient } from 'ui-shared/composables/useHttpClient'")).toBe(true)
    expect(ID_FALLBACK.test('const id = data.product._id || data.product.id')).toBe(true)
    expect(ID_FALLBACK.test('params: { id: invoice.id || invoice._id }')).toBe(true)
  })

  for (const { pkg, calls } of CONVERTED) {
    it(`${pkg}: no file outside its API modules imports or calls the HTTP client`, () => {
      const offenders = sources(pkg)
        .filter(([, text]) => CLIENT_IMPORT.test(text) || rawCalls(text) > 0)
        .map(([f]) => f)
      expect(offenders).toEqual([])
    })

    it(`${pkg}: its API modules make the calls`, () => {
      const modules = [...new Glob(`${pkg}/src/api/*.ts`).scanSync(PACKAGES)]
      const made = modules.reduce((n, f) => n + rawCalls(readFileSync(join(PACKAGES, f), 'utf8')), 0)
      expect(made).toBeGreaterThanOrEqual(calls)
    })

    it(`${pkg}: no id is read one way and then the other`, () => {
      const guessed = files(pkg).filter(f => ID_FALLBACK.test(readFileSync(join(PACKAGES, f), 'utf8')))
      expect(guessed).toEqual([])
    })
  }
})
