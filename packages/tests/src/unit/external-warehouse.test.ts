import { describe, it, expect } from 'bun:test'
import {
  becomesExternal, externalScope, externalWarehouseRefusal, flagsAfterSave, holdsStockRefusal, sideIsExternal,
} from 'config/external-warehouse'
import { externalSides, movementWarehouseRefusal, namesExternalWarehouses } from 'config/movement-warehouses'

/**
 * An external warehouse is another site's, named here so a transfer can say where the goods went or
 * came from. It keeps no stock in this org. These are the pure rules; `external-warehouse.flow` runs
 * them over the routes and the engine.
 */

describe('the flag', () => {
  it('a warehouse is never both default and external', () => {
    expect(externalWarehouseRefusal({ isDefault: true, isExternal: true })?.code).toBe('external_default')
    for (const flags of [{}, { isDefault: true }, { isExternal: true }, { isDefault: false, isExternal: true }, { isDefault: true, isExternal: false }]) {
      expect(externalWarehouseRefusal(flags)).toBeNull()
    }
  })

  it('reads a save against what the warehouse already is: either flag may be the one that changes', () => {
    // The default one is marked external.
    expect(externalWarehouseRefusal(flagsAfterSave({ isDefault: true }, { isExternal: true }))?.code).toBe('external_default')
    // The external one is made the default.
    expect(externalWarehouseRefusal(flagsAfterSave({ isExternal: true }, { isDefault: true }))?.code).toBe('external_default')
    // Swapped in one save: fine.
    expect(externalWarehouseRefusal(flagsAfterSave({ isDefault: true }, { isDefault: false, isExternal: true }))).toBeNull()
    // A save that names neither changes neither.
    expect(flagsAfterSave({ isDefault: true, isExternal: false }, {})).toEqual({ isDefault: true, isExternal: false })
    // A warehouse stored before the flag existed has none.
    expect(flagsAfterSave({ isDefault: false }, {})).toEqual({ isDefault: false, isExternal: false })
    expect(flagsAfterSave(null, { isExternal: true })).toEqual({ isDefault: false, isExternal: true })
  })

  it('becoming external is the change that needs the warehouse empty; the way back never does', () => {
    expect(becomesExternal({ isExternal: false }, { isExternal: true })).toBe(true)
    expect(becomesExternal({}, { isExternal: true })).toBe(true)
    expect(becomesExternal(null, { isExternal: true })).toBe(true)
    expect(becomesExternal({ isExternal: true }, { isExternal: true })).toBe(false)
    expect(becomesExternal({ isExternal: true }, { isExternal: false })).toBe(false)
    expect(becomesExternal({ isExternal: false }, { isExternal: false })).toBe(false)
  })

  it('a warehouse that holds stock says how many articles', () => {
    expect(holdsStockRefusal(0)).toBeNull()
    expect(holdsStockRefusal(1)).toMatchObject({ code: 'warehouse_holds_stock', articles: 1 })
    expect(holdsStockRefusal(1)!.message).toContain('1 article:')
    expect(holdsStockRefusal(12)!.message).toContain('12 articles')
  })

  it('a list answers the warehouses that keep stock unless asked otherwise', () => {
    expect(externalScope(undefined)).toBe('own')
    expect(externalScope('')).toBe('own')
    expect(externalScope('exclude')).toBe('own')
    expect(externalScope('true')).toBe('own')
    expect(externalScope('include')).toBe('include')
    expect(externalScope('only')).toBe('only')
  })
})

describe('a movement that names an external warehouse', () => {
  const OWN = 'own'
  const EXT = 'ext'
  /** [type, from, to, the refusal's code or null]: `EXT` marks the side as external. */
  const cases: Array<[string, unknown, unknown, string | null]> = [
    // A transfer names it as the other side.
    ['transfer', OWN, EXT, null],
    ['transfer', EXT, OWN, null],
    // And needs a warehouse of its own on the other one.
    ['transfer', EXT, undefined, 'transfer_without_own_warehouse'],
    ['transfer', EXT, null, 'transfer_without_own_warehouse'],
    ['transfer', undefined, EXT, 'transfer_without_own_warehouse'],
    ['transfer', EXT, EXT, 'transfer_without_own_warehouse'],
    // No other type names one, on either side.
    ['receipt', undefined, EXT, 'external_warehouse_not_transfer'],
    ['receipt', EXT, undefined, 'external_warehouse_not_transfer'],
    ['dispatch', EXT, undefined, 'external_warehouse_not_transfer'],
    ['dispatch', undefined, EXT, 'external_warehouse_not_transfer'],
    ['adjustment', EXT, undefined, 'external_warehouse_not_transfer'],
    ['adjustment', undefined, EXT, 'external_warehouse_not_transfer'],
    ['adjustment', OWN, EXT, 'external_warehouse_not_transfer'],
    ['return', EXT, undefined, 'external_warehouse_not_transfer'],
    ['return', undefined, EXT, 'external_warehouse_not_transfer'],
    ['production_in', undefined, EXT, 'external_warehouse_not_transfer'],
    ['production_out', EXT, undefined, 'external_warehouse_not_transfer'],
  ]
  for (const [type, from, to, code] of cases) {
    it(`${type} from ${from ?? '—'} to ${to ?? '—'}: ${code ?? 'fits'}`, () => {
      const refusal = movementWarehouseRefusal({
        type, fromWarehouseId: from, toWarehouseId: to, fromExternal: from === EXT, toExternal: to === EXT,
      })
      expect(refusal?.code ?? null).toBe(code)
    })
  }

  it('says so in the words of the rule', () => {
    expect(movementWarehouseRefusal({ type: 'dispatch', fromWarehouseId: EXT, fromExternal: true })!.message)
      .toBe('An external warehouse keeps no stock here: it is named only on a transfer, as the other side.')
  })

  it('a caller that says nothing about external warehouses is answered as before', () => {
    // The four rules that stood before, untouched by the two flags being absent or false.
    for (const flags of [{}, { fromExternal: false, toExternal: false }, { fromExternal: null, toExternal: null }]) {
      expect(movementWarehouseRefusal({ type: 'transfer', fromWarehouseId: OWN, toWarehouseId: OWN, ...flags })).toBeNull()
      expect(movementWarehouseRefusal({ type: 'transfer', toWarehouseId: OWN, ...flags })?.code).toBe('transfer_without_from_warehouse')
      expect(movementWarehouseRefusal({ type: 'dispatch', toWarehouseId: OWN, ...flags })?.code).toBe('dispatch_with_to_warehouse')
      expect(movementWarehouseRefusal({ type: 'receipt', fromWarehouseId: OWN, ...flags })?.code).toBe('receipt_with_from_warehouse')
      expect(movementWarehouseRefusal({ type: 'adjustment', fromWarehouseId: OWN, toWarehouseId: OWN, ...flags })?.code).toBe('adjustment_with_both_warehouses')
    }
  })

  it('a flag on a side that names no warehouse says nothing', () => {
    expect(externalSides({ fromExternal: true, toExternal: true })).toEqual({ from: false, to: false })
    expect(externalSides({ fromWarehouseId: null, fromExternal: true, toWarehouseId: EXT, toExternal: true })).toEqual({ from: false, to: true })
    expect(movementWarehouseRefusal({ type: 'receipt', toWarehouseId: OWN, fromExternal: true })).toBeNull()
  })

  it('only a transfer may name one', () => {
    expect(namesExternalWarehouses('transfer')).toBe(true)
    for (const type of ['receipt', 'dispatch', 'adjustment', 'return', 'production_in', 'production_out', undefined, null, '']) {
      expect(namesExternalWarehouses(type)).toBe(false)
    }
  })
})

describe('which side of a movement is external, as the screens and the print say it', () => {
  it('a booked movement: the external pair says so, the stock field never does', () => {
    for (const status of ['completed', 'confirmed', 'cancelled']) {
      // The id sits in the external field.
      expect(sideIsExternal({ status }, undefined, 'ext', false)).toBe(true)
      expect(sideIsExternal({ status }, null, 'ext', true)).toBe(true)
      // The stock field names a warehouse whose stock moved, whatever that warehouse is today.
      expect(sideIsExternal({ status }, 'own', undefined, true)).toBe(false)
      expect(sideIsExternal({ status }, 'own', undefined, false)).toBe(false)
    }
  })

  it('a draft: the warehouse the form chose, as it is now', () => {
    expect(sideIsExternal({ status: 'draft' }, 'wh', undefined, true)).toBe(true)
    expect(sideIsExternal({ status: 'draft' }, 'wh', undefined, false)).toBe(false)
  })

  it('a side that names nothing is not external', () => {
    expect(sideIsExternal({ status: 'draft' }, undefined, undefined, true)).toBe(false)
    expect(sideIsExternal({ status: 'completed' }, null, null, true)).toBe(false)
  })
})
