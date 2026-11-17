import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { answerConfirm, askConfirm, confirmState } from 'ui-shared/composables/confirm'

/**
 * FR-31.16 / .17 (#796): decimal fields in the daily grids, and the app's own confirm dialog.
 *
 * - UI source calls no `confirm`, `alert` or `prompt` of the browser: their „OK" / „Отказ" both read as cancelling, and
 *   they speak the browser's language, not the session's.
 * - The raw `type="number"` inputs only get fewer: a new one is a `DecimalField` (the ceiling is lowered as forms move).
 * - The four daily grids type their quantities, prices and discounts into `DecimalField`s.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')
/** Raw number inputs in UI source after FR-31 B2 (92 when the audit counted them). Lower it as forms move; never raise. */
const RAW_NUMBER_INPUTS_CEILING = 85

function* sources(dir: string, ext: RegExp): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path, ext)
    else if (ext.test(name)) yield path
  }
}

function uiFiles(ext: RegExp): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = []
  for (const pkg of readdirSync(PACKAGES).filter(p => p.endsWith('-ui') || ['ui-shared', 'ui-shell', 'web'].includes(p))) {
    for (const file of sources(join(PACKAGES, pkg, 'src'), ext)) out.push({ rel: relative(PACKAGES, file).replace(/\\/g, '/'), text: readFileSync(file, 'utf8') })
  }
  return out
}

/** A call of the browser's dialog: `confirm(`, `window.alert(`, … — not a method, and not a function of the file's own. */
export function browserDialogCalls(text: string): string[] {
  const own = new Set([...text.matchAll(/(?:function\s+|const\s+|let\s+)(confirm|alert|prompt)\b/g)].map(m => m[1]))
  const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  return [...code.matchAll(/(^|[^\w.$])(window\.)?(confirm|alert|prompt)\s*\(/g)]
    .filter(m => m[2] || !own.has(m[3]))
    .map(m => `${m[2] ?? ''}${m[3]}(`)
}

describe('no browser dialogs (FR-31.17)', () => {
  it('the check sees a call and lets a function of the file’s own through', () => {
    expect(browserDialogCalls("if (!confirm(t('x'))) return")).toEqual(['confirm('])
    expect(browserDialogCalls("window.alert('x')")).toEqual(['window.alert('])
    expect(browserDialogCalls('function confirm() {}\nconfirm()')).toEqual([])
    expect(browserDialogCalls('await askConfirm({})')).toEqual([])
    expect(browserDialogCalls('dialog.confirm()')).toEqual([])
  })

  it('UI source calls no confirm, alert or prompt of the browser', () => {
    const offenders = uiFiles(/\.(ts|vue)$/).flatMap(f => browserDialogCalls(f.text).map(c => `${f.rel}: ${c}`))
    expect(offenders).toEqual([])
  })

  it('askConfirm answers what the person chose, and a second question answers the first No', async () => {
    const yes = askConfirm({ text: 'Delete this order?', confirm: 'Delete', danger: true })
    expect(confirmState.open).toBe(true)
    expect(confirmState.ask?.confirm).toBe('Delete')
    answerConfirm(true)
    expect(await yes).toBe(true)
    expect(confirmState.open).toBe(false)

    const first = askConfirm({ text: 'A', confirm: 'Do A' })
    const second = askConfirm({ text: 'B', confirm: 'Do B' })
    expect(await first).toBe(false)
    answerConfirm(false)
    expect(await second).toBe(false)
  })
})

describe('decimal fields (FR-31.16)', () => {
  it('raw number inputs only get fewer', () => {
    const count = uiFiles(/\.vue$/)
      .filter(f => f.rel !== 'ui-shared/src/components/DecimalField.vue')
      .reduce((n, f) => n + (f.text.match(/type="number"/g)?.length ?? 0), 0)
    expect(count).toBeLessThanOrEqual(RAW_NUMBER_INPUTS_CEILING)
  })

  it('the four daily grids type quantities, prices and discounts into DecimalFields', () => {
    const grids: [string, string[]][] = [
      ['invoicing-ui/src/components/document-form/DocumentLineTable.vue', ['v-model="line.quantity"', 'v-model="line.unitPrice"', 'v-model="line.discount"']],
      ['inventory-ui/src/views/MovementFormView.vue', ['v-model="line.quantity"', 'v-model="line.unitCost"']],
      ['inventory-ui/src/views/InventoryCountFormView.vue', ['v-model="line.countedQuantity"']],
      ['ui-shared/src/components/cash-register/RegisterTerminal.vue', ['data-testid="cart-qty"']],
    ]
    for (const [file, fields] of grids) {
      const text = readFileSync(join(PACKAGES, file), 'utf8')
      for (const field of fields) {
        const at = text.indexOf(field)
        expect(at, `${file}: ${field}`).toBeGreaterThan(-1)
        const tag = text.slice(text.lastIndexOf('<', at), at)
        expect(tag.startsWith('<DecimalField'), `${file}: ${field} is a DecimalField`).toBe(true)
      }
    }
  })
})
