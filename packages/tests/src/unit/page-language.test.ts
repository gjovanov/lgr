import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { SUPPORTED_LOCALES, createI18nPlugin, declareLanguage, initialLocale, loadLocale } from 'ui-shared/plugins/i18n'
import { tolerateForeignAnchors, type AnchorHost } from 'ui-shared/composables/foreign-anchor'

/**
 * 2026-11-15: a purchase invoice's Back button did nothing. The page said `<html lang="en">` whatever the person
 * read, the browser translated it, and a translator replaces the page's text nodes: the next thing the app had to
 * place beside one of them failed (`insertBefore … is not a child of this node`), the change stopped half way, and
 * the half-made page could not be taken down, so no move away from it worked.
 *
 * Three things keep that from happening, and each is held here:
 *  - the page says the language it is in, from its first line and on every change of language;
 *  - the page asks translators to leave it alone;
 *  - an insert whose place is gone goes at the end of its parent instead of stopping the render.
 * And the cause of the wrong language: it was decided twice. The browser half is `e2e/tests/translated-page.spec.ts`.
 */

const PACKAGES = join(import.meta.dirname, '..', '..', '..')
const read = (...parts: string[]) => readFileSync(join(PACKAGES, ...parts), 'utf8')

const real = {
  localStorage: (globalThis as any).localStorage,
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  document: (globalThis as any).document,
}

function browser(opts: { saved?: string | null; language?: string }) {
  ;(globalThis as any).localStorage = { getItem: (k: string) => (k === 'lgr_locale' ? opts.saved ?? null : null) }
  Object.defineProperty(globalThis, 'navigator', { value: { language: opts.language ?? 'en-US' }, configurable: true, writable: true })
}

afterEach(() => {
  ;(globalThis as any).localStorage = real.localStorage
  if (real.navigator) Object.defineProperty(globalThis, 'navigator', real.navigator)
  ;(globalThis as any).document = real.document
})

describe('the language a person starts in', () => {
  it('is the one they chose', () => {
    browser({ saved: 'de', language: 'bg-BG' })
    expect(initialLocale()).toBe('de')
  })

  it('is the browser\'s when they never chose, and English when the app does not speak it', () => {
    browser({ saved: null, language: 'bg-BG' })
    expect(initialLocale()).toBe('bg')
    browser({ saved: null, language: 'mk' })
    expect(initialLocale()).toBe('mk')
    browser({ saved: null, language: 'fr-FR' })
    expect(initialLocale()).toBe('en')
  })

  it('is never a saved value the app does not speak', () => {
    browser({ saved: 'xx', language: 'bg-BG' })
    expect(initialLocale()).toBe('bg')
  })
})

describe('the language is decided in one place', () => {
  /** Every UI source: the packages' `src`, less the tests and what is not code. */
  function uiSources(): string[] {
    const out: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === 'locales') continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|vue)$/.test(name)) out.push(path)
      }
    }
    for (const pkg of readdirSync(PACKAGES)) {
      if (pkg !== 'web' && pkg !== 'ui-shell' && pkg !== 'ui-shared' && !pkg.endsWith('-ui')) continue
      const src = join(PACKAGES, pkg, 'src')
      try { if (statSync(src).isDirectory()) walk(src) } catch { /* a package without sources */ }
    }
    return out
  }

  it('nothing but the rule reads the saved language', () => {
    // The store read it as "the saved one, else English" while the screen followed the browser: a person who
    // never chose a language read Bulgarian and printed an English form.
    const sources = uiSources()
    expect(sources.length).toBeGreaterThan(200)
    const readers = sources
      .filter(path => /getItem\(\s*['"]lgr_locale['"]\s*\)/.test(readFileSync(path, 'utf8')))
      .map(path => relative(PACKAGES, path).replace(/\\/g, '/'))
    expect(readers).toEqual(['ui-shared/src/plugins/i18n.ts'])
  })

  it('the app store starts in that language', () => {
    expect(read('ui-shared', 'src', 'stores', 'app.store.ts')).toMatch(/const locale = ref\(initialLocale\(\)\)/)
  })
})

describe('the page says its language, and asks not to be translated', () => {
  const web = read('web', 'index.html')

  it('every SPA shell is marked translate="no", in the standard\'s words and in Chrome\'s', () => {
    for (const ui of ['web', 'desktop-ui']) {
      const html = read(ui, 'index.html')
      expect({ ui, attr: /<html[^>]*\stranslate="no"/.test(html) }).toEqual({ ui, attr: true })
      expect({ ui, meta: /<meta name="google" content="notranslate"\s*\/?>/.test(html) }).toEqual({ ui, meta: true })
    }
  })

  it('the shell knows the same languages as the app, and says one before the app loads', () => {
    const list = /var LGR_LANGS = \[([^\]]*)\]/.exec(web)
    expect(list).not.toBeNull()
    const langs = list![1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
    expect([...langs].sort()).toEqual([...SUPPORTED_LOCALES].sort())
    expect(web.indexOf('document.documentElement.lang = lgrLang')).toBeGreaterThan(0)
    expect(web.indexOf('document.documentElement.lang = lgrLang')).toBeLessThan(web.indexOf('<script type="module"'))
  })

  /** The shell's own rule, run as the browser runs it. */
  function shellSays(opts: { saved?: string | null; language?: string; throws?: boolean }): string {
    const script = /<script>\s*(\/\/ The language the page is in[\s\S]*?)<\/script>/.exec(web)
    expect(script).not.toBeNull()
    const documentElement = { lang: 'en' }
    const localStorage = { getItem: (k: string) => { if (opts.throws) throw new Error('blocked'); return k === 'lgr_locale' ? opts.saved ?? null : null } }
    new Function('localStorage', 'navigator', 'document', script![1])(localStorage, { language: opts.language ?? 'en-US' }, { documentElement })
    return documentElement.lang
  }

  it('the shell\'s rule answers what the app\'s rule answers', () => {
    const cases: Array<{ saved?: string | null; language?: string }> = [
      { saved: 'de', language: 'bg-BG' },
      { saved: null, language: 'bg-BG' },
      { saved: null, language: 'mk' },
      { saved: null, language: 'fr-FR' },
      { saved: 'xx', language: 'bg-BG' },
      { saved: 'xx', language: 'ja' },
      { saved: 'en', language: 'bg' },
    ]
    for (const c of cases) {
      browser(c)
      expect({ ...c, lang: shellSays(c) }).toEqual({ ...c, lang: initialLocale() })
    }
  })

  it('a browser that refuses storage leaves the shell standing', () => {
    expect(shellSays({ throws: true, language: 'bg-BG' })).toBe('en')
  })

  it('choosing a language says it on the page', async () => {
    const documentElement = { lang: 'en' }
    ;(globalThis as any).document = { documentElement }
    declareLanguage('de')
    expect(documentElement.lang).toBe('de')
    await loadLocale(createI18nPlugin(), 'bg')
    expect(documentElement.lang).toBe('bg')
    // A language the app does not speak is English, on the page as on the screen.
    await loadLocale(createI18nPlugin(), 'xx')
    expect(documentElement.lang).toBe('en')
  })
})

describe('an insert whose place is gone', () => {
  /** A parent that keeps its children in order and refuses a foreign anchor, as the DOM does. */
  class Parent implements AnchorHost {
    children: any[] = []
    insertBefore(node: any, anchor: any) {
      if (anchor == null) { this.children.push(node); node.parentNode = this; return node }
      const at = this.children.indexOf(anchor)
      if (at < 0) throw new Error('NotFoundError: the node before which the new node is to be inserted is not a child of this node')
      this.children.splice(at, 0, node)
      node.parentNode = this
      return node
    }
  }
  const node = (name: string, parentNode: unknown = null) => ({ name, parentNode })

  let reports: Array<{ anchor: any; parent: any }>
  let Host: typeof Parent
  beforeEach(() => {
    reports = []
    // A fresh prototype each time: the guard is installed once per prototype.
    Host = class extends Parent {}
    Host.prototype.insertBefore = Parent.prototype.insertBefore
  })
  const install = () => tolerateForeignAnchors(Host.prototype, (anchor, parent) => reports.push({ anchor, parent }))

  it('goes at the end of its parent, and says so', () => {
    expect(install()).toBe('installed')
    const parent = new Host()
    const text = parent.insertBefore(node('text'), null)
    // What a translator does: the text node is replaced by an element of its own.
    const font = node('font', parent)
    parent.children[0] = font
    text.parentNode = null

    const icon = node('icon')
    expect(parent.insertBefore(icon, text)).toBe(icon)
    expect(parent.children.map(c => c.name)).toEqual(['font', 'icon'])
    expect(reports).toEqual([{ anchor: text, parent }])
  })

  it('an anchor that is another parent\'s child is as gone as one that is nobody\'s', () => {
    install()
    const parent = new Host()
    const elsewhere = new Host()
    const moved = elsewhere.insertBefore(node('moved'), null)
    parent.insertBefore(node('new'), moved)
    expect(parent.children.map(c => c.name)).toEqual(['new'])
    expect(elsewhere.children.map(c => c.name)).toEqual(['moved'])
    expect(reports.length).toBe(1)
  })

  it('leaves every ordinary insert to the browser: before a child, and at the end', () => {
    install()
    const parent = new Host()
    const b = parent.insertBefore(node('b'), null)
    parent.insertBefore(node('a'), b)
    parent.insertBefore(node('c'), null)
    parent.insertBefore(node('d'), undefined)
    expect(parent.children.map(c => c.name)).toEqual(['a', 'b', 'c', 'd'])
    expect(reports).toEqual([])
  })

  it('is installed once, however often it is asked', () => {
    expect(install()).toBe('installed')
    const once = Host.prototype.insertBefore
    expect(install()).toBe('already')
    expect(Host.prototype.insertBefore).toBe(once)
  })

  it('says the first one in the console and no other, and does nothing where there is no DOM', () => {
    const warn = console.warn
    const said: unknown[][] = []
    console.warn = (...a: unknown[]) => { said.push(a) }
    try {
      tolerateForeignAnchors(Host.prototype)
      const parent = new Host()
      parent.insertBefore(node('one'), node('gone'))
      parent.insertBefore(node('two'), node('gone too'))
      expect(parent.children.map(c => c.name)).toEqual(['one', 'two'])
      expect(said.length).toBe(1)
      expect(String(said[0][0])).toContain('translator')
    } finally {
      console.warn = warn
    }
    // Bun has no `Node`: the default host is absent, as on a server render.
    expect(typeof (globalThis as any).Node === 'undefined' ? tolerateForeignAnchors() : undefined).toBeUndefined()
  })
})
