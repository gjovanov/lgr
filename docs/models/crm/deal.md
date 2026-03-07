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

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  stage TEXT NOT NULL,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  value REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  probability REAL NOT NULL,
  expected_close_date TEXT,
  actual_close_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','won','lost')),
  lost_reason TEXT,
  assigned_to TEXT NOT NULL,
  notes TEXT,
  tags TEXT DEFAULT '[]',
  custom_fields TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_org_pipeline ON deals(org_id, pipeline_id, stage);
CREATE INDEX IF NOT EXISTS idx_deals_org_contact ON deals(org_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_org_assigned ON deals(org_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_deals_org_status ON deals(org_id, status, expected_close_date);

CREATE TABLE IF NOT EXISTS deal_products (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  discount REAL,
  total REAL NOT NULL,
  sort_order INTEGER DEFAULT 0
);
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
