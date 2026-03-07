# InventoryCount

## Entity Interface

```typescript
export interface IInventoryCountLine {
  id?: string
  productId: string
  systemQuantity: number
  countedQuantity: number
  variance: number
  varianceCost: number
  notes?: string
}

export interface IInventoryCount extends TenantEntity {
  countNumber: string
  warehouseId: string
  date: Date
  status: string
  type: string
  lines: IInventoryCountLine[]
  adjustmentMovementId?: string
  completedBy?: string
  completedAt?: Date
  createdBy: string
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS inventory_counts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  count_number TEXT NOT NULL,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','cancelled')),
  type TEXT NOT NULL CHECK(type IN ('full','partial','cycle')),
  adjustment_movement_id TEXT,
  completed_by TEXT,
  completed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ic_org_wh ON inventory_counts(org_id, warehouse_id, date DESC);

CREATE TABLE IF NOT EXISTS inventory_count_lines (
  id TEXT PRIMARY KEY,
  inventory_count_id TEXT NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  system_quantity REAL NOT NULL,
  counted_quantity REAL NOT NULL,
  variance REAL NOT NULL,
  variance_cost REAL NOT NULL,
  notes TEXT,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant identifier |
| countNumber | string | Yes | auto-generated | Sequential number (format: `IC-YYYY-NNNNN`) |
| warehouseId | string | Yes | - | Ref to Warehouse being counted |
| date | Date | Yes | - | Date of the inventory count |
| status | string | Yes | `'in_progress'` | One of: `in_progress`, `completed`, `cancelled` |
| type | string | Yes | - | One of: `full`, `partial`, `cycle` |
| lines | IInventoryCountLine[] | Yes | - | Count line items (child table in SQLite) |
| adjustmentMovementId | string | No | - | Ref to StockMovement created for variance adjustment |
| completedBy | string | No | - | Ref to User who completed the count |
| completedAt | Date | No | - | Timestamp when count was completed |
| createdBy | string | Yes | - | Ref to User who created the count |
| createdAt | Date | Yes | auto | Timestamp |
| updatedAt | Date | Yes | auto | Timestamp |

### IInventoryCountLine

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | No | Auto-generated |
| productId | string | Yes | Ref to Product |
| systemQuantity | number | Yes | Expected quantity from system records |
| countedQuantity | number | Yes | Actual counted quantity |
| variance | number | Yes | Difference (countedQuantity - systemQuantity) |
| varianceCost | number | Yes | Cost impact of the variance |
| notes | string | No | Notes for the line item |

## Relationships

- **Warehouse** (warehouseId) -- the warehouse where the count takes place
- **Product** (lines[].productId) -- products being counted
- **StockMovement** (adjustmentMovementId) -- auto-created adjustment movement when count is completed with variances
- **User** (createdBy) -- user who initiated the count
- **User** (completedBy) -- user who completed the count

## API Endpoints (prefix: `/api/org/:orgId/warehouse/inventory-count`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List inventory counts (filters: `productId`; pagination: `page`, `size`, `sortBy`, `sortOrder`). Response enriches records with `warehouseName`, `itemCount`, `varianceCount`. |
| POST | `/` | Yes | Create inventory count (`countNumber` auto-generated, `createdBy` set from authenticated user) |
| GET | `/:id` | Yes | Get inventory count by ID (lines enriched with `productName`, `productSku`) |
| PUT | `/:id` | Yes | Update inventory count |
| DELETE | `/:id` | Yes | Delete inventory count |
| POST | `/:id/complete` | Yes | Complete the count -- if variances exist, creates an adjustment StockMovement (type `adjustment`) and confirms it to update stock levels; updates `lastCountDate` on relevant StockLevel records |
