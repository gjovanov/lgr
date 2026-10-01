import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * FR-14.17 — the page `lgr-web` shows when the cloud does not answer.
 *
 * ⚠ It must render with the machine's network OFF. Fetching anything to display "the server is
 * unreachable" is the joke that writes itself (C10's trap), and the failure mode is invisible
 * in development, where every CDN is reachable and the page looks fine.
 */

const PAGE = join(
  import.meta.dirname, '..', '..', '..',
  'desktop-ui', 'public', 'unreachable.html',
)

const html = readFileSync(PAGE, 'utf8')

describe('the bundled unreachable page', () => {
  it('loads nothing from the network', () => {
    // Any absolute URL in a src/href/url() would be a remote dependency.
    const remote = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || []
    expect(remote).toEqual([])

    const cssRemote = html.match(/url\(\s*["']?https?:\/\//gi) || []
    expect(cssRemote).toEqual([])

    for (const forbidden of ['fonts.googleapis', 'cdn.', 'unpkg', 'jsdelivr', '@import']) {
      expect(html.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('uses only system fonts', () => {
    // ⚠ A web font is the easiest thing to add and the hardest to notice missing: the page
    // still renders, in a fallback, on the one machine that matters.
    expect(html).toContain('system-ui')
    expect(html).not.toMatch(/@font-face/i)
  })

  it('says plainly that nothing works offline', () => {
    // The temptation is to imply work is being kept somewhere. There is no local data at all
    // since FR-14.34, and implying otherwise is how a shop keeps serving customers believing
    // the sales will sync later.
    expect(html).toContain('Nothing works offline')
  })

  it('offers both actions through the shell scheme, not through IPC', () => {
    // `lgr-web` is in no capability — that is what refuses the cloud app (FR-14.9) — so the
    // buttons must not reach for `invoke`.
    expect(html).toContain('lgr-shell://retry')
    expect(html).toContain('lgr-shell://diagnostics')
    expect(html).not.toContain('__TAURI')
    expect(html).not.toMatch(/\binvoke\s*\(/)
  })

  it('carries every string in all four locales (FR-14.33)', () => {
    // The page cannot import the catalogue — it is a plain file outside the Vue app — so its
    // strings live inline and still have to exist in all four languages.
    //
    // ⚠ Parsed per locale block rather than counted across the file: `offline:` also occurs in
    // the English prose ("Nothing works offline: …"), and a substring count quietly turns a
    // real coverage check into an assertion about punctuation.
    const keys = ['title', 'body', 'offline', 'next', 'retry', 'diagnostics']

    for (const key of keys) {
      // English is the markup itself, via the anchor the script replaces.
      expect(html).toContain(`data-i18n="${key}"`)
    }

    for (const locale of ['bg', 'de', 'mk']) {
      const start = html.indexOf(`${locale}: {`)
      expect({ locale, found: start >= 0 }).toEqual({ locale, found: true })
      const block = html.slice(start, html.indexOf('}', start))
      const missing = keys.filter(k => !new RegExp(`\\b${k}:`).test(block))
      expect({ locale, missing }).toEqual({ locale, missing: [] })
    }
  })
})
