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
