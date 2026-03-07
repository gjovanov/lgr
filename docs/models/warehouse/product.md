# Product

## Entity Interface

```typescript
export interface IProductDimensions {
  length: number
  width: number
  height: number
  unit: string
}

export interface IProductCustomPrice {
  id?: string
  contactId: string
  price: number
  minQuantity?: number
  validFrom?: Date
  validTo?: Date
}

export interface IProductVariant {
  id?: string
  name: string
  options: string[]
}

export interface IProduct extends TenantEntity {
  sku: string
  barcode?: string
  name: string
  description?: string
  category: string
  type: string
  unit: string
  purchasePrice: number
  sellingPrice: number
  currency: string
  taxRate: number
  revenueAccountId?: string
  expenseAccountId?: string
  inventoryAccountId?: string
  trackInventory: boolean
  minStockLevel?: number
  maxStockLevel?: number
  weight?: number
  dimensions?: IProductDimensions
  images?: string[]
  customPrices: IProductCustomPrice[]
  variants?: IProductVariant[]
  tags?: string[]
  isActive: boolean
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  sku TEXT NOT NULL,
  barcode TEXT,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('goods','service','raw_material','finished_product')),
  unit TEXT NOT NULL,
  purchase_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  tax_rate REAL NOT NULL DEFAULT 0,
  revenue_account_id TEXT,
  expense_account_id TEXT,
  inventory_account_id TEXT,
  track_inventory INTEGER NOT NULL DEFAULT 1,
  min_stock_level REAL,
  max_stock_level REAL,
  weight REAL,
  dimensions TEXT,
  images TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_products_org_barcode ON products(org_id, barcode);
CREATE INDEX IF NOT EXISTS idx_products_org_category ON products(org_id, category);
CREATE INDEX IF NOT EXISTS idx_products_org_tags ON products(org_id, tags);

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  name, description, sku, barcode, category,
  content='products', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS product_custom_prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  price REAL NOT NULL,
  min_quantity REAL,
  valid_from TEXT,
  valid_to TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant identifier |
| sku | string | Yes | - | Stock keeping unit, unique per org |
| barcode | string | No | - | Product barcode |
| name | string | Yes | - | Product name (text-indexed for search) |
| description | string | No | - | Product description |
| category | string | Yes | - | Product category |
| type | string | Yes | - | One of: `goods`, `service`, `raw_material`, `finished_product` |
| unit | string | Yes | - | Unit of measure (e.g., pcs, kg, m) |
| purchasePrice | number | No | `0` | Purchase/cost price |
| sellingPrice | number | No | `0` | Default selling price |
| currency | string | No | `'EUR'` | Price currency code |
| taxRate | number | No | `0` | Tax rate percentage |
| revenueAccountId | string | No | - | Ref to Account (revenue) |
| expenseAccountId | string | No | - | Ref to Account (expense) |
| inventoryAccountId | string | No | - | Ref to Account (inventory) |
| trackInventory | boolean | No | `true` | Whether stock levels are tracked |
| minStockLevel | number | No | - | Minimum stock level for reorder alerts |
| maxStockLevel | number | No | - | Maximum stock level |
| weight | number | No | - | Product weight |
| dimensions | IProductDimensions | No | - | JSON object: `{ length, width, height, unit }` |
| images | string[] | No | `[]` | Array of image URLs |
| customPrices | IProductCustomPrice[] | No | `[]` | Per-contact custom pricing (child table in SQLite) |
| variants | IProductVariant[] | No | `[]` | Product variants (child table in SQLite) |
| tags | string[] | No | `[]` | Freeform tags (JSON array in SQLite) |
| isActive | boolean | No | `true` | Soft-delete flag |
| createdAt | Date | Yes | auto | Timestamp |
| updatedAt | Date | Yes | auto | Timestamp |

### IProductCustomPrice

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | No | Auto-generated |
| contactId | string | Yes | Ref to Contact |
| price | number | Yes | Custom price for this contact |
| minQuantity | number | No | Minimum quantity for price to apply |
| validFrom | Date | No | Start of validity period |
| validTo | Date | No | End of validity period |

### IProductVariant

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | No | Auto-generated |
| name | string | Yes | Variant name (e.g., "Color") |
| options | string[] | Yes | Variant values (e.g., ["Red", "Blue"]) |

## Relationships

- **Account** (revenueAccountId, expenseAccountId, inventoryAccountId) -- optional links to chart of accounts
- **Contact** (customPrices[].contactId) -- contacts with custom pricing
- **StockLevel** -- one StockLevel per product-warehouse pair
- **StockMovement** (lines[].productId) -- movement lines reference products
- **InventoryCount** (lines[].productId) -- count lines reference products
- **PriceList** (items[].productId) -- price list items reference products

## API Endpoints (prefix: `/api/org/:orgId/warehouse/product`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List products (filters: `category`, `type`, `search`, `tags`; pagination: `page`, `size`, `sortBy`, `sortOrder`) |
| POST | `/` | Yes | Create product |
| GET | `/:id` | Yes | Get product by ID |
| PUT | `/:id` | Yes | Update product |
| DELETE | `/:id` | Yes | Deactivate product (soft delete -- sets `isActive: false`) |
