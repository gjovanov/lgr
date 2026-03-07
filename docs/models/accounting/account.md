# Account

## Entity Interface

```typescript
export interface IAccount extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  code: string
  name: string
  type: string          // 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  subType: string
  parentId?: Types.ObjectId
  currency?: string
  description?: string
  isSystem: boolean
  isActive: boolean
  balance: number
  tags?: string[]
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
  sub_type TEXT NOT NULL,
  parent_id TEXT REFERENCES accounts(id),
  currency TEXT,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  balance REAL NOT NULL DEFAULT 0,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accounts_org_type ON accounts(org_id, type);
CREATE INDEX IF NOT EXISTS idx_accounts_org_parent ON accounts(org_id, parent_id);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| code | string | Yes | - | Unique account code within the organization |
| name | string | Yes | - | Display name of the account |
| type | string | Yes | - | Account classification: `asset`, `liability`, `equity`, `revenue`, `expense` |
| subType | string | Yes | - | Further classification within the account type |
| parentId | ObjectId | No | - | Self-referencing parent account for hierarchical chart of accounts |
| currency | string | No | - | Currency code (e.g., EUR, USD) for the account |
| description | string | No | - | Free-text description of the account |
| isSystem | boolean | No | `false` | Whether this is a system-generated account (cannot be deleted) |
| isActive | boolean | No | `true` | Whether the account is active and available for use |
| balance | number | No | `0` | Current account balance (updated when journal entries are posted/voided) |
| tags | string[] | No | `[]` | Arbitrary tags for categorization and filtering |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **Self-referencing**: `parentId` references another `Account` for tree hierarchy
- **Referenced by**: `JournalEntryLine.accountId`, `FixedAsset.accountId`, `FixedAsset.depreciationAccountId`, `FixedAsset.accumulatedDepAccountId`, `BankAccount.accountId`, `TaxReturnLine.accountId`

## Indexes

- `(orgId, code)` -- unique
- `(orgId, type)`
- `(orgId, parentId)`

## API Endpoints (prefix: `/api/org/:orgId/accounting/account`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List accounts (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. Supports `view=tree` for hierarchical response. |
| POST | `/` | Yes | Create account. Restricted to `admin` or `accountant` roles. |
| GET | `/:id` | Yes | Get single account by ID. |
| PUT | `/:id` | Yes | Update account. Setting `parentId` to empty clears parent. |
| DELETE | `/:id` | Yes | Delete account. Blocked if account is system or has journal entries. |
