# FixedAsset

## Entity Interface

```typescript
export interface IDepreciationEntry {
  date: Date
  amount: number
  accumulatedAmount: number
  bookValue: number
  journalEntryId?: Types.ObjectId
}

export interface IFixedAsset extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  code: string
  name: string
  description?: string
  category: string
  accountId: Types.ObjectId
  depreciationAccountId: Types.ObjectId
  accumulatedDepAccountId: Types.ObjectId
  purchaseDate: Date
  purchasePrice: number
  currency: string
  salvageValue: number
  usefulLifeMonths: number
  depreciationMethod: string  // 'straight_line' | 'declining_balance' | 'units_of_production'
  currentValue: number
  status: string              // 'active' | 'disposed' | 'fully_depreciated'
  disposalDate?: Date
  disposalPrice?: number
  depreciationSchedule: IDepreciationEntry[]
  location?: string
  assignedTo?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

### Parent table: `fixed_assets`

```sql
CREATE TABLE IF NOT EXISTS fixed_assets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  depreciation_account_id TEXT NOT NULL REFERENCES accounts(id),
  accumulated_dep_account_id TEXT NOT NULL REFERENCES accounts(id),
  purchase_date TEXT NOT NULL,
  purchase_price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  salvage_value REAL NOT NULL DEFAULT 0,
  useful_life_months INTEGER NOT NULL,
  depreciation_method TEXT NOT NULL CHECK(depreciation_method IN ('straight_line','declining_balance','units_of_production')),
  current_value REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disposed','fully_depreciated')),
  disposal_date TEXT,
  disposal_price REAL,
  location TEXT,
  assigned_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_fa_org_category ON fixed_assets(org_id, category);
```

### Child table: `fixed_asset_depreciation`

```sql
CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
  id TEXT PRIMARY KEY,
  fixed_asset_id TEXT NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  accumulated_amount REAL NOT NULL,
  book_value REAL NOT NULL,
  journal_entry_id TEXT,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

### FixedAsset fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| code | string | Yes | - | Unique asset code within the organization |
| name | string | Yes | - | Display name of the asset |
| description | string | No | - | Free-text description |
| category | string | Yes | - | Asset category (e.g., vehicles, equipment, buildings) |
| accountId | ObjectId | Yes | - | Chart of accounts entry for the asset |
| depreciationAccountId | ObjectId | Yes | - | Expense account for depreciation charges |
| accumulatedDepAccountId | ObjectId | Yes | - | Contra-asset account for accumulated depreciation |
| purchaseDate | Date | Yes | - | Date the asset was acquired |
| purchasePrice | number | Yes | - | Original purchase cost |
| currency | string | No | `EUR` | Currency of purchase price |
| salvageValue | number | Yes | `0` | Estimated residual value at end of useful life |
| usefulLifeMonths | number | Yes | - | Expected useful life in months |
| depreciationMethod | string | Yes | - | Method: `straight_line`, `declining_balance`, `units_of_production` |
| currentValue | number | Yes | - | Current book value of the asset |
| status | string | Yes | `active` | Lifecycle: `active`, `disposed`, `fully_depreciated` |
| disposalDate | Date | No | - | Date the asset was disposed of |
| disposalPrice | number | No | - | Sale/disposal price |
| depreciationSchedule | IDepreciationEntry[] | No | `[]` | Computed depreciation schedule (see below) |
| location | string | No | - | Physical location of the asset |
| assignedTo | ObjectId | No | - | Employee the asset is assigned to |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

### DepreciationEntry fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| date | Date | Yes | - | Date of the depreciation entry |
| amount | number | Yes | - | Depreciation amount for this period |
| accumulatedAmount | number | Yes | - | Total accumulated depreciation to date |
| bookValue | number | Yes | - | Remaining book value after this entry |
| journalEntryId | ObjectId | No | - | Associated journal entry (when depreciation is posted) |

## Relationships

- **References**: `accountId` -> `Account`, `depreciationAccountId` -> `Account`, `accumulatedDepAccountId` -> `Account`, `assignedTo` -> `Employee`
- **Depreciation references**: `journalEntryId` -> `JournalEntry`

## Indexes

- `(orgId, code)` -- unique
- `(orgId, category)`

## API Endpoints (prefix: `/api/org/:orgId/accounting/fixed-asset`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List fixed assets (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. Default sort: `createdAt` desc. |
| POST | `/` | Yes | Create fixed asset. |
| GET | `/:id` | Yes | Get single fixed asset by ID. |
| PUT | `/:id` | Yes | Update fixed asset. |
| DELETE | `/:id` | Yes | Delete fixed asset. |
