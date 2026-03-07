# POSTransaction

## Entity Interface

```typescript
interface IPOSTransactionLine {
  productId: Types.ObjectId
  name: string
  quantity: number
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
}

interface IPOSTransactionPayment {
  method: string           // 'cash' | 'card' | 'mobile' | 'voucher'
  amount: number
  reference?: string
}

export interface IPOSTransaction extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  sessionId: Types.ObjectId
  transactionNumber: string
  type: string             // 'sale' | 'return' | 'exchange'
  customerId?: Types.ObjectId
  lines: IPOSTransactionLine[]
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
  payments: IPOSTransactionPayment[]
  changeDue: number
  invoiceId?: Types.ObjectId
  movementId?: Types.ObjectId
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS pos_transactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  session_id TEXT NOT NULL REFERENCES pos_sessions(id),
  transaction_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('sale','return','exchange')),
  customer_id TEXT,
  subtotal REAL NOT NULL,
  discount_total REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  change_due REAL NOT NULL DEFAULT 0,
  invoice_id TEXT,
  movement_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, transaction_number)
);
CREATE INDEX IF NOT EXISTS idx_pos_txn_session ON pos_transactions(org_id, session_id);
CREATE INDEX IF NOT EXISTS idx_pos_txn_date ON pos_transactions(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pos_transaction_lines (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES pos_transactions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pos_transaction_payments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES pos_transactions(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('cash','card','mobile','voucher')),
  amount REAL NOT NULL,
  reference TEXT,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| sessionId | ObjectId | Yes | - | References the parent POSSession |
| transactionNumber | string | Yes | - | Unique transaction number within the organization |
| type | string | Yes | - | Transaction type: `sale`, `return`, `exchange` |
| customerId | ObjectId | No | - | References the Contact (customer), if identified |
| lines | IPOSTransactionLine[] | No | `[]` | Line items (child table: `pos_transaction_lines`) |
| lines[].productId | ObjectId | Yes | - | References the Product sold |
| lines[].name | string | Yes | - | Product name (snapshot at time of sale) |
| lines[].quantity | number | Yes | - | Quantity sold |
| lines[].unitPrice | number | Yes | - | Unit price |
| lines[].discount | number | Yes | `0` | Discount amount |
| lines[].taxRate | number | Yes | `0` | Tax rate percentage |
| lines[].taxAmount | number | Yes | `0` | Calculated tax amount |
| lines[].lineTotal | number | Yes | - | Total for this line |
| subtotal | number | Yes | - | Sum of line totals before discounts and tax |
| discountTotal | number | Yes | `0` | Total discount amount |
| taxTotal | number | Yes | `0` | Total tax amount |
| total | number | Yes | - | Final transaction total |
| payments | IPOSTransactionPayment[] | No | `[]` | Payment methods used (child table: `pos_transaction_payments`) |
| payments[].method | string | Yes | - | Payment method: `cash`, `card`, `mobile`, `voucher` |
| payments[].amount | number | Yes | - | Amount paid via this method |
| payments[].reference | string | No | - | Payment reference (card auth code, voucher number, etc.) |
| changeDue | number | Yes | `0` | Change returned to the customer |
| invoiceId | ObjectId | No | - | References the Invoice generated for this transaction |
| movementId | ObjectId | No | - | References the StockMovement created for inventory |
| createdBy | ObjectId | Yes | - | User who processed the transaction |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **References**: `sessionId` -> `POSSession`, `customerId` -> `Contact`, `invoiceId` -> `Invoice`, `movementId` -> `StockMovement`, `createdBy` -> `User`, `lines[].productId` -> `Product`
- **Referenced by**: None

## Indexes

- `(orgId, transactionNumber)` -- unique
- `(orgId, sessionId)`
- `(orgId, createdAt)` -- descending

## API Endpoints (prefix: `/api/org/:orgId/erp/pos`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/transaction` | Yes | Create a POS transaction (sale, return, exchange). |
| GET | `/transaction` | Yes | List POS transactions (paginated). Query: `page`, `size`, `sessionId`. |
| GET | `/transaction/:id` | Yes | Get single POS transaction by ID. |
