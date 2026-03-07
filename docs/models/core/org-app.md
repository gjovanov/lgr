# OrgApp

## Entity Interface

```typescript
interface IOrgApp extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  appId: string
  enabled: boolean
  activatedAt: Date
  activatedBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS org_apps (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  app_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  activated_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, app_id)
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| appId | string | Yes | - | App identifier from `APP_REGISTRY`: `accounting`, `invoicing`, `warehouse`, `payroll`, `hr`, `crm`, `erp` |
| enabled | boolean | Yes | `true` | Whether the app is currently active for this org |
| activatedAt | Date | Yes | `Date.now` | When the app was first activated |
| activatedBy | string (ObjectId) | No | - | References the User (admin) who activated the app |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

**Unique constraint:** `(orgId, appId)` -- each app can only have one activation record per org.

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization this app activation belongs to (`orgId`) |
| belongsTo | User | The admin who activated this app (`activatedBy`) |

## API Endpoints

**Cloud API prefix:** `/api/org/:orgId/apps`
**Desktop API:** same endpoints at port 4080

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/org/:orgId/apps` | List available apps with activation status (filtered by user permissions and subscription plan) | Signed in |
| POST | `/api/org/:orgId/apps/:appId/activate` | Activate an app for this org | Admin only |
| POST | `/api/org/:orgId/apps/:appId/deactivate` | Deactivate an app for this org | Admin only |
