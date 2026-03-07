# BackgroundTask

## Entity Interface

```typescript
interface IBackgroundTask extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  userId: Types.ObjectId
  type: string
  status: string
  params: object
  result?: object
  progress: number
  logs: string[]
  error?: string
  startedAt?: Date
  completedAt?: Date
  createdAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS background_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  params TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  progress REAL NOT NULL DEFAULT 0,
  logs TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bg_tasks_user ON background_tasks(org_id, user_id, status);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| userId | string (ObjectId) | Yes | - | References the User who initiated this task |
| type | string | Yes | - | Task type identifier (e.g., `report_generation`, `data_import`) |
| status | string | Yes | `'pending'` | Task status: `pending`, `processing`, `completed`, `failed` |
| params | JSON | Yes | `{}` | Input parameters for the task |
| result | JSON | No | - | Task output/result data on completion |
| progress | number | Yes | `0` | Progress percentage (0-100) |
| logs | string[] (JSON) | Yes | `[]` | Array of log messages appended during execution |
| error | string | No | - | Error message if the task failed |
| startedAt | Date | No | - | Timestamp when processing began |
| completedAt | Date | No | - | Timestamp when processing finished |
| createdAt | Date | Yes | `Date.now` | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

**MongoDB TTL:** The `createdAt` field has a TTL index (`expireAfterSeconds: 604800`) that automatically removes tasks after 7 days.

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization scope (`orgId`) |
| belongsTo | User | The user who initiated this task (`userId`) |

## API Endpoints

Background tasks are managed internally by the task runner service. Task status and progress are communicated to the frontend via WebSocket. There are no direct CRUD endpoints exposed for background tasks.
