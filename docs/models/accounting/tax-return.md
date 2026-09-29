# TaxReturn

## Entity Interface

```typescript
export interface ITaxReturnLine {
  description: string
  taxableAmount: number
  taxRate: number
  taxAmount: number
  accountId: Types.ObjectId
}

export interface ITaxReturn extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  type: string          // 'vat' | 'income_tax' | 'corporate_tax' | 'payroll_tax'
  period: {
    from: Date
    to: Date
  }
  status: string        // 'draft' | 'filed' | 'paid'
  totalTax: number
  totalInput: number
  totalOutput: number
  netPayable: number
  lines: ITaxReturnLine[]
  filedAt?: Date
  filedBy?: Types.ObjectId
  attachments: Types.ObjectId[]
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

### TaxReturn fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| type | string | Yes | - | Tax type: `vat`, `income_tax`, `corporate_tax`, `payroll_tax` |
| period.from | Date | Yes | - | Start date of the tax period |
| period.to | Date | Yes | - | End date of the tax period |
| status | string | Yes | `draft` | Lifecycle: `draft`, `filed` (submitted to authority), `paid` |
| totalTax | number | Yes | `0` | Total tax amount |
| totalInput | number | Yes | `0` | Total input tax (deductible) |
| totalOutput | number | Yes | `0` | Total output tax (collected) |
| netPayable | number | Yes | `0` | Net tax payable (output - input) |
| lines | ITaxReturnLine[] | No | `[]` | Itemized tax line details (see below) |
| filedAt | Date | No | - | Timestamp when the return was filed |
| filedBy | ObjectId | No | - | User who filed the return |
| attachments | ObjectId[] | No | `[]` | References to File documents (supporting docs) |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

### TaxReturnLine fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| description | string | Yes | - | Description of the tax line item |
| taxableAmount | number | Yes | - | Base amount subject to tax |
| taxRate | number | Yes | - | Tax rate applied (e.g., 0.20 for 20%) |
| taxAmount | number | Yes | - | Computed tax amount |
| accountId | ObjectId | Yes | - | Associated chart of accounts entry |

## Relationships

- **References**: `filedBy` -> `User`, `attachments[]` -> `File`
- **Line references**: `accountId` -> `Account`

## Indexes

- `(orgId, type, period.from)` -- descending period start

## Notes

The `period` field is stored as an embedded object in MongoDB (`{ from, to }`) but flattened to `period_from` and `period_to` columns in SQLite.

## API Endpoints (prefix: `/api/org/:orgId/accounting/tax-return`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List tax returns (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. Default sort: `createdAt` desc. |
| POST | `/` | Yes | Create tax return. |
| GET | `/:id` | Yes | Get single tax return by ID. |
| PUT | `/:id` | Yes | Update tax return. |
| DELETE | `/:id` | Yes | Delete tax return. |
