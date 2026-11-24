import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * FR-32.22 (#797): `useDocumentForm` is built from its parts (`document-form/parts/`), each at most 500 lines, called
 * in the order their hooks register. `usePendingChanges` (state) registers its `onMounted` before the form's
 * (`load.ts#mountForm`), so the clean state is taken when the load resolves (FR-31 A1), and the watchers run in the
 * order they were made when the composable was one file.
 */
const DIR = resolve(import.meta.dir, '..', '..', '..', 'web', 'src', 'modules', 'invoicing', 'composables', 'document-form')
const MAX_LINES = 500
const read = (rel: string) => readFileSync(join(DIR, rel), 'utf8').replace(/\r\n/g, '\n')

/** Lines as `wc -l` counts them in a file that ends with a newline, and the last line too when it does not. */
function lineCount(text: string): number {
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.length - 1 : lines.length
}

/** The parts, in the order `useDocumentForm` calls them. */
const PARTS = [
  ['state', 'useFormState('],
  ['totals', 'useFormTotals('],
  ['lines', 'useFormLines('],
  ['product-update', 'useFormProductUpdate('],
  ['pricing', 'useFormPricing('],
  ['products', 'useFormProducts('],
  ['party', 'useFormParty('],
  ['load', 'useFormLoad('],
  ['status', 'useFormStatus('],
  ['print', 'useFormPrint('],
  ['saving', 'useFormSaving('],
  ['issue', 'useFormIssue('],
] as const

const files = ['useDocumentForm.ts', ...readdirSync(join(DIR, 'parts')).filter(f => f.endsWith('.ts')).sort().map(f => `parts/${f}`)]

describe('useDocumentForm in parts (FR-32.22)', () => {
  it('every file of the split is at most 500 lines', () => {
    const over = files.map(f => [f, lineCount(read(f))] as const).filter(([, n]) => n > MAX_LINES).map(([f, n]) => `${f}: ${n}`)
    expect(over).toEqual([])
  })

  it('the parts are the ones listed here: a new one is added to the order below', () => {
    expect(files.filter(f => f.startsWith('parts/')).map(f => f.slice('parts/'.length, -'.ts'.length)).sort())
      .toEqual(PARTS.map(([name]) => name).sort())
  })

  it('the composable calls them in the order their hooks register, and the form\'s onMounted last', () => {
    const composable = read('useDocumentForm.ts')
    const body = composable.slice(composable.indexOf('export function useDocumentForm('))
    const at = PARTS.map(([name, call]) => ({ name, at: body.indexOf(`= ${call}`) }))
    for (const p of at) expect({ part: p.name, called: p.at > -1 }).toEqual({ part: p.name, called: true })
    expect(at.map(p => p.name)).toEqual([...at].sort((a, b) => a.at - b.at).map(p => p.name))
    const mounted = body.indexOf('load.mountForm()')
    expect(mounted).toBeGreaterThan(at[at.length - 1].at)
    expect(body.indexOf('return {')).toBeGreaterThan(mounted)
  })

  it('the pending-changes guard is in the first part, and the form\'s onMounted only in load.ts#mountForm', () => {
    expect(read('parts/state.ts')).toContain('usePendingChanges({')
    for (const f of files) {
      const count = (read(f).match(/\bonMounted\(/g) ?? []).length
      expect({ file: f, onMounted: count }).toEqual({ file: f, onMounted: f === 'parts/load.ts' ? 1 : 0 })
    }
    const load = read('parts/load.ts')
    const mountForm = load.slice(load.indexOf('function mountForm()'))
    expect(mountForm).toContain('onMounted(async () => {')
  })
})
