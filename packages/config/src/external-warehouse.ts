/**
 * An external warehouse: another site's warehouse, named in this org so a transfer can say where
 * the goods went or where they came from.
 *
 * It keeps no stock here. A transfer to it takes the goods out of the org's own warehouse and puts
 * them nowhere; a transfer from it brings them in as goods arriving from outside. The movement is a
 * document for the people on the other side, not a booking on their stock: they keep their own.
 *
 * So the flag excludes two things. The default warehouse is where documents book stock when nobody
 * says otherwise, and an external one books none. And a warehouse that holds goods cannot become
 * external: its levels would stay on the stock reports with nothing able to move them again.
 *
 * Pure, so the form and the server cannot disagree. Whether the warehouse holds stock is the one
 * part that needs the database (`services/biz/external-warehouses#articlesHeldAt`).
 */

export interface WarehouseFlags {
  isDefault?: boolean | null
  isExternal?: boolean | null
}

export interface ExternalWarehouseRefusal {
  code: 'external_default' | 'warehouse_holds_stock' | 'warehouse_in_use'
  message: string
  /** `warehouse_holds_stock`: how many articles it holds or has reserved. */
  articles?: number
  /** `warehouse_in_use`: what still names it, and how many of each. Only kinds above zero. */
  uses?: Partial<Record<WarehouseUse, number>>
}

/**
 * What can name a warehouse and later move stock there without passing a door that asks whether it is
 * external (#779). Each is counted only while it is live: a device or workstation not switched off, a
 * till session not closed, a count in progress, a reservation still active, an order not finished.
 */
export const WAREHOUSE_USES = [
  'fiscalDevices',
  'workstations',
  'tillSessions',
  'counts',
  'reservations',
  'supplierOrders',
  'customerOrders',
] as const
export type WarehouseUse = typeof WAREHOUSE_USES[number]

const USE_WORDS: Record<WarehouseUse, [string, string]> = {
  fiscalDevices: ['fiscal device', 'fiscal devices'],
  workstations: ['workstation', 'workstations'],
  tillSessions: ['open till session', 'open till sessions'],
  counts: ['count in progress', 'counts in progress'],
  reservations: ['active reservation', 'active reservations'],
  supplierOrders: ['open supplier order', 'open supplier orders'],
  customerOrders: ['open customer order', 'open customer orders'],
}

/** Why a warehouse cannot carry these flags together, or null. */
export function externalWarehouseRefusal(w: WarehouseFlags): ExternalWarehouseRefusal | null {
  if (w.isDefault && w.isExternal) {
    return {
      code: 'external_default',
      message: 'An external warehouse keeps no stock here, so it cannot be the default warehouse: choose one or the other.',
    }
  }
  return null
}

/** The flags a warehouse has after a save that names only some of them. */
export function flagsAfterSave(stored: WarehouseFlags | null | undefined, body: WarehouseFlags): Required<WarehouseFlags> {
  return {
    isDefault: !!(body.isDefault ?? stored?.isDefault),
    isExternal: !!(body.isExternal ?? stored?.isExternal),
  }
}

/** Whether a save turns a stock-keeping warehouse into an external one: the change that needs it empty. */
export function becomesExternal(stored: WarehouseFlags | null | undefined, next: WarehouseFlags): boolean {
  return !!next.isExternal && !stored?.isExternal
}

/** Why a warehouse that holds this many articles cannot become external, or null when it holds none. */
export function holdsStockRefusal(articles: number): ExternalWarehouseRefusal | null {
  if (!(articles > 0)) return null
  return {
    code: 'warehouse_holds_stock',
    message: `This warehouse holds or has reserved stock of ${articles} ${articles === 1 ? 'article' : 'articles'}: an external warehouse keeps none. Move the goods out or write them off first.`,
    articles,
  }
}

/**
 * Why a warehouse that something live still names cannot become external, or null when nothing does.
 * Each of them books a movement later (a count's completion, a till's sale, a reservation's dispatch, an
 * order's receipt) without asking again, and the engine would book nothing on the external side: the
 * document completes and no stock moves. So it is asked before the switch, as the goods are.
 */
export function inUseRefusal(counts: Partial<Record<WarehouseUse, number>>): ExternalWarehouseRefusal | null {
  const uses: Partial<Record<WarehouseUse, number>> = {}
  for (const kind of WAREHOUSE_USES) if ((counts[kind] ?? 0) > 0) uses[kind] = counts[kind]
  const kinds = Object.keys(uses) as WarehouseUse[]
  if (!kinds.length) return null
  const list = kinds.map(k => `${uses[k]} ${USE_WORDS[k][uses[k] === 1 ? 0 : 1]}`).join(', ')
  return {
    code: 'warehouse_in_use',
    message: `This warehouse is still named by ${list}: an external warehouse keeps no stock, so they would move none. Finish them or move them to another warehouse first.`,
    uses,
  }
}

/**
 * Whether the warehouse a movement names on one side is an external one, as the list, the page and
 * the print say it. Booked, the stock field (`fromWarehouseId` / `toWarehouseId`) names a warehouse whose
 * stock moved, and the external pair one that kept none. A draft names what the form chose in the
 * stock field, and that warehouse may be external now (`isExternalNow`).
 */
export function sideIsExternal(m: { status?: string }, stockId: unknown, externalId: unknown, isExternalNow: boolean): boolean {
  return stockId ? m.status === 'draft' && isExternalNow : !!externalId
}

/**
 * Which warehouses a list answers. Every picker asks without the parameter and gets the warehouses
 * that keep stock: an external one is never offered where a document books goods.
 */
export type ExternalScope = 'own' | 'include' | 'only'

export function externalScope(value: unknown): ExternalScope {
  return value === 'include' || value === 'only' ? value : 'own'
}
