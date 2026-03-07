# PaymentOrder

## Entity Interface

**Source:** `packages/db/src/models/payment-order.model.ts`

```typescript
interface IPaymentOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  orderNumber: string
  type: string               // 'payment' | 'receipt'
  date?: Date
  contactId: Types.ObjectId  // ref: Contact
  bankAccountId?: Types.ObjectId // ref: BankAccount
  amount: number
  currency: string           // default: 'EUR'
  exchangeRate: number       // default: 1
  invoiceIds: Types.ObjectId[] // ref: Invoice
  reference?: string
  description?: string
  status: string             // 'draft' | 'approved' | 'executed' | 'cancelled'
  executedAt?: Date
  journalEntryId?: Types.ObjectId // ref: JournalEntry
  createdBy: Types.ObjectId  // ref: User
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

**Source:** `packages/dal-sqlite/src/schema/invoicing.schema.ts`

### Main table: `payment_orders`

```sql
CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  order_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('payment','receipt')),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  exchange_rate REAL NOT NULL DEFAULT 1,
  invoice_ids TEXT NOT NULL DEFAULT '[]',
  reference TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','executed','cancelled')),
  executed_at TEXT,
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
| orderNumber / order_number | String | TEXT | Yes | - | Auto-generated: `PO-YYYY-00001` |
| type | String | TEXT | Yes | - | `payment`, `receipt` (UI maps: outgoing->payment, incoming->receipt) |
| date | Date | - | No | - | Mongo only (not in SQLite schema) |
| contactId / contact_id | ObjectId | TEXT FK | Yes | - | Ref: Contact |
| bankAccountId / bank_account_id | ObjectId | TEXT FK | No (Mongo) / Yes (SQLite) | - | Ref: BankAccount |
| amount | Number | REAL | Yes | - | |
| currency | String | TEXT | Yes | `EUR` | |
| exchangeRate / exchange_rate | Number | REAL | Yes | 1 | |
| invoiceIds / invoice_ids | [ObjectId] | TEXT (JSON) | No | `[]` | JSON array of Invoice IDs |
| reference | String | TEXT | No | - | |
| description | String | TEXT | No | - | |
| status | String | TEXT | Yes | `draft` | `draft`, `approved`, `executed`, `cancelled` |
| executedAt / executed_at | Date | TEXT | No | - | Set when executed |
| journalEntryId / journal_entry_id | ObjectId | TEXT | No | - | Ref: JournalEntry |
| createdBy / created_by | ObjectId | TEXT | Yes | - | Ref: User |
| createdAt / created_at | Date | TEXT | Yes | auto | |
| updatedAt / updated_at | Date | TEXT | Yes | auto | |

## Relationships

| Relation | Target Model | Field | Type |
|----------|-------------|-------|------|
| Belongs to | Org | orgId | Many-to-one |
| Belongs to | Contact | contactId | Many-to-one |
| References | BankAccount | bankAccountId | Many-to-one (optional in Mongo) |
| References | Invoice | invoiceIds | Many-to-many (stored as array) |
| References | JournalEntry | journalEntryId | Many-to-one (optional) |
| Created by | User | createdBy | Many-to-one |

## API Endpoints

**Base URL:** `/api/org/:orgId/invoicing/payment-order`

**Controller:** `packages/invoicing-api/src/controllers/payment-order.controller.ts`

| Method | Path | Description | Auth | Query Params |
|--------|------|-------------|------|-------------|
| GET | `/` | List payment orders (paginated, with contact/bank lookups) | Yes | `page`, `size`, `sortBy`, `sortOrder` |
| GET | `/:id` | Get payment order by ID | Yes | - |
| POST | `/` | Create payment order (auto-generates orderNumber) | Yes | - |
| PUT | `/:id` | Update payment order | Yes | - |
| DELETE | `/:id` | Delete payment order | Yes | - |
| POST | `/:id/execute` | Execute payment order (sets status to `executed`) | Yes | - |

**List response key:** `paymentOrders`

**Order number format:** `PO-YYYY-00001`

**Type mapping (UI <-> API):**
- UI sends `outgoing` -> stored as `payment`
- UI sends `incoming` -> stored as `receipt`
- List endpoint maps back: `payment` -> `outgoing`, `receipt` -> `incoming`

**MongoDB indexes:**
- `{ orgId: 1, orderNumber: 1 }` (unique)
