import { StockLevel, Warehouse } from 'db/models'

/**
 * What the database knows about external warehouses (`config/external-warehouse` holds the rules).
 *
 * An external warehouse is another site's, named here only so a transfer can say where the goods
 * went or came from. The engine (`confirmMovement`) books nothing on one, and the doors a user comes
 * through refuse a movement that names one where it cannot be (`config/movement-warehouses`). Both
 * ask here which of a movement's warehouses is external NOW: the flag is read when the movement is
 * written or confirmed, never remembered on a draft.
 */

const OBJECT_ID = /^[0-9a-f]{24}$/i

/** Which of these warehouses of the org are external. One query, and none when no id is named. */
export async function externalWarehouseIds(orgId: unknown, ids: unknown[]): Promise<Set<string>> {
  const named = [...new Set(ids.filter(Boolean).map(String))].filter(id => OBJECT_ID.test(id))
  if (!named.length) return new Set()
  const rows: any[] = await Warehouse.find({ orgId, _id: { $in: named }, isExternal: true } as any, { _id: 1 }).lean().exec()
  return new Set(rows.map(r => String(r._id)))
}

export interface ExternalSides {
  fromExternal: boolean
  toExternal: boolean
}

/** The two flags `movementWarehouseRefusal` takes, for a movement's warehouses as they are now. */
export async function movementExternalSides(
  orgId: unknown,
  m: { fromWarehouseId?: unknown; toWarehouseId?: unknown },
): Promise<ExternalSides> {
  const external = await externalWarehouseIds(orgId, [m.fromWarehouseId, m.toWarehouseId])
  return {
    fromExternal: !!m.fromWarehouseId && external.has(String(m.fromWarehouseId)),
    toExternal: !!m.toWarehouseId && external.has(String(m.toWarehouseId)),
  }
}

/**
 * How many articles a warehouse holds or has reserved: what stops it becoming external. A level left
 * at zero by goods that came and went does not count.
 */
export async function articlesHeldAt(orgId: unknown, warehouseId: unknown): Promise<number> {
  return StockLevel.countDocuments({
    orgId,
    warehouseId,
    $or: [{ quantity: { $ne: 0 } }, { reservedQuantity: { $gt: 0 } }],
  } as any).exec()
}
