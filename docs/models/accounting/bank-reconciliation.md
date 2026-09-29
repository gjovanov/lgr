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
