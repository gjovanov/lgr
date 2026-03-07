# Pipeline

## Entity Interface

```typescript
interface IPipelineStage {
  name: string
  order: number
  probability: number
  color: string
}

export interface IPipeline extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  stages: IPipelineStage[]
  isDefault: boolean
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  probability REAL NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | string | Yes | - | Pipeline name (unique within the organization) |
| stages | IPipelineStage[] | No | `[]` | Ordered list of deal stages (child table: `pipeline_stages`) |
| stages[].name | string | Yes | - | Stage display name |
| stages[].order | number | Yes | - | Sort order of the stage |
| stages[].probability | number | Yes | - | Default win probability for deals in this stage |
| stages[].color | string | Yes | - | Display color for UI rendering |
| isDefault | boolean | No | `false` | Whether this is the default pipeline for new deals |
| isActive | boolean | No | `true` | Whether the pipeline is available for use |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **Referenced by**: `Deal.pipelineId`

## Indexes

- `(orgId, name)` -- unique

## API Endpoints (prefix: `/api/org/:orgId/crm/pipeline`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List pipelines (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. |
| POST | `/` | Yes | Create pipeline with stages. |
| GET | `/:id` | Yes | Get single pipeline by ID. |
| PUT | `/:id` | Yes | Update pipeline (name, stages, active status). |
| DELETE | `/:id` | Yes | Delete pipeline. Blocked if deals reference it. |
