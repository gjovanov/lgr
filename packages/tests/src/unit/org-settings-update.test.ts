import { describe, it, expect } from 'bun:test'
import { orgSettingsUpdate } from 'services/biz/org-settings-update'

/**
 * The update a `settings` object of `PUT /org/:orgId` asks for: one path for each value sent, so that what a save does
 * not name stays as it is stored. What the route then stores is `integration/org-settings-save.flow`.
 */
describe('orgSettingsUpdate', () => {
  it('names one path for each value sent, however deep its block', () => {
    expect(orgSettingsUpdate({
      baseCurrency: 'EUR',
      taxConfig: { vatEnabled: false },
      inventory: { defaultCostingMethod: 'fifo', allowNegativeStock: true },
      dailyDigest: { hour: 0, sections: { kpis: false, ops: true } },
    })).toEqual({
      set: {
        'settings.baseCurrency': 'EUR',
        'settings.taxConfig.vatEnabled': false,
        'settings.inventory.defaultCostingMethod': 'fifo',
        'settings.inventory.allowNegativeStock': true,
        // Zero and false are values like any other.
        'settings.dailyDigest.hour': 0,
        'settings.dailyDigest.sections.kpis': false,
        'settings.dailyDigest.sections.ops': true,
      },
      unset: [],
    })
  })

  it('a list is a value: it goes whole to its own path, rows and all', () => {
    const rates = [{ name: 'Standard', rate: 20 }, { name: 'Zero', rate: 0 }]
    const { set, unset } = orgSettingsUpdate({ modules: [], taxConfig: { vatRates: rates }, dailyDigest: { recipients: [{ userId: 'a'.repeat(24) }] } })
    expect(set).toEqual({
      'settings.modules': [],
      'settings.taxConfig.vatRates': rates,
      'settings.dailyDigest.recipients': [{ userId: 'a'.repeat(24) }],
    })
    expect(unset).toEqual([])
  })

  it('a block sent empty names nothing, and neither does a value that was not given', () => {
    const nothing = { set: {}, unset: [] }
    expect(orgSettingsUpdate({})).toEqual(nothing)
    expect(orgSettingsUpdate({ taxConfig: {}, dailyDigest: { sections: {} } })).toEqual(nothing)
    expect(orgSettingsUpdate({ locale: undefined, taxConfig: { defaultVatRate: undefined, taxIdLabel: null } })).toEqual(nothing)
  })

  it('what is not a block of settings asks for nothing', () => {
    const nothing = { set: {}, unset: [] }
    for (const given of [undefined, null, 'settings', 7, true, ['baseCurrency'], new Date(0)]) {
      expect(orgSettingsUpdate(given)).toEqual(nothing)
    }
  })

  it('the digest\'s language sent empty is removed; any other empty text is stored as sent', () => {
    expect(orgSettingsUpdate({ dailyDigest: { locale: '', enabled: true } })).toEqual({
      set: { 'settings.dailyDigest.enabled': true },
      unset: ['settings.dailyDigest.locale'],
    })
    expect(orgSettingsUpdate({ dailyDigest: { locale: 'bg' } })).toEqual({ set: { 'settings.dailyDigest.locale': 'bg' }, unset: [] })
    // Only that path. The org's own language, or any other text, sent empty is stored as sent.
    expect(orgSettingsUpdate({ locale: '', taxConfig: { taxIdLabel: '' } })).toEqual({
      set: { 'settings.locale': '', 'settings.taxConfig.taxIdLabel': '' },
      unset: [],
    })
  })

  it('a key that could not be a setting\'s name is skipped, with everything under it, and the rest is written', () => {
    expect(orgSettingsUpdate({
      dailyDigest: { sections: { kpis: false, 'stock.x': true, $set: true, '': true } },
      'taxConfig.defaultVatRate': 0,
      $unset: { baseCurrency: 1 },
      '': { locale: 'bg' },
      timezone: 'Europe/Sofia',
    })).toEqual({
      set: { 'settings.dailyDigest.sections.kpis': false, 'settings.timezone': 'Europe/Sofia' },
      unset: [],
    })
  })

  it('a value that is not plain JSON is a value, never walked into', () => {
    class Id { constructor(public hex: string) {} }
    const day = new Date(0)
    const id = new Id('a'.repeat(24))
    expect(orgSettingsUpdate({ inventory: { defaultInventoryAccountId: id }, backup: { since: day } }).set).toEqual({
      'settings.inventory.defaultInventoryAccountId': id,
      'settings.backup.since': day,
    })
  })

  it('reads a block that has no prototype, as a parser may make one, and changes nothing it is given', () => {
    const bare = Object.assign(Object.create(null), { taxConfig: Object.assign(Object.create(null), { vatEnabled: true }) })
    expect(orgSettingsUpdate(bare).set).toEqual({ 'settings.taxConfig.vatEnabled': true })

    const given = { taxConfig: { vatEnabled: true, vatRates: [{ name: 'Standard', rate: 20 }] }, dailyDigest: { locale: '' } }
    const copy = JSON.parse(JSON.stringify(given))
    orgSettingsUpdate(given)
    expect(given).toEqual(copy)
  })
})
