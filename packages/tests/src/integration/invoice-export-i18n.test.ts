import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Quick locale-pinning test for the "Tax" column label.
 * The UI catalog references `invoicing.tax`; Bulgarian users expect "ДДС".
 */
describe('Invoice export i18n', () => {
  const base = join(import.meta.dir, '../../../../packages/ui-shared/src/locales')

  it('bg.json exposes invoicing.tax → ДДС', () => {
    const bg = JSON.parse(readFileSync(join(base, 'bg.json'), 'utf-8'))
    expect(bg.invoicing.tax).toBe('ДДС')
  })

  it('en.json exposes invoicing.tax → Tax', () => {
    const en = JSON.parse(readFileSync(join(base, 'en.json'), 'utf-8'))
    expect(en.invoicing.tax).toBe('Tax')
  })

  it('de.json exposes invoicing.tax → MwSt.', () => {
    const de = JSON.parse(readFileSync(join(base, 'de.json'), 'utf-8'))
    expect(de.invoicing.tax).toBe('MwSt.')
  })

  it('mk.json exposes invoicing.tax → ДДВ', () => {
    const mk = JSON.parse(readFileSync(join(base, 'mk.json'), 'utf-8'))
    expect(mk.invoicing.tax).toBe('ДДВ')
  })
})
