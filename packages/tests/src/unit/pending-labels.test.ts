import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * FR-31.15 (#796): no English in another language's session.
 *
 * Forty labels were handed to the Pending Changes panel as English literals (`{ label: 'Name', … }`): a Bulgarian
 * person read "Name" and "Date" there. A label is the key the field itself is labelled with (`t('common.name')`).
 * This fails on a string literal as a `label` inside the `getPreviewFields` of a `usePendingChanges` or
 * `useDialogPendingChanges` call. It sits beside `web-catalogue-i18n.test.ts`.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')
/**
 * FR-27 P3-3 removes this view (the permission sets go with the grant); it is another agent's to touch until then.
 * The exception goes with the file.
 */
const LEAVING = ['web/src/modules/portal/views/settings/PermissionSetsView.vue']

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|vue)$/.test(name)) yield path
  }
}

/** The text of every `getPreviewFields: …` up to the end of its array. */
function previewBlocks(text: string): string[] {
  const out: string[] = []
  const re = /getPreviewFields\s*:/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const open = text.indexOf('[', m.index)
    if (open < 0) continue
    let depth = 0
    let i = open
    for (; i < text.length; i++) {
      if (text[i] === '[') depth++
      else if (text[i] === ']' && --depth === 0) break
    }
    out.push(text.slice(open, i + 1))
  }
  return out
}

describe('Pending Changes labels are the fields’ own keys (FR-31.15)', () => {
  it('no getPreviewFields hands the panel a string literal as a label', () => {
    const offenders: string[] = []
    let blocks = 0
    const roots = [join(PACKAGES, 'web', 'src', 'modules'), ...readdirSync(PACKAGES).filter(p => p.endsWith('-ui') || p === 'ui-shared' || p === 'ui-shell').map(p => join(PACKAGES, p, 'src'))]
    for (const root of roots) {
      for (const file of sources(root)) {
        const rel = relative(PACKAGES, file).replace(/\\/g, '/')
        if (LEAVING.includes(rel)) continue
        const text = readFileSync(file, 'utf8')
        for (const block of previewBlocks(text)) {
          blocks++
          for (const lit of block.matchAll(/label\s*:\s*(['"`])([^'"`]*)\1/g)) offenders.push(`${rel}: label ${lit[1]}${lit[2]}${lit[1]}`)
        }
      }
    }
    expect(blocks).toBeGreaterThan(15)
    expect(offenders).toEqual([])
  })

  it('the check sees a literal and lets a key through', () => {
    expect(previewBlocks("getPreviewFields: () => [{ label: 'Name', value: x }]")[0]).toContain("label: 'Name'")
    const ok = previewBlocks("getPreviewFields: () => [{ label: t('common.name'), value: x }]")[0]
    expect([...ok.matchAll(/label\s*:\s*(['"`])([^'"`]*)\1/g)]).toHaveLength(0)
  })
})
