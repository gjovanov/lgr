# Activity

## Entity Interface

```typescript
export interface IActivity extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  type: string             // 'call' | 'email' | 'meeting' | 'task' | 'note' | 'follow_up'
  subject: string
  description?: string
  contactId?: Types.ObjectId
  dealId?: Types.ObjectId
  leadId?: Types.ObjectId
  assignedTo: Types.ObjectId
  dueDate?: Date
  completedAt?: Date
  status: string           // 'pending' | 'completed' | 'cancelled'
  priority: string         // 'low' | 'medium' | 'high'
  duration?: number
  outcome?: string
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| type | string | Yes | - | Activity type: `call`, `email`, `meeting`, `task`, `note`, `follow_up` |
| subject | string | Yes | - | Activity subject / title |
| description | string | No | - | Detailed description of the activity |
| contactId | ObjectId | No | - | References the related Contact |
| dealId | ObjectId | No | - | References the related Deal |
| leadId | ObjectId | No | - | References the related Lead |
| assignedTo | ObjectId | Yes | - | User responsible for the activity |
| dueDate | Date | No | - | Due date for the activity |
| completedAt | Date | No | - | Timestamp when the activity was completed |
| status | string | Yes | `'pending'` | Activity status: `pending`, `completed`, `cancelled` |
| priority | string | Yes | `'medium'` | Priority level: `low`, `medium`, `high` |
| duration | number | No | - | Duration in minutes |
| outcome | string | No | - | Result or outcome of the activity |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **References**: `contactId` -> `Contact`, `dealId` -> `Deal`, `leadId` -> `Lead`, `assignedTo` -> `User`
- **Referenced by**: None

## Indexes

- `(orgId, assignedTo, status, dueDate)`
- `(orgId, contactId)`
- `(orgId, dealId)`

## API Endpoints (prefix: `/api/org/:orgId/crm/activity`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List activities (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. |
| POST | `/` | Yes | Create activity. |
| GET | `/:id` | Yes | Get single activity by ID. |
| PUT | `/:id` | Yes | Update activity (complete, cancel, reschedule). |
| DELETE | `/:id` | Yes | Delete activity. |
