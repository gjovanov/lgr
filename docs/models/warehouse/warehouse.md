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
  /** Another site's warehouse: it keeps no stock here (`config/external-warehouse`). */
  isExternal?: boolean
  isActive: boolean
  tags?: string[]
}
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
| isExternal | boolean | No | `false` | Another site's warehouse, named here so a transfer can say where the goods went or came from. It keeps no stock in this org: no movement books a level or a cost layer on it. Never together with `isDefault` |
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
- **StockMovement** (externalFromWarehouseId, externalToWarehouseId) -- an external warehouse a completed transfer named: no stock moved there
- **InventoryCount** (warehouseId) -- counts are scoped to a warehouse

## External warehouses

The rules are pure functions in `packages/config/src/external-warehouse.ts`, shared by the form and the server.

- A warehouse is never both default and external: 422 `{ code: 'external_default' }`.
- A warehouse does not become external while a `StockLevel` of it has `quantity != 0` or `reservedQuantity > 0`: 422 `{ code: 'warehouse_holds_stock', articles }`, where `articles` is how many it holds or has reserved. External back to stock-keeping is always allowed.
- Nor while something live still names it (#779): an active fiscal device or workstation, a till session not closed, a count in progress, an active reservation, a supplier order not yet received (its header or any allocation), a customer order not yet delivered (its preferred warehouse). 422 `{ code: 'warehouse_in_use', uses }`, where `uses` counts each kind above zero. Each of these books a movement later without asking again, and the engine would book nothing on the external side. Counted by `liveUsesOf` in `packages/services/src/biz/external-warehouses.ts`. Asked after the goods.
- Only a transfer names one, with a warehouse of the org's own on the other side (see [StockMovement](stock-movement.md)).
- The server's "default, else first warehouse" fallbacks skip external warehouses.

## API Endpoints (prefix: `/api/org/:orgId/warehouse/warehouse`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List warehouses (filters: `tags`, `external`; pagination: `page`, `size`, `sortBy`, `sortOrder`). Without `external` the list answers only the warehouses that keep stock, which is what every picker asks for; `external=include` answers all, `external=only` the external ones |
| POST | `/` | Yes | Create warehouse. Default and external together answers 422 `external_default` |
| GET | `/:id` | Yes | Get warehouse by ID |
| PUT | `/:id` | Yes | Update warehouse, judged as it would stand after the save: 422 `external_default`, 422 `warehouse_holds_stock` when it would become external while it holds or has reserved stock, or 422 `warehouse_in_use` while something live names it |
| DELETE | `/:id` | Yes | Deactivate warehouse (soft delete -- sets `isActive: false`) |
