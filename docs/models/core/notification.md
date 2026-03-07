# Notification

## Entity Interface

```typescript
interface INotification extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  userId: Types.ObjectId
  type: string
  title: string
  message: string
  module: string
  entityType?: string
  entityId?: Types.ObjectId
  read: boolean
  readAt?: Date
  createdAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('info','success','warning','error')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  module TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(org_id, user_id, read, created_at DESC);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| userId | string (ObjectId) | Yes | - | References the User this notification is for |
| type | string | Yes | - | Notification severity: `info`, `success`, `warning`, `error` |
| title | string | Yes | - | Notification title/heading |
| message | string | Yes | - | Notification body text |
| module | string | Yes | - | Module that generated this notification (e.g., `invoicing`) |
| entityType | string | No | - | Type of related entity (e.g., `Invoice`) |
| entityId | string (ObjectId) | No | - | ID of related entity for deep linking |
| read | boolean | Yes | `false` | Whether the user has read this notification |
| readAt | Date | No | - | Timestamp when the notification was marked as read |
| createdAt | Date | Yes | `Date.now` | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

Note: The MongoDB model does not use `{ timestamps: true }` -- it sets `createdAt` manually via `{ type: Date, default: Date.now }`. The SQLite schema includes both `created_at` and `updated_at`.

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization scope (`orgId`) |
| belongsTo | User | The user this notification is addressed to (`userId`) |

## API Endpoints

**Cloud API prefix:** `/api/org/:orgId/notification`
**Desktop API:** same endpoints at port 4080

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/org/:orgId/notification` | List notifications (paginated, filterable by read/module) | Signed in |
| PUT | `/api/org/:orgId/notification/:id/read` | Mark a single notification as read | Signed in |
| PUT | `/api/org/:orgId/notification/read-all` | Mark all unread notifications as read | Signed in |
