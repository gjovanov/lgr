# POSSession

## Entity Interface

```typescript
export interface IPOSSession extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  warehouseId: Types.ObjectId
  cashierId: Types.ObjectId
  sessionNumber: string
  openedAt: Date
  closedAt?: Date
  status: string           // 'open' | 'closed'
  openingBalance: number
  closingBalance?: number
  expectedBalance?: number
  difference?: number
  currency: string
  totalSales: number
  totalReturns: number
  totalCash: number
  totalCard: number
  transactionCount: number
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS pos_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  cashier_id TEXT NOT NULL,
  session_number TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  opening_balance REAL NOT NULL,
  closing_balance REAL,
  expected_balance REAL,
  difference REAL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  total_sales REAL NOT NULL DEFAULT 0,
  total_returns REAL NOT NULL DEFAULT 0,
  total_cash REAL NOT NULL DEFAULT 0,
  total_card REAL NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pos_sessions_cashier ON pos_sessions(org_id, cashier_id, opened_at DESC);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| warehouseId | ObjectId | Yes | - | References the Warehouse (store/location) for this POS session |
| cashierId | ObjectId | Yes | - | References the User operating the register |
| sessionNumber | string | Yes | - | Auto-generated session number (e.g., "POS-0001") |
| openedAt | Date | No | `Date.now` | Timestamp when the session was opened |
| closedAt | Date | No | - | Timestamp when the session was closed |
| status | string | Yes | `'open'` | Session status: `open`, `closed` |
| openingBalance | number | Yes | - | Cash in the register at session start |
| closingBalance | number | No | - | Cash in the register at session close (manually counted) |
| expectedBalance | number | No | - | Expected cash balance based on transactions |
| difference | number | No | - | Difference between closing and expected balance |
| currency | string | No | `'EUR'` | Currency code |
| totalSales | number | Yes | `0` | Total sales amount during the session |
| totalReturns | number | Yes | `0` | Total returns amount during the session |
| totalCash | number | Yes | `0` | Total cash payments received |
| totalCard | number | Yes | `0` | Total card payments received |
| transactionCount | number | Yes | `0` | Number of transactions in the session |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **References**: `warehouseId` -> `Warehouse`, `cashierId` -> `User`
- **Referenced by**: `POSTransaction.sessionId`

## Indexes

- `(orgId, cashierId, openedAt)` -- descending on openedAt

## API Endpoints (prefix: `/api/org/:orgId/erp/pos`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/session` | Yes | Open a new POS session. |
| GET | `/session` | Yes | List POS sessions (paginated). |
| GET | `/session/:id` | Yes | Get single POS session by ID. |
| PUT | `/session/:id` | Yes | Close POS session (set closing balance). |
