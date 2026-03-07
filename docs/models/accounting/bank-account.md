# BankAccount

## Entity Interface

```typescript
export interface IBankAccount extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  bankName: string
  accountNumber: string
  iban?: string
  swift?: string
  currency: string
  accountId: Types.ObjectId
  balance: number
  isDefault: boolean
  isActive: boolean
  lastReconciledDate?: Date
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  iban TEXT,
  swift TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  account_id TEXT NOT NULL REFERENCES accounts(id),
  balance REAL NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_reconciled_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, account_number)
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | string | Yes | - | Display name for the bank account |
| bankName | string | Yes | - | Name of the financial institution |
| accountNumber | string | Yes | - | Bank account number (unique per org) |
| iban | string | No | - | International Bank Account Number |
| swift | string | No | - | SWIFT/BIC code for international transfers |
| currency | string | No | `EUR` | Account currency code |
| accountId | ObjectId | Yes | - | Linked chart of accounts entry (typically an asset account) |
| balance | number | No | `0` | Current bank balance |
| isDefault | boolean | No | `false` | Whether this is the default bank account for the organization |
| isActive | boolean | No | `true` | Whether the bank account is active |
| lastReconciledDate | Date | No | - | Date of the most recent completed reconciliation |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **Belongs to**: `accountId` -> `Account`
- **Referenced by**: `BankReconciliation.bankAccountId`

## Indexes

- `(orgId, accountNumber)` -- unique

## API Endpoints (prefix: `/api/org/:orgId/accounting/bank-account`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List bank accounts (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. Default sort: `createdAt` desc. |
| POST | `/` | Yes | Create bank account. |
| GET | `/:id` | Yes | Get single bank account by ID. |
| PUT | `/:id` | Yes | Update bank account. |
| DELETE | `/:id` | Yes | Delete bank account. |
