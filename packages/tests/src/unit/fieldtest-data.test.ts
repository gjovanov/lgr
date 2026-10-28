import { describe, it, expect } from 'bun:test'
import {
  CATEGORIES, FIELDTEST_SLUG, PRESETS, contacts, documents, eikIsValid, products, stream,
} from '../../../../scripts/lib/fieldtest-data.ts'

/**
 * The synthetic field-test org's data (FR-20.112, plan step T-2): deterministic, sized like
 * regal-pz, and impossible to mistake for, or deliver to, anyone real.
 */

describe('the field-test generator', () => {
  it('is deterministic: the same seed gives the same data, another seed other data', () => {
    expect(JSON.stringify(products(7, 500))).toBe(JSON.stringify(products(7, 500)))
    expect(JSON.stringify(contacts(7, 50))).toBe(JSON.stringify(contacts(7, 50)))
    expect(JSON.stringify(documents(7, PRESETS.small))).toBe(JSON.stringify(documents(7, PRESETS.small)))
    expect(JSON.stringify(products(8, 50))).not.toBe(JSON.stringify(products(7, 50)))
  })

  it('draws each kind from its own stream: more products change no contact', () => {
    expect(JSON.stringify(products(7, 300))).toBe(JSON.stringify(products(7, 1000).slice(0, 300)))
    expect(JSON.stringify(contacts(7, 60))).toBe(JSON.stringify(contacts(7, 2000).slice(0, 60)))
  })

  it('makes the regal preset\'s 23k products unique, Cyrillic, tagged and in the 12 fastener categories', () => {
    const all = products(42, PRESETS.regal.products)
    expect(all).toHaveLength(23_000)
    expect(new Set(all.map(p => p.name)).size).toBe(all.length)
    expect(new Set(all.map(p => p.sku)).size).toBe(all.length)
    expect(new Set(all.map(p => p._id)).size).toBe(all.length)
    expect(all.every(p => /[А-Яа-я]/.test(p.name))).toBe(true)
    expect(all.every(p => p.tags.some(t => t.startsWith('DIN ')))).toBe(true)
    expect(all.every(p => CATEGORIES.includes(p.category))).toBe(true)
    expect(CATEGORIES).toHaveLength(12)
    expect(all.every(p => p.sellingPrice > p.purchasePrice && p.purchasePrice > 0)).toBe(true)
  })

  it('gives no contact a real company\'s tax number or a deliverable address', () => {
    const all = contacts(42, PRESETS.regal.contacts)
    expect(all.filter(c => eikIsValid(c.taxId))).toEqual([])
    expect(all.every(c => c.email.endsWith('.invalid'))).toBe(true)
    expect(all.every(c => c.vatNumber === `BG${c.taxId}`)).toBe(true)
    // The control: the validator accepts a correct number. 1·1 + 2·2 + … + 8·8 = 204, and 204 mod 11 = 6.
    expect(eikIsValid('123456786')).toBe(true)
    expect(eikIsValid('123456787')).toBe(false)
  })

  it('stocks every product a sale needs before the sale: no level can go below zero', () => {
    for (const preset of [PRESETS.small, PRESETS.regal]) {
      const { receipts, invoices } = documents(42, preset)
      const stock = new Map<number, number>()
      for (const lines of receipts) for (const l of lines) stock.set(l.productIndex, (stock.get(l.productIndex) ?? 0) + l.quantity)
      for (const inv of invoices) {
        for (const l of inv.lines) {
          stock.set(l.productIndex, (stock.get(l.productIndex) ?? 0) - l.quantity)
          expect(stock.get(l.productIndex)!).toBeGreaterThanOrEqual(0)
        }
      }
      expect(receipts).toHaveLength(preset.receipts)
      expect(invoices).toHaveLength(preset.invoices)
      // A document never lists a product twice.
      for (const doc of [...receipts, ...invoices.map(i => i.lines)]) {
        expect(new Set(doc.map(l => l.productIndex)).size).toBe(doc.length)
      }
    }
  })

  it('writes only into field-test orgs', () => {
    for (const ok of ['lgr-fieldtest', 'lgr-fieldtest-ci', 'lgr-fieldtest-onprem', 'lgr-fieldtest-run-42']) expect(FIELDTEST_SLUG.test(ok)).toBe(true)
    for (const no of ['regal', 'regal-pz', 'acme-corp', 'lgr-fieldtest-', 'lgr-fieldtestx', 'x-lgr-fieldtest', 'lgr-fieldtest-Regal', '']) expect(FIELDTEST_SLUG.test(no)).toBe(false)
  })

  it('makes valid ObjectIds', () => {
    const r = stream(1, 'ids')
    for (let i = 0; i < 100; i++) expect(r.objectId()).toMatch(/^[0-9a-f]{24}$/)
  })
})
