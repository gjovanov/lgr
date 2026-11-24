import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * FR-31.21 (#796): icon buttons have names.
 *
 * An icon-only `v-btn` (`icon="mdi-…"`, or `icon` with a `<v-icon>` inside) says nothing to a screen reader and
 * nothing on hover. Every one names itself with a translated `aria-label` and a `title` (the tooltip), or carries a
 * `v-tooltip`/`v-bind` that does. 66 did not when this was written (69 of 188 by the audit's pattern).
 */

const PACKAGES = resolve(import.meta.dir, '../../..')
/** FR-27 P3-3 takes these views apart; they are another agent's to touch until then. The exception goes with them. */
const LEAVING = ['web/src/modules/portal/views/settings/InvitesView.vue', 'web/src/modules/portal/views/settings/UsersView.vue', 'web/src/modules/portal/views/settings/PermissionSetsView.vue']

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (name.endsWith('.vue')) yield path
  }
}

/** The icon-only buttons of a template that name themselves in no way. */
export function namelessIconButtons(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/<v-btn\b([^>]*?)\/?>/gs)) {
    const attrs = m[1]
    const icon = /(?<![:\w-])icon="([^"]+)"/.exec(attrs)
    const bare = /(?<![\w:-])icon(?=[\s/]|$)/.test(attrs)
    if (!icon && !bare) continue
    if (/aria-label|(?<![\w-])title=|:title=|v-tooltip|v-bind=/.test(attrs)) continue
    out.push(icon ? icon[1] : '(an icon inside)')
  }
  return out
}

describe('icon buttons have names (FR-31.21)', () => {
  it('the check sees a nameless one and lets a named one through', () => {
    expect(namelessIconButtons('<v-btn icon="mdi-close" @click="x" />')).toEqual(['mdi-close'])
    expect(namelessIconButtons('<v-btn icon variant="text"><v-icon>mdi-apps</v-icon></v-btn>')).toEqual(['(an icon inside)'])
    expect(namelessIconButtons(`<v-btn icon="mdi-close" :aria-label="$t('common.close')" />`)).toEqual([])
    expect(namelessIconButtons('<v-btn color="primary">Save</v-btn>')).toEqual([])
  })

  it('no icon-only button in UI source is without a name', () => {
    const offenders: string[] = []
    const roots = [join(PACKAGES, 'web', 'src', 'modules'), ...readdirSync(PACKAGES).filter(p => p.endsWith('-ui') || p === 'ui-shared' || p === 'ui-shell').map(p => join(PACKAGES, p, 'src'))]
    for (const root of roots) {
      for (const file of sources(root)) {
        const rel = relative(PACKAGES, file).replace(/\\/g, '/')
        if (LEAVING.includes(rel)) continue
        for (const b of namelessIconButtons(readFileSync(file, 'utf8'))) offenders.push(`${rel}: ${b}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
