import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { Vue } from '../helpers/vue-harness'
import { rowKey } from 'ui-shared/composables/row-key'

/**
 * FR-31.12 (#796): the line grids key their rows by the line, not by its position, and the key is in no payload.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')

describe('a line’s key (FR-31.12)', () => {
  it('is the line’s own: the same through a removal above it, and through its reactive proxy', () => {
    const form = Vue.reactive({ lines: [{ description: 'a' }, { description: 'b' }, { description: 'c' }] })
    const [a, , c] = form.lines.map(rowKey)
    expect(new Set(form.lines.map(rowKey)).size).toBe(3)
    form.lines.splice(1, 1)
    expect(form.lines.map(rowKey)).toEqual([a, c])
    // An edit of the line keeps it.
    form.lines[1].description = 'changed'
    expect(rowKey(form.lines[1])).toBe(c)
  })

  it('is written nowhere on the line: a payload or the unsaved-edits copy cannot carry it', () => {
    const line = { description: 'a', quantity: 1 }
    rowKey(line)
    expect(Object.keys(line)).toEqual(['description', 'quantity'])
    expect(JSON.stringify(line)).toBe('{"description":"a","quantity":1}')
  })

  it('a line made anew (a load, a restore) is a new row', () => {
    const line = { description: 'a' }
    expect(rowKey({ ...line })).not.toBe(rowKey(line))
  })

  it('the eight grids of §1.6 key their rows by it', () => {
    const grids: [string, RegExp][] = [
      ['invoicing-ui/src/components/document-form/DocumentLineTable.vue', /v-for="\(line, idx\) in form\.lines" :key="rowKey\(line\)"/],
      ['inventory-ui/src/views/MovementFormView.vue', /v-for="\(line, idx\) in form\.lines" :key="rowKey\(line\)"/],
      // FR-30.17: the count's lines are a data table keyed by their article (a count holds each article once), so a typed
      // quantity stays with its article through a search, a filter or a scroll.
      ['inventory-ui/src/views/InventoryCountFormView.vue', /item-value="productId"/],
      ['inventory-ui/src/views/PriceListFormView.vue', /v-for="\(item, idx\) in form\.items" :key="rowKey\(item\)"/],
      ['inventory-ui/src/views/ProductFormView.vue', /v-for="\(tier, i\) in priceTiers" :key="rowKey\(tier\)"/],
      ['accounting-ui/src/views/accounting/JournalEntryFormView.vue', /v-for="\(line, idx\) in form\.lines" :key="rowKey\(line\)"/],
      ['accounting-ui/src/views/accounting/JournalEntriesView.vue', /v-for="\(line, idx\) in form\.lines" :key="rowKey\(line\)"/],
      ['ui-shared/src/components/cash-register/RegisterTerminal.vue', /v-for="\(line, idx\) in lines" :key="rowKey\(line\)"/],
    ]
    for (const [file, keyed] of grids) {
      const text = readFileSync(join(PACKAGES, file), 'utf8')
      expect(keyed.test(text), file).toBe(true)
    }
  })
})
