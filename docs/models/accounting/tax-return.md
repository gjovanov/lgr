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
  kind?: string         // 'vat' | 'decl1_6' | 'etz' | 'art73_6': set on a return its filing flow owns
  periodCode?: string   // 'YYYYMM'
  cells?: Record<string, number>
  rowCounts?: { sales: number; purchase: number }
  declarant?: ITaxReturnDeclarant
  files?: ITaxReturnFile[]
  source?: string       // 'imported' | 'generated'
  ack?: { number: string; fileId?: Types.ObjectId }
  supersedesId?: Types.ObjectId
  period: {
    from: Date
    to: Date
  }
  status: string        // 'draft' | 'generated' | 'filed' | 'paid' | 'corrected'
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
| kind | string | No | - | Set by a filing flow (FR-25 §3.8), and only there. A return with a `kind` belongs to that flow: the generic `PUT` and `DELETE` below refuse it |
| periodCode | string | No | - | `YYYYMM`, on a return with a `kind` |
| cells | object | No | - | `DEKLAR`'s cells by official code, in integer cents. `01-33` is in hundredths. A blank cell has no key |
| rowCounts | object | No | - | Rows in the sales and purchase registers |
| declarant | object | No | - | Who the return names: `vatId`, `name`, `filer`, and `vies` for VIES. ⚠ `vies.id` is an ЕГН or ЛНЧ, `select: false` |
| files | ITaxReturnFile[] | No | `[]` | `{ name, fileId?, sha256, bytes }`. A VAT file has no `fileId`: its bytes regenerate from the frozen rows and must equal `sha256` |
| source | string | No | - | `imported` from the filed files, or `generated` here |
| ack | object | No | - | The authority's acknowledgement, a number and optionally a `File` |
| supersedesId | ObjectId | No | - | On a correction, the return it replaces. Nothing writes it yet |
| status | string | Yes | `draft` | Lifecycle: `draft`, `generated`, `filed` (submitted to authority), `paid`, `corrected` |
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
- `(orgId, kind, periodCode, supersedesId)` -- `tax_return_period_unique`, on a return with a `kind`: one per period, and one per return it corrects

## Notes

The `period` field is stored as an embedded object in MongoDB (`{ from, to }`) but flattened to `period_from` and `period_to` columns in SQLite.

## API Endpoints (prefix: `/api/org/:orgId/accounting/tax-return`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List tax returns (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. Default sort: `createdAt` desc. |
| POST | `/` | Yes | Create tax return. |
| GET | `/:id` | Yes | Get single tax return by ID. |
| PUT | `/:id` | Yes | Update tax return. Refuses a return with a `kind` (409). |
| DELETE | `/:id` | Yes | Delete tax return. Refuses a return with a `kind` (409). |

## VAT endpoints (prefix: `/api/org/:orgId/accounting/vat`)

LGR produces the files and a person files them (FR-25 D7): nothing here talks to the NRA.

| Method | Path | Needs | Description |
|--------|------|-------|-------------|
| GET | `/` | any `accounting.*` | The returns, newest period first |
| GET | `/:period` | any `accounting.*` | A period: its return if it has one, and how many rows it holds |
| GET | `/:period/rows` | any `accounting.*` | A register, paged. Query: `side`, `page`, `size` |
| GET | `/:period/file/:name` | any `accounting.*` | A file, regenerated and proven against its `sha256`. 409 `vat_return_stale` when the rows have moved |
| GET | `/:period/ack` | any `accounting.*` | The acknowledgement file |
| POST | `/:period/generate` | `accounting.file` | Number the rows, compute the return, record the files. 409 once filed; 422 `vat_declarant_missing` with `fields` when it does not know who files |
| POST | `/:period/mark-filed` | `accounting.file` | `number`, optionally `file` (multipart). Freezes the return with its rows, unless the rows have moved |
