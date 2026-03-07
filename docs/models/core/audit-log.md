# AuditLog

## Entity Interface

```typescript
interface IAuditLog extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  userId: Types.ObjectId
  action: string
  module: string
  entityType: string
  entityId: Types.ObjectId
  changes?: { field: string; oldValue: any; newValue: any }[]
  ipAddress?: string
  userAgent?: string
  timestamp: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  module TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  changes TEXT,
  ip_address TEXT,
  user_agent TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_ts ON audit_logs(org_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(org_id, entity_type, entity_id);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| userId | string (ObjectId) | Yes | - | References the User who performed the action |
| action | string | Yes | - | Action performed (e.g., `create`, `update`, `delete`, `post`, `void`) |
| module | string | Yes | - | Module where the action occurred (e.g., `accounting`, `invoicing`) |
| entityType | string | Yes | - | Type of entity affected (e.g., `JournalEntry`, `Invoice`) |
| entityId | string (ObjectId) | Yes | - | ID of the affected entity |
| changes | JSON array | No | - | Array of field-level changes: `[{ field, oldValue, newValue }]` |
| ipAddress | string | No | - | IP address of the request |
| userAgent | string | No | - | Browser/client user agent string |
| timestamp | Date | Yes | `Date.now` | When the action occurred |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization scope (`orgId`) |
| belongsTo | User | The user who performed the action (`userId`) |

## API Endpoints

Audit logs are created internally by the audit service when entity changes occur. There are no direct CRUD endpoints exposed for audit logs. They may be queried as part of admin/settings views in the Portal UI.
