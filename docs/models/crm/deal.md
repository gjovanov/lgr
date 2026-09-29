# Deal

## Entity Interface

```typescript
interface IDealProduct {
  productId: Types.ObjectId
  quantity: number
  unitPrice: number
  discount?: number
  total: number
}

export interface IDeal extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  contactId: Types.ObjectId
  stage: string
  pipelineId: Types.ObjectId
  value: number
  currency: string
  probability: number
  expectedCloseDate?: Date
  actualCloseDate?: Date
  status: string           // 'open' | 'won' | 'lost'
  lostReason?: string
  assignedTo: Types.ObjectId
  products?: IDealProduct[]
  notes?: string
  tags?: string[]
  customFields?: Map<string, any>
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | string | Yes | - | Deal name / title |
| contactId | ObjectId | Yes | - | References the Contact associated with this deal |
| stage | string | Yes | - | Current pipeline stage name |
| pipelineId | ObjectId | Yes | - | References the Pipeline this deal belongs to |
| value | number | Yes | - | Deal monetary value |
| currency | string | No | `'EUR'` | Currency code |
| probability | number | Yes | - | Win probability percentage (0-100) |
| expectedCloseDate | Date | No | - | Expected close date |
| actualCloseDate | Date | No | - | Actual close date (set when won/lost) |
| status | string | Yes | `'open'` | State machine: `open` -> `won` / `lost` |
| lostReason | string | No | - | Reason for losing the deal (if status is `lost`) |
| assignedTo | ObjectId | Yes | - | User responsible for the deal |
| products | IDealProduct[] | No | `[]` | Products associated with the deal (child table: `deal_products`) |
| notes | string | No | - | Free-text notes |
| tags | string[] | No | `[]` | Tags for categorization |
| customFields | Map | No | `{}` | Arbitrary key-value custom fields |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **References**: `contactId` -> `Contact`, `pipelineId` -> `Pipeline`, `assignedTo` -> `User`, `products[].productId` -> `Product`
- **Referenced by**: `Activity.dealId`, `Lead.convertedToDealId`

## Indexes

- `(orgId, pipelineId, stage)`
- `(orgId, contactId)`
- `(orgId, assignedTo)`
- `(orgId, status, expectedCloseDate)`

## API Endpoints (prefix: `/api/org/:orgId/crm/deal`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List deals (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`, `status`, `pipelineId`. |
| POST | `/` | Yes | Create deal. |
| GET | `/:id` | Yes | Get single deal by ID. |
| PUT | `/:id` | Yes | Update deal (move stages, mark won/lost). |
| DELETE | `/:id` | Yes | Delete deal. |
