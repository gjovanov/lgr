/**
 * Which warehouse a stock movement may name, by its type (#168).
 *
 * `confirmMovement` never reads `type`: it takes the quantity out of `fromWarehouseId` and puts it
 * into `toWarehouseId`. So a `dispatch` naming only a To warehouse ADDS stock, and a `receipt`
 * naming a From warehouse takes it out of one. The form made the first easy: a new movement starts
 * as a receipt with its To warehouse filled in, and changing the type left it there.
 *
 * Two types have one side only. Every other type is free: a transfer names both or, on the imports
 * (destination untracked), From alone; an adjustment and a return name whichever side they touch.
 * A movement naming neither warehouse moves nothing and stays allowed: the form asks, it does not
 * refuse (`MovementFormView.vue`).
 *
 * Pure, so the form and the server cannot disagree. The server applies it at the doors a user comes
 * through (`movement.controller.ts`, `doc-import.controller.ts`), and ⚠ deliberately NOT inside
 * `confirmMovement`: see the note there.
 */

export type WarehouseSide = 'from' | 'to'

/** The side a movement of this type never names, or null when it may name either. */
export function unusedWarehouseSide(type: string | null | undefined): WarehouseSide | null {
  if (type === 'dispatch') return 'to'
  if (type === 'receipt') return 'from'
  return null
}

export interface MovementWarehouses {
  type?: string | null
  fromWarehouseId?: unknown
  toWarehouseId?: unknown
}

export interface MovementWarehouseRefusal {
  code: 'dispatch_with_to_warehouse' | 'receipt_with_from_warehouse'
  message: string
}

/** Why these warehouses do not fit this type, or null when they do. */
export function movementWarehouseRefusal(m: MovementWarehouses): MovementWarehouseRefusal | null {
  const unused = unusedWarehouseSide(m.type)
  if (unused === 'to' && m.toWarehouseId) {
    return {
      code: 'dispatch_with_to_warehouse',
      message: 'A dispatch takes goods out of a warehouse: choose it as the From warehouse and leave the To warehouse empty.',
    }
  }
  if (unused === 'from' && m.fromWarehouseId) {
    return {
      code: 'receipt_with_from_warehouse',
      message: 'A receipt brings goods into a warehouse: choose it as the To warehouse and leave the From warehouse empty.',
    }
  }
  return null
}
