/**
 * FR-28.37 — the node model of an order's allocations and reservations.
 *
 * PURE: no Vue, no I18n, no access to the store. A screen hands in its state (the lines and
 * allocations as edited, the reservations the server returned, the changes staged on the form) and
 * gets back nodes and figures. Three screens draw the same tree (the supplier order, the customer
 * order, the reservation page), so what a row says and what a parent adds up to is decided here, once.
 *
 * Only types in this file: it costs nothing at run time.
 */
import type { CoverageStatus } from 'config/order-coverage'

/** What a row is. A `placeholder` stands where something is missing (or is being added) under a parent. */
export type TreeNodeKind = 'line' | 'allocation' | 'reservation' | 'placeholder'

/**
 * Something about a row a person should notice, shown on the row and rolled up to its closed parents.
 * `unallocated` is information (a new line always starts with it) and does not open anything; the
 * others are the order's own state of repair and do. `overReserved` is a customer-order line holding more
 * than it needs (a quantity edited down below what is reserved), and `late` a reservation whose supplier order
 * is expected after the date the customer asked for.
 */
export type TreeFlag = 'overAllocated' | 'overReserved' | 'unallocated' | 'new' | 'changed' | 'cancelledOnSave' | 'late'

/**
 * What can be done to a row; the screen draws a control for each one it is given and acts on it.
 * The supplier order's are `addWarehouse` .. `undo` (staged, saved with the order); the customer order acts at once:
 * `reserve` (a menu on a line), and `editQuantity`, `release` and `reserveAgain` on a reservation.
 */
export type TreeActionType =
  | 'addWarehouse' | 'addClient' | 'remove' | 'changeClient' | 'cancel' | 'undo'
  | 'reserve' | 'editQuantity' | 'release' | 'reserveAgain'
export interface TreeAction {
  type: TreeActionType
  /** Offered, but not now: a warehouse with nothing free cannot take a client. */
  disabled?: boolean
}

/** The figures of §2.6, one set for every kind of row. `null` where a column has no meaning for the row. */
export interface TreeFigures {
  /** Ordered (line), allocated to this warehouse (allocation), reserved for this client (reservation). */
  quantity: number
  /** Held for clients on this row or below it. A reservation's own figure is what it holds. */
  reserved: number
  /** Line: ordered − allocated. Allocation: allocated − reserved. A reservation has none. */
  free: number | null
  /** On the line, or into this warehouse. A reservation has none. */
  received: number | null
  invoiced: number
  dispatched: number
}

/** A reservation as the form has it: the saved one with the changes staged on it, or one staged to be made. */
export interface ReservationRow {
  /** Stable across a save? No: a staged create has a client key until it is saved. */
  key: string
  resId?: string
  /** Set on a reservation staged to be created. */
  createKey?: string
  number?: string
  status?: string
  contactId: string
  quantity: number
  invoiced: number
  dispatched: number
  /** What a cancel cannot take back: the larger of what is invoiced and what is dispatched. */
  consumed: number
  internalOrderId?: string
  /** Staged to be cancelled on save. */
  cancelled: boolean
  /** Its quantity or client is staged to change. */
  changed: boolean
  editable: boolean
  cancellable: boolean
  canChangeClient: boolean
  // ── what a customer order and the reservation page say of it (the supplier order's rows leave these out) ──
  /** Held on free stock, or on a supplier order's warehouse. */
  source?: 'stock' | 'order'
  warehouseId?: string
  /** The supplier order it sits on, its line and its warehouse (an allocation): a link to them opens that line. */
  orderId?: string
  orderLineId?: string
  allocationId?: string
  /** The line of the customer order it serves: a link to that order opens it. */
  internalOrderLineId?: string
  /** When its supplier order is expected, and whether that is after the date the customer asked for. */
  expectedDate?: string
  late?: boolean
}

/** How far a customer-order line is covered: `config/order-coverage`, and what of it waits on a supplier order not sent. */
export interface NodeCoverage {
  status: CoverageStatus
  onUnsentOrder: number
}

export interface TreeNode {
  /** Stable while the row is the same row, so open state and focus follow it: `l:`, `a:`, `r:`, `ph:`, `ed:` + id or client key. */
  id: string
  parentId?: string
  kind: TreeNodeKind
  /** 0 line, 1 allocation, 2 reservation (a customer order has two levels: its reservations are depth 1). */
  depth: number
  /** The article, the warehouse or the client: what the person reads first. Empty on a placeholder. */
  label: string
  figures: TreeFigures
  /** A reservation's own status, as the server has it. */
  status?: string
  /** This row's own flags. */
  flags: TreeFlag[]
  /** Its own flags and those of everything below it: what a closed parent still says. */
  rolledFlags: TreeFlag[]
  actions: TreeAction[]
  /** Open on its own: it holds live reservations, or something below it needs a look. */
  defaultOpen: boolean
  children: TreeNode[]
  /** What a placeholder stands for. */
  placeholderOf?: 'allocation' | 'reservation'
  /** A placeholder that is the inline row adding one, not the muted "none yet" line. */
  editing?: boolean
  /** Where the row's data lives in the form, so the screen can edit it. */
  source: {
    groupIndex: number
    lineIndex?: number
    allocationIndex?: number
  }
  /** A reservation node's own row. */
  reservation?: ReservationRow
  /** A customer-order line's coverage: what the chip on its row says. */
  coverage?: NodeCoverage
}

// ── inputs ─────────────────────────────────────────────────────────────────────────────────────

/** `_key` names an allocation before it is saved, so a reservation staged on it can point at it. */
export interface AllocationInput {
  _id?: string
  _key?: string
  warehouseId: string
  quantity: number
  receivedQuantity?: number
}

export interface LineInput {
  _id?: string
  /** A line not saved yet has only this. */
  _key?: string
  productId?: string
  description: string
  quantity: number
  receivedQuantity?: number
  allocations: AllocationInput[]
}

export interface GroupInput {
  _id?: string
  supplierId?: string
  lines: LineInput[]
}

/** What the server returns for a reservation of the order (cancelled ones too). */
export interface ServerReservation {
  _id: string
  reservationNumber?: string
  status: string
  contactId: string
  quantity: number
  invoicedQuantity?: number
  dispatchedQuantity?: number
  allocationId?: string
  internalOrderId?: string
  // ── what the customer order and the reservation page read besides ──
  internalOrderLineId?: string
  source?: 'stock' | 'order'
  warehouseId?: string
  orderId?: string
  /** The line of the supplier order it sits on. */
  lineId?: string
  expectedDate?: string | Date | null
  /** The client's name, where the server says it (the reservation page); a screen's own labels say it otherwise. */
  contactName?: string
}

export interface StagedCreate {
  key: string
  alloc: { id?: string; key?: string }
  contactId: string
  quantity: number
  repeatOf?: string
}

/** The reservation changes staged on the form and saved with the order (`reservationChanges`). */
export interface StagedChanges {
  creates: StagedCreate[]
  updates: Record<string, { quantity?: number; contactId?: string }>
  cancels: string[]
}

/** A column of the tree: every row of every kind has a cell under each, in this order. */
export interface TreeColumn {
  key: string
  title: string
  /** What the header says when the pointer rests on it (a figure that means something different on each level). */
  hint?: string
  align?: 'start' | 'end' | 'center'
  /** CSS width of the column; none: it takes what is left. */
  width?: string
  /** Left out while the table would otherwise scroll sideways; the screen says its figure another way (`columns.ts`). */
  optional?: boolean
}

export interface FigureInput {
  reservations: ServerReservation[]
  staged: StagedChanges
  readonly: boolean
}

export interface TreeLabels {
  warehouse(id: string): string
  contact(id: string): string
}

/** A row being added under a parent (the inline `+ Warehouse` / `+ Client` row). */
export interface AddingRow {
  parentId: string
  kind: 'allocation' | 'reservation'
}

export interface GroupFigures {
  lines: number
  ordered: number
  allocated: number
  reserved: number
  received: number
  invoiced: number
  dispatched: number
}

export interface SupplierGroupTree {
  index: number
  id: string
  /** The group's lines. */
  nodes: TreeNode[]
  figures: GroupFigures
}

export interface SupplierOrderTree {
  groups: SupplierGroupTree[]
  /** What the Totals card shows: the groups added up. */
  totals: GroupFigures
  /** Every node by id, for finding a row from where it was clicked or linked to. */
  index: Map<string, TreeNode>
}

// ── the customer order (ORDI): lines and their reservations, two levels ─────────────────────────

/** A line of a customer order as the form has it, with the changes typed since it was loaded. */
export interface CustomerLineInput {
  _id?: string
  productId?: string
  description: string
  quantity: number
}

/** What the server derives per saved line and nothing on the form can: the invoices and deliveries against it. */
export interface CustomerLineServerFigures {
  /** Of what the line holds, what waits on a supplier order not sent yet (FR-22.44). */
  onUnsentOrder: number
  invoiced: number
  delivered: number
}

export interface CustomerOrderTotals {
  lines: number
  ordered: number
  reserved: number
  /** What is still short: the lines' short quantities added up. */
  short: number
  invoiced: number
  delivered: number
}

export interface CustomerOrderTree {
  /** The lines, in the order of the form. */
  nodes: TreeNode[]
  totals: CustomerOrderTotals
  index: Map<string, TreeNode>
}

// ── the reservation page: where a reservation sits ──────────────────────────────────────────────

/** What the server says about the supply a reservation hangs on (`detail.supply` of `GET /reservations/:id`). */
export interface SupplyInput {
  kind: 'order' | 'stock'
  /** An order's line and every warehouse (allocation) it was given. */
  line?: { _id: string; description: string; quantity: number; receivedQuantity: number }
  allocations?: Array<{ _id: string; warehouseId: string; warehouseName: string; quantity: number; receivedQuantity: number }>
  /** Free stock in one warehouse: what is on the shelf, and what a new reservation could still take. */
  warehouse?: { _id: string; name: string; onHand: number; available: number }
  /** The reservations on it, this one among them. */
  reservations: ServerReservation[]
}
