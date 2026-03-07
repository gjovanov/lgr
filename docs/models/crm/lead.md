# Lead

## Entity Interface

```typescript
export interface ILead extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  source: string           // 'website' | 'referral' | 'cold_call' | 'email' | 'social' | 'event' | 'other'
  status: string           // 'new' | 'contacted' | 'qualified' | 'unqualified' | 'converted'
  companyName?: string
  contactName: string
  email?: string
  phone?: string
  website?: string
  industry?: string
  estimatedValue?: number
  currency?: string
  notes?: string
  assignedTo?: Types.ObjectId
  convertedToContactId?: Types.ObjectId
  convertedToDealId?: Types.ObjectId
  convertedAt?: Date
  tags?: string[]
  customFields?: Map<string, any>
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  source TEXT NOT NULL CHECK(source IN ('website','referral','cold_call','email','social','event','other')),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','unqualified','converted')),
  company_name TEXT,
  contact_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  website TEXT,
  industry TEXT,
  estimated_value REAL,
  currency TEXT,
  notes TEXT,
  assigned_to TEXT,
  converted_to_contact_id TEXT,
  converted_to_deal_id TEXT,
  converted_at TEXT,
  tags TEXT DEFAULT '[]',
  custom_fields TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_org_status ON leads(org_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_org_assigned ON leads(org_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_org_source ON leads(org_id, source);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| source | string | Yes | - | Lead source: `website`, `referral`, `cold_call`, `email`, `social`, `event`, `other` |
| status | string | Yes | `'new'` | Lead status: `new`, `contacted`, `qualified`, `unqualified`, `converted` |
| companyName | string | No | - | Company name of the lead |
| contactName | string | Yes | - | Contact person name |
| email | string | No | - | Contact email address |
| phone | string | No | - | Contact phone number |
| website | string | No | - | Company website URL |
| industry | string | No | - | Industry classification |
| estimatedValue | number | No | - | Estimated deal value |
| currency | string | No | - | Currency code for the estimated value |
| notes | string | No | - | Free-text notes |
| assignedTo | ObjectId | No | - | User assigned to work the lead |
| convertedToContactId | ObjectId | No | - | Contact created when lead is converted |
| convertedToDealId | ObjectId | No | - | Deal created when lead is converted |
| convertedAt | Date | No | - | Timestamp of conversion |
| tags | string[] | No | `[]` | Tags for categorization |
| customFields | Map | No | `{}` | Arbitrary key-value custom fields |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **References**: `assignedTo` -> `User`, `convertedToContactId` -> `Contact`, `convertedToDealId` -> `Deal`
- **Referenced by**: `Activity.leadId`

## Indexes

- `(orgId, status)`
- `(orgId, assignedTo)`
- `(orgId, source)`

## API Endpoints (prefix: `/api/org/:orgId/crm/lead`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List leads (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`, `status`, `source`. |
| POST | `/` | Yes | Create lead. |
| GET | `/:id` | Yes | Get single lead by ID. |
| PUT | `/:id` | Yes | Update lead. |
| DELETE | `/:id` | Yes | Delete lead. |
