import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * FR-14.33 — every shell string exists in en/bg/de/mk.
 *
 * ⚠ A missing key renders LITERALLY. `fallbackLocale: 'en'` covers a key missing from ONE
 * locale, not a key missing everywhere, and nothing in Vue warns at build time — the first
 * sign is `shell.settings.rotateKeyHint` printed on a customer's screen. FR-06 learned this
 * the same way, which is why the chunk says to add all four in the same change as the string.
 *
 * ⚠ A SOURCE test, deliberately. Rendering every view in jsdom to find a missing key would
 * need the whole Vuetify stack and would still only cover the branches a test happened to
 * take; the banner that fires on a revoked desktop is exactly the one nobody renders. Reading
 * the catalogues and the call sites covers all of them.
 */

const SHELL = join(import.meta.dirname, '..', '..', '..', 'desktop-ui', 'src')
const LOCALES = ['en', 'bg', 'de', 'mk'] as const

type Json = Record<string, unknown>

function load(locale: string): Json {
  return JSON.parse(readFileSync(join(SHELL, 'locales', `${locale}.json`), 'utf8'))
}

/** Every leaf path, e.g. `shell.overview.title`. */
function leafKeys(obj: Json, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...leafKeys(v as Json, path))
    } else {
      out.push(path)
    }
  }
  return out
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(vue|ts)$/.test(entry)) acc.push(p)
  }
  return acc
}

describe('the shell catalogue (FR-14.33)', () => {
  const catalogues = Object.fromEntries(LOCALES.map(l => [l, leafKeys(load(l)).sort()])) as
    Record<(typeof LOCALES)[number], string[]>

  it('has the same keys in every locale', () => {
    const en = new Set(catalogues.en)
    for (const locale of LOCALES) {
      if (locale === 'en') continue
      const here = new Set(catalogues[locale])
      const missing = [...en].filter(k => !here.has(k))
      const extra = [...here].filter(k => !en.has(k))
      expect({ locale, missing }).toEqual({ locale, missing: [] })
      // An extra key is dead weight, and usually a rename that was only half applied.
      expect({ locale, extra }).toEqual({ locale, extra: [] })
    }
  })

  it('has no empty string in any locale', () => {
    for (const locale of LOCALES) {
      const messages = load(locale)
      for (const key of catalogues[locale]) {
        const value = key.split('.').reduce<any>((o, part) => o?.[part], messages)
        expect(typeof value === 'string' && value.trim().length > 0).toBe(true)
      }
    }
  })

  it('defines every key the shell actually asks for', () => {
    const en = new Set(catalogues.en)
    const files = walk(SHELL)
    // `$t('x')`, `t('x')` and the `titleKey: 'x'` / `labelKey: 'x'` indirections the banners use.
    const patterns = [
      /\$t\(\s*'([^']+)'/g,
      /[^.\w]t\(\s*'([^']+)'/g,
      /(?:titleKey|bodyKey|labelKey):\s*'([^']+)'/g,
    ]

    const missing: Array<{ file: string; key: string }> = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      for (const re of patterns) {
        for (const m of src.matchAll(re)) {
          const key = m[1]
          // Only the shell's own namespace: `ui-shared` composables legitimately resolve
          // their own keys through the same `t`.
          if (!key.startsWith('shell.')) continue
          if (!en.has(key)) missing.push({ file: file.slice(SHELL.length + 1), key })
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('offers exactly the four locales the picker lists', () => {
    const src = readFileSync(join(SHELL, 'plugins', 'i18n.ts'), 'utf8')
    for (const locale of LOCALES) {
      expect(src).toContain(`'${locale}'`)
    }
  })
})
