import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PRODUCT_TYPES as MODEL_PRODUCT_TYPES } from 'config/constants'
import { PRODUCT_TYPES } from 'ui-shared/composables/useProductTypes'

/**
 * FR-22.11 (B-14) — the web apps say everything in every language they offer.
 *
 * ⚠ Neither way a key goes missing fails anything at build time:
 *  - missing from ONE locale, it falls back to English (`fallbackLocale: 'en'`). The regal staff
 *    read „Download", „Qty" and „Unit" in the Bulgarian print dialog, because bg.json had never
 *    been given `common.download`, `common.qty` or `common.unit`; de and mk lacked 44 keys.
 *  - missing from en as well, it renders the KEY itself: `common.remove` was the label of every
 *    line's delete button in all four languages, and new accounting forms were titled
 *    „common.new Сметка".
 *
 * A SOURCE test, like the shell's (desktop-shell-i18n.test.ts): rendering every view to find a
 * missing key would cover only the branches some test happened to take. It reads the catalogues
 * and every call site that names a key literally. A key built at run time (`t(\`x.${y}\`)`) is
 * out of its reach — product types and movement statuses are those, so they get their own case.
 *
 * desktop-ui is not here: it has its own catalogue and its own test.
 */

const PACKAGES = join(import.meta.dir, '..', '..', '..')
const LOCALES_DIR = join(PACKAGES, 'ui-shared', 'src', 'locales')
const LOCALES = ['en', 'bg', 'de', 'mk'] as const
type Locale = (typeof LOCALES)[number]
type Json = Record<string, unknown>

function load(locale: Locale): Json {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), 'utf8'))
}

/** Every leaf path, e.g. `common.remove`. */
function leafKeys(obj: Json, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leafKeys(v as Json, path))
    else out.push(path)
  }
  return out
}

function valueAt(obj: Json, key: string): unknown {
  return key.split('.').reduce<unknown>((o, part) => (o as Json | undefined)?.[part], obj)
}

function* sources(dir: string, ext: RegExp): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path, ext)
    else if (ext.test(name)) yield path
  }
}

/** The web apps' sources: every `*-ui` but the desktop shell, plus ui-shared and ui-shell. */
function webSourceRoots(): string[] {
  return readdirSync(PACKAGES)
    .filter(p => (p.endsWith('-ui') && p !== 'desktop-ui') || p === 'ui-shared' || p === 'ui-shell')
    .map(p => join(PACKAGES, p, 'src'))
}

const catalogues = Object.fromEntries(LOCALES.map(l => [l, load(l)])) as Record<Locale, Json>
const keys = Object.fromEntries(LOCALES.map(l => [l, new Set(leafKeys(catalogues[l]))])) as Record<Locale, Set<string>>

describe('the web catalogue (FR-22.11)', () => {
  it('bg, de and mk have every key en has, and none en lacks', () => {
    for (const locale of ['bg', 'de', 'mk'] as const) {
      const missing = [...keys.en].filter(k => !keys[locale].has(k))
      expect({ locale, missing }).toEqual({ locale, missing: [] })
      // A key only one locale has is usually a rename applied halfway — or `invoicing.email`,
      // a STRING in en, grown into an object in one locale: a leaf that en does not have.
      const extra = [...keys[locale]].filter(k => !keys.en.has(k))
      expect({ locale, extra }).toEqual({ locale, extra: [] })
    }
  })

  it('has a non-empty string at every key, in every locale', () => {
    for (const locale of LOCALES) {
      const bad = [...keys[locale]].filter(k => {
        const v = valueAt(catalogues[locale], k)
        return typeof v !== 'string' || !v.trim()
      })
      expect({ locale, bad }).toEqual({ locale, bad: [] })
    }
  })

  it('defines every key the web apps name literally', () => {
    // `$t('a.b')` / `t('a.b', …)` with the literal as the WHOLE first argument — a prefix that is
    // concatenated (`t('warehouse.filter.' + f)`) or interpolated is not a key — and the config
    // indirections the forms and the page registry use (`i18n: 'a.b'`, `titleKey: 'a.b'`…).
    // `te()` is left out on purpose: asking whether a key exists is how optional labels work.
    const patterns = [
      /(?<![\w$.])\$?t\(\s*(['"`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1\s*[,)]/g,
      /\b(?:i18n|[A-Za-z]*Key)\s*:\s*(['"`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g,
    ]
    const missing: string[] = []
    const seen = new Set<string>()
    let sites = 0
    for (const root of webSourceRoots()) {
      for (const file of sources(root, /\.(vue|ts)$/)) {
        const src = readFileSync(file, 'utf8')
        for (const re of patterns) {
          for (const m of src.matchAll(re)) {
            const key = m[2]
            if (key.startsWith('$vuetify.')) continue
            sites++
            seen.add(key)
            if (!keys.en.has(key)) missing.push(`${relative(PACKAGES, file).replace(/\\/g, '/')}: ${key}`)
          }
        }
      }
    }
    // The scan is looking at the right thing: thousands of call sites, and the one key the
    // FR names (every line-delete button's label) among them.
    expect(sites).toBeGreaterThan(2000)
    expect(seen.has('common.remove')).toBe(true)
    expect(missing).toEqual([])
  })

  it('names every product type, and the UI offers exactly the model\'s types', () => {
    expect([...PRODUCT_TYPES]).toEqual([...MODEL_PRODUCT_TYPES])
    for (const locale of LOCALES) {
      for (const type of MODEL_PRODUCT_TYPES) {
        expect({ locale, type, has: keys[locale].has(`warehouse.productTypes.${type}`) })
          .toEqual({ locale, type, has: true })
      }
    }
  })

  it('names a stock movement\'s every status where the list and the form look it up', () => {
    // StockMovement's status enum; the list's StatusChip and the form's pipeline both read
    // `invoicing.status.<status>`.
    for (const locale of LOCALES) {
      for (const status of ['draft', 'confirmed', 'completed', 'cancelled']) {
        expect(keys[locale].has(`invoicing.status.${status}`)).toBe(true)
      }
    }
  })

  it('no app closes its message bar with a hard-coded English „Close"', () => {
    // Every SPA's App.vue had `<v-btn …>Close</v-btn>` under every snackbar (B-14).
    const roots = readdirSync(PACKAGES).filter(p => p.endsWith('-ui') || p === 'ui-shared' || p === 'ui-shell')
    const offenders: string[] = []
    for (const p of roots) {
      for (const file of sources(join(PACKAGES, p, 'src'), /\.vue$/)) {
        readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (/>\s*Close\s*</.test(line)) offenders.push(`${relative(PACKAGES, file).replace(/\\/g, '/')}:${i + 1}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })
})
