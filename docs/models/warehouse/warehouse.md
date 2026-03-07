# Warehouse

## Entity Interface

```typescript
export interface IWarehouseAddress {
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

export interface IWarehouse extends TenantEntity {
  name: string
  code: string
  address?: IWarehouseAddress | string
  type: string
  manager?: string
  managerId?: string
  isDefault: boolean
  isActive: boolean
  tags?: string[]
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  address TEXT,
  type TEXT NOT NULL CHECK(type IN ('warehouse','store','production','transit')),
  manager TEXT,
  manager_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant identifier |
| name | string | Yes | - | Warehouse name |
| code | string | Yes | - | Short code, unique per org |
| address | IWarehouseAddress or string | No | - | Address as structured object or free-text string; stored as JSON TEXT in SQLite |
| type | string | Yes | - | One of: `warehouse`, `store`, `production`, `transit` |
| manager | string | No | - | Manager name (display) |
| managerId | string | No | - | Ref to User |
| isDefault | boolean | No | `false` | Whether this is the default warehouse for the org |
| isActive | boolean | No | `true` | Soft-delete flag |
| tags | string[] | No | `[]` | Freeform tags (JSON array in SQLite) |
| createdAt | Date | Yes | auto | Timestamp |
| updatedAt | Date | Yes | auto | Timestamp |

### IWarehouseAddress

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| street | string | Yes | Street address |
| city | string | Yes | City |
| state | string | No | State or province |
| postalCode | string | Yes | Postal/ZIP code |
| country | string | Yes | Country |

## Relationships

- **User** (managerId) -- optional warehouse manager
- **StockLevel** (warehouseId) -- stock levels tracked per warehouse
- **StockMovement** (fromWarehouseId, toWarehouseId) -- movements originate from or arrive at warehouses
- **InventoryCount** (warehouseId) -- counts are scoped to a warehouse

## API Endpoints (prefix: `/api/org/:orgId/warehouse/warehouse`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List warehouses (filters: `tags`; pagination: `page`, `size`, `sortBy`, `sortOrder`) |
| POST | `/` | Yes | Create warehouse |
| GET | `/:id` | Yes | Get warehouse by ID |
| PUT | `/:id` | Yes | Update warehouse |
| DELETE | `/:id` | Yes | Deactivate warehouse (soft delete -- sets `isActive: false`) |
