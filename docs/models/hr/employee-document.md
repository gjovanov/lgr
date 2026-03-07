# EmployeeDocument

## Entity Interface

```typescript
export interface IEmployeeDocument extends TenantEntity {
  employeeId: string
  type: string
  title: string
  description?: string
  fileId: string
  validFrom?: Date
  validTo?: Date
  isConfidential: boolean
  createdBy: string
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS employee_documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL CHECK(type IN ('contract','amendment','id_copy','certificate','evaluation','warning','other')),
  title TEXT NOT NULL,
  description TEXT,
  file_id TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  is_confidential INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ed_emp_type ON employee_documents(org_id, employee_id, type);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| employeeId | string | Yes | - | Reference to the Employee this document belongs to |
| type | string | Yes | - | Document type: `contract`, `amendment`, `id_copy`, `certificate`, `evaluation`, `warning`, `other` |
| title | string | Yes | - | Document title |
| description | string | No | - | Document description |
| fileId | string | Yes | - | Reference to the uploaded File record |
| validFrom | Date | No | - | Document validity start date |
| validTo | Date | No | - | Document validity end date |
| isConfidential | boolean | Yes | `false` (0) | Whether the document is confidential |
| createdBy | string | Yes | - | User ID who uploaded the document |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **Employee** -- `employeeId` references the employee who owns this document
- **File** -- `fileId` references the uploaded file record
- **User** -- `createdBy` references the user who created/uploaded the document

## API Endpoints (prefix: `/api/org/:orgId/hr/employee-document`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List employee documents. Pagination: `page`, `size`, `sortBy`, `sortOrder`. Returns `{ employeeDocuments, total, page, size, totalPages }` |
| POST | `/` | isSignIn | Create employee document. Auto-sets `createdBy` from authenticated user. |
| GET | `/:id` | isSignIn | Get single employee document by ID |
| PUT | `/:id` | isSignIn | Update employee document |
| DELETE | `/:id` | isSignIn | Delete employee document |
