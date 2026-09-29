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
