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
  movementNumber: string
  type: string
  status: string
  date: Date
  fromWarehouseId?: string
  toWarehouseId?: string
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
| fromWarehouseId | string | No | - | Ref to Warehouse (source) |
| toWarehouseId | string | No | - | Ref to Warehouse (destination) |
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
- **Product** (lines[].productId) -- products being moved
- **Contact** (contactId) -- supplier or customer associated with the movement
- **Invoice** (invoiceId) -- linked invoice (e.g., purchase receipt from invoice)
- **ProductionOrder** (productionOrderId) -- linked production order (cross-module with ERP)
- **JournalEntry** (journalEntryId) -- linked accounting entry (cross-module with Accounting)
- **User** (createdBy) -- user who created the movement
- **InventoryCount** -- adjustment movements are auto-created when completing inventory counts with variances

## API Endpoints (prefix: `/api/org/:orgId/warehouse/movement`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List movements (filters: `type`, `status`, `warehouseId`, `productId`, `dateFrom`, `dateTo`; pagination: `page`, `size`, `sortBy`, `sortOrder`). Response enriches records with `fromWarehouseName`, `toWarehouseName`, `contactName`. |
| POST | `/` | Yes | Create movement (status defaults to `draft`; `movementNumber` auto-generated if not provided) |
| GET | `/:id` | Yes | Get movement by ID (lines enriched with `productName`, `productSku`) |
| PUT | `/:id` | Yes | Update movement (only allowed when status is `draft`) |
| POST | `/:id/confirm` | Yes | Confirm a draft movement -- triggers stock level updates via the warehouse business service |
