import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * FR-32.23 (#797): one base for the two order forms, each at most 900 lines.
 *
 * The supplier order (ORDO, `OrderFormView.vue`) and the customer order (ORDI, `InternalOrderFormView.vue`) were 1 544
 * and 1 564 lines, and 27 of their functions shared a name. What they share is `composables/order-form/useOrderFormBase`
 * (the order's identity on the screen, the contact pools and the warehouses, the order-wide actions, Delete) and
 * `components/order-form/OrderFormFooter.vue` (notes, terms, tags, the totals and Save). What each is on its own is
 * in `composables/order-form` and `components/order-form` too, beside them. A form that grows past the limit moves
 * its work there again.
 */
const PACKAGES = resolve(import.meta.dir, '..', '..', '..')
const UI = join(PACKAGES, 'invoicing-ui', 'src')
const MAX_LINES = 900
const FORMS = ['views/OrderFormView.vue', 'views/InternalOrderFormView.vue']

/** Lines as `wc -l` counts them in a file that ends with a newline, and the last line too when it does not. */
function lineCount(text: string): number {
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.length - 1 : lines.length
}

const read = (rel: string) => readFileSync(join(UI, rel), 'utf8')

describe('the two order forms (FR-32.23)', () => {
  it(`each is at most ${MAX_LINES} lines`, () => {
    const over = FORMS.map(f => [f, lineCount(read(f))] as const).filter(([, n]) => n > MAX_LINES).map(([f, n]) => `${f}: ${n}`)
    expect(over).toEqual([])
  })

  it('a form over the limit fails', () => {
    expect(lineCount('x\n'.repeat(MAX_LINES + 1)) > MAX_LINES).toBe(true)
    expect(lineCount('x\n'.repeat(MAX_LINES)) > MAX_LINES).toBe(false)
  })

  it('both stand on the one base and the one footer', () => {
    for (const f of FORMS) {
      const text = read(f)
      expect(text, f).toContain('useOrderFormBase({')
      expect(text, f).toContain('<OrderFormFooter')
    }
  })

  it('their route names are the ones they had', () => {
    const manifest = readFileSync(join(UI, 'manifest.ts'), 'utf8')
    for (const [name, view] of [
      ['invoicing.orders.new', 'OrderFormView'],
      ['invoicing.orders.edit', 'OrderFormView'],
      ['invoicing.internalOrders.new', 'InternalOrderFormView'],
      ['invoicing.internalOrders.edit', 'InternalOrderFormView'],
    ]) {
      expect(manifest, name).toMatch(new RegExp(`name: '${name.replace(/\./g, '\\.')}', component: \\(\\) => import\\('\\./views/${view}\\.vue'\\)`))
    }
  })
})
