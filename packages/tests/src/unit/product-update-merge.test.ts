import { describe, it, expect } from 'bun:test'
import { mergeTiersByName } from 'services/biz/product-update.service'

/**
 * The tiers of a goods-receipt / supplier-bill product update are merged into the product's own
 * by NAME — never a replacement of the list. The forms used to send the whole list as they had
 * read it: filters they did not copy were erased, „Price N" slots were padded in, and a price
 * changed elsewhere meanwhile was put back.
 */

const current = () => [
  { name: 'Доставна цена', percent: 0, finalPrice: 10, manualOverride: true, contactIds: [], tags: [] },
  { name: 'Цена 1', percent: 30, finalPrice: 13, manualOverride: false, contactIds: ['k1'], tags: ['Цена 1'], minQuantity: 10, validFrom: '2026-01-01', validTo: '2026-12-31' },
]

describe('mergeTiersByName', () => {
  it('sets only the fields a change gives, on the tier of that name, keeping its filters', () => {
    const out = mergeTiersByName(current(), [{ name: 'Цена 1', finalPrice: 15, manualOverride: true }])
    expect(out[1]).toEqual({
      name: 'Цена 1', percent: 30, finalPrice: 15, manualOverride: true,
      contactIds: ['k1'], tags: ['Цена 1'], minQuantity: 10, validFrom: '2026-01-01', validTo: '2026-12-31',
    })
    expect(out[0]).toEqual(current()[0])
  })

  it('finds the tier whatever spacing its name was stored or sent with, and keeps the stored name', () => {
    const out = mergeTiersByName([{ name: 'Цена1', percent: 0, finalPrice: 9, manualOverride: true }], [{ name: 'Цена 1', finalPrice: 11 }])
    expect(out).toEqual([{ name: 'Цена1', percent: 0, finalPrice: 11, manualOverride: true }])
  })

  it('adds a name the product does not hold, after its own, with no filters', () => {
    const out = mergeTiersByName(current(), [{ name: 'Цена 4', finalPrice: 33, manualOverride: true }])
    expect(out.map(t => t.name)).toEqual(['Доставна цена', 'Цена 1', 'Цена 4'])
    expect(out[2]).toEqual({ name: 'Цена 4', percent: 0, finalPrice: 33, manualOverride: true, contactIds: [], tags: [] })
  })

  it('leaves what no change names, and does not touch the list it was given', () => {
    const given = current()
    const out = mergeTiersByName(given, [])
    expect(out).toEqual(current())
    mergeTiersByName(given, [{ name: 'Цена 1', finalPrice: 1 }])
    expect(given).toEqual(current())
  })

  it('applies two changes to one tier in order', () => {
    const out = mergeTiersByName(current(), [{ name: 'Цена 1', finalPrice: 14 }, { name: 'Цена 1', finalPrice: 16, manualOverride: true }])
    expect([out[1].finalPrice, out[1].manualOverride]).toEqual([16, true])
  })
})
