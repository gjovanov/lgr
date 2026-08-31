import { describe, it, expect } from 'bun:test'
import { buildTiers, repriceTiers, PROTECTED_TIERS } from 'services/biz/doc-import/map-movement'

/**
 * A разписка delivers its price columns as HEADINGS, and a wrapped heading folds back together
 * without its spaces — „Цена на едро" arrives as „Ценанаедро", „Прод. цена" as „Прод.цена".
 * Slot lookup is by exact name, so an unrecognised label silently writes nothing: the wholesale
 * column would quietly stop protecting the cost side, and a numbered tier would land nowhere.
 */
describe('price-tier slot naming', () => {
  it('routes the numbered tiers onto their catalog slots, however the header was spaced', () => {
    const existing = buildTiers(0, {})
    const out = repriceTiers(existing, { 'Цена 1': 11.05, 'Цена2': 9.4, 'Цена  5': 8 }, 10)
    const at = (n: string) => out.find((t: any) => t.name === n)
    expect(at('Цена 1')!.finalPrice).toBe(11.05)
    expect(at('Цена 2')!.finalPrice).toBe(9.4)   // "Цена2" — the unspaced form the PDF header gives
    expect(at('Цена 5')!.finalPrice).toBe(8)
    // A tier the document did not carry keeps whatever the snapshot seed put there.
    expect(at('Цена 3')!.finalPrice).toBe(0)
  })

  it('never lets a разписка write the cost-side slots', () => {
    for (const n of ['Доставна цена', 'Цена на едро', 'Цена 0', 'Прод. цена']) expect(PROTECTED_TIERS.has(n)).toBe(true)
    const before = buildTiers(5, { 'Цена 1': 9 })
    const out = repriceTiers(before, { 'Доставна цена': 99, 'Цена на едро': 42 }, 5)
    expect(out.find((t: any) => t.name === 'Доставна цена')!.finalPrice).toBe(5)
    expect(out.find((t: any) => t.name === 'Цена на едро')!.finalPrice).toBe(before.find((t: any) => t.name === 'Цена на едро')!.finalPrice)
  })

  it('marks each written tier with its own name, which is what tag-based resolution matches on', () => {
    const out = repriceTiers(buildTiers(0, {}), { 'Цена 4': 3.2 }, 2)
    expect(out.find((t: any) => t.name === 'Цена 4')!.tags).toEqual(['Цена 4'])
    expect(out.find((t: any) => t.name === 'Цена 4')!.manualOverride).toBe(true)
  })
})
