# ProductionOrder

## Entity Interface

```typescript
interface IQualityCheck {
  parameter: string
  expected: string
  actual: string
  passed: boolean
}

interface IProductionStage {
  name: string
  order: number
  status: string           // 'pending' | 'in_progress' | 'completed' | 'skipped'
  plannedDuration: number
  actualDuration?: number
  assignedTo?: Types.ObjectId
  startedAt?: Date
  completedAt?: Date
  notes?: string
  qualityChecks?: IQualityCheck[]
}

interface IMaterialConsumed {
  productId: Types.ObjectId
  plannedQuantity: number
  actualQuantity: number
  wastage: number
  movementId?: Types.ObjectId
}

export interface IProductionOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  orderNumber: string
  bomId: Types.ObjectId
  productId: Types.ObjectId
  quantity: number
  warehouseId: Types.ObjectId
  outputWarehouseId: Types.ObjectId
  status: string           // 'planned' | 'in_progress' | 'quality_check' | 'completed' | 'cancelled'
  priority: string         // 'low' | 'normal' | 'high' | 'urgent'
  plannedStartDate: Date
  plannedEndDate: Date
  actualStartDate?: Date
  actualEndDate?: Date
  stages: IProductionStage[]
  materialsConsumed: IMaterialConsumed[]
  quantityProduced: number
  quantityDefective: number
  totalCost: number
  costPerUnit: number
  notes?: string
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS production_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  order_number TEXT NOT NULL,
  bom_id TEXT NOT NULL REFERENCES bill_of_materials(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  output_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','quality_check','completed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  planned_start_date TEXT NOT NULL,
  planned_end_date TEXT NOT NULL,
  actual_start_date TEXT,
  actual_end_date TEXT,
  quantity_produced REAL NOT NULL DEFAULT 0,
  quantity_defective REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  cost_per_unit REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, order_number)
);
CREATE INDEX IF NOT EXISTS idx_po_org_status ON production_orders(org_id, status, planned_start_date);
CREATE INDEX IF NOT EXISTS idx_po_org_product ON production_orders(org_id, product_id);

CREATE TABLE IF NOT EXISTS production_stages (
  id TEXT PRIMARY KEY,
  production_order_id TEXT NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','skipped')),
  planned_duration REAL NOT NULL,
  actual_duration REAL,
  assigned_to TEXT,
  started_at TEXT,
  completed_at TEXT,
  notes TEXT,
  quality_checks TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS materials_consumed (
  id TEXT PRIMARY KEY,
  production_order_id TEXT NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  planned_quantity REAL NOT NULL,
  actual_quantity REAL NOT NULL DEFAULT 0,
  wastage REAL NOT NULL DEFAULT 0,
  movement_id TEXT,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| orderNumber | string | Yes | - | Unique production order number within the organization |
| bomId | ObjectId | Yes | - | References the BillOfMaterials used for production |
| productId | ObjectId | Yes | - | References the Product being manufactured |
| quantity | number | Yes | - | Target production quantity |
| warehouseId | ObjectId | Yes | - | Source warehouse for raw materials |
| outputWarehouseId | ObjectId | Yes | - | Destination warehouse for finished goods |
| status | string | Yes | `'planned'` | State machine: `planned` -> `in_progress` -> `quality_check` -> `completed`; `cancelled` from any state |
| priority | string | Yes | `'normal'` | Priority: `low`, `normal`, `high`, `urgent` |
| plannedStartDate | Date | Yes | - | Scheduled start date |
| plannedEndDate | Date | Yes | - | Scheduled end date |
| actualStartDate | Date | No | - | Actual start date |
| actualEndDate | Date | No | - | Actual end date |
| stages | IProductionStage[] | No | `[]` | Production stages (child table: `production_stages`) |
| materialsConsumed | IMaterialConsumed[] | No | `[]` | Materials consumed during production (child table: `materials_consumed`) |
| quantityProduced | number | Yes | `0` | Quantity successfully produced |
| quantityDefective | number | Yes | `0` | Quantity of defective output |
| totalCost | number | Yes | `0` | Total production cost |
| costPerUnit | number | Yes | `0` | Cost per unit produced |
| notes | string | No | - | Free-text notes |
| createdBy | ObjectId | Yes | - | User who created the order |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **References**: `bomId` -> `BillOfMaterials`, `productId` -> `Product`, `warehouseId` -> `Warehouse`, `outputWarehouseId` -> `Warehouse`, `createdBy` -> `User`, `stages[].assignedTo` -> `Employee`, `materialsConsumed[].productId` -> `Product`, `materialsConsumed[].movementId` -> `StockMovement`
- **Referenced by**: None

## Cross-Module Dependencies

- **ERP -> Warehouse**: When a production order is completed, stock movements are created to consume raw materials and produce finished goods. This is handled via cross-app events (`production.completed`).

## Indexes

- `(orgId, orderNumber)` -- unique
- `(orgId, status, plannedStartDate)`
- `(orgId, productId)`

## API Endpoints (prefix: `/api/org/:orgId/erp/production-order`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List production orders (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`, `status`. |
| POST | `/` | Yes | Create production order. |
| GET | `/:id` | Yes | Get single production order by ID. |
| PUT | `/:id` | Yes | Update production order (advance stages, record output). |
| DELETE | `/:id` | Yes | Delete production order (only if status is `planned`). |
