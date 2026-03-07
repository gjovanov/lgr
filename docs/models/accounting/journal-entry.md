# JournalEntry

## Entity Interface

```typescript
export interface IJournalEntryLine {
  accountId: Types.ObjectId
  description?: string
  debit: number
  credit: number
  currency: string
  exchangeRate: number
  baseDebit: number
  baseCredit: number
  contactId?: Types.ObjectId
  projectId?: Types.ObjectId
  costCenterId?: string
  tags?: string[]
}

export interface IJournalEntry extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  entryNumber: string
  date: Date
  fiscalPeriodId: Types.ObjectId
  description: string
  reference?: string
  type: string          // 'standard' | 'adjusting' | 'closing' | 'reversing' | 'opening'
  status: string        // 'draft' | 'posted' | 'voided'
  lines: IJournalEntryLine[]
  totalDebit: number
  totalCredit: number
  attachments: Types.ObjectId[]
  sourceModule?: string
  sourceId?: Types.ObjectId
  createdBy: Types.ObjectId
  postedBy?: Types.ObjectId
  postedAt?: Date
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

### Parent table: `journal_entries`

```sql
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  entry_number TEXT NOT NULL,
  date TEXT NOT NULL,
  fiscal_period_id TEXT NOT NULL REFERENCES fiscal_periods(id),
  description TEXT NOT NULL,
  reference TEXT,
  type TEXT NOT NULL DEFAULT 'standard' CHECK(type IN ('standard','adjusting','closing','reversing','opening')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','voided')),
  total_debit REAL NOT NULL DEFAULT 0,
  total_credit REAL NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]',
  source_module TEXT,
  source_id TEXT,
  created_by TEXT NOT NULL,
  posted_by TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, entry_number)
);
CREATE INDEX IF NOT EXISTS idx_je_org_date ON journal_entries(org_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_je_org_status ON journal_entries(org_id, status);
CREATE INDEX IF NOT EXISTS idx_je_org_period ON journal_entries(org_id, fiscal_period_id);
```

### Child table: `journal_entry_lines`

```sql
CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  description TEXT,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  exchange_rate REAL NOT NULL DEFAULT 1,
  base_debit REAL NOT NULL DEFAULT 0,
  base_credit REAL NOT NULL DEFAULT 0,
  contact_id TEXT,
  project_id TEXT,
  cost_center_id TEXT,
  tags TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jel_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account ON journal_entry_lines(account_id);
```

## Field Reference

### JournalEntry fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| entryNumber | string | Yes | Auto-generated | Unique entry number (format: `JE-YYYY-NNNNN`). Auto-generated if not provided on create. |
| date | Date | Yes | - | Transaction date |
| fiscalPeriodId | ObjectId | Yes | Auto-resolved | Fiscal period. Auto-resolved from `date` if not provided (creates FY + periods as needed). |
| description | string | Yes | - | Entry description/memo |
| reference | string | No | - | External reference number |
| type | string | Yes | `standard` | Entry type: `standard`, `adjusting`, `closing`, `reversing`, `opening` |
| status | string | Yes | `draft` | Lifecycle: `draft` (editable), `posted` (finalized, updates balances), `voided` (reversed) |
| lines | IJournalEntryLine[] | Yes | - | Debit/credit line items (see below) |
| totalDebit | number | Yes | `0` | Sum of all line debits. Auto-computed from lines if not provided. |
| totalCredit | number | Yes | `0` | Sum of all line credits. Must equal totalDebit (tolerance: 0.01). |
| attachments | ObjectId[] | No | `[]` | References to File documents |
| sourceModule | string | No | - | Originating module (e.g., `invoicing`) for cross-module entries |
| sourceId | ObjectId | No | - | ID of the originating document |
| createdBy | ObjectId | Yes | - | User who created the entry (auto-set from JWT) |
| postedBy | ObjectId | No | - | User who posted the entry |
| postedAt | Date | No | - | Timestamp when the entry was posted |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

### JournalEntryLine fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| accountId | ObjectId | Yes | - | Target account for this line |
| description | string | No | - | Line-level description |
| debit | number | No | `0` | Debit amount in transaction currency |
| credit | number | No | `0` | Credit amount in transaction currency |
| currency | string | No | `EUR` | Transaction currency code |
| exchangeRate | number | Yes | `1` | Exchange rate to base currency |
| baseDebit | number | Yes | `0` | Debit amount in base currency |
| baseCredit | number | Yes | `0` | Credit amount in base currency |
| contactId | ObjectId | No | - | Associated contact (customer/vendor) |
| projectId | ObjectId | No | - | Associated construction project |
| costCenterId | string | No | - | Cost center identifier |
| tags | string[] | No | `[]` | Line-level tags |

## Relationships

- **Belongs to**: `fiscalPeriodId` -> `FiscalPeriod`
- **References**: `createdBy` -> `User`, `postedBy` -> `User`, `attachments[]` -> `File`
- **Line references**: `accountId` -> `Account`, `contactId` -> `Contact`, `projectId` -> `ConstructionProject`
- **Referenced by**: `FiscalYear.closingEntryId`, `FixedAssetDepreciation.journalEntryId`, `BankReconciliationItem.journalEntryId`

## Indexes

- `(orgId, entryNumber)` -- unique
- `(orgId, date)` -- descending
- `(orgId, status)`
- `(orgId, lines.accountId, date)` -- descending (MongoDB embedded)
- `(orgId, fiscalPeriodId)`

## API Endpoints (prefix: `/api/org/:orgId/accounting/journal`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List journal entries (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`, `status`, `fiscalPeriodId`, `startDate`, `endDate`. |
| POST | `/` | Yes | Create journal entry. Auto-generates `entryNumber` and resolves `fiscalPeriodId` from date if not provided. Validates debit = credit. Always created as `draft`. |
| GET | `/:id` | Yes | Get single entry with enriched line data (account code + name per line). |
| PUT | `/:id` | Yes | Update entry. Only draft entries can be edited. |
| DELETE | `/:id` | Yes | Delete entry. Only draft entries can be deleted. |
| POST | `/:id/post` | Yes | Post a draft entry. Sets status to `posted`, records `postedBy`/`postedAt`, and updates account balances. |
| POST | `/:id/void` | Yes | Void a posted entry. Reverses account balance changes and sets status to `voided`. |
