import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROLES } from 'config/constants'
import {
  CATALOGUE, EDITOR_FEATURES, FEATURE_GROUPS, LEVELS, beyondLevel, levelOf, levelsOf, summarize, templateGrant, withImplied,
  type CapabilityId,
} from 'config/access'

/**
 * FR-27.1, FR-27.4 (#529) — what the role editor shows: a level per feature and its extras, and the three summary
 * lines; and every label of it in en, bg, de and mk (a missing key renders literally, FR-27.1).
 */

const LOCALES = ['en', 'bg', 'de', 'mk'] as const
const catalogue = (loc: string) => JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'ui-shared', 'src', 'locales', `${loc}.json`), 'utf8'))
const actionKey = (a: string) => a.replace(/[:-]/g, '_')

describe('the labels of the access model, in four locales', () => {
  for (const loc of LOCALES) {
    it(loc, () => {
      const access = catalogue(loc).access ?? {}
      const missing: string[] = []
      for (const f of CATALOGUE) {
        if (!access.feature?.[f.id]) missing.push(`feature.${f.id}`)
        for (const a of f.actions as readonly string[]) if (!access.action?.[actionKey(a)]) missing.push(`action.${actionKey(a)}`)
      }
      for (const g of FEATURE_GROUPS) if (!access.group?.[g]) missing.push(`group.${g}`)
      for (const l of LEVELS) if (!access.level?.[l]) missing.push(`level.${l}`)
      for (const r of ROLES) if (!access.roles?.[r]?.description) missing.push(`roles.${r}.description`)
      expect([...new Set(missing)]).toEqual([])
    })
  }
})

describe('levels and extras', () => {
  it('View ⊂ Work ⊂ Full for every feature, and extras outside them', () => {
    for (const f of EDITOR_FEATURES) {
      const l = levelsOf(f)
      expect({ f: f.id, view: l.view.every(c => l.work.includes(c)), work: l.work.every(c => l.full.includes(c)), extras: l.extras.every(c => !l.full.includes(c)) })
        .toEqual({ f: f.id, view: true, work: true, extras: true })
    }
  })

  it("a level's capabilities read back as that level, with nothing beyond it", () => {
    const products = CATALOGUE.find(f => f.id === 'products')!
    const work = { caps: new Set(levelsOf(products).work) }
    expect(levelOf(products, work)).toBe('work')
    expect(beyondLevel(products, work)).toEqual([])
    const plusExport = { caps: new Set<CapabilityId>([...levelsOf(products).view, 'products.export']) }
    expect(levelOf(products, plusExport)).toBe('view')
    expect(beyondLevel(products, plusExport)).toEqual(['products.export'])
  })

  it('the Seller reads Products and Devices, works on sales documents, and holds no totals (#493)', () => {
    const seller = templateGrant('seller')
    const find = (id: string) => CATALOGUE.find(f => f.id === id)!
    expect(levelOf(find('products'), seller)).toBe('view')
    expect(levelOf(find('devices'), seller)).toBe('view')
    expect(levelOf(find('sales-docs'), seller)).not.toBe('none')
    expect(levelOf(find('payments'), seller)).toBe('none')
    expect(beyondLevel(find('sales-docs'), seller)).not.toContain('sales-docs.totals')
  })

  it('a role made in the editor gets the helpers its forms read', () => {
    expect(withImplied(['sales-docs.view', 'sales-docs.create'])).toEqual(expect.arrayContaining(['pricing.read', 'stock-availability.transfer', 'tags.edit']))
  })
})

describe('the summary under a role (§2.3)', () => {
  it('the Seller: creates sales documents and transfers, reads products, does not see payments or accounting', () => {
    const s = summarize(templateGrant('seller'))
    expect(s.canCreate).toEqual(expect.arrayContaining(['sales-docs', 'proforma', 'contacts', 'movements']))
    expect(s.readOnly).toEqual(expect.arrayContaining(['products', 'devices']))
    expect(s.notVisible).toEqual(expect.arrayContaining(['payments', 'bills', 'price-lists', 'journal']))
  })

  it('the Administrator creates everything', () => {
    const s = summarize({ all: true })
    expect(s.notVisible).toEqual([])
    expect(s.readOnly).toEqual([])
  })
})
