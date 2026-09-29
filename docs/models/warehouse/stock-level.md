# StockLevel

## Entity Interface

```typescript
export interface IStockLevel extends TenantEntity {
  productId: string
  warehouseId: string
  quantity: number
  reservedQuantity: number
  availableQuantity: number
  avgCost: number
  lastCountDate?: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant identifier |
| productId | string | Yes | - | Ref to Product |
| warehouseId | string | Yes | - | Ref to Warehouse |
| quantity | number | Yes | `0` | Total physical quantity on hand |
| reservedQuantity | number | No | `0` | Quantity reserved (e.g., for pending orders) |
| availableQuantity | number | Yes | `0` | Quantity available (quantity - reservedQuantity) |
| avgCost | number | Yes | `0` | Weighted average cost per unit |
| lastCountDate | Date | No | - | Date of the last physical inventory count |
| createdAt | Date | Yes | auto | Timestamp |
| updatedAt | Date | Yes | auto | Timestamp |

## Relationships

- **Product** (productId) -- the product whose stock is being tracked
- **Warehouse** (warehouseId) -- the warehouse where the stock is held
- Unique constraint on `(orgId, productId, warehouseId)` -- one record per product-warehouse pair per tenant

## API Endpoints (prefix: `/api/org/:orgId/warehouse/stock-level`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List stock levels (filters: `warehouseId`, `productId`, `category`, `search`, `tags`; pagination: `page`, `size`, `sortBy`, `sortOrder`). Response enriches each record with `productSku`, `productName`, `warehouseName` via manual lookups. |

Note: StockLevel records are not created or updated directly via the API. They are managed automatically by the warehouse business service when stock movements are confirmed.
