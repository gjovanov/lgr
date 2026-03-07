# CashOrder

## Entity Interface

**Source:** `packages/db/src/models/cash-order.model.ts`

```typescript
interface ICashOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  orderNumber: string
  type: string                    // 'receipt' | 'disbursement'
  date?: Date
  party?: string
  contactId?: Types.ObjectId      // ref: Contact
  amount: number
  currency: string                // default: 'EUR'
  description?: string
  accountId?: Types.ObjectId      // ref: Account
  counterAccountId?: Types.ObjectId // ref: Account
  journalEntryId?: Types.ObjectId // ref: JournalEntry
  createdBy: Types.ObjectId       // ref: User
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

**Source:** `packages/dal-sqlite/src/schema/invoicing.schema.ts`

### Main table: `cash_orders`

```sql
CREATE TABLE IF NOT EXISTS cash_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  order_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('receipt','disbursement')),
  contact_id TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  description TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  counter_account_id TEXT NOT NULL REFERENCES accounts(id),
  journal_entry_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, order_number)
);
```

## Field Reference

| Field | Mongo Type | SQLite Type | Required | Default | Notes |
|-------|-----------|-------------|----------|---------|-------|
| id / _id | ObjectId | TEXT PK | Yes | auto | |
| orgId / org_id | ObjectId | TEXT | Yes | - | Tenant ID |
| orderNumber / order_number | String | TEXT | Yes | - | Auto-generated: `CO-YYYY-00001` |
| type | String | TEXT | Yes | - | `receipt`, `disbursement` |
| date | Date | - | No | - | Mongo only (not in SQLite schema) |
| party | String | - | No | - | Mongo only; free-text party name |
| contactId / contact_id | ObjectId | TEXT | No | - | Ref: Contact |
| amount | Number | REAL | Yes | - | |
| currency | String | TEXT | Yes | `EUR` | |
| description | String | TEXT | No (Mongo) / Yes (SQLite) | - | |
| accountId / account_id | ObjectId | TEXT | No (Mongo) / Yes (SQLite) | - | Ref: Account (cash account) |
| counterAccountId / counter_account_id | ObjectId | TEXT | No (Mongo) / Yes (SQLite) | - | Ref: Account (counter account) |
| journalEntryId / journal_entry_id | ObjectId | TEXT | No | - | Ref: JournalEntry |
| createdBy / created_by | ObjectId | TEXT | Yes | - | Ref: User |
| createdAt / created_at | Date | TEXT | Yes | auto | |
| updatedAt / updated_at | Date | TEXT | Yes | auto | |

## Relationships

| Relation | Target Model | Field | Type |
|----------|-------------|-------|------|
| Belongs to | Org | orgId | Many-to-one |
| References | Contact | contactId | Many-to-one (optional) |
| References | Account | accountId | Many-to-one (cash account) |
| References | Account | counterAccountId | Many-to-one (counter account) |
| References | JournalEntry | journalEntryId | Many-to-one (optional) |
| Created by | User | createdBy | Many-to-one |

## API Endpoints

**Base URL:** `/api/org/:orgId/invoicing/cash-order`

**Controller:** `packages/invoicing-api/src/controllers/cash-order.controller.ts`

| Method | Path | Description | Auth | Query Params |
|--------|------|-------------|------|-------------|
| GET | `/` | List cash orders (paginated, with contact/account lookups) | Yes | `page`, `size`, `sortBy`, `sortOrder` |
| GET | `/:id` | Get cash order by ID | Yes | - |
| POST | `/` | Create cash order (auto-generates orderNumber) | Yes | - |
| PUT | `/:id` | Update cash order | Yes | - |
| DELETE | `/:id` | Delete cash order | Yes | - |

**List response key:** `cashOrders`

**Order number format:** `CO-YYYY-00001`

**List response enrichment:** Each item includes `contactName`, `accountName`, and `counterAccountName` resolved from the referenced entities.

**MongoDB indexes:**
- `{ orgId: 1, orderNumber: 1 }` (unique)
