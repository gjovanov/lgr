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
