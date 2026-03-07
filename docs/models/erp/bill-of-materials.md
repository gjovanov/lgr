# BillOfMaterials

## Entity Interface

```typescript
interface IBOMMaterial {
  productId: Types.ObjectId
  quantity: number
  unit: string
  wastagePercent: number
  cost: number
  notes?: string
}

export interface IBillOfMaterials extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  productId: Types.ObjectId
  name: string
  version: string
  status: string           // 'draft' | 'active' | 'obsolete'
  materials: IBOMMaterial[]
  laborHours: number
  laborCostPerHour: number
  overheadCost: number
  totalMaterialCost: number
  totalCost: number
  instructions?: string
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS bill_of_materials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','obsolete')),
  labor_hours REAL NOT NULL,
  labor_cost_per_hour REAL NOT NULL,
  overhead_cost REAL NOT NULL DEFAULT 0,
  total_material_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  instructions TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bom_org_product ON bill_of_materials(org_id, product_id);

CREATE TABLE IF NOT EXISTS bom_materials (
  id TEXT PRIMARY KEY,
  bom_id TEXT NOT NULL REFERENCES bill_of_materials(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  wastage_percent REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL,
  notes TEXT,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| productId | ObjectId | Yes | - | References the finished Product this BOM produces |
| name | string | Yes | - | BOM name / description |
| version | string | Yes | - | Version identifier (e.g., "1.0", "v2") |
| status | string | Yes | `'draft'` | BOM status: `draft`, `active`, `obsolete` |
| materials | IBOMMaterial[] | No | `[]` | List of input materials (child table: `bom_materials`) |
| materials[].productId | ObjectId | Yes | - | References the raw material Product |
| materials[].quantity | number | Yes | - | Required quantity |
| materials[].unit | string | Yes | - | Unit of measure (e.g., "kg", "pcs") |
| materials[].wastagePercent | number | No | `0` | Expected wastage percentage |
| materials[].cost | number | Yes | - | Cost per unit of material |
| materials[].notes | string | No | - | Notes about the material |
| laborHours | number | Yes | - | Total labor hours required |
| laborCostPerHour | number | Yes | - | Cost per labor hour |
| overheadCost | number | Yes | `0` | Additional overhead costs |
| totalMaterialCost | number | Yes | `0` | Sum of all material costs |
| totalCost | number | Yes | `0` | Total cost (materials + labor + overhead) |
| instructions | string | No | - | Manufacturing instructions |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **References**: `productId` -> `Product`, `materials[].productId` -> `Product`
- **Referenced by**: `ProductionOrder.bomId`

## Indexes

- `(orgId, productId)`

## API Endpoints (prefix: `/api/org/:orgId/erp/bom`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List BOMs (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. |
| POST | `/` | Yes | Create BOM with materials. |
| GET | `/:id` | Yes | Get single BOM by ID. |
| PUT | `/:id` | Yes | Update BOM. |
| DELETE | `/:id` | Yes | Delete BOM. Blocked if production orders reference it. |
