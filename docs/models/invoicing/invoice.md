# Invoice

## Entity Interface

**Source:** `packages/db/src/models/invoice.model.ts`

```typescript
interface IInvoiceLine {
  productId?: Types.ObjectId   // ref: Product
  description: string
  quantity: number
  unit: string
  unitPrice: number
  discount: number             // default: 0
  taxRate: number
  taxAmount: number
  lineTotal: number
  accountId?: Types.ObjectId   // ref: Account
  warehouseId?: Types.ObjectId // ref: Warehouse
}

interface IInvoicePayment {
  date: Date
  amount: number
  method: string               // 'cash' | 'bank_transfer' | 'card' | 'check' | 'other'
  reference?: string
  bankAccountId?: Types.ObjectId  // ref: BankAccount
  journalEntryId?: Types.ObjectId // ref: JournalEntry
}

interface IInvoiceAddress {
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

interface IInvoiceRecurringConfig {
  enabled: boolean
  frequency: string            // 'weekly' | 'monthly' | 'quarterly' | 'yearly'
  nextDate: Date
  endDate?: Date
}

interface IInvoice extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  invoiceNumber: string
  type: string                 // 'invoice' | 'proforma' | 'credit_note' | 'debit_note'
  direction: string            // 'outgoing' | 'incoming'
  status: string               // 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'voided' | 'cancelled' | 'converted'
  contactId: Types.ObjectId    // ref: Contact
  issueDate: Date
  dueDate: Date
  currency: string             // default: 'EUR'
  exchangeRate: number         // default: 1
  lines: IInvoiceLine[]
  subtotal: number             // default: 0
  discountTotal: number        // default: 0
  taxTotal: number             // default: 0
  total: number                // default: 0
  totalBase: number            // default: 0
  amountPaid: number           // default: 0
  amountDue: number            // default: 0
  payments: IInvoicePayment[]
  notes?: string
  terms?: string
  footer?: string
  billingAddress: IInvoiceAddress
  shippingAddress?: IInvoiceAddress
  relatedInvoiceId?: Types.ObjectId   // ref: Invoice (self)
  convertedInvoiceId?: Types.ObjectId // ref: Invoice (self)
  proformaId?: Types.ObjectId         // ref: Invoice (self)
  journalEntryId?: Types.ObjectId     // ref: JournalEntry
  recurringConfig?: IInvoiceRecurringConfig
  attachments: Types.ObjectId[]       // ref: File
  sentAt?: Date
  paidAt?: Date
  tags?: string[]
  createdBy: Types.ObjectId           // ref: User
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

### invoices

| Field | Mongo Type | SQLite Type | Required | Default | Notes |
|-------|-----------|-------------|----------|---------|-------|
| id / _id | ObjectId | TEXT PK | Yes | auto | |
| orgId / org_id | ObjectId | TEXT | Yes | - | Tenant ID |
| invoiceNumber / invoice_number | String | TEXT | Yes | - | Auto-generated (INV-/BILL- prefix) |
| type | String | TEXT | Yes | - | `invoice`, `proforma`, `credit_note`, `debit_note` |
| direction | String | TEXT | Yes | - | `outgoing`, `incoming` |
| status | String | TEXT | Yes | `draft` | See status enum |
| contactId / contact_id | ObjectId | TEXT FK | Yes | - | Ref: Contact |
| issueDate / issue_date | Date | TEXT | Yes | - | |
| dueDate / due_date | Date | TEXT | Yes | - | Defaults to issueDate if not provided |
| currency | String | TEXT | Yes | `EUR` | |
| exchangeRate / exchange_rate | Number | REAL | Yes | 1 | |
| subtotal | Number | REAL | Yes | 0 | |
| discountTotal / discount_total | Number | REAL | Yes | 0 | |
| taxTotal / tax_total | Number | REAL | Yes | 0 | |
| total | Number | REAL | Yes | 0 | |
| totalBase / total_base | Number | REAL | Yes | 0 | total * exchangeRate |
| amountPaid / amount_paid | Number | REAL | Yes | 0 | |
| amountDue / amount_due | Number | REAL | Yes | 0 | |
| notes | String | TEXT | No | - | |
| terms | String | TEXT | No | - | |
| footer | String | TEXT | No | - | |
| billingAddress / billing_address | Object | TEXT (JSON) | Yes | - | JSON in SQLite |
| shippingAddress / shipping_address | Object | TEXT (JSON) | No | - | JSON in SQLite |
| relatedInvoiceId / related_invoice_id | ObjectId | TEXT FK | No | - | Self-ref |
| convertedInvoiceId / converted_invoice_id | ObjectId | TEXT FK | No | - | Self-ref |
| proformaId / proforma_id | ObjectId | TEXT FK | No | - | Self-ref |
| journalEntryId / journal_entry_id | ObjectId | TEXT | No | - | Ref: JournalEntry |
| recurringConfig / recurring_config | Object | TEXT (JSON) | No | - | JSON in SQLite |
| attachments | [ObjectId] | TEXT (JSON) | No | `[]` | JSON array / child table |
| sentAt / sent_at | Date | TEXT | No | - | |
| paidAt / paid_at | Date | TEXT | No | - | |
| tags | [String] | TEXT (JSON) | No | `[]` | |
| voidingUntil | Date | - | No | - | FR-23: a void under way holds the document until then, against the hold a receipt takes |
| createdBy / created_by | ObjectId | TEXT | Yes | - | Ref: User |
| createdAt / created_at | Date | TEXT | Yes | auto | |
| updatedAt / updated_at | Date | TEXT | Yes | auto | |

### invoice_lines

| Field | Mongo Type | SQLite Type | Required | Default | Notes |
|-------|-----------|-------------|----------|---------|-------|
| id | (subdoc _id) | TEXT PK | Yes | auto | |
| invoice_id | (parent ref) | TEXT FK | Yes | - | CASCADE delete |
| productId / product_id | ObjectId | TEXT | No | - | Ref: Product |
| description | String | TEXT | Yes | - | |
| quantity | Number | REAL | Yes | - | |
| unit | String | TEXT | Yes | - | |
| unitPrice / unit_price | Number | REAL | Yes | - | |
| discount | Number | REAL | Yes | 0 | Percentage |
| taxRate / tax_rate | Number | REAL | Yes | - | Percentage |
| taxAmount / tax_amount | Number | REAL | Yes | - | Computed |
| lineTotal / line_total | Number | REAL | Yes | - | Computed |
| accountId / account_id | ObjectId | TEXT | No | - | Ref: Account |
| warehouseId / warehouse_id | ObjectId | TEXT | No | - | Ref: Warehouse |
| sort_order | - | INTEGER | No | 0 | SQLite only |

### invoice_payments

| Field | Mongo Type | SQLite Type | Required | Default | Notes |
|-------|-----------|-------------|----------|---------|-------|
| id | (subdoc _id) | TEXT PK | Yes | auto | |
| invoice_id | (parent ref) | TEXT FK | Yes | - | CASCADE delete |
| date | Date | TEXT | Yes | - | |
| amount | Number | REAL | Yes | - | |
| method | String | TEXT | Yes | - | `cash`, `bank_transfer`, `card`, `check`, `other` |
| reference | String | TEXT | No | - | |
| bankAccountId / bank_account_id | ObjectId | TEXT | No | - | Ref: BankAccount |
| journalEntryId / journal_entry_id | ObjectId | TEXT | No | - | Ref: JournalEntry. Stamped in place by `payment.recorded`, on `receiptId` or on the row's own id |
| sort_order | - | INTEGER | No | 0 | SQLite only |

## Relationships

| Relation | Target Model | Field | Type |
|----------|-------------|-------|------|
| Belongs to | Org | orgId | Many-to-one |
| Belongs to | Contact | contactId | Many-to-one |
| Created by | User | createdBy | Many-to-one |
| References | JournalEntry | journalEntryId | Many-to-one (optional) |
| References | Invoice (self) | relatedInvoiceId | Self-ref (optional) |
| References | Invoice (self) | convertedInvoiceId | Self-ref (optional) |
| References | Invoice (self) | proformaId | Self-ref (optional) |
| Has many | InvoiceLine | lines (embedded) / invoice_lines (child table) | One-to-many |
| Has many | InvoicePayment | payments (embedded) / invoice_payments (child table) | One-to-many |
| Has many | File | attachments / invoice_attachments (child table) | Many-to-many |
| Referenced by | StockMovement | invoiceId | One-to-many |
| Referenced by | PaymentOrder | invoiceIds | Many-to-many |

## API Endpoints

**Base URL:** `/api/org/:orgId/invoices`

**Controller:** `packages/invoicing-api/src/controllers/invoice.controller.ts`

| Method | Path | Description | Auth | Query Params |
|--------|------|-------------|------|-------------|
| GET | `/` | List invoices (paginated) | Yes | `type`, `direction`, `status`, `contactId`, `tags`, `startDate`, `endDate`, `page`, `size`, `sortBy`, `sortOrder` |
| POST | `/` | Create invoice (auto-generates invoiceNumber) | Yes | - |
| GET | `/:id` | Get invoice by ID (populates contact) | Yes | - |
| PUT | `/:id` | Update invoice (draft only) | Yes | - |
| DELETE | `/:id` | Delete invoice (draft only) | Yes | - |
| POST | `/:id/send` | Mark invoice as sent + create stock movement. An unlinked bill may answer 409 `receipt_overlap`, as `/receive` does | Yes | - |
| POST | `/:id/receive` | Mark incoming invoice as received + create stock movement. An unlinked bill answers 409 `receipt_overlap` while an unclaimed goods receipt may be the same delivery; the optional body `{ acknowledgeOverlap: true }` receives anyway (FR-22.31c). 409 `bill_not_draft` when another request took it first; 422 `stock_line_without_warehouse` or `stock_line_without_product` when booking it would be refused, with the bill still a draft | Yes | - |
| POST | `/:id/payments` | Record a payment on invoice. Cash or card on an issued sales invoice or debit note prints a `payment_receipt` where the org prints (FR-23) | Yes | - |
| POST | `/:id/void` | Void invoice + reverse stock movement | Yes | - |
| POST | `/:id/convert` | Convert proforma to invoice | Yes | - |

**List response key:** `invoices`

**Invoice number format:** `INV-000001` (outgoing), `BILL-000001` (incoming)

**Status transitions:**
- `draft` -> `sent` (via `/send`) or `received` (incoming, via `/receive`)
- `sent` -> `partially_paid` -> `paid` (via `/payments`)
- `draft` | `sent` -> `voided` (via `/void`)
- `proforma` -> `converted` (via `/convert`, creates new invoice)

**MongoDB indexes:**
- `{ orgId: 1, invoiceNumber: 1 }` (unique)
- `{ orgId: 1, contactId: 1 }`
- `{ orgId: 1, status: 1 }`
- `{ orgId: 1, direction: 1, issueDate: -1 }`
- `{ orgId: 1, dueDate: 1, status: 1 }`
- `{ orgId: 1, tags: 1 }`
