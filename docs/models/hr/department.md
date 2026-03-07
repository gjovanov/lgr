# Department

## Entity Interface

```typescript
export interface IDepartment extends TenantEntity {
  name: string
  code: string
  parentId?: string
  headId?: string
  description?: string
  isActive: boolean
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  parent_id TEXT REFERENCES departments(id),
  head_id TEXT,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| name | string | Yes | - | Department name |
| code | string | Yes | - | Unique department code within the org |
| parentId | string | No | - | Parent department ID (for hierarchy) |
| headId | string | No | - | Employee ID of the department head |
| description | string | No | - | Department description |
| isActive | boolean | Yes | `true` (1) | Whether the department is active |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **Department (self)** -- `parentId` references a parent department for hierarchical structure
- **Employee** -- `headId` references the department head

## API Endpoints (prefix: `/api/org/:orgId/hr/department`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List departments. Pagination: `page`, `size`, `sortBy` (default: `name`), `sortOrder` (default: `asc`). Returns `{ departments, total, page, size, totalPages }` |
| POST | `/` | isSignIn | Create department. Body: `name`, `code` (required), `parentId`, `headId`, `description` (optional). Role restricted: `admin` or `hr_manager`. |
| GET | `/:id` | isSignIn | Get single department by ID |
| PUT | `/:id` | isSignIn | Update department. Role restricted: `admin` or `hr_manager`. |
| DELETE | `/:id` | isSignIn | Soft-delete: sets `isActive` to `false`. Role restricted: `admin` or `hr_manager`. |
