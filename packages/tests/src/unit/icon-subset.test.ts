import { describe, it, expect } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ICON_DIR, mdiFont, usedIconNames } from '../../../../scripts/build-icon-subset'

/**
 * FR-30.21 (#795, slice G): the icon font holds the icons the app uses.
 *
 * Every `mdi-…` name a UI source, a manifest or the app registry names (and Vuetify's own components) is in the
 * committed subset with its glyph's rule, so it renders. A name used and not shipped fails here: run
 * `bun scripts/build-icon-subset.ts` and commit what it writes.
 */
describe('the icon subset', () => {
  const shipped: string[] = JSON.parse(readFileSync(join(ICON_DIR, 'icons.json'), 'utf8'))
  const css = readFileSync(join(ICON_DIR, 'mdi-subset.css'), 'utf8').replace(/\r\n/g, '\n')

  it('ships every icon the sources use, and nothing they do not', () => {
    const used = usedIconNames()
    expect(used.filter((n) => !shipped.includes(n))).toEqual([])
    expect(shipped.filter((n) => !used.includes(n))).toEqual([])
  })

  it('gives each shipped icon the glyph @mdi/font gives it', () => {
    const { codepoints } = mdiFont()
    for (const name of shipped) {
      expect({ name, rule: css.includes(`.${name}::before {\n  content: "\\${codepoints.get(name)}";`) }).toEqual({ name, rule: true })
    }
    // Vuetify's own icons are among them (a checkbox, a menu's arrow, a closing cross).
    for (const name of ['mdi-checkbox-marked', 'mdi-checkbox-blank-outline', 'mdi-menu-down', 'mdi-close']) expect(shipped).toContain(name)
  })

  it('weighs at most 40 KB, and is what the app loads instead of the whole font', () => {
    expect(statSync(join(ICON_DIR, 'mdi-subset.woff2')).size).toBeLessThanOrEqual(40 * 1024)
    const plugin = readFileSync(join(import.meta.dir, '..', '..', '..', 'ui-shared', 'src', 'plugins', 'vuetify.ts'), 'utf8')
    expect(plugin).toContain("import '../styles/icons/mdi-subset.css'")
    expect(plugin).not.toMatch(/^import '@mdi\/font/m)
  })
})
