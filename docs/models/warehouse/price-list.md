# PriceList

## Entity Interface

```typescript
export interface IPriceListItem {
  id?: string
  productId: string
  price: number
  minQuantity?: number
  discount?: number
}

export interface IPriceList extends TenantEntity {
  name: string
  currency: string
  isDefault: boolean
  validFrom?: Date
  validTo?: Date
  items: IPriceListItem[]
  isActive: boolean
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS price_lists (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  is_default INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS price_list_items (
  id TEXT PRIMARY KEY,
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  price REAL NOT NULL,
  min_quantity REAL,
  discount REAL,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant identifier |
| name | string | Yes | - | Price list name, unique per org |
| currency | string | No | `'EUR'` | Currency code for all prices in this list |
| isDefault | boolean | No | `false` | Whether this is the default price list |
| validFrom | Date | No | - | Start of validity period |
| validTo | Date | No | - | End of validity period |
| items | IPriceListItem[] | No | `[]` | Price list entries (child table in SQLite) |
| isActive | boolean | No | `true` | Soft-delete flag |
| createdAt | Date | Yes | auto | Timestamp |
| updatedAt | Date | Yes | auto | Timestamp |

### IPriceListItem

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | No | Auto-generated |
| productId | string | Yes | Ref to Product |
| price | number | Yes | Price for this product in this list |
| minQuantity | number | No | Minimum quantity for this price tier |
| discount | number | No | Discount percentage |

## Relationships

- **Product** (items[].productId) -- products included in the price list

## API Endpoints (prefix: `/api/org/:orgId/warehouse/price-list`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List price lists (pagination: `page`, `size`, `sortBy`, `sortOrder`) |
| POST | `/` | Yes | Create price list |
| GET | `/:id` | Yes | Get price list by ID |
| PUT | `/:id` | Yes | Update price list |
| DELETE | `/:id` | Yes | Delete price list |
