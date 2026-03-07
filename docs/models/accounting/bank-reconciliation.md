# BankReconciliation

## Entity Interface

```typescript
export interface IBankReconciliationItem {
  date: Date
  description: string
  amount: number
  type: string          // 'deposit' | 'withdrawal'
  matched: boolean
  journalEntryId?: Types.ObjectId
  bankReference?: string
}

export interface IBankReconciliation extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  bankAccountId: Types.ObjectId
  statementDate: Date
  statementBalance: number
  bookBalance: number
  difference: number
  status: string        // 'draft' | 'completed'
  items: IBankReconciliationItem[]
  reconciledBy?: Types.ObjectId
  reconciledAt?: Date
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

### Parent table: `bank_reconciliations`

```sql
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  statement_date TEXT NOT NULL,
  statement_balance REAL NOT NULL,
  book_balance REAL NOT NULL,
  difference REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','completed')),
  reconciled_by TEXT,
  reconciled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_br_org_bank ON bank_reconciliations(org_id, bank_account_id, statement_date DESC);
```

### Child table: `bank_reconciliation_items`

```sql
CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
  matched INTEGER NOT NULL DEFAULT 0,
  journal_entry_id TEXT,
  bank_reference TEXT,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

### BankReconciliation fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| bankAccountId | ObjectId | Yes | - | Bank account being reconciled |
| statementDate | Date | Yes | - | Date of the bank statement |
| statementBalance | number | Yes | - | Ending balance per bank statement |
| bookBalance | number | Yes | - | Ending balance per books |
| difference | number | Yes | `0` | Discrepancy between statement and book balance |
| status | string | Yes | `draft` | Lifecycle: `draft` (in progress), `completed` (finalized) |
| items | IBankReconciliationItem[] | No | `[]` | Individual reconciliation line items (see below) |
| reconciledBy | ObjectId | No | - | User who completed the reconciliation |
| reconciledAt | Date | No | - | Timestamp when reconciliation was completed |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

### BankReconciliationItem fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| date | Date | Yes | - | Transaction date |
| description | string | Yes | - | Transaction description |
| amount | number | Yes | - | Transaction amount |
| type | string | Yes | - | Transaction direction: `deposit` or `withdrawal` |
| matched | boolean | No | `false` | Whether this item has been matched to a book entry |
| journalEntryId | ObjectId | No | - | Matched journal entry (when reconciled) |
| bankReference | string | No | - | Bank-provided reference number |

## Relationships

- **Belongs to**: `bankAccountId` -> `BankAccount`
- **References**: `reconciledBy` -> `User`
- **Item references**: `journalEntryId` -> `JournalEntry`

## Indexes

- `(orgId, bankAccountId, statementDate)` -- descending date

## API Endpoints (prefix: `/api/org/:orgId/accounting/reconciliation`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List reconciliations (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. Default sort: `createdAt` desc. |
| POST | `/` | Yes | Create reconciliation. |
| GET | `/:id` | Yes | Get single reconciliation by ID. |
| PUT | `/:id` | Yes | Update reconciliation. |
| DELETE | `/:id` | Yes | Delete reconciliation. |
