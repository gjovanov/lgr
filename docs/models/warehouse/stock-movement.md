# StockMovement

## Entity Interface

```typescript
export interface IStockMovementLine {
  id?: string
  productId: string
  quantity: number
  unitCost: number
  totalCost: number
  batchNumber?: string
  expiryDate?: Date
  serialNumbers?: string[]
}

export interface IStockMovement extends TenantEntity {
  /** The mirror that took its stock back when its document was removed. It stays `completed`. */
  reversedBy?: string
  reversedAt?: Date
  movementNumber: string
  type: string
  status: string
  date: Date
  fromWarehouseId?: string
  toWarehouseId?: string
  /** The external warehouse a completed movement named on a side: no stock moved there. */
  externalFromWarehouseId?: string
  externalToWarehouseId?: string
  contactId?: string
  invoiceId?: string
  productionOrderId?: string
  lines: IStockMovementLine[]
  totalAmount: number
  notes?: string
  journalEntryId?: string
  createdBy: string
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant identifier |
| movementNumber | string | Yes | auto-generated | Sequential number (format: `SM-YYYY-NNNNN`) |
| type | string | Yes | - | One of: `receipt`, `dispatch`, `transfer`, `adjustment`, `return`, `production_in`, `production_out` |
| status | string | Yes | `'draft'` | One of: `draft`, `confirmed`, `completed`, `cancelled` |
| date | Date | Yes | now | Movement date |
| fromWarehouseId | string | No | - | Ref to Warehouse (source). On a completed movement: a warehouse whose stock it took out |
| toWarehouseId | string | No | - | Ref to Warehouse (destination). On a completed movement: a warehouse whose stock it added to |
| externalFromWarehouseId | string | No | - | Ref to an external Warehouse the goods came from. Set when the movement is completed; a draft keeps the form's choice in `fromWarehouseId` |
| externalToWarehouseId | string | No | - | Ref to an external Warehouse the goods went to. Set when the movement is completed; a draft keeps the form's choice in `toWarehouseId` |
| contactId | string | No | - | Ref to Contact (supplier/customer) |
| invoiceId | string | No | - | Ref to Invoice (linked invoice) |
| productionOrderId | string | No | - | Ref to ProductionOrder (ERP cross-module) |
| lines | IStockMovementLine[] | Yes | - | Movement line items (child table in SQLite) |
| totalAmount | number | Yes | `0` | Sum total of all line costs |
| notes | string | No | - | Free-text notes |
| journalEntryId | string | No | - | Ref to JournalEntry (accounting cross-module) |
| createdBy | string | Yes | - | Ref to User who created the movement |
| createdAt | Date | Yes | auto | Timestamp |
| updatedAt | Date | Yes | auto | Timestamp |

### IStockMovementLine

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | No | Auto-generated |
| productId | string | Yes | Ref to Product |
| quantity | number | Yes | Quantity moved |
| unitCost | number | Yes | Cost per unit |
| totalCost | number | Yes | Line total (quantity x unitCost) |
| batchNumber | string | No | Batch/lot number for traceability |
| expiryDate | Date | No | Expiry date (for perishable goods) |
| serialNumbers | string[] | No | Serial numbers for serialized items |

## Relationships

- **Warehouse** (fromWarehouseId) -- source warehouse (for dispatch, transfer)
- **Warehouse** (toWarehouseId) -- destination warehouse (for receipt, transfer)
- **Warehouse** (externalFromWarehouseId, externalToWarehouseId) -- the external warehouse on a transfer's other side
- **Product** (lines[].productId) -- products being moved
- **Contact** (contactId) -- supplier or customer associated with the movement
- **Invoice** (invoiceId) -- linked invoice (e.g., purchase receipt from invoice)
- **ProductionOrder** (productionOrderId) -- linked production order (cross-module with ERP)
- **JournalEntry** (journalEntryId) -- linked accounting entry (cross-module with Accounting)
- **User** (createdBy) -- user who created the movement
- **InventoryCount** -- adjustment movements are auto-created when completing inventory counts with variances

## Costs between two of the org's own warehouses

A movement that books both sides (a transfer between two warehouses that keep stock) moves goods that are already valued (#778). On confirm the goods arrive at what they cost where they left: the source level's average for a weighted-average article, the cost of the layers consumed for FIFO/LIFO/FEFO, the standard cost for a standard one. The line's `unitCost` is only what the form showed; `resolvedUnitCost` records what was booked. The org's stock value is the same before and after. Only a source with no level to consume from (the goods went below zero there) falls back to the line's cost.

## External warehouses

A warehouse marked `isExternal` (see [Warehouse](warehouse.md)) is another site's: it keeps no stock in this org.

- Only a `transfer` names one, with a warehouse of the org's own on the other side. Any other type naming one answers 422 `{ code: 'external_warehouse_not_transfer' }`; a transfer with no warehouse of the org's own answers 422 `{ code: 'transfer_without_own_warehouse' }`. The rule is `movementWarehouseRefusal` in `packages/config/src/movement-warehouses.ts`.
- Confirming books the org's own side only: a transfer to an external warehouse takes the goods out of the From warehouse, a transfer from one brings them into the To warehouse at the line's cost. No level and no cost layer is written for the external one.
- **On a completed movement `fromWarehouseId` / `toWarehouseId` name only warehouses whose stock it moved.** The id of the external warehouse moves to `externalFromWarehouseId` / `externalToWarehouseId` when the movement is completed. A reader that wants the other side of a transfer reads `fromWarehouseId || externalFromWarehouseId` (and the same for To).
- The flag is read when the movement is written and again when it is confirmed. A draft does not remember it.

## API Endpoints (prefix: `/api/org/:orgId/warehouse/movement`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List movements (filters: `type`, `status`, `warehouseId`, `productId`, `dateFrom`, `dateTo`; pagination: `page`, `size`, `sortBy`, `sortOrder`). Response enriches records with `fromWarehouseName`, `toWarehouseName`, `contactName`, and with `fromExternal` / `toExternal` (whether that side is an external warehouse). `warehouseId` and the two name sorts also read the external pair. |
| POST | `/` | Yes | Create movement (status defaults to `draft`; `movementNumber` auto-generated if not provided). A `dispatch` naming To, a `receipt` naming From, a `transfer` naming To with no From or an `adjustment` naming both answers 422 (FR-22.31b). So does an external warehouse on anything but a transfer, and a transfer with no warehouse of the org's own |
| GET | `/:id` | Yes | Get movement by ID (lines enriched with `productName`, `productSku`; `fromExternal` / `toExternal` say which side is an external warehouse) |
| GET | `/:id/export` | Yes | The movement as a printed document: a PDF named `<movementNumber>.pdf` (query: `locale`). It carries no price and no total. 404 when the org has no such movement, 503 when the renderer fails |
| PUT | `/:id` | Yes | Update movement (only allowed when status is `draft`). `fromWarehouseId` / `toWarehouseId` / `contactId` take `null` to clear; left out, they stay. Judged as the movement would stand after the edit |
| POST | `/:id/confirm` | Yes | Confirm a draft movement -- triggers stock level updates via the warehouse business service. Refuses a draft whose warehouses do not fit its type (422), reading the external flag as it is now |
